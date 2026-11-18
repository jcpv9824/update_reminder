import sql from "mssql";
import { writeSqlAuditLog } from "./auditSqlWriter";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

export type CatalogRefreshScope = { environment: CatalogEnvironment; actorId: string; sourceIds?: readonly string[] };
export type CatalogRefreshSettings = { environment: CatalogEnvironment; matchKeyVersion: number; includeSag: boolean };
export type CatalogRefreshClaim = Readonly<{
  jobId: string; workerId: string; leaseToken: string; attempt: number; sourceId: string;
  environment: CatalogEnvironment; bindingRevision: string; profileRevision: string; matchKeyVersion: number;
}>;
export type CatalogRefreshStatus = {
  pending: boolean; items: { sourceId: string; status: "queued" | "processing" | "retry" | "succeeded" | "failed"; updatedAt: string }[];
};

// Queue transitions and publication acquire the same lock before examining versions or jobs.
export const catalogRefreshPublicationLockSql = `
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  DECLARE @lockCode int;
  DECLARE @resource nvarchar(255)=N'portal-sag:catalog-customer-publication:'+@environment;
  EXEC @lockCode=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
  IF @lockCode<0 THROW 53320,N'Catalog publication lock unavailable.',1;
`;

// All names are fixed. The same SQL eligibility predicate fences jobs and publisher transactions.
export const currentCertifiedCatalogSourceSql = `b.source_state='active'
  AND ((b.source_role='erp-customers' AND b.contract_version='erp_v1')
    OR (b.source_role='sag-admin' AND b.contract_version='sag_admin_v1'))
  AND b.validated_at IS NOT NULL AND b.validated_profile_version=p.row_version
  AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1`;

const sourceJoin = `JOIN settings.external_database_connections AS p
  ON p.external_database_connection_key=b.external_database_connection_key`;

const authorizedScopeSql = `
  DECLARE @actorKey bigint;
  SELECT @actorKey=u.user_key FROM security.users AS u
  WHERE u.source_id=@actorId AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2 AND u.active=1;

  DECLARE @selected TABLE(source_id uniqueidentifier NOT NULL PRIMARY KEY);
  INSERT @selected(source_id) SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@sourceIds);
  DECLARE @scope TABLE(catalog_source_key bigint NOT NULL PRIMARY KEY,source_id uniqueidentifier NOT NULL);
  INSERT @scope(catalog_source_key,source_id)
  SELECT b.catalog_source_key,b.source_id FROM settings.catalog_source_bindings AS b
  WHERE b.portal_environment=@environment AND b.source_role='erp-customers' AND b.source_state='active'
    AND (@sourceIds IS NULL OR EXISTS(SELECT 1 FROM @selected AS selection WHERE selection.source_id=b.source_id))
    AND (EXISTS(SELECT 1 FROM security.catalog_source_readers AS reader
          WHERE reader.user_key=@actorKey AND reader.catalog_source_key=b.catalog_source_key AND reader.revoked_at IS NULL)
      OR EXISTS(SELECT 1 FROM security.user_roles AS ur JOIN security.roles AS r ON r.role_id=ur.role_id AND r.active=1
          WHERE ur.user_key=@actorKey AND r.role_id=N'super_admin'));

  DECLARE @allowed bit=CASE WHEN @actorKey IS NULL OR EXISTS(
    SELECT 1 FROM @selected AS selection WHERE NOT EXISTS(SELECT 1 FROM @scope AS scope WHERE scope.source_id=selection.source_id)
  ) THEN 0 ELSE 1 END;
`;

const retrySecondsSql = `CASE j.attempt_no WHEN 1 THEN 30 WHEN 2 THEN 60 WHEN 3 THEN 120 WHEN 4 THEN 240 ELSE 300 END`;

// Reap expired/stale jobs in bounded batches; no profile is ever written or reactivated.
const reapJobsSql = (requestedOnly: boolean) => `
  DECLARE @reaped TABLE(job_key bigint NOT NULL,attempt_no tinyint NOT NULL,attempt_ordinal bigint NULL,
    event_kind varchar(12) NOT NULL);
  ;WITH stale AS (
    SELECT ${requestedOnly ? "" : "TOP (50) "}j.job_key FROM settings.catalog_source_refresh_jobs AS j
    WHERE j.portal_environment=@environment AND j.finished_at IS NULL${requestedOnly ? `
      AND (EXISTS(SELECT 1 FROM @scope AS s WHERE s.catalog_source_key=j.catalog_source_key)
        OR (@includeSag=1 AND EXISTS(SELECT 1 FROM settings.catalog_source_bindings AS b
          WHERE b.catalog_source_key=j.catalog_source_key AND b.portal_environment=@environment AND b.source_role='sag-admin'
            AND b.source_state='active')))` : ""} AND NOT EXISTS(
      SELECT 1 FROM settings.catalog_source_bindings AS b ${sourceJoin}
      WHERE b.catalog_source_key=j.catalog_source_key AND b.portal_environment=@environment
        AND b.row_version=j.binding_version AND p.row_version=j.profile_version AND j.match_key_version=@matchKeyVersion
        AND (b.source_role<>'sag-admin' OR @includeSag=1) AND ${currentCertifiedCatalogSourceSql})
    ${requestedOnly ? "" : "ORDER BY j.job_key"}
  )
  UPDATE j SET job_status='cancelled',updated_at=@now,finished_at=@now,attempt_ordinal=NULL,
    worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
  OUTPUT inserted.job_key,inserted.attempt_no,deleted.attempt_ordinal,'stale' INTO @reaped
  FROM settings.catalog_source_refresh_jobs AS j JOIN stale ON stale.job_key=j.job_key;

  ${requestedOnly ? "" : `;WITH expired AS (
    SELECT TOP (50) j.job_key FROM settings.catalog_source_refresh_jobs AS j
    WHERE j.portal_environment=@environment AND j.finished_at IS NULL AND j.job_status='processing'
      AND j.lease_expires_at<=@now
    ORDER BY j.lease_expires_at,j.job_key
  )
  UPDATE j SET job_status=CASE WHEN j.attempt_no>=5 THEN 'failed' ELSE 'retry' END,updated_at=@now,
    finished_at=CASE WHEN j.attempt_no>=5 THEN @now ELSE NULL END,
    available_at=DATEADD(second,${retrySecondsSql},j.lease_expires_at),
    attempt_ordinal=NULL,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
  OUTPUT inserted.job_key,inserted.attempt_no,deleted.attempt_ordinal,'expired' INTO @reaped
  FROM settings.catalog_source_refresh_jobs AS j JOIN expired ON expired.job_key=j.job_key;`}

  INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,attempt_ordinal,event_kind,occurred_at)
  SELECT job_key,attempt_no,attempt_ordinal,event_kind,@now FROM @reaped;
`;

const enqueueRequestSql = `${catalogRefreshPublicationLockSql}${authorizedScopeSql}
  IF @allowed=0 BEGIN SELECT @allowed AS allowed,0 AS accepted,0 AS coalesced; RETURN; END;
  IF NOT EXISTS(SELECT 1 FROM @scope) BEGIN SELECT @allowed AS allowed,0 AS accepted,0 AS coalesced; RETURN; END;

  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  ${reapJobsSql(true)}
  DECLARE @eligible TABLE(catalog_source_key bigint NOT NULL PRIMARY KEY,source_role varchar(15) NOT NULL,
    binding_version binary(8) NOT NULL,profile_version binary(8) NOT NULL);
  INSERT @eligible(catalog_source_key,source_role,binding_version,profile_version)
  SELECT b.catalog_source_key,b.source_role,b.row_version,p.row_version
  FROM settings.catalog_source_bindings AS b ${sourceJoin}
  WHERE b.portal_environment=@environment AND ${currentCertifiedCatalogSourceSql}
    AND ((b.source_role='sag-admin' AND @includeSag=1)
      OR EXISTS(SELECT 1 FROM @scope AS scope WHERE scope.catalog_source_key=b.catalog_source_key));

  DECLARE @coalesced int=(SELECT COUNT(*) FROM @eligible AS e JOIN settings.catalog_source_refresh_jobs AS j
    ON j.catalog_source_key=e.catalog_source_key AND j.finished_at IS NULL
    WHERE e.source_role='erp-customers' AND j.binding_version=e.binding_version AND j.profile_version=e.profile_version
      AND j.match_key_version=@matchKeyVersion);
  DECLARE @inserted TABLE(catalog_source_key bigint NOT NULL PRIMARY KEY);
  INSERT settings.catalog_source_refresh_jobs(catalog_source_key,portal_environment,binding_version,profile_version,
    match_key_version,provenance,requested_by,job_status,requested_at,updated_at,available_at)
  OUTPUT inserted.catalog_source_key INTO @inserted
  SELECT e.catalog_source_key,@environment,e.binding_version,e.profile_version,@matchKeyVersion,
    'request',@actorId,'queued',@now,@now,@now FROM @eligible AS e
  WHERE NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs AS j
    WHERE j.catalog_source_key=e.catalog_source_key AND j.finished_at IS NULL);
  SELECT @allowed AS allowed,@coalesced AS coalesced,COUNT(*) AS accepted
  FROM @inserted AS i JOIN @eligible AS e ON e.catalog_source_key=i.catalog_source_key AND e.source_role='erp-customers';
`;

const enqueueDueSql = `${catalogRefreshPublicationLockSql}
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  ${reapJobsSql(false)}
  INSERT settings.catalog_source_refresh_jobs(catalog_source_key,portal_environment,binding_version,profile_version,
    match_key_version,provenance,job_status,requested_at,updated_at,available_at)
  SELECT TOP (50) b.catalog_source_key,@environment,b.row_version,p.row_version,@matchKeyVersion,
    'timer','queued',@now,@now,@now
  FROM settings.catalog_source_bindings AS b ${sourceJoin}
  LEFT JOIN settings.catalog_customer_revision_heads AS h ON h.catalog_source_key=b.catalog_source_key
  LEFT JOIN core.catalog_customer_source_revisions AS r ON r.revision_key=h.revision_key
    AND r.binding_version=b.row_version AND r.profile_version=p.row_version AND r.match_key_version=@matchKeyVersion
  OUTER APPLY (
    SELECT TOP (1) j.binding_version,j.profile_version,j.match_key_version,j.job_status,j.finished_at
    FROM settings.catalog_source_refresh_jobs AS j WHERE j.catalog_source_key=b.catalog_source_key
    ORDER BY j.job_key DESC
  ) AS lastJob
  WHERE b.portal_environment=@environment AND ${currentCertifiedCatalogSourceSql}
    AND (b.source_role<>'sag-admin' OR @includeSag=1)
    AND (r.revision_key IS NULL OR h.attempted_at<=DATEADD(minute,-5,@now))
    AND NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs AS j
      WHERE j.catalog_source_key=b.catalog_source_key AND j.finished_at IS NULL)
    AND (lastJob.finished_at IS NULL OR lastJob.finished_at<=DATEADD(minute,-5,@now) OR lastJob.job_status='cancelled'
      OR lastJob.binding_version<>b.row_version OR lastJob.profile_version<>p.row_version OR lastJob.match_key_version<>@matchKeyVersion)
  ORDER BY CASE WHEN b.source_role='sag-admin' THEN 0 ELSE 1 END,b.catalog_source_key;
  SELECT @@ROWCOUNT AS enqueued;
`;

const claimSql = `${catalogRefreshPublicationLockSql}
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  ${reapJobsSql(false)}
  DECLARE @claimed TABLE(job_key bigint NOT NULL,attempt_no tinyint NOT NULL);
  ;WITH eligible AS (
    SELECT TOP (@count) j.job_key FROM settings.catalog_source_refresh_jobs AS j
    JOIN settings.catalog_source_bindings AS b ON b.catalog_source_key=j.catalog_source_key ${sourceJoin}
    WHERE j.portal_environment=@environment AND b.portal_environment=@environment AND j.finished_at IS NULL
      AND j.job_status IN ('queued','retry') AND j.attempt_no<5 AND j.available_at<=@now
      AND j.binding_version=b.row_version AND j.profile_version=p.row_version AND j.match_key_version=@matchKeyVersion
      AND (b.source_role<>'sag-admin' OR @includeSag=1) AND ${currentCertifiedCatalogSourceSql}
    ORDER BY j.available_at,j.job_key
  )
  UPDATE j SET job_status='processing',updated_at=@now,attempt_no=j.attempt_no+1,
    worker_id=@workerId,lease_token=NEWID(),lease_expires_at=DATEADD(second,120,@now)
  OUTPUT inserted.job_key,inserted.attempt_no INTO @claimed
  FROM settings.catalog_source_refresh_jobs AS j JOIN eligible ON eligible.job_key=j.job_key;

  INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,event_kind,occurred_at)
  SELECT job_key,attempt_no,'claimed',@now FROM @claimed;

  SELECT CONVERT(char(36),j.job_id) AS jobId,CONVERT(char(36),j.worker_id) AS workerId,
    CONVERT(char(36),j.lease_token) AS leaseToken,j.attempt_no AS attempt,CONVERT(char(36),b.source_id) AS sourceId,
    j.portal_environment AS environment,j.binding_version AS bindingRevision,j.profile_version AS profileRevision,
    j.match_key_version AS matchKeyVersion
  FROM @claimed AS c JOIN settings.catalog_source_refresh_jobs AS j ON j.job_key=c.job_key
  JOIN settings.catalog_source_bindings AS b ON b.catalog_source_key=j.catalog_source_key
  ORDER BY j.job_key;
`;

// Exact claim and source pin. No "status=processing" check alone is sufficient.
export const catalogRefreshFenceSql = `j.job_id=@jobId AND j.worker_id=@workerId AND j.lease_token=@leaseToken
  AND j.attempt_no=@jobAttempt AND j.job_status='processing' AND j.finished_at IS NULL
  AND j.portal_environment=@environment AND b.source_id=@source AND b.portal_environment=@environment
  AND j.binding_version=@binding AND j.profile_version=@profile AND j.match_key_version=@currentKeyVersion`;

const completeSql = (publication: boolean) => `${publication ? "SET NOCOUNT ON;" : catalogRefreshPublicationLockSql}
  IF @outcome IS NULL OR @outcome NOT IN (${publication ? "'succeeded','superseded'" : "'retry','stale'"})
    THROW 55105,N'Catalog refresh completion outcome is invalid.',1;
  DECLARE @jobKey bigint,@leaseUntil datetime2(3);
  SELECT @jobKey=j.job_key,@leaseUntil=j.lease_expires_at
  FROM settings.catalog_source_refresh_jobs AS j WITH (UPDLOCK,HOLDLOCK)
  JOIN settings.catalog_source_bindings AS b ON b.catalog_source_key=j.catalog_source_key
  WHERE ${catalogRefreshFenceSql}${publication ? " AND j.attempt_ordinal=CONVERT(bigint,@reservedOrdinal)" : ""};
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  IF @jobKey IS NULL OR @leaseUntil<=@now BEGIN SELECT CONVERT(bit,0) AS completed; RETURN; END;

  ${publication ? `DECLARE @verifiedHead bit=0;
  IF EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs AS j
    JOIN settings.catalog_customer_revision_heads AS h ON h.catalog_source_key=j.catalog_source_key
    JOIN core.catalog_customer_source_revisions AS r ON r.revision_key=h.revision_key AND r.catalog_source_key=h.catalog_source_key
    WHERE j.job_key=@jobKey AND h.attempt_status='succeeded' AND r.attempt_ordinal=h.attempt_ordinal
      AND ((@outcome='succeeded' AND h.attempt_ordinal=CONVERT(bigint,@reservedOrdinal))
        OR (@outcome='superseded' AND h.attempt_ordinal>CONVERT(bigint,@reservedOrdinal)))
      AND r.binding_version=@binding AND r.profile_version=@profile AND r.match_key_version=@currentKeyVersion
      AND r.sealed_at IS NOT NULL AND r.observed_at<=@now AND r.verified_until>@now)
    SET @verifiedHead=1;
  IF @outcome='succeeded' AND @verifiedHead=0 THROW 55106,N'Catalog refresh successful head is not verified.',1;` : ""}

  DECLARE @completed TABLE(job_key bigint NOT NULL,attempt_no tinyint NOT NULL,attempt_ordinal bigint NULL,
    event_kind varchar(12) NOT NULL);
  UPDATE j SET job_status=CASE ${publication ? `WHEN @outcome='succeeded' THEN 'succeeded'
      WHEN @outcome='superseded' AND @verifiedHead=1 THEN 'succeeded'` : ""}
      WHEN @outcome IN ('stale','superseded') THEN 'cancelled'
      WHEN j.attempt_no>=5 THEN 'failed' ELSE 'retry' END,
    updated_at=@now,finished_at=CASE WHEN @outcome<>'retry' OR j.attempt_no>=5 THEN @now ELSE NULL END,
    available_at=CASE WHEN @outcome='retry' AND j.attempt_no<5 THEN DATEADD(second,${retrySecondsSql},@now) ELSE j.available_at END,
    attempt_ordinal=NULL,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
  OUTPUT inserted.job_key,inserted.attempt_no,deleted.attempt_ordinal,
    CASE WHEN @outcome='retry' AND inserted.attempt_no>=5 THEN 'failed' ELSE @outcome END INTO @completed
  FROM settings.catalog_source_refresh_jobs AS j WHERE j.job_key=@jobKey;
  INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,attempt_ordinal,event_kind,occurred_at)
  SELECT job_key,attempt_no,attempt_ordinal,event_kind,@now FROM @completed;
  IF @leaseUntil<=SYSUTCDATETIME() THROW 55104,N'Catalog refresh lease expired before commit.',1;
  SELECT CONVERT(bit,1) AS completed;
`;

const statusSql = `SET NOCOUNT ON;${authorizedScopeSql}
  DECLARE @sagPending bit=0;
  IF @allowed=1 AND @includeSag=1 AND EXISTS(SELECT 1 FROM @scope) AND EXISTS(
    SELECT 1 FROM settings.catalog_source_bindings AS b ${sourceJoin}
    JOIN settings.catalog_source_refresh_jobs AS j ON j.catalog_source_key=b.catalog_source_key
    WHERE b.portal_environment=@environment AND b.source_role='sag-admin' AND j.portal_environment=@environment
      AND j.finished_at IS NULL AND j.binding_version=b.row_version AND j.profile_version=p.row_version
      AND ${currentCertifiedCatalogSourceSql}) SET @sagPending=1;
  SELECT @allowed AS allowed,@sagPending AS sagPending;
  SELECT CONVERT(char(36),s.source_id) AS sourceId,
    CASE WHEN j.job_status='cancelled' THEN 'failed' ELSE j.job_status END AS status,j.updated_at AS updatedAt
  FROM @scope AS s CROSS APPLY (
    SELECT TOP (1) j.job_status,j.updated_at FROM settings.catalog_source_refresh_jobs AS j
    WHERE j.catalog_source_key=s.catalog_source_key AND j.portal_environment=@environment ORDER BY j.job_key DESC
  ) AS j WHERE @allowed=1 ORDER BY s.source_id;
`;

const completionSql = completeSql(false);
const completePublicationSql = completeSql(true);

/** The executable fixed batches used by the SQL rehearsal and the repository. */
export const catalogRefreshQueueSqlBatches = { enqueueRequest: enqueueRequestSql, enqueueDue: enqueueDueSql,
  claim: claimSql, complete: completionSql, completePublication: completePublicationSql, status: statusSql } as const;

function scopeParameters(request: sql.Request, input: CatalogRefreshScope) {
  return request.input("actorId", sql.NVarChar(150), input.actorId)
    .input("sourceIds", sql.NVarChar(sql.MAX), input.sourceIds === undefined ? null : JSON.stringify(input.sourceIds));
}

function configurationParameters(request: sql.Request, input: CatalogRefreshSettings) {
  return request.input("environment", sql.VarChar(10), input.environment)
    .input("matchKeyVersion", sql.SmallInt, input.matchKeyVersion).input("includeSag", sql.Bit, input.includeSag);
}

export function bindCatalogRefreshFence(request: sql.Request, claim: CatalogRefreshClaim) {
  return request.input("environment", sql.VarChar(10), claim.environment)
    .input("source", sql.UniqueIdentifier, claim.sourceId)
    .input("binding", sql.VarBinary(8), Buffer.from(claim.bindingRevision, "hex"))
    .input("profile", sql.VarBinary(8), Buffer.from(claim.profileRevision, "hex"))
    .input("currentKeyVersion", sql.SmallInt, claim.matchKeyVersion)
    .input("jobId", sql.UniqueIdentifier, claim.jobId).input("workerId", sql.UniqueIdentifier, claim.workerId)
    .input("leaseToken", sql.UniqueIdentifier, claim.leaseToken).input("jobAttempt", sql.TinyInt, claim.attempt);
}

export function enqueueCatalogRefreshRequest(input: CatalogRefreshScope & CatalogRefreshSettings) {
  return runSqlTransaction(async tx => {
    const { recordset } = await scopeParameters(configurationParameters(tx.request(), input), input)
      .query<{ allowed: boolean; accepted: number; coalesced: number }>(enqueueRequestSql);
    const row = recordset[0];
    if (!row?.allowed) return null;
    const { accepted, coalesced } = row;
    await writeSqlAuditLog(tx, { entityType: "catalog_refresh", entityId: input.environment,
      action: "catalog_refresh_requested", performedBy: input.actorId, performedByEmail: "system", metadata: { accepted, coalesced } });
    return { accepted, coalesced };
  });
}

export function enqueueDueCatalogRefreshSources(input: CatalogRefreshSettings) {
  return runSqlTransaction(async tx => {
    const { recordset } = await configurationParameters(tx.request(), input).query<{ enqueued: number }>(enqueueDueSql);
    return recordset[0].enqueued;
  });
}

export function claimCatalogRefreshJobs(input: CatalogRefreshSettings, workerId: string, count: number): Promise<CatalogRefreshClaim[]> {
  if (count !== 1 && count !== 2) throw new Error("invalid_catalog_refresh_claim_count");
  return runSqlTransaction(async tx => {
    type Row = Omit<CatalogRefreshClaim, "bindingRevision" | "profileRevision"> & { bindingRevision: Buffer; profileRevision: Buffer };
    const { recordset } = await configurationParameters(tx.request(), input)
      .input("workerId", sql.UniqueIdentifier, workerId).input("count", sql.TinyInt, count).query<Row>(claimSql);
    return recordset.map(row => ({ ...row, bindingRevision: row.bindingRevision.toString("hex"), profileRevision: row.profileRevision.toString("hex") }));
  });
}

export function completeCatalogRefreshClaim(claim: CatalogRefreshClaim, outcome: "retry" | "stale") {
  return runSqlTransaction(async tx => {
    const { recordset } = await bindCatalogRefreshFence(tx.request(), claim).input("outcome", sql.VarChar(12), outcome)
      .query<{ completed: boolean }>(completionSql);
    return recordset[0]?.completed === true;
  });
}

/** Only the fenced publication transaction can close a successful job. */
export async function completePublishedCatalogRefresh(tx: sql.Transaction, claim: CatalogRefreshClaim,
  ordinal: string, outcome: "succeeded" | "superseded") {
  const { recordset } = await bindCatalogRefreshFence(tx.request(), claim).input("outcome", sql.VarChar(12), outcome)
    .input("reservedOrdinal", sql.VarChar(19), ordinal).query<{ completed: boolean }>(completePublicationSql);
  if (recordset[0]?.completed !== true) throw new Error("catalog_publication_forbidden");
}

export function readCatalogRefreshStatus(input: CatalogRefreshScope & { includeSag: boolean }): Promise<CatalogRefreshStatus | null> {
  return runSqlTransaction(async tx => {
    const rows = await scopeParameters(tx.request(), input).input("environment", sql.VarChar(10), input.environment)
      .input("includeSag", sql.Bit, input.includeSag).query(statusSql);
    if (!Array.isArray(rows.recordsets) || rows.recordsets.length !== 2) throw new Error("invalid_catalog_refresh_status_result");
    const [visibility, jobs]: [{ allowed: boolean; sagPending: boolean }[],
      { sourceId: string; status: CatalogRefreshStatus["items"][number]["status"]; updatedAt: Date }[]] = [rows.recordsets[0], rows.recordsets[1]];
    if (!visibility[0]?.allowed) return null;
    const items = jobs.map(job => ({ sourceId: job.sourceId.toLowerCase(), status: job.status, updatedAt: job.updatedAt.toISOString() }));
    return { pending: visibility[0].sagPending || items.some(job => ["queued", "processing", "retry"].includes(job.status)), items };
  });
}
