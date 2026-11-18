import sql from "mssql";
import type { CatalogActiveUserContract } from "./catalogActiveUserSqlReader";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";

/** A server-side verification result, never fields deserialized from HTTP. */
export type CatalogReportingProfileRegistration = Readonly<{
  portalEnvironment: CatalogEnvironment;
  targetId: string;
  connectionId: string;
  profileVersion: Buffer;
  trustedInstanceId: string;
  identityFingerprint: Buffer;
  evidence: CatalogActiveUserContract;
  proofId: string;
  verifiedAt: Date;
  validUntil: Date;
  actor: { id: string };
}>;

type SqlConflict = "authority-changed" | "proof-stale" | "proof-replayed" | "reference-changed" | "connection-in-use";
export type CatalogReportingProfileRegistrationResult = { status: "registered"; reportingProfileId: string }
  | { status: "conflict"; reason: "invalid-proof" | SqlConflict };
type Row = { result: "registered"; profile_id: string; replaced_profile_id: string | null } | { result: SqlConflict };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(v);
const text = (v: unknown, width: number): v is string => typeof v === "string" && v.length > 0 && v.length <= width
  && v.trim().length > 0 && !/\p{Cc}/u.test(v);
const id = (v: unknown): v is string => text(v, 150) && v === v.trim();
const binary = (v: unknown, width: number): v is Buffer => Buffer.isBuffer(v) && v.length === width && v.some(n => n !== 0);
const date = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.valueOf())
  && v.getUTCFullYear() >= 1 && v.getUTCFullYear() <= 9999;
const hasExactKeys = (value: object, expected: readonly string[]): boolean => Reflect.ownKeys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key));

function bindCountContract(evidence: CatalogActiveUserContract) {
  if (!evidence || typeof evidence !== "object") return null;
  if (evidence.contract === "approved_aggregate_view_v1" && hasExactKeys(evidence, ["contract"])) {
    return { contract: evidence.contract, column: null, storage: null, bit: null, active: null, inactive: null };
  }
  if (evidence.contract !== "certified_usuarios_v1" || evidence.population !== "all_rows" ||
      typeof evidence.activeColumn !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(evidence.activeColumn)) return null;
  const keys = ["contract", "population", "activeColumn", "storage", "activeValue"];
  if (evidence.storage === "bit" && hasExactKeys(evidence, keys) && (evidence.activeValue === 0 || evidence.activeValue === 1)) {
    return { contract: evidence.contract, column: evidence.activeColumn, storage: "bit", bit: evidence.activeValue === 1, active: null, inactive: null };
  }
  if (evidence.storage === "text" && hasExactKeys(evidence, [...keys, "inactiveValue"]) && text(evidence.activeValue, 32)
      && text(evidence.inactiveValue, 32) && evidence.activeValue !== evidence.inactiveValue) {
    return { contract: evidence.contract, column: evidence.activeColumn, storage: "text", bit: null,
      active: evidence.activeValue, inactive: evidence.inactiveValue };
  }
  return null;
}

/** Fixed parameterized SQL. All expected conflicts are decided before changing rows. */
export const REGISTER_CATALOG_REPORTING_PROFILE_SQL = `
  -- Recheck and lock the operator after the external proof and through the audit commit.
  IF NOT EXISTS (
    SELECT 1 FROM security.users AS u WITH (HOLDLOCK)
    JOIN security.user_roles AS ur WITH (HOLDLOCK) ON ur.user_key=u.user_key
    JOIN security.roles AS r WITH (HOLDLOCK) ON r.role_id=ur.role_id
    WHERE u.source_id=@actor AND u.active=1 AND r.role_id=N'super_admin'
      AND r.active=1 AND r.system_role=1 AND r.protected_role=1
      AND u.source_id COLLATE Latin1_General_100_BIN2=@actor COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(u.source_id)=DATALENGTH(@actor)
  )
  BEGIN
    SELECT 'authority-changed' AS result;
    RETURN;
  END;

  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  IF @verifiedAt>@now OR @validUntil<=@now
  BEGIN
    SELECT 'proof-stale' AS result;
    RETURN;
  END;

  DECLARE @targetKey bigint,@nameFingerprint binary(32),@connectionKey bigint;
  SELECT @targetKey=t.physical_target_key,@nameFingerprint=t.database_name_fingerprint
  FROM core.catalog_physical_targets AS t WITH (UPDLOCK,HOLDLOCK)
  WHERE t.target_id=@targetId AND t.portal_environment=@environment AND t.target_kind='database'
    AND t.identity_fingerprint=CONVERT(binary(32),@identityFingerprint);

  SELECT @connectionKey=p.external_database_connection_key
  FROM settings.external_database_connections AS p WITH (UPDLOCK,HOLDLOCK)
  WHERE p.source_id=@connectionId AND p.source_id COLLATE Latin1_General_100_BIN2=@connectionId COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(p.source_id)=DATALENGTH(@connectionId) AND p.row_version=CONVERT(binary(8),@profileVersion)
    AND p.status='active' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
    AND @nameFingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.database_name));

  IF @targetKey IS NULL OR @connectionKey IS NULL OR @nameFingerprint IS NULL
  BEGIN
    SELECT 'reference-changed' AS result;
    RETURN;
  END;

  IF EXISTS (SELECT 1 FROM settings.catalog_reporting_profiles WITH (UPDLOCK,HOLDLOCK) WHERE proof_id=@proofId)
  BEGIN
    SELECT 'proof-replayed' AS result;
    RETURN;
  END;

  -- A configured reporting connection belongs to one target/environment for its lifetime.
  IF EXISTS (
    SELECT 1 FROM settings.catalog_reporting_profiles WITH (UPDLOCK,HOLDLOCK)
    WHERE external_database_connection_key=@connectionKey AND (physical_target_key<>@targetKey OR portal_environment<>@environment)
  )
  BEGIN
    SELECT 'connection-in-use' AS result;
    RETURN;
  END;

  DECLARE @latestVerifiedAt datetime2(3),@openProfileKey bigint;
  SELECT @latestVerifiedAt=MAX(verified_at),
    @openProfileKey=MAX(CASE WHEN retired_at IS NULL THEN catalog_reporting_profile_key END)
  FROM settings.catalog_reporting_profiles WITH (UPDLOCK,HOLDLOCK)
  WHERE physical_target_key=@targetKey AND portal_environment=@environment;

  SET @now=SYSUTCDATETIME();
  IF @latestVerifiedAt>=@verifiedAt OR @verifiedAt>@now OR @validUntil<=@now
  BEGIN
    SELECT 'proof-stale' AS result;
    RETURN;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM core.catalog_physical_target_links AS l WITH (HOLDLOCK)
    JOIN core.clients AS c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.status='active'
    JOIN core.domains AS d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=l.client_key AND d.status='active'
    JOIN core.databases AS db WITH (HOLDLOCK) ON db.database_key=l.database_key AND db.domain_key=l.domain_key
      AND db.client_key=l.client_key AND db.status='active'
    JOIN core.database_access_profiles AS operational WITH (HOLDLOCK)
      ON operational.access_profile_key=l.access_profile_key AND operational.access_profile_key=db.access_profile_key
      AND operational.active=1 AND operational.row_version=l.access_profile_version
    WHERE l.physical_target_key=@targetKey AND l.portal_environment=@environment AND l.target_kind='database'
      AND l.retired_at IS NULL AND l.verified_at<=@now AND l.valid_until>@now
      AND @nameFingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),operational.initial_catalog))
  )
  BEGIN
    SELECT 'reference-changed' AS result;
    RETURN;
  END;

  DECLARE @previous TABLE (profile_id uniqueidentifier NOT NULL);
  IF @openProfileKey IS NOT NULL
  BEGIN
    UPDATE settings.catalog_reporting_profiles SET retired_at=@now,retired_by=@actor
      OUTPUT deleted.reporting_profile_id INTO @previous(profile_id)
      WHERE catalog_reporting_profile_key=@openProfileKey AND retired_at IS NULL;
    IF (SELECT COUNT(*) FROM @previous)<>1
      THROW 53721,N'No se pudo sustituir el perfil de conteo certificado.',1;
  END;

  DECLARE @newProfile TABLE (profile_id uniqueidentifier NOT NULL);
  INSERT settings.catalog_reporting_profiles(physical_target_key,portal_environment,target_kind,
    external_database_connection_key,verified_profile_version,trusted_instance_id,verified_identity_fingerprint,
    count_contract,active_column,active_storage,active_bit,active_text,inactive_text,proof_id,verified_by,verified_at,valid_until)
  OUTPUT inserted.reporting_profile_id INTO @newProfile(profile_id)
  VALUES(@targetKey,@environment,'database',@connectionKey,CONVERT(binary(8),@profileVersion),@instanceId,
    CONVERT(binary(32),@identityFingerprint),@contract,@column,@storage,@activeBit,@activeText,@inactiveText,@proofId,@actor,@verifiedAt,@validUntil);

  SELECT 'registered' AS result,LOWER(CONVERT(char(36),p.profile_id)) AS profile_id,
    (SELECT LOWER(CONVERT(char(36),profile_id)) FROM @previous) AS replaced_profile_id
  FROM @newProfile AS p;`;

export async function registerSqlCatalogReportingProfile(input: CatalogReportingProfileRegistration): Promise<CatalogReportingProfileRegistrationResult> {
  const contract = bindCountContract(input?.evidence);
  if (!input || !contract || (input.portalEnvironment !== "qa" && input.portalEnvironment !== "production") ||
      !uuid(input.targetId) || !uuid(input.trustedInstanceId) || !uuid(input.proofId) || !id(input.connectionId) || !id(input.actor?.id) ||
      !binary(input.profileVersion, 8) || !binary(input.identityFingerprint, 32) || !date(input.verifiedAt) || !date(input.validUntil) ||
      input.validUntil <= input.verifiedAt) return { status: "conflict", reason: "invalid-proof" };

  const proof = { environment: input.portalEnvironment, targetId: input.targetId, connectionId: input.connectionId,
    profileVersion: Buffer.from(input.profileVersion), instanceId: input.trustedInstanceId,
    identityFingerprint: Buffer.from(input.identityFingerprint), proofId: input.proofId,
    verifiedAt: new Date(input.verifiedAt), validUntil: new Date(input.validUntil), actor: input.actor.id };
  return runSqlTransaction<CatalogReportingProfileRegistrationResult>(async transaction => {
    const { recordset } = await new sql.Request(transaction)
      .input("environment", sql.VarChar(10), proof.environment).input("targetId", sql.UniqueIdentifier, proof.targetId)
      .input("connectionId", sql.NVarChar(150), proof.connectionId).input("profileVersion", sql.VarBinary(8), proof.profileVersion)
      .input("identityFingerprint", sql.VarBinary(32), proof.identityFingerprint).input("instanceId", sql.UniqueIdentifier, proof.instanceId)
      .input("proofId", sql.UniqueIdentifier, proof.proofId).input("actor", sql.NVarChar(150), proof.actor)
      .input("verifiedAt", sql.DateTime2(3), proof.verifiedAt).input("validUntil", sql.DateTime2(3), proof.validUntil)
      .input("contract", sql.VarChar(32), contract.contract).input("column", sql.VarChar(128), contract.column)
      .input("storage", sql.VarChar(4), contract.storage).input("activeBit", sql.Bit, contract.bit)
      .input("activeText", sql.NVarChar(32), contract.active).input("inactiveText", sql.NVarChar(32), contract.inactive)
      .query<Row>(REGISTER_CATALOG_REPORTING_PROFILE_SQL);

    const row = recordset[0];
    if (recordset.length !== 1 || !row) throw new Error("catalog_reporting_profile_registration_incomplete");
    if (row.result === "authority-changed" || row.result === "proof-stale" || row.result === "proof-replayed" || row.result === "reference-changed" || row.result === "connection-in-use") {
      return { status: "conflict", reason: row.result };
    }
    if (row.result !== "registered" || !uuid(row.profile_id) || (row.replaced_profile_id !== null && !uuid(row.replaced_profile_id))) {
      throw new Error("catalog_reporting_profile_registration_incomplete");
    }
    await writeSqlAuditLog(transaction, {
      entityType: "catalog_reporting_profile", entityId: row.profile_id,
      action: row.replaced_profile_id === null ? "catalog_reporting_profile_registered" : "catalog_reporting_profile_reverified",
      performedBy: proof.actor, performedByEmail: "",
    });
    return { status: "registered", reportingProfileId: row.profile_id };
  }).catch(() => { throw new Error("catalog_reporting_profile_registration_failed"); });
}
