import sql from "mssql";
import { readCatalogTaskExecution, type CatalogExecutionSnapshot } from "./catalogExecutionSqlRepository";
import { persistCatalogTaskCutoffCheck } from "./catalogExecutionReconcileSqlRepository";
import { catalogDomainRouteFingerprintSql } from "./catalogPhysicalTargetIdentity";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import type { CatalogTaskObservation } from "./catalogTaskTargetPlanning";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";

const BATCH = 32;
async function readQueue(environment: CatalogEnvironment): Promise<string[]> {
  const result = await (await getSqlPool()).request().input("env", sql.VarChar(10), environment)
    .input("take", sql.Int, BATCH).query<{ executionKey: string }>(`
    DECLARE @now datetime2(3)=SYSUTCDATETIME();
    SELECT TOP (@take) LOWER(CONVERT(varchar(64),e.execution_key,2)) AS executionKey
    FROM workflow.catalog_task_executions e
    JOIN workflow.update_tasks task ON task.task_key=e.task_key
    JOIN core.catalog_physical_targets target ON target.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id)
      AND target.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2 AND target.portal_environment=@env
    WHERE e.retired_at IS NULL AND e.cutoff_evaluated_at IS NULL AND task.status NOT IN ('completed','cancelled')
      AND (e.last_checked_at IS NULL OR (e.cutoff_at<=@now AND e.last_checked_at<e.cutoff_at)
        OR e.last_checked_at<=DATEADD(minute,-5,@now))
    ORDER BY CASE WHEN e.cutoff_at<=@now THEN 0 ELSE 1 END,
      CASE WHEN e.cutoff_at<=@now THEN e.cutoff_at ELSE e.last_checked_at END, e.catalog_execution_key;`);
  return result.recordset.map(row => row.executionKey);
}

type EvidenceRow = { linkId: string; checkedAt: Date; effectiveAt: Date; validUntil: Date | null };
/** Current history can prove a positive at cutoff only when it was actually registered by then. */
async function readEvidence(transaction: sql.Transaction, snapshot: CatalogExecutionSnapshot, environment: CatalogEnvironment) {
  const result = await transaction.request().input("env", sql.VarChar(10), environment)
    .input("execution", sql.VarBinary(32), Buffer.from(snapshot.executionKey, "hex")).query<EvidenceRow>(`
    DECLARE @checkedAt datetime2(3)=SYSUTCDATETIME();
    SELECT l.link_id AS linkId, @checkedAt AS checkedAt, boundary.as_of AS effectiveAt, proof.valid_until AS validUntil
    FROM workflow.catalog_task_executions e
    JOIN core.catalog_physical_targets target ON target.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id)
      AND target.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2 AND target.portal_environment=@env
    JOIN workflow.catalog_task_execution_links l ON l.catalog_execution_key=e.catalog_execution_key
    CROSS APPLY (VALUES(CASE WHEN e.cutoff_at<@checkedAt THEN e.cutoff_at ELSE @checkedAt END)) boundary(as_of)
    JOIN core.clients c ON c.client_key=l.client_key
    JOIN core.domains d ON d.domain_key=l.domain_key AND d.client_key=l.client_key
    LEFT JOIN core.databases db ON db.database_key=l.database_key AND db.client_key=l.client_key AND db.domain_key=l.domain_key
    LEFT JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key
    OUTER APPLY (
      SELECT TOP (1) t.valid_until FROM core.catalog_physical_target_links t
      WHERE t.portal_environment=@env AND t.physical_target_key=target.physical_target_key
        AND t.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2
        AND t.client_key=l.client_key AND t.domain_key=l.domain_key AND t.verified_at<=boundary.as_of
        AND t.registered_at<=boundary.as_of AND target.created_at<=boundary.as_of AND t.valid_until>boundary.as_of
        AND t.retired_at IS NULL AND l.created_at<=boundary.as_of AND c.status='active' AND d.status='active'
        AND ((e.execution_kind='domain' AND t.database_key IS NULL AND d.environment_id=l.link_environment
          AND t.domain_route_fingerprint=${catalogDomainRouteFingerprintSql})
          OR (e.execution_kind='database' AND t.database_key=l.database_key AND db.status='active'
            AND db.environment_id=l.link_environment AND p.active=1 AND t.access_profile_key=p.access_profile_key
            AND t.access_profile_version=p.row_version
            AND target.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.initial_catalog))))
        AND (l.catalog_source_key IS NULL OR EXISTS (
          SELECT 1 FROM settings.catalog_source_bindings b
          JOIN settings.external_database_connections profile ON profile.external_database_connection_key=b.external_database_connection_key
          JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key
          JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
          JOIN core.catalog_customer_revision_rows data ON data.revision_key=r.revision_key
          WHERE b.catalog_source_key=l.catalog_source_key AND b.portal_environment=@env AND b.source_state='active'
            AND b.validated_at<=boundary.as_of AND b.validated_profile_version=profile.row_version
            AND profile.status='active' AND profile.active=1 AND profile.encrypt_connection=1 AND profile.password_configured=1
            AND h.attempt_status='succeeded' AND h.attempted_at<=boundary.as_of
            AND r.sealed_at<=boundary.as_of AND r.observed_at<=boundary.as_of AND r.verified_until>boundary.as_of
            AND r.binding_version=b.row_version AND r.profile_version=profile.row_version
            AND data.source_record_id=TRY_CONVERT(int,l.catalog_record_id)
            AND CONVERT(nvarchar(11),data.source_record_id) COLLATE Latin1_General_100_BIN2=l.catalog_record_id
            AND DATALENGTH(CONVERT(nvarchar(11),data.source_record_id))=DATALENGTH(l.catalog_record_id)
            AND (b.source_role<>'erp-customers' OR data.active_code='S')
        ))
      ORDER BY t.registered_at DESC,t.physical_target_link_key DESC
    ) proof
    WHERE e.execution_key=@execution;`);
  return result.recordset;
}

const defaultIo = { queue: readQueue, transaction: runSqlTransaction, snapshot: readCatalogTaskExecution,
  evidence: readEvidence, persist: persistCatalogTaskCutoffCheck };

export async function runCatalogTaskCutoffSweep(io = defaultIo, env: NodeJS.ProcessEnv = process.env) {
  if (env.PORTAL_CATALOG_CUTOFF_ENABLED?.trim() !== "true") return null;
  const environment = env.PORTAL_SAG_ENVIRONMENT?.trim();
  if (environment !== "qa" && environment !== "production") throw new Error("catalog_cutoff_environment_invalid");
  const batch = await io.queue(environment);
  const result = { updated: 0, skipped: 0, failed: 0 };
  for (const executionKey of batch) {
    try {
      const status = await io.transaction(async tx => {
        const snapshot = await io.snapshot({ executionKey }, tx);
        if (!snapshot || snapshot.occurrence.state !== "open" || snapshot.occurrence.cutoffEvaluatedAt !== undefined) return "unchanged";
        const rows = await io.evidence(tx, snapshot, environment);
        const checkedAt = rows[0]?.checkedAt.valueOf();
        const ids = new Set(rows.map(row => row.linkId));
        if (checkedAt === undefined || !Number.isSafeInteger(checkedAt) || rows.length !== snapshot.links.length ||
          ids.size !== rows.length || !snapshot.links.every(link => ids.has(link.linkId))) throw new Error("catalog_cutoff_evidence_incomplete");
        const asOf = Math.min(checkedAt, snapshot.occurrence.cutoffAt);
        const observations = rows.map((row): CatalogTaskObservation => {
          if (row.checkedAt.valueOf() !== checkedAt || row.effectiveAt.valueOf() !== asOf ||
            (row.validUntil !== null && (!Number.isSafeInteger(row.validUntil.valueOf()) || row.validUntil.valueOf() <= asOf))) {
            throw new Error("catalog_cutoff_evidence_invalid");
          }
          return row.validUntil === null ? { linkId: row.linkId, observedAt: asOf, status: "unverifiable" }
            : { linkId: row.linkId, observedAt: asOf, status: "verified", targetId: snapshot.occurrence.targetId, validUntil: row.validUntil.valueOf() };
        });
        return io.persist({ snapshot, checkedAt, observations }, tx);
      });
      result[status === "updated" ? "updated" : "skipped"]++;
    } catch { result.failed++; }
  }
  return result;
}
