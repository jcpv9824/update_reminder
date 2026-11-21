/** Schedule lifecycle, independent of task status and of untrusted browser timestamps. */
export type ScheduledTargetEvidence = Readonly<{
  linkId: string;
  state: "eligible" | "absent" | "unverifiable";
}>;

export type ScheduleActivationEvidence = Readonly<{
  /** Must describe the entire authorized scope to turn omission into absence. */
  complete: boolean;
  /** Effective time of this server-side observation, not when a worker received it. */
  observedAt: number;
  validUntil?: number;
  targets: readonly ScheduledTargetEvidence[];
}>;

export type ScheduleActivation = Readonly<{
  startDate: string;
  createdAt: number;
  phase?: "planning" | "frozen" | "held" | "cancelled";
  frozenAt?: number;
  observedAt?: number;
  members: readonly ScheduledTargetEvidence[];
}>;

const bogotaOffset = 5 * 3_600_000;
const limit = 5000;
const compareId = (a: string, b: string): number => a === b ? 0 : a < b ? -1 : 1;
const validTime = (time: unknown): time is number => typeof time === "number" && Number.isSafeInteger(time);
function invalid(): never { throw new Error("catalog_schedule_activation_invalid"); }

export function scheduleActivationAt(date: string, createdAt: number): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validTime(createdAt)) return invalid();
  const utc = Date.parse(`${date}T00:00:00.000Z`);
  if (!validTime(utc) || new Date(utc).toISOString().slice(0, 10) !== date) return invalid();
  // A same-day copy never imports anything from the original's frozen cohort.
  return Math.max(utc + bogotaOffset, createdAt);
}

function byLink(rows: readonly ScheduledTargetEvidence[]) {
  if (!Array.isArray(rows) || rows.length > limit) return invalid();
  const result = new Map<string, ScheduledTargetEvidence["state"]>();
  for (const row of rows) {
    if (!row || !row.linkId || row.linkId !== row.linkId.trim() || row.linkId.length > 260 ||
        /\p{C}/u.test(row.linkId) || !["eligible", "absent", "unverifiable"].includes(row.state) || result.has(row.linkId)) return invalid();
    result.set(row.linkId, row.state);
  }
  return result;
}

/** Reconcile one versioned definition; the caller supplies complete/as-of evidence and persists it atomically. */
export function reconcileScheduleActivation(
  current: ScheduleActivation, checkedAt: number, evidence?: ScheduleActivationEvidence,
): ScheduleActivation {
  const activationAt = scheduleActivationAt(current.startDate, current.createdAt);
  if (!validTime(checkedAt) || checkedAt < current.createdAt) return invalid();
  if (current.frozenAt !== undefined) {
    if (current.frozenAt !== activationAt || !current.phase || current.phase === "planning") return invalid();
    return current;
  }
  if (current.phase && current.phase !== "planning") return invalid();
  const activated = checkedAt >= activationAt;
  const boundary = Math.min(checkedAt, activationAt);
  const members = byLink(current.members);
  const observed = evidence ? byLink(evidence.targets) : undefined;
  if (evidence && (!validTime(evidence.observedAt) || evidence.observedAt > checkedAt ||
      typeof evidence.complete !== "boolean" || (evidence.validUntil !== undefined &&
        (!validTime(evidence.validUntil) || evidence.validUntil <= evidence.observedAt)))) return invalid();
  if (current.observedAt !== undefined && (!validTime(current.observedAt) || current.observedAt > boundary)) return invalid();
  const fresh = evidence && evidence.observedAt >= current.createdAt &&
    evidence.observedAt <= boundary && evidence.observedAt >= (current.observedAt ?? -Infinity) &&
    (evidence.validUntil === undefined ? evidence.observedAt === boundary : evidence.validUntil > boundary);
  if (!activated && !fresh) return current;
  const proven = fresh ? observed : undefined;
  const complete = Boolean(fresh && evidence?.complete);
  // Do not accept fresh-looking eligibility from a partial/failed scan.
  // Persist explicitly observed negatives and unknowns, not just members seen on an earlier pass.
  if (complete && proven) for (const [link, state] of proven) members.set(link, state);
  if (members.size > limit) return invalid();
  for (const link of members.keys()) members.set(link, complete ? proven?.get(link) ?? "absent" : "unverifiable");
  const next = [...members.entries()].sort(([a], [b]) => compareId(a, b)).map(([linkId, state]) => ({ linkId, state }));
  const phase = !activated ? "planning" : next.some(row => row.state === "eligible") ? "frozen"
    : complete && !next.some(row => row.state === "unverifiable") ? "cancelled" : "held";
  return { ...current, phase, members: next, ...(fresh && evidence && { observedAt: evidence.observedAt }),
    ...(activated && { frozenAt: activationAt }) };
}
import { createHash } from "node:crypto";
import type { CatalogScheduleRosterRow } from "./schedulingSqlRepository";

/** Snapshot commits do not change the parent version used by operation approvals. */
export function catalogScheduleRosterToken(row: Pick<CatalogScheduleRosterRow, "version" | "activation" | "copyLinks" | "draftOrigin" | "draftLinks">): string {
  return row.activation === undefined && row.copyLinks === undefined && row.draftOrigin === undefined ? row.version : createHash("sha256")
    .update(JSON.stringify(row.draftOrigin ? [row.version, row.activation, row.copyLinks, row.draftOrigin, row.draftLinks]
      : [row.version, row.activation, row.copyLinks])).digest("hex");
}
