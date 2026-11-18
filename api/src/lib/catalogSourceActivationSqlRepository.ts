import sql from "mssql";
import type { CurrentUser } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { CATALOG_ERP_ISSUER_SCOPE, type SqlCatalogSourceBinding } from "./catalogSourceBindingsSqlRepository";
import { getCatalogSourceActivationIssue, type CatalogSourceVerification } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const rowVersion = /^[0-9a-f]{16}$/i;
export const CATALOG_SOURCE_ACTIVATION_PROOF_MAX_AGE_MS = 120_000;
type ActivationResult = "activated" | "superseded" | "conflict";

const activateBindingSql = `
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  -- Lock the environment singleton, then the profile, in the same profile-first
  -- order as draft saves. No external calls happen inside this transaction.
  DECLARE @lockResult int, @resource nvarchar(255)=N'portal-sag:catalog-source-activation:'+@environment;
  EXEC @lockResult=sys.sp_getapplock @Resource=@resource, @LockMode='Exclusive',
    @LockOwner='Transaction', @LockTimeout=5000;
  IF @lockResult<0 THROW 53120, N'Catalog source activation lock unavailable.', 1;

  DECLARE @profileKey bigint, @bindingKey bigint;
  SELECT @profileKey=p.external_database_connection_key
  FROM settings.external_database_connections AS p WITH (UPDLOCK,HOLDLOCK)
  WHERE p.source_id=@profileId AND p.row_version=CONVERT(binary(8),@profileVersion)
    AND p.status='active' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1;

  IF @profileKey IS NOT NULL
    SELECT @bindingKey=b.catalog_source_key
    FROM settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
    WHERE b.source_id=@bindingId AND b.row_version=CONVERT(binary(8),@bindingVersion)
      AND b.external_database_connection_key=@profileKey AND b.portal_environment=@environment
      AND b.source_state=@expectedState AND (b.source_state='draft'
        OR (b.source_state='active' AND b.validated_profile_version<>CONVERT(binary(8),@profileVersion)))
      AND b.source_role=@role AND b.contract_version=@contract
      AND (b.issuer_scope COLLATE Latin1_General_100_BIN2=@issuerScope COLLATE Latin1_General_100_BIN2
        OR (b.issuer_scope IS NULL AND @issuerScope IS NULL));

  IF @bindingKey IS NULL
  BEGIN
    SELECT CAST('superseded' AS varchar(10)) AS result;
    RETURN;
  END;

  IF EXISTS (SELECT 1 FROM settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
      WHERE b.portal_environment=@environment AND b.source_state='active'
        AND b.external_database_connection_key=@profileKey AND b.catalog_source_key<>@bindingKey)
    OR (@role='sag-admin' AND EXISTS (
      SELECT 1 FROM settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
      WHERE b.portal_environment=@environment AND b.source_state='active' AND b.source_role='sag-admin'
        AND b.catalog_source_key<>@bindingKey))
  BEGIN
    SELECT CAST('conflict' AS varchar(10)) AS result;
    RETURN;
  END;

  -- Recheck against the database's clock *after* taking all locks. A delayed,
  -- future-dated or stale certification cannot activate the source.
  DECLARE @validatedAt datetime2(3)=SYSUTCDATETIME();
  IF @checkedAt>@validatedAt OR @checkedAt<DATEADD(millisecond,-@maxProofAgeMs,@validatedAt)
  BEGIN
    SELECT CAST('superseded' AS varchar(10)) AS result;
    RETURN;
  END;

  DECLARE @writes TABLE (binding_key bigint NOT NULL);
  UPDATE settings.catalog_source_bindings
  SET source_state='active', validated_profile_version=CONVERT(binary(8),@profileVersion),
    validated_at=@validatedAt, updated_at=@validatedAt, updated_by=@actorId
  OUTPUT inserted.catalog_source_key INTO @writes(binding_key)
  WHERE catalog_source_key=@bindingKey AND source_state=@expectedState AND row_version=CONVERT(binary(8),@bindingVersion)
    AND (source_state='draft' OR (source_state='active' AND validated_profile_version<>CONVERT(binary(8),@profileVersion)));

  SELECT CAST(CASE WHEN (SELECT COUNT_BIG(*) FROM @writes)=1 THEN 'activated' ELSE 'superseded' END AS varchar(10)) AS result;
`;

function validIdentity(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value === value.trim() && !/\p{Cc}/u.test(value);
}

/** Service-only; the caller must authorize the actor and construct evidence from the approved probe. */
export async function activateSqlCatalogSource(
  binding: SqlCatalogSourceBinding,
  evidence: CatalogSourceVerification,
  actor: CurrentUser,
): Promise<ActivationResult> {
  if (!validIdentity(actor.id, 150)) throw new Error("invalid_catalog_source_actor");
  const renewingStaleActive = binding.state === "active" && binding.canReadCurrentProfile === false;
  if ((binding.state !== "draft" && !renewingStaleActive) ||
      binding.id.length !== 36 || !uuid.test(binding.id) || !validIdentity(binding.profileId, 150) ||
      binding.profileRevision.length !== 16 || binding.bindingVersion.length !== 16 ||
      !rowVersion.test(binding.profileRevision) || !rowVersion.test(binding.bindingVersion) ||
      binding.id !== evidence.bindingId || binding.bindingVersion !== evidence.bindingVersion ||
      (binding.environment !== "qa" && binding.environment !== "production") ||
      !((binding.role === "erp-customers" && binding.contractVersion === "erp_v1" &&
        typeof binding.issuerScope === "string" && CATALOG_ERP_ISSUER_SCOPE.test(binding.issuerScope)) ||
        (binding.role === "sag-admin" && binding.contractVersion === "sag_admin_v1" && binding.issuerScope === undefined)) ||
      getCatalogSourceActivationIssue({ binding, verification: evidence, existing: [],
        nowMs: Date.now(), maxEvidenceAgeMs: CATALOG_SOURCE_ACTIVATION_PROOF_MAX_AGE_MS }) !== null) return "superseded";

  try {
    return await runSqlTransaction(async transaction => {
      const result = await new sql.Request(transaction)
        .input("bindingId", sql.UniqueIdentifier, binding.id)
        .input("profileId", sql.NVarChar(150), binding.profileId)
        .input("bindingVersion", sql.VarBinary(8), Buffer.from(binding.bindingVersion, "hex"))
        .input("profileVersion", sql.VarBinary(8), Buffer.from(binding.profileRevision, "hex"))
        .input("environment", sql.VarChar(10), binding.environment)
        .input("expectedState", sql.VarChar(10), binding.state)
        .input("role", sql.VarChar(15), binding.role)
        .input("contract", sql.VarChar(40), binding.contractVersion)
        .input("issuerScope", sql.NVarChar(80), binding.issuerScope ?? null)
        .input("actorId", sql.NVarChar(150), actor.id)
        .input("checkedAt", sql.DateTime2(3), new Date(evidence.checkedAtMs))
        .input("maxProofAgeMs", sql.Int, CATALOG_SOURCE_ACTIVATION_PROOF_MAX_AGE_MS)
        .query<{ result: string }>(activateBindingSql);
      const status = result.recordset[0]?.result;
      if (result.recordset.length !== 1 || (status !== "activated" && status !== "superseded" && status !== "conflict")) {
        throw new Error("invalid_catalog_activation_result");
      }
      if (status === "activated") {
        await writeSqlAuditLog(transaction, {
          entityType: "catalog_source_binding", entityId: binding.id,
          action: renewingStaleActive ? "catalog_source_revalidated" : "catalog_source_activated",
          performedBy: actor.id, performedByEmail: "",
        });
      }
      return status;
    }, sql.ISOLATION_LEVEL.SERIALIZABLE);
  } catch {
    throw new Error("catalog_source_activation_failed");
  }
}
