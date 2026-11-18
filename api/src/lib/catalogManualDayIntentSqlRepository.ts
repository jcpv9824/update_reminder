import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

type Scope = { portalEnvironment: CatalogEnvironment; date: string };
type Intent = { scheduleId: string; scheduleVersion: string };
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 150 && value === value.trim() && !/\p{C}/u.test(value);
const isVersion = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
const validScope = (scope: Scope) => (scope.portalEnvironment === "qa" || scope.portalEnvironment === "production") &&
  /^\d{4}-\d{2}-\d{2}$/.test(scope.date) && Number.isFinite(Date.parse(scope.date)) &&
  new Date(scope.date).toISOString().slice(0, 10) === scope.date;
const invalid = (): never => { throw new Error("catalog_manual_intent_invalid"); };
const unavailable = (): never => { throw new Error("catalog_manual_intent_unavailable"); };

export const readCatalogManualDayIntentsSql = `
SELECT TOP (5001) s.source_id AS scheduleId,
  LOWER(CONVERT(char(16),i.schedule_version,2)) AS scheduleVersion
FROM scheduling.catalog_manual_day_intents i WITH (HOLDLOCK)
JOIN scheduling.update_schedules s WITH (HOLDLOCK) ON s.schedule_key=i.schedule_key AND s.row_version=i.schedule_version
JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK)
  ON a.portal_environment=i.portal_environment AND a.schedule_key=i.schedule_key AND a.schedule_version=i.schedule_version
  AND a.retired_at IS NULL AND a.approved_at<=SYSUTCDATETIME()
WHERE i.portal_environment=@portalEnvironment AND DATALENGTH(i.portal_environment)=DATALENGTH(@portalEnvironment)
  AND i.task_date=@taskDate AND s.active=1 AND s.deleted_at IS NULL AND s.frequency_type='manual'
  AND s.start_date<=@taskDate AND (s.end_date IS NULL OR s.end_date>=@taskDate)
ORDER BY i.schedule_key;
`;

export async function readSqlCatalogManualDayIntentsInTransaction(transaction: sql.Transaction, scope: Scope):
  Promise<ReadonlyMap<string, string>> {
  if (!validScope(scope)) return invalid();
  try {
    const { recordset } = await new sql.Request(transaction).input("portalEnvironment", sql.VarChar(10), scope.portalEnvironment)
      .input("taskDate", sql.Date, scope.date).query<Intent>(readCatalogManualDayIntentsSql);
    if (!Array.isArray(recordset) || recordset.length > 5000) return unavailable();
    const intents = new Map<string, string>();
    for (const { scheduleId, scheduleVersion } of recordset) {
      if (!isId(scheduleId) || !isVersion(scheduleVersion) || intents.has(scheduleId)) return unavailable();
      intents.set(scheduleId, scheduleVersion);
    }
    return intents;
  } catch { return unavailable(); }
}

export async function readSqlCatalogManualDayIntents(scope: Scope): Promise<ReadonlyMap<string, string>> {
  if (!validScope(scope)) return invalid();
  return runSqlTransaction(transaction => readSqlCatalogManualDayIntentsInTransaction(transaction, scope));
}

const appendSql = `
SET NOCOUNT ON;
DECLARE @now datetime2(3)=SYSUTCDATETIME();
IF @now>=@cutoffAt THROW 54780,N'Manual schedule cutoff has passed.',1;
DECLARE @requested TABLE (schedule_key bigint NOT NULL PRIMARY KEY, schedule_version binary(8) NOT NULL);
INSERT @requested
SELECT s.schedule_key,s.row_version
FROM OPENJSON(@schedules) WITH (id nvarchar(150), version char(16)) wanted
JOIN scheduling.update_schedules s WITH (HOLDLOCK)
  ON s.source_id COLLATE Latin1_General_100_BIN2=wanted.id COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(s.source_id)=DATALENGTH(wanted.id)
  AND s.row_version=TRY_CONVERT(binary(8),wanted.version,2)
JOIN scheduling.catalog_schedule_operation_approvals approved WITH (HOLDLOCK)
  ON approved.schedule_key=s.schedule_key AND approved.schedule_version=s.row_version
  AND approved.portal_environment=@portalEnvironment AND approved.retired_at IS NULL AND approved.approved_at<=@now
WHERE s.active=1 AND s.deleted_at IS NULL AND s.frequency_type='manual'
  AND s.start_date<=@taskDate AND (s.end_date IS NULL OR s.end_date>=@taskDate);
IF (SELECT COUNT(*) FROM @requested)<>@expectedCount
  THROW 54781,N'Manual schedule selection is no longer current and approved.',1;
DECLARE @actor bigint;
SELECT @actor=u.user_key FROM security.users u WITH (HOLDLOCK)
WHERE u.source_id=@actorId AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(u.source_id)=DATALENGTH(@actorId) AND u.active=1;
IF @actor IS NULL THROW 54782,N'Manual schedule actor is no longer active.',1;
INSERT scheduling.catalog_manual_day_intents(portal_environment,task_date,schedule_key,schedule_version,requested_by)
SELECT @portalEnvironment,@taskDate,r.schedule_key,r.schedule_version,@actor FROM @requested r
WHERE NOT EXISTS (
  SELECT 1 FROM scheduling.catalog_manual_day_intents i WITH (UPDLOCK,HOLDLOCK)
  WHERE i.portal_environment=@portalEnvironment AND i.task_date=@taskDate
    AND i.schedule_key=r.schedule_key AND i.schedule_version=r.schedule_version
);
IF SYSUTCDATETIME()>=@cutoffAt THROW 54780,N'Manual schedule cutoff has passed.',1;
SELECT COUNT(*) AS accepted FROM @requested;`;

/**
 * Future HTTP caller must enforce the existing generate-task authorization for
 * this actor before calling. Accepts exact version selections only; scheduling
 * intent is not task creation, a license grant, or authorization to read data.
 */
export async function appendSqlCatalogManualDayIntents(scope: Scope & {
  actorId: string; cutoffAt: Date; selected: readonly Intent[];
}): Promise<void> {
  if (!validScope(scope) || !isId(scope.actorId) || !(scope.cutoffAt instanceof Date) ||
    !Number.isFinite(scope.cutoffAt.valueOf()) || !Array.isArray(scope.selected) || scope.selected.length < 1 ||
    scope.selected.length > 100 || scope.selected.some(row => !row || !isId(row.scheduleId) || !isVersion(row.scheduleVersion)) ||
    new Set(scope.selected.map(row => row.scheduleId)).size !== scope.selected.length) return invalid();
  try {
    await runSqlTransaction(async transaction => {
      const { recordset } = await new sql.Request(transaction)
        .input("portalEnvironment", sql.VarChar(10), scope.portalEnvironment).input("taskDate", sql.Date, scope.date)
        .input("actorId", sql.NVarChar(150), scope.actorId).input("cutoffAt", sql.DateTime2(3), scope.cutoffAt)
        .input("expectedCount", sql.Int, scope.selected.length)
        .input("schedules", sql.NVarChar(sql.MAX), JSON.stringify(scope.selected.map(row =>
          ({ id: row.scheduleId, version: row.scheduleVersion }))))
        .query<{ accepted: number }>(appendSql);
      if (recordset?.length !== 1 || recordset[0].accepted !== scope.selected.length) return unavailable();
    });
  } catch { return unavailable(); }
}
