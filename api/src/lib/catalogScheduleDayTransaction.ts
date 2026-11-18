import sql from "mssql";
import { lockCatalogTaskDay } from "./catalogExecutionCoexistenceSql";
import { readSqlCatalogManualDayIntentsInTransaction } from "./catalogManualDayIntentSqlRepository";
import { catalogRegistrationConflictReason, registerSqlCatalogTaskExecutionInTransaction,
  type CatalogExecutionRegistration, type CatalogExecutionRegistrationResult } from "./catalogExecutionRegistrationSqlRepository";
import { readSqlCatalogPhysicalTargets, readSqlCatalogPhysicalTargetsInTransaction } from "./catalogPhysicalTargetSqlRepository";
import type { CatalogInventoryProofScope } from "./catalogScheduleInventory";
import type { CatalogOneTimeScheduleObservation } from "./catalogScheduleDay";
import { readSqlCatalogSchedulePopulationCoverageInTransaction } from "./catalogSchedulePopulationCoverage";
import { readSqlCatalogScheduleRosterInTransaction } from "./schedulingSqlRepository";
import { runSqlTransaction } from "./sqlTransaction";

export type CatalogScheduleDayTransactionContext = Readonly<{
  date: string; cutoffAt: Date; revisionId: string; scope: CatalogInventoryProofScope;
  roster: ReadonlyMap<string, string>; manualIntents: ReadonlyMap<string, string>;
}>;
type TransactionIo = {
  resolve: typeof readSqlCatalogPhysicalTargets;
  register: (input: CatalogExecutionRegistration) => Promise<CatalogExecutionRegistrationResult>;
  observeOneTimeSchedules?: (items: readonly CatalogOneTimeScheduleObservation[]) => Promise<void>;
};
type OneTimeObserver = (transaction: sql.Transaction, context: CatalogScheduleDayTransactionContext,
  items: readonly CatalogOneTimeScheduleObservation[], validUntil: Date) => Promise<void>;
type Stop = "cutoff" | "unverified";
type Result<T> = { status: "committed"; value: T } | { status: Stop };
class DayStop extends Error { constructor(readonly status: Stop) { super(status); } }
const stop = (status: Stop): never => { throw new DayStop(status); };
const clockSql = `
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  SELECT CASE WHEN @now>=@cutoffAt THEN 'cutoff'
    WHEN @now>=@validUntil THEN 'unverified' ELSE 'valid' END AS status;`;
async function checkClock(transaction: sql.Transaction, cutoffAt: Date, validUntil: Date) {
  const result = await new sql.Request(transaction).input("cutoffAt", sql.DateTime2(3), cutoffAt)
    .input("validUntil", sql.DateTime2(3), validUntil).query<{ status: "cutoff" | "unverified" | "valid" }>(clockSql);
  const status = result.recordset[0]?.status;
  if (status !== "valid") return stop(status === "cutoff" ? "cutoff" : "unverified");
}

/**
 * Owns the whole day's transaction. `work` may compute in-memory and use the
 * provided SQL delegates only; source network I/O must finish first. Re-read
 * the certified population, including previously held edges, under SERIALIZABLE
 * before any tasks. Keep both task-day locks until the whole batch commits.
 */
export async function runSqlCatalogScheduleDayTransaction<T>(context: CatalogScheduleDayTransactionContext,
  work: (io: TransactionIo) => Promise<T>, observe?: OneTimeObserver): Promise<Result<T>> {
  const { cutoffAt, date, revisionId, roster, scope, manualIntents } = context;
  if (date !== scope.date || !(cutoffAt instanceof Date) || !Number.isFinite(cutoffAt.valueOf()) || roster.size > 5000) {
    return { status: "unverified" };
  }
  try {
    return await runSqlTransaction(async transaction => {
      // Other task writers already acquire this lock before relation locks.
      // A batch that spans both kinds always acquires them in the same order.
      for (const targetType of ["database", "domain"] as const) {
        if (!await lockCatalogTaskDay(transaction, { taskDate: date, targetType })) return stop("unverified");
      }
      const coverage = await readSqlCatalogSchedulePopulationCoverageInTransaction(transaction, scope);
      if (!coverage.complete || coverage.id !== revisionId) return stop("unverified");
      let deadline = coverage.validUntil;
      const actual = await readSqlCatalogScheduleRosterInTransaction(transaction, date);
      if (actual.length !== roster.size || new Set(actual.map(row => row.schedule.id)).size !== roster.size ||
          actual.some(row => roster.get(row.schedule.id) !== row.version)) return stop("unverified");
      const oneTime = new Map(actual.filter(({ schedule }) => schedule.active && schedule.frequencyType === "once" &&
        schedule.startDate === date).map(({ schedule, version }) => [schedule.id, version]));
      const verified = new Map<string, Map<string, { executionKey: string; operationId: string }>>();
      let observed = false;
      const currentIntents = await readSqlCatalogManualDayIntentsInTransaction(transaction, { date, portalEnvironment: scope.portalEnvironment });
      if (currentIntents.size !== manualIntents.size ||
        [...currentIntents].some(([id, version]) => manualIntents.get(id) !== version)) return stop("unverified");
      await checkClock(transaction, cutoffAt, deadline);
      const value = await work({
        resolve: input => input.portalEnvironment === scope.portalEnvironment
          ? readSqlCatalogPhysicalTargetsInTransaction(transaction, input) : stop("unverified"),
        register: async registration => {
          if (registration.portalEnvironment !== scope.portalEnvironment || registration.task.taskDate !== date ||
              registration.group.occurrenceId !== date || registration.group.revisionId !== revisionId ||
              registration.cutoffAt.valueOf() !== cutoffAt.valueOf() ||
              [...registration.scheduleVersions].some(([id, version]) => roster.get(id) !== version)) return stop("unverified");
          if (observed) return stop("unverified");
          const verifyOneTimeExpectation = observe !== undefined && [...registration.scheduleVersions.keys()].some(id => oneTime.has(id));
          const { outcome, validUntil } = await registerSqlCatalogTaskExecutionInTransaction(transaction, registration, {
            replayMode: "certified-day", ...(verifyOneTimeExpectation ? { verifyOneTimeExpectation: true as const } : {}),
          });
          if ((outcome.status === "registered" || outcome.oneTimeExpectationVerified) &&
            (!(validUntil instanceof Date) || !Number.isFinite(validUntil.valueOf()))) {
            return stop("unverified");
          }
          if (validUntil && validUntil < deadline) deadline = validUntil;
          if (verifyOneTimeExpectation && outcome.oneTimeExpectationVerified && outcome.taskId === registration.task.id) {
            for (const { scheduleId, link } of registration.group.sources) {
              if (!oneTime.has(scheduleId)) continue;
              const byLink = verified.get(scheduleId) ?? new Map();
              const candidate = { executionKey: registration.group.executionKey, operationId: registration.group.operationId };
              const prior = byLink.get(link.linkId);
              if (prior && (prior.executionKey !== candidate.executionKey || prior.operationId !== candidate.operationId)) return stop("unverified");
              byLink.set(link.linkId, candidate);
              verified.set(scheduleId, byLink);
            }
          }
          return outcome;
        },
        ...(observe ? { observeOneTimeSchedules: async (items: readonly CatalogOneTimeScheduleObservation[]) => {
          if (observed || items.length !== oneTime.size || new Set(items.map(item => item.scheduleId)).size !== oneTime.size) {
            return stop("unverified");
          }
          for (const item of items) {
            if (oneTime.get(item.scheduleId) !== item.scheduleVersion) return stop("unverified");
            if (item.pairs === null) continue;
            const byLink = verified.get(item.scheduleId);
            if (!byLink || !item.pairs.length || item.pairs.length !== byLink.size ||
                new Set(item.pairs.map(pair => pair.linkId)).size !== byLink.size || item.pairs.some(pair => {
                  const proof = byLink.get(pair.linkId);
                  return !proof || proof.executionKey !== pair.executionKey || proof.operationId !== item.operationId;
                })) return stop("unverified");
          }
          observed = true;
          if (items.length) await observe(transaction, context, items, deadline);
        } } : {}),
      });
      if (observe && oneTime.size && !observed) return stop("unverified");
      await checkClock(transaction, cutoffAt, deadline);
      return { status: "committed", value };
    });
  } catch (error) {
    if (error instanceof DayStop) return { status: error.status };
    const reason = catalogRegistrationConflictReason(error);
    if (reason) return { status: reason === "cutoff-passed" ? "cutoff" : "unverified" };
    throw error;
  }
}
