import sql from "mssql";
import type { CatalogEnvironment, CatalogSourceBinding, CatalogSourceRole, CatalogSourceState } from "./catalogSourceConfiguration";
import { getSqlPool } from "./sql";

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
      SELECT CONVERT(char(36), b.source_id) AS catalog_source_id,
             p.source_id AS profile_id, b.display_name, b.source_role,
             b.portal_environment, b.source_state, b.issuer_scope, b.contract_version,
             b.row_version AS binding_version, p.row_version AS profile_version,
             CONVERT(bit, CASE WHEN b.source_state='active' AND p.status='active'
               AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
               AND b.validated_at IS NOT NULL AND b.validated_profile_version=p.row_version
               THEN 1 ELSE 0 END) AS can_read_current_profile
      FROM settings.catalog_source_bindings AS b
      JOIN settings.external_database_connections AS p
        ON p.external_database_connection_key=b.external_database_connection_key
      WHERE b.portal_environment=@environment
      ORDER BY b.catalog_source_key;
    `);
  return result.recordset.map(mapCatalogSourceBindingRow);
}
