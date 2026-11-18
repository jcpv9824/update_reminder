import sql from "mssql";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { catalogDomainRouteFingerprintSql } from "./catalogPhysicalTargetIdentity";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

type BrowserEvidence = { kind: "domain"; domainRouteFingerprint: Buffer;
  databaseId?: never; accessProfileKey?: never; accessProfileVersion?: never };
type DatabaseEvidence = { kind: "database"; databaseId: string; accessProfileKey: string;
  accessProfileVersion: Buffer; domainRouteFingerprint?: never };

/** Produced by a trusted verifier; this contract must not be populated directly from a request. */
export type CatalogPhysicalTargetRegistration = Readonly<{
  portalEnvironment: CatalogEnvironment;
  clientId: string;
  domainId: string;
  /** Protected hash of verified service identity, not a hash of a hostname or display/database name. */
  identityFingerprint: Buffer;
  proofId: string;
  verifiedAt: Date;
  validUntil: Date;
  actor: { id: string };
} & (BrowserEvidence | DatabaseEvidence)>;

type SqlConflict = "proof-replayed" | "proof-stale" | "reference-changed" | "identity-collision";
export type CatalogPhysicalTargetRegistrationResult = { status: "registered"; targetId: string; linkId: string }
  | { status: "conflict"; reason: "invalid-proof" | SqlConflict };

type RegisteredRow = { result: "registered"; target_id: string; link_id: string; replaced_link_id: string | null };
type WriteRow = RegisteredRow | { result: SqlConflict };

const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const nonZeroGuid = (value: unknown): value is string => typeof value === "string" && guid.test(value)
  && value !== "00000000-0000-0000-0000-000000000000";
const sourceId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 150
  && value === value.trim() && !/\p{Cc}/u.test(value);
const bytes = (value: unknown, size: number): value is Buffer => Buffer.isBuffer(value)
  && value.length === size && value.some(octet => octet !== 0);
const date = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.valueOf())
  && value.getUTCFullYear() >= 1 && value.getUTCFullYear() <= 9999;
const sqlKey = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;

function isValid(input: CatalogPhysicalTargetRegistration): boolean {
  if (!input || (input.portalEnvironment !== "qa" && input.portalEnvironment !== "production") ||
      !sourceId(input.clientId) || !sourceId(input.domainId) || !sourceId(input.actor?.id) ||
      !bytes(input.identityFingerprint, 32) || !nonZeroGuid(input.proofId) || !date(input.verifiedAt) ||
      !date(input.validUntil) || input.validUntil <= input.verifiedAt) return false;
  if (input.kind === "domain") return bytes(input.domainRouteFingerprint, 32) && input.databaseId === undefined
    && input.accessProfileKey === undefined && input.accessProfileVersion === undefined;
  return input.kind === "database" && sourceId(input.databaseId) && sqlKey(input.accessProfileKey)
    && bytes(input.accessProfileVersion, 8) && input.domainRouteFingerprint === undefined;
}

/** Fixed, parameterized batch. All checks precede writes and all writes precede the audit commit. */
export const REGISTER_CATALOG_PHYSICAL_TARGET_SQL = `
  DECLARE @clientKey bigint,@domainKey bigint,@databaseKey bigint,@profileKey bigint;
  DECLARE @databaseNameFingerprint binary(32);
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  IF @verifiedAt>@now OR @validUntil<=@now
  BEGIN
    SELECT 'proof-stale' AS result;
    RETURN;
  END;

  -- Lock the logical owner first. Stable IDs are exact, not matched by display names or collation aliases.
  SELECT @clientKey=c.client_key,@domainKey=d.domain_key
  FROM core.clients AS c WITH (UPDLOCK,HOLDLOCK)
  JOIN core.domains AS d WITH (UPDLOCK,HOLDLOCK) ON d.client_key=c.client_key AND d.source_id=@domainId
  WHERE c.source_id=@clientId AND c.status='active' AND d.status='active'
    AND c.source_id COLLATE Latin1_General_100_BIN2=@clientId COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(c.source_id)=DATALENGTH(@clientId)
    AND d.source_id COLLATE Latin1_General_100_BIN2=@domainId COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(d.source_id)=DATALENGTH(@domainId)
    AND (@kind='database' OR ${catalogDomainRouteFingerprintSql}=CONVERT(binary(32),@routeFingerprint));

  IF @kind='database' AND @domainKey IS NOT NULL
  BEGIN
    SELECT @databaseKey=db.database_key,@profileKey=p.access_profile_key,
      @databaseNameFingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.initial_catalog))
    FROM core.databases AS db WITH (UPDLOCK,HOLDLOCK)
    JOIN core.database_access_profiles AS p WITH (UPDLOCK,HOLDLOCK) ON p.access_profile_key=db.access_profile_key
    WHERE db.source_id=@databaseId AND db.source_id COLLATE Latin1_General_100_BIN2=@databaseId COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(db.source_id)=DATALENGTH(@databaseId)
      AND db.client_key=@clientKey AND db.domain_key=@domainKey AND db.status='active'
      AND p.active=1 AND p.access_profile_key=@verifiedProfileKey AND p.row_version=CONVERT(binary(8),@profileVersion);
  END;
  IF @domainKey IS NULL OR (@kind='database' AND @databaseKey IS NULL)
  BEGIN
    SELECT 'reference-changed' AS result;
    RETURN;
  END;

  IF EXISTS (SELECT 1 FROM core.catalog_physical_target_links WITH (UPDLOCK,HOLDLOCK) WHERE proof_id=@proofId)
  BEGIN
    SELECT 'proof-replayed' AS result;
    RETURN;
  END;

  -- Compare evidence across the entire history of this logical link, including retired rows.
  DECLARE @latestVerifiedAt datetime2(3),@openLinkKey bigint;
  SELECT @latestVerifiedAt=MAX(verified_at),
    @openLinkKey=MAX(CASE WHEN retired_at IS NULL THEN physical_target_link_key END)
  FROM core.catalog_physical_target_links WITH (UPDLOCK,HOLDLOCK)
  WHERE portal_environment=@environment AND target_kind=@kind AND client_key=@clientKey AND domain_key=@domainKey
    AND ((@kind='domain' AND database_key IS NULL) OR (@kind='database' AND database_key=@databaseKey));
  IF @latestVerifiedAt>=@verifiedAt
  BEGIN
    SELECT 'proof-stale' AS result;
    RETURN;
  END;

  DECLARE @physicalKey bigint,@targetId uniqueidentifier,@storedDatabaseNameFingerprint binary(32);
  SELECT @physicalKey=physical_target_key,@targetId=target_id,@storedDatabaseNameFingerprint=database_name_fingerprint
  FROM core.catalog_physical_targets WITH (UPDLOCK,HOLDLOCK)
  WHERE portal_environment=@environment AND target_kind=@kind AND identity_fingerprint=CONVERT(binary(32),@identityFingerprint);

  -- A copied SQL database can retain its GUID on the same instance. The immutable
  -- name fingerprint is only a veto after identity match, including after every prior link expires.
  IF @kind='database' AND @physicalKey IS NOT NULL AND (
    @storedDatabaseNameFingerprint IS NULL OR @databaseNameFingerprint IS NULL
    OR @databaseNameFingerprint<>@storedDatabaseNameFingerprint)
  BEGIN
    SELECT 'identity-collision' AS result;
    RETURN;
  END;

  SET @now=SYSUTCDATETIME();
  IF @verifiedAt>@now OR @validUntil<=@now
  BEGIN
    SELECT 'proof-stale' AS result;
    RETURN;
  END;
  IF @physicalKey IS NULL
  BEGIN
    DECLARE @newTarget TABLE (physical_key bigint NOT NULL,target_id uniqueidentifier NOT NULL);
    INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint,database_name_fingerprint)
    OUTPUT inserted.physical_target_key,inserted.target_id INTO @newTarget(physical_key,target_id)
    VALUES(@environment,@kind,CONVERT(binary(32),@identityFingerprint),@databaseNameFingerprint);
    SELECT @physicalKey=physical_key,@targetId=target_id FROM @newTarget;
  END;

  DECLARE @retired TABLE (link_id uniqueidentifier NOT NULL);
  IF @openLinkKey IS NOT NULL
  BEGIN
    UPDATE core.catalog_physical_target_links SET retired_at=@now
      OUTPUT deleted.link_id INTO @retired(link_id)
      WHERE physical_target_link_key=@openLinkKey AND retired_at IS NULL;
    IF (SELECT COUNT(*) FROM @retired)<>1
      THROW 53621,N'No se pudo sustituir el vínculo verificado del catálogo.',1;
  END;
  DECLARE @newLinkId uniqueidentifier=NEWID();
  INSERT core.catalog_physical_target_links(link_id,physical_target_key,portal_environment,target_kind,client_key,domain_key,
    database_key,access_profile_key,access_profile_version,domain_route_fingerprint,proof_id,verified_by,verified_at,valid_until)
  VALUES(@newLinkId,@physicalKey,@environment,@kind,@clientKey,@domainKey,@databaseKey,@profileKey,CONVERT(binary(8),@profileVersion),
    CONVERT(binary(32),@routeFingerprint),@proofId,@actorId,@verifiedAt,@validUntil);

  SELECT 'registered' AS result,LOWER(CONVERT(char(36),@targetId)) AS target_id,
    LOWER(CONVERT(char(36),inserted.link_id)) AS link_id,
    (SELECT LOWER(CONVERT(char(36),link_id)) FROM @retired) AS replaced_link_id
  FROM core.catalog_physical_target_links AS inserted WHERE inserted.link_id=@newLinkId AND inserted.proof_id=@proofId;`;

export async function registerSqlCatalogPhysicalTarget(input: CatalogPhysicalTargetRegistration): Promise<CatalogPhysicalTargetRegistrationResult> {
  if (!isValid(input)) return { status: "conflict", reason: "invalid-proof" };
  // Snapshot mutable Buffer/Date evidence before awaiting acquisition of a SQL transaction.
  const proof = {
    environment: input.portalEnvironment, kind: input.kind, clientId: input.clientId, domainId: input.domainId,
    databaseId: input.databaseId ?? null, profileKey: input.accessProfileKey ?? null,
    profileVersion: input.accessProfileVersion ? Buffer.from(input.accessProfileVersion) : null,
    routeFingerprint: input.domainRouteFingerprint ? Buffer.from(input.domainRouteFingerprint) : null,
    identityFingerprint: Buffer.from(input.identityFingerprint), id: input.proofId,
    verifiedAt: new Date(input.verifiedAt), validUntil: new Date(input.validUntil), actorId: input.actor.id,
  };
  return runSqlTransaction<CatalogPhysicalTargetRegistrationResult>(async transaction => {
    const result = await new sql.Request(transaction)
      .input("environment", sql.VarChar(10), proof.environment).input("kind", sql.VarChar(20), proof.kind)
      .input("clientId", sql.NVarChar(150), proof.clientId).input("domainId", sql.NVarChar(150), proof.domainId)
      .input("databaseId", sql.NVarChar(150), proof.databaseId).input("verifiedProfileKey", sql.BigInt, proof.profileKey)
      .input("profileVersion", sql.VarBinary(8), proof.profileVersion)
      .input("routeFingerprint", sql.VarBinary(32), proof.routeFingerprint)
      .input("identityFingerprint", sql.VarBinary(32), proof.identityFingerprint).input("proofId", sql.UniqueIdentifier, proof.id)
      .input("verifiedAt", sql.DateTime2(3), proof.verifiedAt).input("validUntil", sql.DateTime2(3), proof.validUntil)
      .input("actorId", sql.NVarChar(150), proof.actorId).query<WriteRow>(REGISTER_CATALOG_PHYSICAL_TARGET_SQL);

    if (result.recordset.length !== 1) throw new Error("catalog_physical_target_registration_incomplete");
    const row = result.recordset[0];
    if (row.result === "proof-replayed" || row.result === "proof-stale" || row.result === "reference-changed" || row.result === "identity-collision") {
      return { status: "conflict", reason: row.result };
    }
    if (row.result !== "registered" || !nonZeroGuid(row.target_id) || !nonZeroGuid(row.link_id) ||
        (row.replaced_link_id !== null && !nonZeroGuid(row.replaced_link_id))) throw new Error("catalog_physical_target_registration_incomplete");
    // Audit only opaque internal IDs. The stored DDL already preserves prior evidence and the proof nonce.
    await writeSqlAuditLog(transaction, {
      entityType: "catalog_physical_target_link", entityId: row.link_id,
      action: row.replaced_link_id === null ? "catalog_physical_target_registered" : "catalog_physical_target_reverified",
      performedBy: proof.actorId, performedByEmail: "",
    });
    return { status: "registered", targetId: row.target_id, linkId: row.link_id };
  }).catch(() => {
    // Some driver errors contain bound key values; callers never need that diagnostic payload.
    throw new Error("catalog_physical_target_registration_failed");
  });
}
