import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { lockCatalogTaskDay } from "./catalogExecutionCoexistenceSql";
import { readCatalogOnceClosureProofSql } from "./catalogOnceClosureSql";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";

export type CatalogOnceClosureCandidate = Readonly<{
  portalEnvironment: CatalogEnvironment;
  taskDate: string;
  /** Decimal text is lossless for SQL bigint, unlike a JavaScript number. */
  observationKey: string;
}>;
type ProofRow = { scheduleId: string; scheduleVersion: string; clientId: string };
const maxSqlBigInt = 9223372036854775807n;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 150 &&
  value === value.trim() && !/\p{C}/u.test(value);
const completedReason = "one_time_schedule_executed";

export const completeCatalogOnceScheduleSql = `
DECLARE @stamp datetime2(3)=SYSUTCDATETIME();
UPDATE s SET active=0,completed_at=@stamp,completed_reason=N'one_time_schedule_executed',
  updated_at=@stamp,updated_by=N'system'
FROM scheduling.update_schedules s
JOIN scheduling.catalog_once_observations o ON o.schedule_key=s.schedule_key
  AND o.observation_key=@observationKey AND o.portal_environment=@portalEnvironment
  AND o.task_date=@taskDate AND o.schedule_version=s.row_version AND o.pair_count>0
WHERE s.source_id=@scheduleId AND DATALENGTH(s.source_id)=DATALENGTH(@scheduleId)
  AND s.source_id COLLATE Latin1_General_100_BIN2=@scheduleId COLLATE Latin1_General_100_BIN2
  AND s.row_version=TRY_CONVERT(binary(8),@scheduleVersion,2)
  AND s.active=1 AND s.frequency_type='once' AND s.start_date=@taskDate AND s.deleted_at IS NULL
  AND s.completed_at IS NULL AND o.cutoff_at<=SYSUTCDATETIME();
SELECT @@ROWCOUNT AS changed;`;

/** Internal repository only. A stale/blocked candidate must not fall back to another observation. */
export async function completeSqlCatalogOnceSchedule(candidate: CatalogOnceClosureCandidate): Promise<boolean> {
  const { portalEnvironment, taskDate, observationKey } = candidate;
  if ((portalEnvironment !== "qa" && portalEnvironment !== "production") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(taskDate) || !Number.isFinite(Date.parse(taskDate)) ||
      new Date(taskDate).toISOString().slice(0, 10) !== taskDate ||
      typeof observationKey !== "string" || !/^[1-9][0-9]{0,18}$/.test(observationKey) ||
      BigInt(observationKey) > maxSqlBigInt) throw new Error("catalog_once_closure_candidate_invalid");

  return runSqlTransaction(async transaction => {
    for (const targetType of ["database", "domain"] as const) {
      if (!await lockCatalogTaskDay(transaction, { taskDate, targetType })) return false;
    }
    const request = () => new sql.Request(transaction)
      .input("portalEnvironment", sql.VarChar(10), portalEnvironment)
      .input("taskDate", sql.Date, taskDate).input("observationKey", sql.BigInt, observationKey);
    const { recordset } = await request().query<ProofRow>(readCatalogOnceClosureProofSql);
    if (recordset.length === 0) return false;
    const { scheduleId, scheduleVersion, clientId } = recordset[0];
    if (recordset.length !== 1 || !id(scheduleId) || !id(clientId) ||
      typeof scheduleVersion !== "string" || !/^[0-9a-f]{16}$/.test(scheduleVersion)) {
      throw new Error("catalog_once_closure_proof_invalid");
    }
    const update = await request().input("scheduleId", sql.NVarChar(150), scheduleId)
      .input("scheduleVersion", sql.Char(16), scheduleVersion).query<{ changed: number }>(completeCatalogOnceScheduleSql);
    if (update.recordset.length === 1 && update.recordset[0].changed === 0) return false;
    if (update.recordset.length !== 1 || update.recordset[0].changed !== 1) throw new Error("catalog_once_closure_update_invalid");
    await writeSqlAuditLog(transaction, {
      entityType: "schedule", entityId: scheduleId, clientId, action: "schedule_one_time_completed",
      performedBy: "system", performedByEmail: "system",
      metadata: { reason: completedReason, runDate: taskDate, scheduleId, observationId: observationKey },
    });
    return true;
  });
}
