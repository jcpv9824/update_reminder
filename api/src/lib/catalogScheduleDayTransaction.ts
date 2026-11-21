import sql from "mssql";
import { lockCatalogTaskDay } from "./catalogExecutionCoexistenceSql";
import { readSqlCatalogManualDayIntentsInTransaction } from "./catalogManualDayIntentSqlRepository";
import { catalogRegistrationConflictReason, registerSqlCatalogTaskExecutionInTransaction,
  type CatalogExecutionRegistration, type CatalogExecutionRegistrationResult } from "./catalogExecutionRegistrationSqlRepository";
import { readSqlCatalogPhysicalTargets, readSqlCatalogPhysicalTargetsInTransaction,
  readSqlCatalogPhysicalTargetPinsInTransaction } from "./catalogPhysicalTargetSqlRepository";
import { verifyCatalogSagTargetRuntimeProof } from "./catalogSagTargetRuntimeSqlRepository";
import { loadCatalogSagTargetProofKey } from "./catalogSagTargetProofKey";
import type { CatalogInventoryProofScope } from "./catalogScheduleInventory";
import type { CatalogOneTimeScheduleObservation } from "./catalogScheduleDay";
import { readSqlCatalogSchedulePopulationCoverageInTransaction } from "./catalogSchedulePopulationCoverage";
import { readSqlCatalogScheduleRosterInTransaction } from "./schedulingSqlRepository";
import { catalogScheduleRosterToken } from "./catalogScheduleActivation";
import { runSqlTransaction } from "./sqlTransaction";
import { resolveCatalogSchedulePreviewReservations } from "./catalogScheduleConflictSelection";
import { readAuthorizedCatalogSourceIdsInTransaction } from "./catalogSourceAccessSqlRepository";
import { readSqlCatalogScheduleOperationApprovalsInTransaction } from "./catalogScheduleOperationApprovalSqlRepository";

export type CatalogScheduleDayTransactionContext = Readonly<{
  date: string; cutoffAt: Date; revisionId: string; scope: CatalogInventoryProofScope;
  roster: ReadonlyMap<string, string>; manualIntents: ReadonlyMap<string, string>;
  matchKeyVersion?: number;
  /** Internally derived from the due and authorized rules, never supplied by a request. */
  sagDatabaseLinkIds?: ReadonlySet<string>;
  /** Authenticated caller for interactive previews only; never from request parameters. */
  previewActorId?: string;
  previewOrigin?: Readonly<{ scheduleId: string; scheduleVersion: string; operationId: string }>;
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
type LinkRequest = Parameters<TransactionIo["resolve"]>[0]["links"][number];
type Target = Awaited<ReturnType<TransactionIo["resolve"]>>[number];
type CoveredLink = CatalogInventoryProofScope["links"][number];
type CoveredDatabase = Pick<Extract<CoveredLink, { kind: "database" }>,
  "linkId" | "customerId" | "domainId" | "databaseId" | "environment">;
const held: Target = Object.freeze({ status: "unverifiable" });
const sameDatabaseLink = (left: LinkRequest, right: CoveredDatabase): boolean =>
  left.kind === "database" && left.linkId === right.linkId && left.customerId === right.customerId &&
  left.domainId === right.domainId && left.databaseId === right.databaseId && left.environment === right.environment;
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
  work: (io: TransactionIo, inspect: (input: Parameters<typeof resolveCatalogSchedulePreviewReservations>[1]) =>
    ReturnType<typeof resolveCatalogSchedulePreviewReservations>, transaction: sql.Transaction,
    proofDeadline: () => Date, tightenDeadline: (until: Date) => void) => Promise<T>,
  observe?: OneTimeObserver): Promise<Result<T>> {
  const { cutoffAt, date, revisionId, roster, scope, manualIntents } = context;
  if (date !== scope.date || !(cutoffAt instanceof Date) || !Number.isFinite(cutoffAt.valueOf()) || roster.size > 5000) {
    return { status: "unverified" };
  }
  const requireSagProof = process.env.PORTAL_CATALOG_SAG_V2_ENABLED?.trim() === "true";
  const { matchKeyVersion } = context;
  const eligible = new Map<string, CoveredDatabase>();
  let key: Buffer | null = null;
  try {
    if (requireSagProof) {
      if (scope.links.length > 5000 || (context.sagDatabaseLinkIds?.size ?? 0) > 5000) return stop("unverified");
      for (const link of scope.links) {
        if (link.kind !== "database" || link.evidence.state !== "verified" || !context.sagDatabaseLinkIds?.has(link.linkId)) continue;
        if (eligible.has(link.linkId)) return stop("unverified");
        const { linkId, customerId, domainId, databaseId, environment } = link;
        eligible.set(linkId, { linkId, customerId, domainId, databaseId, environment });
      }
      if (eligible.size) key = await loadCatalogSagTargetProofKey(scope.portalEnvironment, matchKeyVersion, process.env, cutoffAt.getTime());
    }
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
          actual.some(row => roster.get(row.schedule.id) !== catalogScheduleRosterToken(row))) return stop("unverified");
      const definitionVersions = new Map(actual.map(({ schedule, version }) => [schedule.id, version]));
      if (context.previewOrigin) {
        const origin = context.previewOrigin;
        const versionOnDay = definitionVersions.get(origin.scheduleId);
        if (versionOnDay !== undefined && versionOnDay !== origin.scheduleVersion) return stop("unverified");
        const approvals = await readSqlCatalogScheduleOperationApprovalsInTransaction(transaction, scope.portalEnvironment, [origin]);
        if (approvals.get(origin.scheduleId)?.operationId !== origin.operationId) return stop("unverified");
      }
      const oneTime = new Map(actual.filter(({ schedule, activation }) => activation === undefined && schedule.active && schedule.frequencyType === "once" &&
        schedule.startDate === date).map(({ schedule, version }) => [schedule.id, version]));
      const verified = new Map<string, Map<string, { executionKey: string; operationId: string }>>();
      let observed = false;
      const currentIntents = await readSqlCatalogManualDayIntentsInTransaction(transaction, { date, portalEnvironment: scope.portalEnvironment });
      if (currentIntents.size !== manualIntents.size ||
        [...currentIntents].some(([id, version]) => manualIntents.get(id) !== version)) return stop("unverified");
      await checkClock(transaction, cutoffAt, deadline);
      const resolvedDatabases = new Map<string, Target>();
      const scopedResolve: TransactionIo["resolve"] = async input => {
        if (input.portalEnvironment !== scope.portalEnvironment) return stop("unverified");
        if (!requireSagProof) return readSqlCatalogPhysicalTargetsInTransaction(transaction, input);
        if (input.links.length > 5000 || observed) return stop("unverified");
        const domains = input.links.filter(link => link.kind === "domain");
        const domainTargets = domains.length ? await readSqlCatalogPhysicalTargetsInTransaction(transaction, {
          portalEnvironment: scope.portalEnvironment, links: domains,
        }) : [];
        if (domainTargets.length !== domains.length) return stop("unverified");

        if (key && matchKeyVersion !== undefined) {
          const unresolved = new Map<string, CoveredDatabase>();
          for (const link of input.links) {
            const approved = link.linkId === undefined ? undefined : eligible.get(link.linkId);
            if (approved && sameDatabaseLink(link, approved) && !resolvedDatabases.has(approved.linkId)) {
              unresolved.set(approved.linkId, approved);
            }
          }
          const links = [...unresolved.values()].map(({ linkId, customerId, domainId, databaseId, environment }) =>
            ({ kind: "database" as const, linkId, customerId, domainId, databaseId, environment }));
          const targets = links.length ? await readSqlCatalogPhysicalTargetPinsInTransaction(transaction, {
            portalEnvironment: scope.portalEnvironment, links,
          }) : [];
          if (targets.length !== links.length) return stop("unverified");
          for (const [index, target] of targets.entries()) {
            // The SQL clock still fences commit. Also stop issuing proof RPCs
            // if a large exact selection has already crossed the local cutoff.
            if (Date.now() >= cutoffAt.getTime()) return stop("cutoff");
            const { linkId } = links[index];
            if (target.status === "verified") {
              const proof = await verifyCatalogSagTargetRuntimeProof(transaction, {
                environment: scope.portalEnvironment, purpose: "task", operationalLinkId: linkId,
                physicalLinkId: target.physicalLinkId, physicalTargetId: target.id, matchKeyVersion, reportInstanceId: null,
              }, key);
              if (proof?.targetId === target.id && proof.validUntil instanceof Date &&
                proof.validUntil.getTime() > Date.now()) {
                if (proof.validUntil < deadline) deadline = proof.validUntil;
                resolvedDatabases.set(linkId, { status: "verified", id: proof.targetId });
                continue;
              }
            }
            // A missing physical or SAG row is not certified deletion.
            resolvedDatabases.set(linkId, held);
          }
        }
        let domainIndex = 0;
        return input.links.map(link => {
          if (link.kind === "domain") return domainTargets[domainIndex++];
          const approved = link.linkId === undefined ? undefined : eligible.get(link.linkId);
          return approved && sameDatabaseLink(link, approved) ? resolvedDatabases.get(approved.linkId) ?? held : held;
        });
      };
      const value = await work({
        resolve: scopedResolve,
        register: async registration => {
          if (context.previewActorId) return stop("unverified");
          if (registration.portalEnvironment !== scope.portalEnvironment || registration.task.taskDate !== date ||
              registration.group.occurrenceId !== date || registration.group.revisionId !== revisionId ||
              registration.cutoffAt.valueOf() !== cutoffAt.valueOf() ||
              [...registration.scheduleVersions].some(([id, version]) => definitionVersions.get(id) !== version)) return stop("unverified");
          if (observed) return stop("unverified");
          if (requireSagProof && (registration.group.kind === "database" || registration.task.targetType === "database")) {
            if (registration.group.kind !== "database" || registration.task.targetType !== "database" ||
              registration.matchKeyVersion !== matchKeyVersion || registration.group.sources.length === 0 ||
              registration.group.sources.some(({ link }) => {
                const approved = eligible.get(link.linkId);
                const resolved = resolvedDatabases.get(link.linkId);
                return !approved || !sameDatabaseLink(link, approved) || resolved?.status !== "verified" ||
                  resolved.id !== registration.group.targetId;
              })) return stop("unverified");
          }
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
      }, async input => {
        if (input.taskDate !== date || input.cutoffAt.getTime() !== cutoffAt.getTime()) return null;
        if (context.previewActorId) {
          const allowed = await readAuthorizedCatalogSourceIdsInTransaction(transaction, {
            actorId: context.previewActorId, environment: scope.portalEnvironment,
          });
          const records = new Map(scope.links.map(link => [link.linkId, link.evidence]));
          for (const group of [...input.plan.tasks, ...input.plan.conflicts]) {
            for (const { link } of group.sources) {
              const evidence = records.get(link.linkId);
              if (evidence?.state !== "verified" || !allowed.has(evidence.sourceId)) return null;
            }
          }
        }
        return resolveCatalogSchedulePreviewReservations(transaction, input);
      }, transaction, () => new Date(deadline.getTime()), until => {
        if (!(until instanceof Date) || !Number.isFinite(until.getTime())) return stop("unverified");
        if (until < deadline) deadline = new Date(until.getTime());
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
  } finally {
    key?.fill(0);
  }
}
