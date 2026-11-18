import { describe, expect, it } from "vitest";
import {
  planCatalogTaskTargets,
  reconcileCatalogTaskOccurrence,
  type CatalogTaskLink,
  type CatalogTaskOccurrence,
  type CatalogTaskObservation,
  type CatalogTaskRequest,
} from "../lib/catalogTaskTargetPlanning";

const occurrenceId = "jornada-2026-11-17";
const revision = { id: "revision-1", complete: true };
const request: CatalogTaskRequest = {
  scheduleId: "programa-uno",
  operationId: "release-1",
  assignment: { kind: "user", id: "updater-1" },
  scope: { kind: "database" },
};
const sqlLink: Extract<CatalogTaskLink, { kind: "database" }> = {
  linkId: "link-uno", customerId: "cliente-uno", domainId: "dominio-uno",
  databaseId: "base-uno", catalogRecordId: "origen-uno", environment: "production",
  state: "active", moduleIds: ["A", "B"],
  kind: "database", target: { status: "verified", id: "destino-verificado" },
};
const otherLink: CatalogTaskLink = {
  ...sqlLink, linkId: "link-dos", customerId: "cliente-dos", catalogRecordId: "origen-dos",
  domainId: "dominio-dos", environment: "test", databaseId: "base-dos", moduleIds: ["A"],
};
const plan = (links: readonly CatalogTaskLink[], requests: readonly CatalogTaskRequest[] = [request]) =>
  planCatalogTaskTargets({ occurrenceId, revision, links, requests });

describe("catalog task planning", () => {
  it("groups a verified physical database while retaining every separate link and schedule", () => {
    const second = { ...request, scheduleId: "programa-dos" };
    const output = plan([sqlLink, otherLink, { ...sqlLink }], [request, second]);
    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0].sources).toHaveLength(4);
    expect(output.tasks[0].sources.map(source => [source.scheduleId, source.link.customerId])).toEqual([
      ["programa-dos", "cliente-dos"], ["programa-dos", "cliente-uno"],
      ["programa-uno", "cliente-dos"], ["programa-uno", "cliente-uno"],
    ]);
    expect(output.tasks[0].executionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(plan([otherLink, sqlLink], [second, request]).tasks).toEqual(output.tasks);
  });

  it("filters first by client, domain, environment and explicit immutable link IDs", () => {
    const output = plan([sqlLink, otherLink], [{
      ...request,
      scope: { kind: "database", customerId: "cliente-uno", domainId: "dominio-uno",
        environment: "production", linkIds: ["link-uno", "link-dos"] },
    }]);
    expect(output.tasks[0].sources.map(source => source.link.linkId)).toEqual(["link-uno"]);
    expect(plan([sqlLink, otherLink], [{ ...request, scope: { kind: "database", linkIds: [] } }]).tasks)
      .toEqual([]);
    expect(plan([sqlLink], [{ ...request, scope: { kind: "database", linkIds: ["perdido"] } }]).held)
      .toEqual([{ scheduleId: request.scheduleId, linkId: "perdido", reason: "link_not_found" }]);
    expect(() => plan([sqlLink], [{ ...request, scope: { kind: "database", domainId: "dominio-uno" } }]))
      .toThrow(/cliente/);
  });

  it("does not union licensed modules across environments or silently drop a missing requirement", () => {
    const a = { ...sqlLink, moduleIds: ["A"] };
    const b = { ...otherLink, moduleIds: ["B"] };
    const rule: CatalogTaskRequest = {
      ...request, scope: { kind: "database", modules: { mode: "all", ids: ["A", "B"] } },
    };
    expect(plan([a, b], [rule]).tasks).toEqual([]);
    const anyRule: CatalogTaskRequest = {
      ...request, scope: { kind: "database", modules: { mode: "any", ids: ["A", "B"] } },
    };
    expect(plan([a, b], [anyRule]).tasks[0].sources).toHaveLength(2);
    expect(plan([{ ...a, moduleIds: null }], [rule]).held[0].reason).toBe("license_unverified");
  });

  it("requires verified targets, separates target kinds and never groups an incomplete revision", () => {
    const { databaseId: _databaseId, ...common } = sqlLink;
    const domain: CatalogTaskLink = { ...common, kind: "domain", linkId: "web-uno" };
    const output = plan([sqlLink, domain, { ...otherLink, target: { status: "unverifiable" } }], [
      request, { ...request, scope: { kind: "domain" } },
    ]);
    expect(output.tasks).toHaveLength(2);
    expect(new Set(output.tasks.map(task => task.executionKey)).size).toBe(2);
    expect(output.held.map(row => row.reason)).toEqual(["target_unverifiable"]);
    expect(planCatalogTaskTargets({ occurrenceId, revision: { ...revision, complete: false },
      links: [sqlLink], requests: [request] }).ready).toBe(false);
  });

  it("blocks incompatible operations or assignees without creating duplicate work", () => {
    const output = plan([sqlLink, otherLink], [
      request, {
        ...request, scheduleId: "programa-dos", operationId: "release-2",
        assignment: { kind: "user", id: "updater-2" },
      },
    ]);
    expect(output.tasks).toEqual([]);
    expect(output.conflicts).toHaveLength(1);
    expect(output.conflicts[0].reasons).toEqual(["incompatible_operation", "incompatible_assignment"]);
    expect(output.conflicts[0].sources).toHaveLength(4);
  });

  it("rejects incoherent duplicate link rows rather than choosing one by query ordering", () => {
    expect(() => plan([sqlLink, { ...sqlLink, target: { status: "verified", id: "otro" } }]))
      .toThrow(/inconsistente/);
  });
});

describe("catalog task cutoff", () => {
  const cutoffAt = Date.parse("2026-11-18T05:00:00.000Z"); // midnight after Nov 17 in Bogotá
  const createTask = (): CatalogTaskOccurrence => ({
    occurrenceId, cutoffAt, state: "open", targetId: "destino-verificado",
    links: [{ linkId: "link-uno", state: "active" }, { linkId: "link-dos", state: "active" }],
  });
  const verified = (linkId: string, observedAt: number): Extract<CatalogTaskObservation, { status: "verified" }> => ({
    linkId, status: "verified", targetId: "destino-verificado", observedAt, validUntil: cutoffAt + 1,
  });

  it("hides unverifiable links before cutoff and restores a verified link without changing the task ID", () => {
    const task = createTask();
    const first = reconcileCatalogTaskOccurrence({ task, checkedAt: cutoffAt - 10,
      observations: [verified("link-uno", cutoffAt - 10)] });
    expect(first.visibleLinkIds).toEqual(["link-uno"]);
    expect(first.transitions).toEqual([{ type: "hidden", linkId: "link-dos", reason: "unverifiable" }]);
    expect(first.task.state).toBe("open");
    const second = reconcileCatalogTaskOccurrence({ task: first.task, checkedAt: cutoffAt - 1,
      observations: [verified("link-uno", cutoffAt - 1), verified("link-dos", cutoffAt - 1)] });
    expect(second.visibleLinkIds).toEqual(["link-uno", "link-dos"]);
    expect(second.transitions).toEqual([{ type: "restored", linkId: "link-dos" }]);
    expect(second.task.occurrenceId).toBe(task.occurrenceId);
  });

  it("retires only the missing link at cutoff when another verified link remains", () => {
    const result = reconcileCatalogTaskOccurrence({ task: createTask(), checkedAt: cutoffAt,
      observations: [
        { linkId: "link-uno", status: "not_found", observedAt: cutoffAt },
        verified("link-dos", cutoffAt),
      ] });
    expect(result.task.state).toBe("open");
    expect(result.task.links[0]).toEqual({
      linkId: "link-uno", state: "retired", reason: "not_found", lastEvidenceAt: cutoffAt,
    });
    expect(result.visibleLinkIds).toEqual(["link-dos"]);
    const repeated = reconcileCatalogTaskOccurrence({ task: result.task, checkedAt: cutoffAt + 10,
      observations: [verified("link-uno", cutoffAt + 5), verified("link-dos", cutoffAt)] });
    expect(repeated.task).toBe(result.task);
    expect(repeated.transitions).toEqual([]);
  });

  it("retires the occurrence when all links fail, never treating late data as a pre-cutoff recovery", () => {
    const result = reconcileCatalogTaskOccurrence({ task: createTask(), checkedAt: cutoffAt + 10,
      observations: [
        { linkId: "link-uno", status: "not_found", observedAt: cutoffAt },
        verified("link-dos", cutoffAt + 1),
      ] });
    expect(result.task.state).toBe("retired");
    expect(result.task.links.map(link => link.state === "retired" ? link.reason : null))
      .toEqual(["not_found", "unverifiable"]);
    expect(result.transitions.at(-1)).toEqual({ type: "occurrence_retired" });
    expect(result.visibleLinkIds).toEqual([]);
    expect(reconcileCatalogTaskOccurrence({ task: result.task, checkedAt: cutoffAt + 20,
      observations: [verified("link-uno", cutoffAt), verified("link-dos", cutoffAt)] }).task)
      .toBe(result.task);
  });

  it("does not switch targets, trust expired/conflicting evidence, or alter a completed task", () => {
    const task = createTask();
    const result = reconcileCatalogTaskOccurrence({ task, checkedAt: cutoffAt - 1, observations: [
      { ...verified("link-uno", cutoffAt - 10), targetId: "otro-destino" },
      { ...verified("link-dos", cutoffAt - 10), validUntil: cutoffAt - 2 },
    ] });
    expect(result.task.links.every(link => link.state === "hidden")).toBe(true);
    const conflicting = reconcileCatalogTaskOccurrence({ task, checkedAt: cutoffAt, observations: [
      verified("link-uno", cutoffAt), { linkId: "link-uno", status: "not_found", observedAt: cutoffAt },
    ] });
    expect(conflicting.task.links[0]).toEqual({
      linkId: "link-uno", state: "retired", reason: "unverifiable", lastEvidenceAt: cutoffAt,
    });
    const completed = { ...task, state: "completed" as const };
    expect(reconcileCatalogTaskOccurrence({ task: completed, checkedAt: cutoffAt,
      observations: [] }).task).toBe(completed);
  });

  it("does not restore a hidden link from older evidence even when its freshness window has not expired", () => {
    const hidden = reconcileCatalogTaskOccurrence({ task: createTask(), checkedAt: cutoffAt - 5, observations: [] });
    const stale = reconcileCatalogTaskOccurrence({
      task: hidden.task, checkedAt: cutoffAt - 1, observations: [verified("link-uno", cutoffAt - 10)],
    });
    expect(stale.visibleLinkIds).toEqual([]);
    expect(stale.transitions).toEqual([]);
  });
});
