import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSqlPool } from "./sql";

export type CatalogScheduleOperationApproval = Readonly<{ operationId: string; scheduleVersion: string }>;
type ExpectedSchedule = Readonly<{ scheduleId: string; scheduleVersion: string }>;
const fail = (): never => { throw new Error("catalog_schedule_operation_approval_unavailable"); };
const validVersion = (version: unknown): version is string =>
  typeof version === "string" && version.length === 16 && /^[0-9a-f]{16}$/.test(version);
const validSchedule = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 150
  && id === id.trim() && !/\p{C}/u.test(id);
export const isCatalogScheduleOperationId = (id: unknown): id is string => typeof id === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) && id === id.trim();

/** Must be rerun under the registration transaction before any new execution is persisted. */
export const readCatalogScheduleOperationApprovalsSql = `
SELECT s.source_id AS scheduleId,
  LOWER(CONVERT(char(16),CONVERT(binary(8),s.row_version),2)) AS scheduleVersion,
  a.operation_id AS operationId
FROM OPENJSON(@expectedSchedules) WITH (id nvarchar(150), version char(16)) AS expected
JOIN scheduling.update_schedules AS s ON s.source_id=expected.id
  AND s.source_id COLLATE Latin1_General_100_BIN2=expected.id COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(s.source_id)=DATALENGTH(expected.id)
  AND s.row_version=TRY_CONVERT(binary(8),expected.version,2)
JOIN scheduling.catalog_schedule_operation_approvals AS a
  ON a.schedule_key=s.schedule_key AND a.schedule_version=s.row_version
  AND a.portal_environment=@portalEnvironment AND a.retired_at IS NULL
WHERE s.active=1 AND s.deleted_at IS NULL AND a.approved_at<=SYSUTCDATETIME()
ORDER BY s.schedule_key;
`.trim();

/** Service-only. An absent approval is unknown, not permission to invent an operation. */
export async function readSqlCatalogScheduleOperationApprovals(
  portalEnvironment: CatalogEnvironment,
  roster: readonly ExpectedSchedule[],
): Promise<ReadonlyMap<string, CatalogScheduleOperationApproval>> {
  if (!["qa", "production"].includes(portalEnvironment) || !Array.isArray(roster) || roster.length > 5000) return fail();
  const expected = new Map<string, string>();
  for (const { scheduleId, scheduleVersion } of roster) {
    if (!validSchedule(scheduleId) || !validVersion(scheduleVersion) || expected.has(scheduleId)) return fail();
    expected.set(scheduleId, scheduleVersion);
  }
  if (!expected.size) return new Map();
  try {
    const { recordset } = await (await getSqlPool()).request()
      .input("portalEnvironment", sql.VarChar(10), portalEnvironment)
      .input("expectedSchedules", sql.NVarChar(sql.MAX), JSON.stringify([...expected].map(([id, version]) => ({ id, version }))))
      .query<Record<string, unknown>>(readCatalogScheduleOperationApprovalsSql);
    if (!Array.isArray(recordset) || recordset.length > expected.size) return fail();
    const approvals = new Map<string, CatalogScheduleOperationApproval>();
    for (const { scheduleId, scheduleVersion, operationId } of recordset) {
      if (!validSchedule(scheduleId) || !validVersion(scheduleVersion) || expected.get(scheduleId) !== scheduleVersion
        || approvals.has(scheduleId) || !isCatalogScheduleOperationId(operationId)) return fail();
      approvals.set(scheduleId, { scheduleVersion, operationId });
    }
    return approvals;
  } catch { return fail(); }
}
