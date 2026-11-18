import sql from "mssql";
import type { CatalogEnvironment, CatalogSourceBinding, CatalogSourceRole, CatalogSourceState } from "./catalogSourceConfiguration";
import type { CurrentUser } from "../types/models";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";

type SourceBindingRow = {
  catalog_source_id: string;
  profile_id: string;
  display_name: string;
  source_role: CatalogSourceRole;
  portal_environment: CatalogEnvironment;
  source_state: CatalogSourceState;
  issuer_scope: string | null;
  contract_version: string;
  binding_version: Buffer;
  profile_version: Buffer;
  can_read_current_profile: boolean;
};

export type SqlCatalogSourceBinding = CatalogSourceBinding & {
  bindingVersion: string;
  canReadCurrentProfile: boolean;
};

export const CATALOG_ERP_ISSUER_SCOPE = /^[A-Z]{2}:[A-Z][A-Z0-9_-]{0,31}$/;

type CatalogSourceDraftInput = { profileId: string; environment: CatalogEnvironment } & (
  { role: "erp-customers"; issuerScope: string } | { role: "sag-admin"; issuerScope?: never }
);

export type SqlCatalogSourceDraftResult = { status: "saved"; binding: SqlCatalogSourceBinding }
  | { status: "profile-not-found" | "unsupported-profile" | "conflict" };

const BINDING_PROJECTION = `
  CONVERT(char(36), b.source_id) AS catalog_source_id,
  p.source_id AS profile_id, b.display_name, b.source_role,
  b.portal_environment, b.source_state, b.issuer_scope, b.contract_version,
  b.row_version AS binding_version, p.row_version AS profile_version,
  CONVERT(bit, CASE WHEN b.source_state='active' AND p.status='active'
    AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
    AND b.validated_at IS NOT NULL AND b.validated_profile_version=p.row_version
    THEN 1 ELSE 0 END) AS can_read_current_profile
`;

export function mapCatalogSourceBindingRow(row: SourceBindingRow): SqlCatalogSourceBinding {
  return {
    id: row.catalog_source_id,
    profileId: row.profile_id,
    label: row.display_name,
    role: row.source_role,
    environment: row.portal_environment,
    state: row.source_state,
    profileRevision: row.profile_version.toString("hex"),
    contractVersion: row.contract_version,
    ...(row.issuer_scope === null ? {} : { issuerScope: row.issuer_scope }),
    bindingVersion: row.binding_version.toString("hex"),
    canReadCurrentProfile: row.can_read_current_profile === true,
  };
}

// Trusted service-only query. The UI must consume an authorization-filtered projection.
// It does not load the host, login, database name, or the secret reference.
export async function readSqlCatalogSourceBindings(
  environment: CatalogEnvironment,
): Promise<SqlCatalogSourceBinding[]> {
  const pool = await getSqlPool();
  const result = await pool.request()
    .input("environment", sql.VarChar(10), environment)
    .query<SourceBindingRow>(`
      SELECT ${BINDING_PROJECTION}
      FROM settings.catalog_source_bindings AS b
      JOIN settings.external_database_connections AS p
        ON p.external_database_connection_key=b.external_database_connection_key
      WHERE b.portal_environment=@environment
      ORDER BY b.catalog_source_key;
    `);
  return result.recordset.map(mapCatalogSourceBindingRow);
}

function catalogProfileRequest(transaction: sql.Transaction, input: CatalogSourceDraftInput): sql.Request {
  return new sql.Request(transaction)
    .input("profileId", sql.NVarChar(150), input.profileId)
    .input("environment", sql.VarChar(10), input.environment);
}

async function findLockedDraftOrActive(
  transaction: sql.Transaction, input: CatalogSourceDraftInput,
): Promise<SourceBindingRow[]> {
  const result = await catalogProfileRequest(transaction, input).query<SourceBindingRow>(`
    SELECT TOP (2) ${BINDING_PROJECTION}
    FROM settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
    JOIN settings.external_database_connections AS p
      ON p.external_database_connection_key=b.external_database_connection_key
    WHERE b.portal_environment=@environment AND p.source_id=@profileId AND b.source_state<>'retired'
    ORDER BY b.catalog_source_key;
  `);
  return result.recordset;
}

/**
 * Draft only: no credential read, external probe, activation, or resurrection of a retired binding.
 * The profile update lock serializes saves for one profile through the same transaction as the audit.
 */
export async function saveSqlCatalogSourceDraft(
  input: CatalogSourceDraftInput,
  actor: Pick<CurrentUser, "id">,
): Promise<SqlCatalogSourceDraftResult> {
  if (!input.profileId || input.profileId !== input.profileId.trim() || input.profileId.length > 150 ||
      /\p{Cc}/u.test(input.profileId) || (input.environment !== "qa" && input.environment !== "production") ||
      (input.role !== "erp-customers" && input.role !== "sag-admin") ||
      (input.role === "erp-customers" && !CATALOG_ERP_ISSUER_SCOPE.test(input.issuerScope)) ||
      (input.role === "sag-admin" && input.issuerScope !== undefined)) {
    throw new Error("Borrador de fuente de catálogo inválido.");
  }
  const issuerScope = input.role === "erp-customers" ? input.issuerScope : null;
  const contractVersion = input.role === "erp-customers" ? "erp_v1" : "sag_admin_v1";
  return runSqlTransaction(async transaction => {
    const profile = (await catalogProfileRequest(transaction, input).query<{
      display_name: string;
      status: "active" | "inactive" | "deleted";
      active: boolean;
      encrypt_connection: boolean;
    }>(`
      SELECT p.display_name, p.status, p.active, p.encrypt_connection
      FROM settings.external_database_connections AS p WITH (UPDLOCK,HOLDLOCK)
      WHERE p.source_id=@profileId;
    `)).recordset[0];
    if (!profile || profile.status === "deleted") return { status: "profile-not-found" };

    const candidates = await findLockedDraftOrActive(transaction, input);
    if (candidates.length > 1) return { status: "conflict" };
    const existing = candidates[0];
    const sameDefinition = existing?.source_role === input.role && existing?.issuer_scope === issuerScope;
    if (existing?.source_state === "active") {
      // Idempotent reads of the same definition do not edit or invalidate an active binding.
      return sameDefinition ? { status: "saved", binding: mapCatalogSourceBindingRow(existing) } : { status: "conflict" };
    }

    const label = profile.display_name.trim();
    if (profile.status !== "active" || profile.active !== true || profile.encrypt_connection !== true
      || !label || label.length > 150 || /\p{Cc}/u.test(label)) return { status: "unsupported-profile" };
    if (existing && sameDefinition && existing.display_name === label && existing.contract_version === contractVersion) {
      return { status: "saved", binding: mapCatalogSourceBindingRow(existing) };
    }

    const parameters = catalogProfileRequest(transaction, input)
      .input("role", sql.VarChar(15), input.role)
      .input("issuerScope", sql.NVarChar(80), issuerScope)
      .input("label", sql.NVarChar(150), label)
      .input("contractVersion", sql.VarChar(40), contractVersion)
      .input("actorId", sql.NVarChar(150), actor.id);

    const write = existing
      ? await parameters
        .input("bindingId", sql.UniqueIdentifier, existing.catalog_source_id)
        .input("bindingVersion", sql.VarBinary(8), existing.binding_version)
        .query<{ written_id: string }>(`
          UPDATE settings.catalog_source_bindings
          SET display_name=@label, source_role=@role, issuer_scope=@issuerScope,
              contract_version=@contractVersion, validated_at=NULL, validated_profile_version=NULL,
              updated_at=SYSUTCDATETIME(), updated_by=@actorId
          OUTPUT CONVERT(char(36), inserted.source_id) AS written_id
          WHERE source_id=@bindingId AND portal_environment=@environment AND source_state='draft'
            AND row_version=CONVERT(binary(8),@bindingVersion);
        `)
      : await parameters.query<{ written_id: string }>(`
          INSERT settings.catalog_source_bindings
            (external_database_connection_key, display_name, source_role, portal_environment,
             source_state, issuer_scope, contract_version, created_by, updated_by)
          OUTPUT CONVERT(char(36), inserted.source_id) AS written_id
          SELECT p.external_database_connection_key, @label, @role, @environment,
            'draft', @issuerScope, @contractVersion, @actorId, @actorId
          FROM settings.external_database_connections AS p
          WHERE p.source_id=@profileId AND NOT EXISTS (
            SELECT 1 FROM settings.catalog_source_bindings AS b
            WHERE b.external_database_connection_key=p.external_database_connection_key
              AND b.portal_environment=@environment
          );
        `);
    if (write.recordset.length !== 1) return { status: "conflict" };
    const after = await findLockedDraftOrActive(transaction, input);
    if (after.length !== 1 || after[0].source_state !== "draft" || after[0].catalog_source_id !== write.recordset[0].written_id) {
      throw new Error("No se pudo confirmar el borrador de la fuente.");
    }
    const binding = mapCatalogSourceBindingRow(after[0]);
    await writeSqlAuditLog(transaction, {
      entityType: "catalog_source_binding",
      entityId: binding.id,
      action: existing ? "catalog_source_draft_updated" : "catalog_source_draft_created",
      performedBy: actor.id,
      performedByEmail: "",
    });
    return { status: "saved", binding };
  });
}
