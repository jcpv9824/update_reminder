import sql from "mssql";
import { readCatalogTaskExecution, type CatalogExecutionSnapshot } from "./catalogExecutionSqlRepository";
import { persistCatalogTaskCutoffCheck } from "./catalogExecutionReconcileSqlRepository";
import { catalogTaskCutoffEvidenceSql } from "./catalogTaskCutoffEvidenceSql";
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
/** Preserve the original cutoff even when a normal source refresh occurs before this sweep. */
export async function readCatalogTaskCutoffEvidence(transaction: sql.Transaction, snapshot: CatalogExecutionSnapshot, environment: CatalogEnvironment) {
  const result = await transaction.request().input("env", sql.VarChar(10), environment)
    .input("execution", sql.VarBinary(32), Buffer.from(snapshot.executionKey, "hex")).query<EvidenceRow>(catalogTaskCutoffEvidenceSql);
  return result.recordset;
}

const defaultIo = { queue: readQueue, transaction: runSqlTransaction, snapshot: readCatalogTaskExecution,
  evidence: readCatalogTaskCutoffEvidence, persist: persistCatalogTaskCutoffCheck };

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
        if (!snapshot || snapshot.workflowStatus === "completed" || snapshot.workflowStatus === "cancelled" ||
          snapshot.occurrence.state !== "open" || snapshot.occurrence.cutoffEvaluatedAt !== undefined) return "unchanged";
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
