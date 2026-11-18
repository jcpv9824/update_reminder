import sql from "mssql";
import type { CatalogOneTimeScheduleObservation } from "./catalogScheduleDay";
import type { CatalogScheduleDayTransactionContext } from "./catalogScheduleDayTransaction";
import { isCatalogScheduleOperationId } from "./catalogScheduleOperationApprovalSqlRepository";
import { catalogPopulationRevisionPrefix } from "./catalogSchedulePopulationCoverage";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const zeroUuid = "00000000-0000-0000-0000-000000000000";
const version = /^[0-9a-f]{16}$/;
const execution = /^[0-9a-f]{64}$/;
const dayAndBogotaOffset = 29 * 3_600_000;
const validInstant = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.valueOf());
const invalid = (): never => { throw new Error("catalog_once_observation_invalid"); };

/**
 * No independent transaction or HTTP caller: the day owner has already
 * fenced the roster and witnessed the exact pairs. SQL independently checks
 * the day locks, live approvals and references before appending.
 */
export async function recordSqlCatalogOnceObservationsInTransaction(
  transaction: sql.Transaction,
  context: CatalogScheduleDayTransactionContext,
  items: readonly CatalogOneTimeScheduleObservation[],
  validUntil: Date,
): Promise<void> {
  const { date, cutoffAt, revisionId, scope, roster } = context;
  const { portalEnvironment, checkedAt } = scope;
  const dayStart = Date.parse(date);
  const populationId = revisionId.startsWith(catalogPopulationRevisionPrefix)
    ? revisionId.slice(catalogPopulationRevisionPrefix.length) : "";
  if ((portalEnvironment !== "qa" && portalEnvironment !== "production") ||
    typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dayStart) ||
    new Date(dayStart).toISOString().slice(0, 10) !== date || scope.date !== date ||
    !validInstant(cutoffAt) || cutoffAt.valueOf() !== dayStart + dayAndBogotaOffset ||
    !validInstant(checkedAt) || !validInstant(validUntil) || checkedAt >= cutoffAt || checkedAt >= validUntil ||
    !uuid.test(populationId) || populationId === zeroUuid || !Array.isArray(items) || items.length < 1 || items.length > 5000) {
    return invalid();
  }
  let totalPairs = 0;
  const seen = new Set<string>();
  const normalized = (items as readonly CatalogOneTimeScheduleObservation[]).map(item => {
    if (!item || typeof item.scheduleId !== "string" || item.scheduleId.length < 1 || item.scheduleId.length > 150 ||
      item.scheduleId !== item.scheduleId.trim() || /\p{C}/u.test(item.scheduleId) || seen.has(item.scheduleId) ||
      typeof item.scheduleVersion !== "string" || !version.test(item.scheduleVersion) ||
      roster.get(item.scheduleId) !== item.scheduleVersion || !isCatalogScheduleOperationId(item.operationId)) return invalid();
    seen.add(item.scheduleId);
    let pairs: CatalogOneTimeScheduleObservation["pairs"] = null;
    if (item.pairs !== null) {
      if (!Array.isArray(item.pairs) || !item.pairs.length || item.pairs.length > 5000) return invalid();
      totalPairs += item.pairs.length;
      if (totalPairs > 20000) return invalid();
      const links = new Set<string>();
      pairs = (item.pairs as NonNullable<CatalogOneTimeScheduleObservation["pairs"]>).map(pair => {
        if (!pair || typeof pair.linkId !== "string" || !uuid.test(pair.linkId) || pair.linkId === zeroUuid ||
          links.has(pair.linkId) || typeof pair.executionKey !== "string" || !execution.test(pair.executionKey)) return invalid();
        links.add(pair.linkId);
        return { linkId: pair.linkId, executionKey: pair.executionKey };
      });
    }
    return { scheduleId: item.scheduleId, scheduleVersion: item.scheduleVersion, operationId: item.operationId, pairs };
  });
  const observations = JSON.stringify(normalized);
  if (Buffer.byteLength(observations, "utf16le") > 8 * 1024 * 1024) return invalid();
  const { recordset } = await new sql.Request(transaction)
    .input("portalEnvironment", sql.VarChar(10), portalEnvironment)
    .input("taskDate", sql.Date, date).input("cutoffAt", sql.DateTime2(3), cutoffAt)
    .input("validUntil", sql.DateTime2(3), validUntil).input("populationId", sql.UniqueIdentifier, populationId)
    .input("observations", sql.NVarChar(sql.MAX), observations)
    .execute<{ accepted: number }>("scheduling.record_catalog_once_observations");
  if (!Array.isArray(recordset) || recordset.length !== 1 || recordset[0]?.accepted !== items.length) {
    throw new Error("catalog_once_observation_not_recorded");
  }
}
