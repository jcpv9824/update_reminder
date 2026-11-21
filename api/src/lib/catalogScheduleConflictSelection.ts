import type sql from "mssql";
import type { CatalogTaskKind, CatalogTaskPlan } from "./catalogTaskTargetPlanning";
import { inspectCatalogExecutionReservationsInTransaction } from "./catalogExecutionRegistrationSqlRepository";

/** Internal projection from an authorized, versioned preview; never use arbitrary browser labels as identity. */
export type ScheduleConflictCandidate = Readonly<{
  linkId: string;
  targetId: string | null;
  kind: "domain" | "database";
  state: "ready" | "conflict" | "unverifiable";
}>;

const physicalKey = (row: ScheduleConflictCandidate) => JSON.stringify([row.kind, row.targetId]);

/** Builds a fresh manual draft selection. Does not update the source schedule or persist the draft. */
export function prepareRemainingCatalogSelection(rows: readonly ScheduleConflictCandidate[]): {
  status: "ready" | "empty"; linkIds: string[];
} {
  const invalid = () => new Error("catalog_schedule_conflict_preview_invalid");
  if (!Array.isArray(rows) || rows.length > 5000) throw invalid();
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.linkId !== "string" || !row.linkId.trim() || row.linkId.length > 260 ||
      seen.has(row.linkId) || !["domain", "database"].includes(row.kind) ||
      !["ready", "conflict", "unverifiable"].includes(row.state) ||
      (row.state !== "unverifiable" && (typeof row.targetId !== "string" || !row.targetId.trim()))) throw invalid();
    seen.add(row.linkId);
    if (row.state === "conflict") conflicts.add(physicalKey(row));
  }
  const linkIds = rows.filter(row => row.state === "ready" && !conflicts.has(physicalKey(row))).map(row => row.linkId).sort();
  return { status: linkIds.length ? "ready" : "empty", linkIds };
}

/**
 * Connect the planner's authorized projection to the same reservation check as generation.
 * Internal only. The caller owns authorization, consistent evidence and lock ordering.
 * No task details or identities from an existing reservation are returned to the caller.
 */
export async function resolveCatalogSchedulePreviewReservations(transaction: sql.Transaction, input: Readonly<{
  taskDate: string;
  cutoffAt: Date;
  plan: CatalogTaskPlan;
  scopeIncomplete?: boolean;
  workflowRoleFor: (scheduleId: string, kind: CatalogTaskKind) => string | undefined;
}>, inspect = inspectCatalogExecutionReservationsInTransaction): Promise<Readonly<{
  coverage: "verified" | "partial";
  heldLinkIds: readonly string[];
  candidates: readonly ScheduleConflictCandidate[];
  remaining: ReturnType<typeof prepareRemainingCatalogSelection>;
}> | null> {
  const { taskDate, cutoffAt, plan, workflowRoleFor } = input;
  if (!plan.ready) return null;
  const candidates = [];
  for (const group of plan.tasks) {
    if (group.occurrenceId !== taskDate || !group.sources.length) return null;
    const roles = new Set(group.sources.map(source => workflowRoleFor(source.scheduleId, group.kind)));
    const [workflowRole] = roles;
    if (roles.size !== 1 || !workflowRole || group.assignment.kind === "unassigned" ||
        (group.assignment.kind === "role" && group.assignment.id !== workflowRole)) return null;
    candidates.push({ kind: group.kind, physicalId: group.targetId, operationId: group.operationId,
      targetIds: [...new Set(group.sources.map(({ link }) => link.databaseId ?? link.domainId))],
      workflowRole, assignment: group.assignment });
  }
  const statuses = await inspect(transaction, { taskDate, cutoffAt, candidates });
  if (!statuses || statuses.length !== candidates.length ||
      statuses.some(status => status !== "unoccupied" && status !== "compatible_reservation" && status !== "conflict")) return null;
  const results = new Map<string, ScheduleConflictCandidate>();
  function add(row: ScheduleConflictCandidate) {
    const current = results.get(row.linkId);
    if (current && (current.kind !== row.kind || current.targetId !== row.targetId)) return false;
    if (current?.state !== "conflict") results.set(row.linkId, row);
    return true;
  }
  for (const [index, group] of plan.tasks.entries()) {
    if (!group.sources.every(source => add({ linkId: source.link.linkId, targetId: group.targetId, kind: group.kind,
      state: statuses[index] === "conflict" ? "conflict" : "ready" }))) return null;
  }
  for (const group of plan.conflicts) {
    if (group.occurrenceId !== taskDate || !group.sources.every(source => add({ linkId: source.link.linkId,
      targetId: group.targetId, kind: group.kind, state: "conflict" }))) return null;
  }
  // A link held anywhere in the proposed scope cannot silently become a ready selection.
  for (const hold of plan.held) {
    const row = results.get(hold.linkId);
    if (row?.state === "ready") results.set(hold.linkId, { ...row, state: "unverifiable" });
  }
  const links = [...results.values()];
  const heldLinkIds = [...new Set(plan.held.map(hold => hold.linkId))].sort();
  return { coverage: input.scopeIncomplete || heldLinkIds.length ? "partial" : "verified", heldLinkIds,
    candidates: links, remaining: prepareRemainingCatalogSelection(links) };
}
