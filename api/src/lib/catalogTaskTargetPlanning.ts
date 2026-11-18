import { createHash } from "node:crypto";
import type { Environment } from "../types/models";

export type CatalogTaskKind = "domain" | "database";
export type CatalogTaskFailure = "not_found" | "unverifiable";
type CatalogTaskTarget = { status: "verified"; id: string } | { status: CatalogTaskFailure };

/**
 * The caller supplies the opaque target identity from the verified destination catalogue.
 * It is deliberately not inferred from the customer, URL text, connection data, or display name.
 */
export type CatalogTaskLink = {
  linkId: string;
  customerId: string;
  domainId: string;
  catalogRecordId: string;
  environment: Environment;
  state: "active" | "inactive" | "unverifiable";
  moduleIds: readonly string[] | null;
  target: CatalogTaskTarget;
} & ({ kind: "domain"; databaseId?: never } | { kind: "database"; databaseId: string });

export type CatalogTaskAssignment =
  | { kind: "unassigned" }
  | { kind: "users"; ids: readonly string[] }
  | { kind: "user" | "role"; id: string };

export type CatalogTaskRequest = {
  scheduleId: string;
  /** Stable identity for compatible work, e.g. the approved release/operation ID. */
  operationId: string;
  assignment: CatalogTaskAssignment;
  scope: {
    kind: CatalogTaskKind;
    customerId?: string;
    domainId?: string;
    environment?: Environment;
    /** If present, the approved fixed set; an empty set does not mean all links. */
    linkIds?: readonly string[];
    excludedLinkIds?: readonly string[];
    modules?: { mode: "all" | "any"; ids: readonly string[] };
  };
};

export type CatalogTaskSource = {
  scheduleId: string;
  operationId: string;
  assignment: CatalogTaskAssignment;
  link: CatalogTaskLink;
};

type CatalogTaskGroup = {
  executionKey: string;
  occurrenceId: string;
  revisionId: string;
  kind: CatalogTaskKind;
  targetId: string;
  sources: CatalogTaskSource[];
};

export type CatalogTaskPlan = {
  ready: boolean;
  tasks: (CatalogTaskGroup & { operationId: string; assignment: CatalogTaskAssignment })[];
  conflicts: (CatalogTaskGroup & {
    reasons: ("incompatible_operation" | "incompatible_assignment")[];
  })[];
  held: {
    scheduleId: string;
    linkId: string;
    reason: "link_not_found" | "link_unverifiable" | "license_unverified" | "target_not_found" | "target_unverifiable";
  }[];
};

const id = (...parts: unknown[]) => JSON.stringify(parts);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function catalogAssignedUsers(assignment: CatalogTaskAssignment): string[] {
  return assignment.kind === "users" ? [...new Set(assignment.ids)].sort(compareText)
    : assignment.kind === "user" ? [assignment.id] : [];
}

export function catalogAssignmentIdentity(assignment: CatalogTaskAssignment): string {
  if (assignment.kind === "user" || assignment.kind === "users") return id("users", catalogAssignedUsers(assignment));
  return id(assignment.kind, assignment.kind === "unassigned" ? null : assignment.id);
}

/** Does not vary by catalogue revision, schedule, owner, assignment, or display label. */
export function catalogTaskExecutionKey(occurrenceId: string, kind: CatalogTaskKind, targetId: string): string {
  if (!occurrenceId.trim() || !targetId.trim()) throw new Error("Identidad de ejecución incompleta.");
  return createHash("sha256").update(id("catalog-task-v1", occurrenceId, kind, targetId), "utf8").digest("hex");
}

function fingerprint(link: CatalogTaskLink): string {
  return id(link.customerId, link.domainId, link.databaseId, link.catalogRecordId, link.environment,
    link.kind, link.state, link.target.status, link.target.status === "verified" ? link.target.id : null,
    link.moduleIds === null ? null : [...new Set(link.moduleIds)].sort(compareText));
}

/**
 * Evaluate each logical link independently before grouping physical targets.
 * This is a write-model plan, not a user-facing DTO; enforce visibility per source in consumers.
 * The repository remains responsible for the unique execution index and atomic writes.
 */
export function planCatalogTaskTargets(input: {
  occurrenceId: string;
  revision: { id: string; complete: boolean };
  requests: readonly CatalogTaskRequest[];
  links: readonly CatalogTaskLink[];
}): CatalogTaskPlan {
  const { occurrenceId, revision, requests, links } = input;
  const result: CatalogTaskPlan = { ready: false, tasks: [], conflicts: [], held: [] };
  if (!revision.complete) return result;
  if (!occurrenceId.trim() || !revision.id.trim()) throw new Error("Ocurrencia o revisión sin identidad.");

  const byId = new Map<string, CatalogTaskLink>();
  for (const link of links) {
    if (!link.linkId.trim() || !link.customerId.trim() || !link.domainId.trim() || !link.catalogRecordId.trim()
      || (link.kind === "database" && !link.databaseId.trim())) {
      throw new Error("Vínculo de catálogo sin identidad.");
    }
    if (link.target.status === "verified" && !link.target.id.trim()) {
      throw new Error("Destino verificado sin identidad.");
    }
    const prior = byId.get(link.linkId);
    if (prior && fingerprint(prior) !== fingerprint(link)) throw new Error("Vínculo inconsistente en la revisión.");
    if (!prior) byId.set(link.linkId, {
      ...link,
      moduleIds: link.moduleIds === null ? null : [...new Set(link.moduleIds)].sort(compareText),
    });
  }

  const groups = new Map<string, Omit<CatalogTaskGroup, "sources"> & { sourceMap: Map<string, CatalogTaskSource> }>();
  const holds = new Map<string, CatalogTaskPlan["held"][number]>();
  for (const request of requests) {
    const { scheduleId, operationId, assignment, scope } = request;
    const assignmentValues = assignment.kind === "role" ? [assignment.id] : catalogAssignedUsers(assignment);
    if (!scheduleId.trim() || !operationId.trim() ||
      (assignment.kind !== "unassigned" && (!assignmentValues.length || assignmentValues.some(value => !value.trim())))) {
      throw new Error("Programación, operación o asignación sin identidad.");
    }
    if (scope.domainId !== undefined && !scope.customerId?.trim()) {
      throw new Error("El dominio debe pertenecer a un cliente seleccionado.");
    }
    for (const value of [scope.customerId, scope.domainId, scope.environment]) {
      if (value !== undefined && !value.trim()) throw new Error("Filtro de identidad vacío.");
    }
    const selected = scope.linkIds === undefined ? null : new Set(scope.linkIds);
    const excluded = new Set(scope.excludedLinkIds);
    const required = [...new Set(scope.modules?.ids)];
    if (scope.modules && (!required.length || required.some(module => !module.trim()))) {
      throw new Error("El filtro de licencias requiere módulos válidos.");
    }
    for (const linkId of selected ?? []) {
      if (!linkId.trim()) throw new Error("Vínculo seleccionado sin identidad.");
      if (!excluded.has(linkId) && !byId.has(linkId)) {
        holds.set(id(scheduleId, linkId, "link_not_found"), { scheduleId, linkId, reason: "link_not_found" });
      }
    }

    for (const link of byId.values()) {
      if (link.kind !== scope.kind || link.state === "inactive" ||
          (scope.customerId !== undefined && link.customerId !== scope.customerId) ||
          (scope.domainId !== undefined && link.domainId !== scope.domainId) ||
          (scope.environment !== undefined && link.environment !== scope.environment) ||
          (selected !== null && !selected.has(link.linkId)) || excluded.has(link.linkId)) continue;
      const hold = (reason: CatalogTaskPlan["held"][number]["reason"]) =>
        holds.set(id(scheduleId, link.linkId, reason), { scheduleId, linkId: link.linkId, reason });

      if (link.state === "unverifiable") {
        hold("link_unverifiable");
        continue;
      }
      if (scope.modules) {
        if (link.moduleIds === null) {
          hold("license_unverified");
          continue;
        }
        const available = new Set(link.moduleIds);
        const matches = scope.modules.mode === "all"
          ? required.every(module => available.has(module))
          : required.some(module => available.has(module));
        if (!matches) continue;
      }
      if (link.target.status !== "verified") {
        hold(link.target.status === "not_found" ? "target_not_found" : "target_unverifiable");
        continue;
      }
      const targetId = link.target.id;
      const executionKey = catalogTaskExecutionKey(occurrenceId, link.kind, targetId);
      let group = groups.get(executionKey);
      if (!group) {
        group = { executionKey, occurrenceId, revisionId: revision.id, kind: link.kind, targetId, sourceMap: new Map() };
        groups.set(executionKey, group);
      }
      group.sourceMap.set(id(scheduleId, link.linkId, operationId, catalogAssignmentIdentity(assignment)),
        { scheduleId, operationId, assignment, link });
    }
  }

  for (const key of [...groups.keys()].sort(compareText)) {
    const { sourceMap, ...identity } = groups.get(key)!;
    const sources = [...sourceMap.entries()].sort(([a], [b]) => compareText(a, b)).map(([, source]) => source);
    const reasons: CatalogTaskPlan["conflicts"][number]["reasons"] = [];
    if (new Set(sources.map(source => source.operationId)).size > 1) reasons.push("incompatible_operation");
    if (new Set(sources.map(source => catalogAssignmentIdentity(source.assignment))).size > 1) reasons.push("incompatible_assignment");
    if (reasons.length) result.conflicts.push({ ...identity, sources, reasons });
    else result.tasks.push({ ...identity, sources, operationId: sources[0].operationId, assignment: sources[0].assignment });
  }
  result.held = [...holds.entries()].sort(([a], [b]) => compareText(a, b)).map(([, hold]) => hold);
  result.ready = true;
  return result;
}

export type CatalogTaskOccurrenceLink = { linkId: string; lastEvidenceAt?: number } & (
  { state: "active" } | { state: "hidden" | "retired"; reason: CatalogTaskFailure }
);

export type CatalogTaskOccurrence = {
  occurrenceId: string;
  targetId: string;
  cutoffAt: number;
  state: "open" | "completed" | "retired";
  links: readonly CatalogTaskOccurrenceLink[];
  /** The cutoff is reconciled once, in the same transaction as its terminal link decisions. */
  cutoffEvaluatedAt?: number;
  /** Prevent a delayed earlier run from undoing a later reconciliation. */
  lastCheckedAt?: number;
};

export type CatalogTaskObservation = { linkId: string; observedAt: number } & (
  { status: "verified"; targetId: string; validUntil: number } | { status: CatalogTaskFailure }
);

export type CatalogTaskOccurrenceTransition =
  | { type: "hidden" | "link_retired"; linkId: string; reason: CatalogTaskFailure }
  | { type: "restored"; linkId: string }
  | { type: "occurrence_retired" };

type CatalogTaskReconciliation = {
  task: CatalogTaskOccurrence;
  visibleLinkIds: string[];
  transitions: CatalogTaskOccurrenceTransition[];
};

function projectOccurrence(task: CatalogTaskOccurrence, transitions: CatalogTaskOccurrenceTransition[] = []): CatalogTaskReconciliation {
  return {
    task,
    visibleLinkIds: task.state === "open" ? task.links.filter(link => link.state === "active").map(link => link.linkId) : [],
    transitions,
  };
}

const observationIdentity = (observation: CatalogTaskObservation) =>
  observation.status === "verified"
    ? id(observation.status, observation.targetId, observation.validUntil)
    : observation.status;

/**
 * Pure cutoff policy; UTC epoch milliseconds for a cutoff computed in the business time zone.
 * Missing, stale, or conflicting observations do not grant visibility. At/after the cutoff,
 * evaluate evidence as of the original cutoff, never a late recovery, and preserve history.
 * Persist transitions with a row-version check; reads must not persist them or reveal access
 * based on this projection alone (execution/reveal needs fresh authorization and verification).
 */
export function reconcileCatalogTaskOccurrence(input: {
  task: CatalogTaskOccurrence;
  checkedAt: number;
  observations: readonly CatalogTaskObservation[];
}): CatalogTaskReconciliation {
  const { task, checkedAt, observations } = input;
  if (!Number.isFinite(checkedAt) || !Number.isFinite(task.cutoffAt)) {
    throw new Error("Hora de verificación o corte inválida.");
  }
  if (task.state !== "open" || task.cutoffEvaluatedAt !== undefined ||
      (task.lastCheckedAt !== undefined && checkedAt < task.lastCheckedAt)) return projectOccurrence(task);
  const atCutoff = checkedAt >= task.cutoffAt;
  const effectiveAt = Math.min(checkedAt, task.cutoffAt);
  const current = new Map<string, { evidence: CatalogTaskObservation; contradictory: boolean }>();
  for (const evidence of observations) {
    if (!Number.isFinite(evidence.observedAt) || evidence.observedAt > effectiveAt) continue;
    const prior = current.get(evidence.linkId);
    if (!prior || evidence.observedAt > prior.evidence.observedAt) {
      current.set(evidence.linkId, { evidence, contradictory: false });
    } else if (evidence.observedAt === prior.evidence.observedAt &&
        observationIdentity(evidence) !== observationIdentity(prior.evidence)) {
      prior.contradictory = true;
    }
  }

  const transitions: CatalogTaskOccurrenceTransition[] = [];
  const links = task.links.map((link): CatalogTaskOccurrenceLink => {
    if (link.state === "retired") return link;
    const value = current.get(link.linkId);
    const candidate = value && !value.contradictory ? value.evidence : undefined;
    const isOlder = candidate && link.lastEvidenceAt !== undefined &&
      (candidate.observedAt < link.lastEvidenceAt ||
        (candidate.observedAt === link.lastEvidenceAt && link.state === "hidden" && candidate.status === "verified"));
    const evidence = isOlder ? undefined : candidate;
    const lastEvidenceAt = evidence?.observedAt ?? effectiveAt;
    const verified = evidence?.status === "verified" && evidence.targetId === task.targetId &&
      Number.isFinite(evidence.validUntil) && evidence.validUntil > effectiveAt;
    if (verified) {
      if (link.state !== "active") transitions.push({ type: "restored", linkId: link.linkId });
      return { linkId: link.linkId, state: "active", lastEvidenceAt };
    }
    const reason = evidence?.status === "not_found" ? "not_found" : "unverifiable";
    if (atCutoff) {
      transitions.push({ type: "link_retired", linkId: link.linkId, reason });
      return { linkId: link.linkId, state: "retired", reason, lastEvidenceAt };
    }
    if (link.state !== "hidden" || link.reason !== reason) transitions.push({ type: "hidden", linkId: link.linkId, reason });
    return { linkId: link.linkId, state: "hidden", reason, lastEvidenceAt };
  });

  const retained = links.some(link => link.state === "active");
  if (atCutoff && !retained) transitions.push({ type: "occurrence_retired" });
  return projectOccurrence({
    ...task, links, lastCheckedAt: checkedAt,
    state: atCutoff && !retained ? "retired" : "open",
    ...(atCutoff ? { cutoffEvaluatedAt: checkedAt } : {}),
  }, transitions);
}
