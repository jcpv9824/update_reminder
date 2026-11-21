import { describe, expect, it, vi } from "vitest";
import { planCatalogTaskTargets, type CatalogTaskLink } from "../lib/catalogTaskTargetPlanning";
import { prepareRemainingCatalogSelection, resolveCatalogSchedulePreviewReservations,
  type ScheduleConflictCandidate } from "../lib/catalogScheduleConflictSelection";

const row = (linkId: string, targetId: string, kind: ScheduleConflictCandidate["kind"],
  state: ScheduleConflictCandidate["state"] = "ready"): ScheduleConflictCandidate => ({ linkId, targetId, kind, state });

describe("work with the remaining schedule targets", () => {
  it("preselects only verified remaining links and keeps a non-conflicting database under a conflicting domain", () => {
    expect(prepareRemainingCatalogSelection([
      row("domain-a", "web-a", "domain", "conflict"),
      row("domain-alias", "web-a", "domain"),
      row("db-in-a", "sql-a", "database"),
      row("db-in-b", "sql-b", "database", "unverifiable"),
      row("db-alias", "sql-a", "database"),
    ])).toEqual({ status: "ready", linkIds: ["db-alias", "db-in-a"] });
  });

  it("never converts an empty remaining selection to all targets", () => {
    expect(prepareRemainingCatalogSelection([row("gone", "sql-a", "database", "conflict")]))
      .toEqual({ status: "empty", linkIds: [] });
  });

  it("rejects inconsistent or ambiguous links rather than preselecting the first one", () => {
    expect(() => prepareRemainingCatalogSelection([
      row("same", "sql-a", "database"), row("same", "sql-b", "database"),
    ])).toThrow();
  });

  it("checks one physical reservation per kind and returns only verified remaining aliases for a new draft", async () => {
    const day = "2026-12-10";
    const link = (linkId: string, kind: "domain" | "database", status: "verified" | "unverifiable" = "verified") => ({ linkId, kind,
      customerId: `customer-${linkId}`, domainId: `domain-${linkId}`, catalogRecordId: `record-${linkId}`,
      ...(kind === "database" ? { databaseId: `database-${linkId}` } : {}), environment: "production", state: "active",
      target: { status, ...(status === "verified" && { id: "shared-fingerprint" }) }, moduleIds: [] }) as CatalogTaskLink;
    const plan = planCatalogTaskTargets({ occurrenceId: day, revision: { id: "revision", complete: true },
      links: [link("domain-a", "domain"), link("db-a", "database"), link("db-b", "database"), link("db-unverified", "database", "unverifiable")],
      requests: (["domain", "database"] as const).map(kind => ({ scheduleId: "approved", operationId: "approved-release",
        assignment: { kind: "role", id: "tester" }, scope: { kind } })) });
    const tx = {} as Parameters<typeof resolveCatalogSchedulePreviewReservations>[0];
    const inspect = vi.fn<NonNullable<Parameters<typeof resolveCatalogSchedulePreviewReservations>[2]>>()
      .mockImplementation(async (_tx, { candidates }) => candidates.map(candidate => candidate.kind === "domain" ? "conflict" : "compatible_reservation"));
    await expect(resolveCatalogSchedulePreviewReservations(tx, { taskDate: day, cutoffAt: new Date("2026-12-11T05:00:00Z"),
      plan, workflowRoleFor: () => "tester" }, inspect)).resolves.toMatchObject({ coverage: "partial", heldLinkIds: ["db-unverified"],
      remaining: { status: "ready", linkIds: ["db-a", "db-b"] } });
    expect(inspect.mock.calls[0][1].candidates).toHaveLength(2);
    expect(inspect.mock.calls[0][1].candidates).toContainEqual(expect.objectContaining({ kind: "database",
      targetIds: ["database-db-a", "database-db-b"] }));
    await expect(resolveCatalogSchedulePreviewReservations(tx, { taskDate: day, cutoffAt: new Date("2026-12-11T05:00:00Z"),
      plan: { ...plan, tasks: [] }, workflowRoleFor: () => "tester" }, inspect)).resolves.toMatchObject({ coverage: "partial",
      heldLinkIds: ["db-unverified"], remaining: { status: "empty", linkIds: [] } });
    await expect(resolveCatalogSchedulePreviewReservations(tx, { taskDate: day, cutoffAt: new Date("2026-12-11T05:00:00Z"),
      plan, workflowRoleFor: () => "mismatched-role" }, inspect)).resolves.toBeNull();
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
