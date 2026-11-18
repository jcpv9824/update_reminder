import { describe, expect, it, vi } from "vitest";
import { readCatalogTaskCutoffEvidence, runCatalogTaskCutoffSweep } from "../lib/catalogTaskCutoffWorker";
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
  it("requires original-boundary bridge and approval proof and never falls back to local for that UUID", async () => {
    const query = vi.fn().mockResolvedValue({ recordset: [] });
    const input = vi.fn().mockReturnThis();
    const transaction = { request: () => ({ input, query }) } as unknown as Parameters<typeof readCatalogTaskCutoffEvidence>[0];
    await expect(readCatalogTaskCutoffEvidence(transaction, snapshot, "qa")).resolves.toEqual([]);
    expect(input).toHaveBeenCalledWith("env", expect.anything(), "qa");
    expect(input).toHaveBeenCalledWith("execution", expect.anything(), Buffer.from(key, "hex"));
    const statement = query.mock.calls[0][0] as string;
    expect(statement).not.toContain("core.catalog_operational_link_evidence");
    for (const condition of [
      "bridge.link_id=TRY_CONVERT(uniqueidentifier,l.link_id) AND DATALENGTH(l.link_id)=72",
      "bridge.portal_environment=@env AND bridge.catalog_source_key=l.catalog_source_key",
      "bridge.client_key=l.client_key AND bridge.domain_key=l.domain_key",
      "bridge.database_key=l.database_key OR (bridge.database_key IS NULL AND l.database_key IS NULL)",
      "bridge.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2",
      "bridge.link_environment=l.link_environment COLLATE Latin1_General_100_BIN2",
      "bridge.source_record_id=TRY_CONVERT(int,l.catalog_record_id)",
      "data.catalog_customer_key=owner.catalog_customer_key",
      "bridge.registered_at<=boundary.as_of AND owner.registered_at<=boundary.as_of",
      "a.approved_at<=boundary.as_of AND a.revision_key<=r.revision_key",
      "a.binding_version=r.binding_version AND a.profile_version=r.profile_version",
      "(bridge.retired_at IS NULL OR bridge.retired_at>boundary.as_of)",
      "(owner.retired_at IS NULL OR owner.retired_at>boundary.as_of)",
      "h.attempt_status='succeeded' AND h.attempted_at<=boundary.as_of",
      "r.sealed_at<=boundary.as_of AND r.observed_at<=boundary.as_of AND r.verified_until>boundary.as_of",
      "r.binding_version=b.row_version AND r.profile_version=profile.row_version",
      "t.registered_at<=boundary.as_of AND target.created_at<=boundary.as_of",
      "l.catalog_source_key IS NOT NULL AND externalProof.valid_until IS NOT NULL",
      "known.link_id=TRY_CONVERT(uniqueidentifier,l.link_id)",
      "CASE WHEN externalProof.valid_until<t.valid_until THEN externalProof.valid_until ELSE t.valid_until END AS valid_until",
    ]) expect(statement).toContain(condition);
    expect(statement).toMatch(/SELECT l\.link_id AS linkId, @checkedAt AS checkedAt, boundary\.as_of AS effectiveAt, proof\.valid_until AS validUntil/i);
  });

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
