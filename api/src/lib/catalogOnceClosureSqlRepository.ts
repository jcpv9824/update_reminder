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

/** A short cursor transaction reserves a fair keyset page, never the day proof locks. */
export const reserveCatalogOnceClosureCandidatesSql = `
SET NOCOUNT ON;
DECLARE @after bigint;
SELECT @after=last_observation_key FROM scheduling.catalog_once_closure_scan_cursors WITH (UPDLOCK,HOLDLOCK)
WHERE portal_environment=@portalEnvironment;
IF @after IS NULL THROW 55004,N'The catalog closure cursor is not installed.',1;
DECLARE @now datetime2(3)=SYSUTCDATETIME();
DECLARE @chosen TABLE(observation_key bigint PRIMARY KEY,task_date date NOT NULL);
INSERT @chosen
SELECT TOP (@take) o.observation_key,o.task_date
FROM scheduling.catalog_once_observations o WITH (HOLDLOCK)
JOIN scheduling.update_schedules s WITH (HOLDLOCK)
  ON s.schedule_key=o.schedule_key AND s.row_version=o.schedule_version AND s.active=1 AND s.deleted_at IS NULL
  AND s.completed_at IS NULL AND s.frequency_type='once' AND s.start_date=o.task_date
WHERE o.portal_environment=@portalEnvironment AND o.cutoff_at<=@now
  AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_once_observations newer WITH (HOLDLOCK)
    WHERE newer.portal_environment=o.portal_environment AND newer.task_date=o.task_date
      AND newer.schedule_key=o.schedule_key AND newer.schedule_version=o.schedule_version AND newer.observation_key>o.observation_key)
ORDER BY CASE WHEN o.observation_key>@after THEN 0 ELSE 1 END,o.observation_key;
DECLARE @last bigint=(SELECT TOP (1) observation_key FROM @chosen
  ORDER BY CASE WHEN observation_key>@after THEN 0 ELSE 1 END DESC,observation_key DESC);
UPDATE scheduling.catalog_once_closure_scan_cursors SET last_observation_key=COALESCE(@last,0),updated_at=SYSUTCDATETIME()
WHERE portal_environment=@portalEnvironment;
SELECT @portalEnvironment AS portalEnvironment,CONVERT(char(10),task_date,23) AS taskDate,
  CONVERT(varchar(20),observation_key) AS observationKey FROM @chosen
ORDER BY CASE WHEN observation_key>@after THEN 0 ELSE 1 END,observation_key;`;

export async function reserveSqlCatalogOnceClosureCandidates(portalEnvironment: CatalogEnvironment,
  take: number): Promise<CatalogOnceClosureCandidate[]> {
  if ((portalEnvironment !== "qa" && portalEnvironment !== "production") || !Number.isInteger(take) || take < 1 || take > 50) {
    throw new Error("catalog_once_candidates_invalid");
  }
  return runSqlTransaction(async transaction => {
    const result = await new sql.Request(transaction).input("portalEnvironment", sql.VarChar(10), portalEnvironment)
      .input("take", sql.Int, take).query<CatalogOnceClosureCandidate>(reserveCatalogOnceClosureCandidatesSql);
    return result.recordset;
  });
}
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
