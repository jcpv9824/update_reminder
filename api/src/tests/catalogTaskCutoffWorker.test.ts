import { describe, expect, it, vi } from "vitest";
import { runCatalogTaskCutoffSweep } from "../lib/catalogTaskCutoffWorker";
import type { CatalogExecutionSnapshot } from "../lib/catalogExecutionSqlRepository";
import { reconcileCatalogTaskOccurrence } from "../lib/catalogTaskTargetPlanning";

const key = "ab".repeat(32);
const checkedAt = new Date("2030-06-22T05:01:00.000Z");
const cutoff = new Date("2030-06-22T05:00:00.000Z");
const env = { PORTAL_CATALOG_CUTOFF_ENABLED: "true", PORTAL_SAG_ENVIRONMENT: "qa" };
const snapshot = { executionKey: key, links: [{ linkId: "first" }, { linkId: "second" }], occurrence: {
  occurrenceId: "2030-06-21", targetId: "abstract-db", cutoffAt: cutoff.valueOf(), state: "open",
  links: [{ linkId: "first", state: "active" }, { linkId: "second", state: "active" }],
} } as CatalogExecutionSnapshot;
const tx = {} as never;
function setup() {
  return { queue: vi.fn().mockResolvedValue([key]),
    transaction: async <T>(fn: (transaction: never) => Promise<T>) => fn(tx),
    snapshot: vi.fn().mockResolvedValue(snapshot),
    evidence: vi.fn().mockResolvedValue([{ linkId: "first", checkedAt, effectiveAt: cutoff, validUntil: null },
      { linkId: "second", checkedAt, effectiveAt: cutoff, validUntil: new Date(cutoff.valueOf() + 1) }]),
    persist: vi.fn().mockResolvedValue("updated") };
}

describe("catalog cutoff sweep", () => {
  it("does nothing until the flag is on and does not infer the environment", async () => {
    const io = setup();
    await expect(runCatalogTaskCutoffSweep(io, {})).resolves.toBeNull();
    await expect(runCatalogTaskCutoffSweep(io, { PORTAL_CATALOG_CUTOFF_ENABLED: "true" })).rejects.toThrow("environment_invalid");
    expect(io.queue).not.toHaveBeenCalled();
  });

  it("uses the SQL boundary and persists decisions with the same transaction as the evidence", async () => {
    const io = setup();
    await expect(runCatalogTaskCutoffSweep(io, env)).resolves.toEqual({ updated: 1, skipped: 0, failed: 0 });
    expect(io.snapshot).toHaveBeenCalledWith({ executionKey: key }, tx);
    expect(io.evidence).toHaveBeenCalledWith(tx, snapshot, "qa");
    const args = io.persist.mock.calls[0][0];
    expect(io.persist.mock.calls[0][1]).toBe(tx);
    expect(args.checkedAt).toBe(checkedAt.valueOf());
    expect(reconcileCatalogTaskOccurrence({ task: args.snapshot.occurrence, checkedAt: args.checkedAt, observations: args.observations }))
      .toMatchObject({ visibleLinkIds: ["second"], transitions: [{ type: "link_retired", linkId: "first" }] });
  });

  it("never writes on an outage, incomplete or late evidence, and can continue other tasks", async () => {
    const io = setup();
    io.queue.mockResolvedValue([key, key, key, key]);
    io.evidence.mockRejectedValueOnce(new Error("private SQL outage"))
      .mockResolvedValueOnce([{ linkId: "first", checkedAt, effectiveAt: cutoff, validUntil: null }])
      .mockResolvedValueOnce([{ linkId: "first", checkedAt, effectiveAt: checkedAt, validUntil: null },
        { linkId: "second", checkedAt, effectiveAt: checkedAt, validUntil: null }]);
    await expect(runCatalogTaskCutoffSweep(io, env)).resolves.toEqual({ updated: 1, skipped: 0, failed: 3 });
    expect(io.persist).toHaveBeenCalledOnce();
  });

  it("treats proof expiry exactly at the cutoff as expired", () => {
    expect(reconcileCatalogTaskOccurrence({ task: snapshot.occurrence, checkedAt: checkedAt.valueOf(), observations: [{
      linkId: "first", status: "verified", targetId: "abstract-db", observedAt: cutoff.valueOf() - 1000, validUntil: cutoff.valueOf(),
    }] }).task.state).toBe("retired");
  });
});
