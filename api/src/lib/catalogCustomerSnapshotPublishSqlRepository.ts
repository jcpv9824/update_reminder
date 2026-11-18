import { randomUUID } from "node:crypto";
import sql from "mssql";
import { writeSqlAuditLog } from "./auditSqlWriter";
import type { CatalogRefreshPublication, CatalogRefreshSink } from "./catalogCustomerRefresh";
import { normalizeCatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";

type Stamp = Parameters<CatalogRefreshSink["recordFailure"]>[0];
export type CatalogPublicationOperator = Pick<Stamp, "environment" | "sourceId" | "bindingRevision" |
  "profileRevision" | "matchKeyVersion"> & { id: string };
const maxRows = 100_000;
const maxScopes = 512;
const maxPayloadBytes = 16 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const version = /^[a-f0-9]{16}$/i;
const bigintUpperBound = 9223372036854775807n;
const validOrdinal = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= bigintUpperBound;
const issuerScope = /^[A-Z]{2}:[A-Z0-9][A-Z0-9_-]{0,31}$/;
const validSqlInt = (n: number) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;

// Only fixed, parameterized SQL against the Portal's own operational store.
// Compare both versions that the worker read before contacting the certified source.
const lockAndCheck = `
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  DECLARE @ordinal bigint=CONVERT(bigint,@attemptOrdinal);
  DECLARE @lockResult int;
  DECLARE @lockResource nvarchar(255)=N'portal-sag:catalog-customer-publication:'+@environment;
  EXEC @lockResult=sys.sp_getapplock @Resource=@lockResource, @LockMode='Exclusive',
    @LockOwner='Transaction', @LockTimeout=5000;
  IF @lockResult<0 THROW 53320, N'Catalog publication lock unavailable.', 1;

  DECLARE @sourceKey bigint, @bindingRole varchar(15), @bindingScope nvarchar(80), @bindingContract varchar(40),
    @hadHead bit=0, @headAttemptOrdinal bigint, @headMatchVersion smallint;
  SELECT @sourceKey=b.catalog_source_key, @bindingRole=b.source_role, @bindingScope=b.issuer_scope,
    @bindingContract=b.contract_version
  FROM settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
  JOIN settings.external_database_connections AS p WITH (UPDLOCK,HOLDLOCK)
    ON p.external_database_connection_key=b.external_database_connection_key
  WHERE b.source_id=@sourceId AND b.portal_environment=@environment AND b.source_state='active'
    AND b.row_version=@bindingRevision AND b.validated_profile_version=p.row_version AND p.row_version=@profileRevision
    AND b.validated_at IS NOT NULL AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1;
  SELECT @hadHead=1, @headAttemptOrdinal=h.attempt_ordinal, @headMatchVersion=r.match_key_version
  FROM settings.catalog_customer_revision_heads AS h WITH (UPDLOCK,HOLDLOCK)
  LEFT JOIN core.catalog_customer_source_revisions AS r ON r.revision_key=h.revision_key
  WHERE h.catalog_source_key=@sourceKey;
  IF @sourceKey IS NULL OR @ordinal<=@headAttemptOrdinal
    OR @matchKeyVersion<@headMatchVersion
  BEGIN
    SELECT CAST('superseded' AS varchar(11)) AS result;
    RETURN;
  END;
`;

const preparePublishBatch = `${lockAndCheck}
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  DECLARE @freshUntil datetime2(3)=DATEADD(minute,@freshnessMinutes,@observedAt);
  IF @freshUntil<=@now OR @observedAt>@now THROW 53326, N'Catalog evidence time is invalid at publication.', 1;
  IF @bindingRole<>@sourceRole OR (@sourceRole='erp-customers' AND @bindingContract<>'erp_v1')
    OR (@sourceRole='sag-admin' AND @bindingContract<>'sag_admin_v1')
    THROW 53321, N'Catalog publication contract changed.', 1;

  CREATE TABLE #catalog_input (
    source_record_id int NOT NULL PRIMARY KEY,
    issuer char(2) COLLATE Latin1_General_100_BIN2 NULL,
    document_type varchar(32) COLLATE Latin1_General_100_BIN2 NULL,
    token binary(32) NULL,
    official_name nvarchar(512) NULL,
    active_code char(1) NULL,
    allocation_id uniqueidentifier NULL,
    catalog_customer_key bigint NULL
  );
  INSERT INTO #catalog_input(source_record_id,issuer,document_type,token,official_name,active_code,allocation_id)
  SELECT sourceRecordId, issuer, documentType, CONVERT(binary(32), token, 2), officialName, activeCode, allocationId
  FROM OPENJSON(@rows) WITH (sourceRecordId int, issuer char(2), documentType varchar(32), token varchar(64),
    officialName nvarchar(512), activeCode char(1), allocationId uniqueidentifier);
  IF (SELECT COUNT_BIG(*) FROM #catalog_input)<>@rowCount THROW 53322, N'Catalog row count mismatch.', 1;

  IF @sourceRole='erp-customers'
  BEGIN
    IF EXISTS (SELECT 1 FROM #catalog_input WHERE token IS NOT NULL
      AND (@bindingScope IS NULL OR CONCAT(issuer, ':', document_type) COLLATE Latin1_General_100_BIN2
        <> @bindingScope COLLATE Latin1_General_100_BIN2))
      THROW 53323, N'ERP catalog document scope changed.', 1;

    -- No direct equality between two HMAC key versions. An authorized reconciliation must move
    -- every ERP first if this policy is rotated; silently issuing new customer IDs is not a rotation.
    IF EXISTS (SELECT 1 FROM settings.catalog_source_bindings AS b
      JOIN settings.catalog_customer_revision_heads AS h ON h.catalog_source_key=b.catalog_source_key
      JOIN core.catalog_customer_source_revisions AS r ON r.revision_key=h.revision_key
      WHERE b.portal_environment=@environment AND b.source_role='erp-customers' AND b.source_state='active'
        AND r.match_key_version<>@matchKeyVersion)
      THROW 53324, N'Catalog comparison key requires verified identity reconciliation.', 1;

    -- Reuse identities even if a matching customer was absent in the previous snapshot
    -- or belongs to another ERP. Only sealed history in this environment/version is evidence.
    SELECT i.source_record_id, MIN(rr.catalog_customer_key) AS min_customer,
      MAX(rr.catalog_customer_key) AS max_customer
    INTO #catalog_identity_matches
    FROM #catalog_input AS i
    JOIN core.catalog_customer_revision_rows AS rr
      ON rr.source_role='erp-customers' AND rr.issuer=i.issuer AND rr.document_type=i.document_type
      AND rr.document_number_token=i.token
    JOIN core.catalog_customer_source_revisions AS r ON r.revision_key=rr.revision_key
      AND r.match_key_version=@matchKeyVersion AND r.sealed_at IS NOT NULL
    JOIN settings.catalog_source_bindings AS b ON b.catalog_source_key=r.catalog_source_key
      AND b.portal_environment=@environment
    GROUP BY i.source_record_id;
    IF EXISTS (SELECT 1 FROM #catalog_identity_matches WHERE min_customer<>max_customer)
      THROW 53325, N'Catalog protected identity requires reconciliation.', 1;
    UPDATE i SET catalog_customer_key=m.min_customer
    FROM #catalog_input AS i JOIN #catalog_identity_matches AS m ON m.source_record_id=i.source_record_id;

    -- For unresolved documents use only the latest exact-source record from the same
    -- binding/profile. A fiscal change or a reassigned source is not continuity evidence.
    ;WITH history AS (
      SELECT rr.source_record_id, rr.catalog_customer_key, rr.document_number_token,
        ROW_NUMBER() OVER (PARTITION BY rr.source_record_id ORDER BY r.revision_key DESC) AS position
      FROM core.catalog_customer_revision_rows AS rr
      JOIN core.catalog_customer_source_revisions AS r ON r.revision_key=rr.revision_key
      JOIN #catalog_input AS candidate ON candidate.source_record_id=rr.source_record_id
        AND candidate.token IS NULL AND candidate.catalog_customer_key IS NULL
      WHERE r.catalog_source_key=@sourceKey AND r.binding_version=@bindingRevision
        AND r.profile_version=@profileRevision AND r.match_key_version=@matchKeyVersion AND r.sealed_at IS NOT NULL
    )
    UPDATE i SET catalog_customer_key=h.catalog_customer_key
    FROM #catalog_input AS i JOIN history AS h ON h.source_record_id=i.source_record_id
    WHERE h.position=1 AND h.document_number_token IS NULL;

    -- One opaque allocation per newly discovered protected identity, independent of its token.
    ;WITH allocations AS (
      SELECT issuer, document_type, token, MIN(source_record_id) AS representative
      FROM #catalog_input WHERE token IS NOT NULL AND catalog_customer_key IS NULL
      GROUP BY issuer, document_type, token
    )
    UPDATE i SET allocation_id=a.allocation_id
    FROM #catalog_input AS i JOIN allocations AS g ON g.issuer=i.issuer AND g.document_type=i.document_type AND g.token=i.token
    JOIN #catalog_input AS a ON a.source_record_id=g.representative
    WHERE i.catalog_customer_key IS NULL;
    INSERT INTO core.catalog_customer_ids(customer_id)
    SELECT DISTINCT allocation_id FROM #catalog_input WHERE catalog_customer_key IS NULL;
    UPDATE i SET catalog_customer_key=c.catalog_customer_key
    FROM #catalog_input AS i JOIN core.catalog_customer_ids AS c ON c.customer_id=i.allocation_id
    WHERE i.catalog_customer_key IS NULL;
  END;

`;

const insertRevision = (includesInventory: boolean) => `
  DECLARE @revisionKey bigint;
  INSERT INTO core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,
    match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until${includesInventory ? ",has_sag_inventory_evidence" : ""})
  VALUES(@sourceKey,@sourceRole,@bindingRevision,@profileRevision,@matchKeyVersion,@ordinal,@rowCount,@scopeCount,@observedAt,@freshUntil${includesInventory ? ",1" : ""});
  SET @revisionKey=CONVERT(bigint,SCOPE_IDENTITY());

  INSERT INTO core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,
    official_name,active_code,issuer,document_type,document_number_token)
  SELECT @revisionKey,@sourceRole,source_record_id,catalog_customer_key,official_name,active_code,issuer,document_type,token
  FROM #catalog_input;
  INSERT INTO core.catalog_customer_revision_scopes(revision_key,issuer,document_type)
  SELECT @revisionKey,issuer,documentType FROM OPENJSON(@scopes) WITH(issuer char(2),documentType varchar(32));
`;

const insertSagaEvidence = `
  INSERT INTO core.catalog_sag_revision_evidence(revision_key,source_record_id,domain_candidate,environment_kind,
    license_codes,test_started_on,production_started_on,demo_started_on)
  SELECT @revisionKey,sourceRecordId,domainCandidate,environmentKind,licenseCodes,testStartedOn,productionStartedOn,demoStartedOn
  FROM OPENJSON(@inventory) WITH (sourceRecordId int,domainCandidate varchar(253),environmentKind varchar(10),
    licenseCodes varchar(25),testStartedOn date,productionStartedOn date,demoStartedOn date);
`;

const sealAndPublishBatch = `
  -- Triggers certify exact counts before allowing the head to advance, all in this transaction.
  SET @now=SYSUTCDATETIME();
  IF @freshUntil<=@now THROW 53326, N'Catalog evidence expired before publication.', 1;
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@now WHERE revision_key=@revisionKey;
  IF @hadHead=1
    UPDATE settings.catalog_customer_revision_heads SET revision_key=@revisionKey,attempt_status='succeeded',attempted_at=@now,
      attempt_ordinal=@ordinal WHERE catalog_source_key=@sourceKey;
  ELSE
    INSERT INTO settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@sourceKey,@revisionKey,'succeeded',@now,@ordinal);
  SELECT CAST('published' AS varchar(11)) AS result;
`;

// Baseline batch doesn't reference any 035 objects. Only an explicitly certified
// SAG revision selects the opt-in batch; SQL 035 must exist before enabling it.
const publishBatch = preparePublishBatch + insertRevision(false) + sealAndPublishBatch;
const publishWithSagaEvidenceBatch = preparePublishBatch + insertRevision(true) + insertSagaEvidence + sealAndPublishBatch;

const failureBatch = `${lockAndCheck}
  -- A failure only marks freshness. It must never clear or write a revision or change opaque IDs.
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  IF @hadHead=1
    UPDATE settings.catalog_customer_revision_heads SET attempt_status='failed',attempted_at=@now,attempt_ordinal=@ordinal
    WHERE catalog_source_key=@sourceKey;
  ELSE
    INSERT INTO settings.catalog_customer_revision_heads(catalog_source_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@sourceKey,'failed',@now,@ordinal);
`;

const reserveAttemptBatch = `
  DECLARE @reserved bigint;
  SET @reserved=NEXT VALUE FOR settings.catalog_customer_attempt_sequence;
  SELECT CONVERT(varchar(19),@reserved) AS attemptOrdinal;
`;

function validStamp(stamp: Stamp): boolean {
  return ["qa", "production"].includes(stamp.environment) && uuid.test(stamp.sourceId) &&
    version.test(stamp.bindingRevision) && version.test(stamp.profileRevision) && validOrdinal(stamp.attemptOrdinal) &&
    Number.isInteger(stamp.matchKeyVersion) &&
    stamp.matchKeyVersion >= 1 && stamp.matchKeyVersion <= 32767 &&
    stamp.observedAt instanceof Date && Number.isFinite(stamp.observedAt.valueOf());
}

function splitScope(scope: string | null) {
  if (scope === null) return { issuer: null, documentType: null };
  if (typeof scope !== "string" || !issuerScope.test(scope)) throw new Error("invalid_catalog_publication");
  const [issuer, documentType] = scope.split(":");
  return { issuer, documentType };
}

function validateAndSerialize(revision: CatalogRefreshPublication): { rows: string; scopes: string; inventory: string | null } {
  const includesInventory = revision.includesSagInventory === true;
  if (!validStamp(revision) || !["erp-customers", "sag-admin"].includes(revision.role) ||
      revision.rows.length > maxRows || revision.completeScopes.length > maxScopes ||
      (revision.includesSagInventory !== undefined && typeof revision.includesSagInventory !== "boolean") ||
      (includesInventory && revision.role !== "sag-admin") ||
      (revision.role === "erp-customers" && revision.completeScopes.length > 0)) throw new Error("invalid_catalog_publication");
  const seen = new Set<number>();
  const isErp = revision.role === "erp-customers";
  const rows = revision.rows.map(row => {
    if (!validSqlInt(row.sourceRecordId) || seen.has(row.sourceRecordId) ||
        (row.matchToken !== null && (!Buffer.isBuffer(row.matchToken) || row.matchToken.length !== 32)) ||
        (row.issuerScope !== null && row.matchToken === null) ||
        (isErp && row.issuerScope === null && row.matchToken !== null) ||
        (!isErp && (row.name !== null || row.activeCode !== null)) ||
        (includesInventory !== (row.sagEvidence !== undefined)) ||
        (row.name !== null && (typeof row.name !== "string" || row.name.length > 512 || /\p{Cc}/u.test(row.name))) ||
        !["S", "N", null].includes(row.activeCode)) throw new Error("invalid_catalog_publication");
    seen.add(row.sourceRecordId);
    const { issuer, documentType } = splitScope(row.issuerScope);
    return { sourceRecordId: row.sourceRecordId, issuer, documentType, token: row.matchToken?.toString("hex") ?? null,
      officialName: row.name?.trim() || null, activeCode: row.activeCode, allocationId: isErp ? randomUUID() : null };
  });
  const covered = new Set(revision.completeScopes);
  if (covered.size !== revision.completeScopes.length || (covered.size && rows.some(row => row.issuer === null))) {
    throw new Error("invalid_catalog_publication");
  }
  const scopes = [...covered].map(sc => splitScope(sc));
  const encoded = JSON.stringify(rows);
  const inventory = includesInventory ? JSON.stringify(revision.rows.map(row => {
    const evidence = row.sagEvidence;
    if (!evidence || typeof evidence !== "object") throw new Error("invalid_catalog_publication");
    // The source adapter already applied the reporting-day cutoff. Re-check
    // canonical shape/calendar syntax here and serialize only approved data.
    const normalized = normalizeCatalogSagInventoryEvidence(evidence, "9999-12-31");
    if (evidence.domainCandidate !== normalized.domainCandidate || evidence.environment !== normalized.environment ||
        evidence.testStartedOn !== normalized.testStartedOn || evidence.productionStartedOn !== normalized.productionStartedOn ||
        evidence.demoStartedOn !== normalized.demoStartedOn ||
        (normalized.licenseCodes === null ? evidence.licenseCodes !== null :
          !Array.isArray(evidence.licenseCodes) || evidence.licenseCodes.length !== normalized.licenseCodes.length ||
          evidence.licenseCodes.some((code, i) => code !== normalized.licenseCodes![i]))) {
      throw new Error("invalid_catalog_publication");
    }
    return { sourceRecordId: row.sourceRecordId, domainCandidate: normalized.domainCandidate,
      environmentKind: normalized.environment, licenseCodes: normalized.licenseCodes?.join("") ?? null,
      testStartedOn: normalized.testStartedOn, productionStartedOn: normalized.productionStartedOn, demoStartedOn: normalized.demoStartedOn };
  })) : null;
  if (Buffer.byteLength(encoded, "utf8") + Buffer.byteLength(inventory ?? "", "utf8") > maxPayloadBytes) {
    throw new Error("invalid_catalog_publication");
  }
  return { rows: encoded, scopes: JSON.stringify(scopes), inventory };
}

function bindStamp(request: sql.Request, stamp: Stamp): sql.Request {
  return request.input("environment", sql.VarChar(10), stamp.environment)
    .input("sourceId", sql.UniqueIdentifier, stamp.sourceId)
    .input("profileRevision", sql.VarBinary(8), Buffer.from(stamp.profileRevision, "hex"))
    .input("bindingRevision", sql.VarBinary(8), Buffer.from(stamp.bindingRevision, "hex"))
    .input("attemptOrdinal", sql.VarChar(19), stamp.attemptOrdinal)
    .input("matchKeyVersion", sql.SmallInt, stamp.matchKeyVersion)
    .input("observedAt", sql.DateTime2(3), stamp.observedAt);
}

/** Supply a separately authorized Portal SQL loader pool; never use the HTTP runtime or a source connection. */
export function createSqlCatalogCustomerSnapshotPublisher(
  pool: Pick<sql.ConnectionPool, "transaction">,
  { freshnessMinutes = 30, operator }: { freshnessMinutes?: number; operator?: CatalogPublicationOperator } = {},
): CatalogRefreshSink {
  if (!Number.isInteger(freshnessMinutes) || freshnessMinutes < 1 || freshnessMinutes > 1440) {
    throw new Error("invalid_catalog_publication");
  }
  if (operator && (!operator.id?.trim() || operator.id.length > 150 || !validStamp({ ...operator,
    observedAt: new Date(), attemptOrdinal: "1" }))) throw new Error("invalid_catalog_publication");
  function assertOperatorScope(stamp: Stamp) {
    if (operator && (operator.sourceId !== stamp.sourceId || operator.environment !== stamp.environment ||
      operator.bindingRevision !== stamp.bindingRevision || operator.profileRevision !== stamp.profileRevision ||
      operator.matchKeyVersion !== stamp.matchKeyVersion)) throw new Error("invalid_catalog_publication");
  }
  async function transaction<T>(work: (request: sql.Request, current: sql.Transaction) => Promise<T>): Promise<T> {
    let current: sql.Transaction | undefined;
    try {
      current = pool.transaction();
      await current.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      if (operator) {
        const allowed = await current.request().input("actorId", sql.NVarChar(150), operator.id)
          .input("source", sql.UniqueIdentifier, operator.sourceId).input("environment", sql.VarChar(10), operator.environment)
          .input("binding", sql.VarBinary(8), Buffer.from(operator.bindingRevision, "hex"))
          .input("profile", sql.VarBinary(8), Buffer.from(operator.profileRevision, "hex")).query<{ allowed: number }>(`
          SET NOCOUNT ON;
          DECLARE @lockCode int;
          DECLARE @resource nvarchar(255)=N'portal-sag:catalog-customer-publication:'+@environment;
          EXEC @lockCode=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
          IF @lockCode<0 THROW 53320, N'Catalog publication lock unavailable.', 1;
          SELECT 1 AS allowed FROM security.users AS u
          JOIN security.user_roles AS ur ON ur.user_key=u.user_key
          JOIN security.roles AS r ON r.role_id=ur.role_id AND r.active=1
          WHERE u.active=1 AND u.source_id=@actorId
            AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
            AND r.role_id=N'super_admin' AND EXISTS (
              SELECT 1 FROM settings.catalog_source_bindings AS b
              JOIN settings.external_database_connections AS p ON p.external_database_connection_key=b.external_database_connection_key
              WHERE b.source_id=@source AND b.portal_environment=@environment AND b.source_state='active'
                AND b.row_version=@binding AND b.validated_profile_version=@profile AND b.validated_at IS NOT NULL
                AND p.row_version=@profile AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
            );`);
        if (allowed.recordset.length !== 1) throw new Error("catalog_publication_forbidden");
      }
      const result = await work(current.request(), current);
      await current.commit();
      return result;
    } catch {
      try { await current?.rollback(); } catch { /* already rolled back or connection no longer reachable */ }
      // No database errors, query text, keys, connection details or customer data cross the worker boundary.
      throw new Error("catalog_publication_failed");
    }
  }
  return {
    async reserveAttempt() {
      return transaction(async request => {
        const result = await request.query<{ attemptOrdinal: string }>(reserveAttemptBatch);
        const ordinal = result.recordset[0]?.attemptOrdinal;
        if (result.recordset.length !== 1 || !validOrdinal(ordinal)) throw new Error("invalid_catalog_sql_result");
        return ordinal;
      });
    },
    async publish(revision) {
      assertOperatorScope(revision);
      const payload = validateAndSerialize(revision);
      return transaction(async (request, current) => {
        const bound = bindStamp(request, revision)
          .input("sourceRole", sql.VarChar(15), revision.role)
          .input("rows", sql.NVarChar(sql.MAX), payload.rows)
          .input("scopes", sql.NVarChar(sql.MAX), payload.scopes)
          .input("rowCount", sql.Int, revision.rows.length)
          .input("scopeCount", sql.Int, revision.completeScopes.length)
          .input("freshnessMinutes", sql.Int, freshnessMinutes);
        const result = payload.inventory === null
          ? await bound.query<{ result: string }>(publishBatch)
          : await bound.input("inventory", sql.NVarChar(sql.MAX), payload.inventory)
            .query<{ result: string }>(publishWithSagaEvidenceBatch);
        const status = result.recordset[0]?.result;
        if (result.recordset.length !== 1 || (status !== "published" && status !== "superseded")) {
          throw new Error("invalid_catalog_sql_result");
        }
        if (operator && status === "published") {
          await writeSqlAuditLog(current, {
            entityType: "catalog_source_binding", entityId: revision.sourceId, action: "catalog_source_refreshed",
            performedBy: operator.id, performedByEmail: "system",
            metadata: { environment: revision.environment, sourceRole: revision.role, status },
          });
        }
        return status;
      });
    },
    async recordFailure(attempt) {
      assertOperatorScope(attempt);
      if (!validStamp(attempt)) throw new Error("invalid_catalog_publication");
      await transaction(async request => { await bindStamp(request, attempt).query(failureBatch); });
    },
  };
}
