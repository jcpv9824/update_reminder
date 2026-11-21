import { describe, expect, it, vi } from "vitest";
import { hasConclusiveHistoricalCopyScope, runCatalogScheduleActivationSweep } from "../lib/catalogScheduleActivationWorker";

const candidate = (n: number) => ({ key: String(n), scheduleId: `schedule-${n}`, version: "0000000000000001", date: "2030-06-22", hasDatabase: false });

describe("bounded historical schedule activation", () => {
  it("loads a database proof key once outside candidate transactions and wipes it even after a failed candidate", async () => {
    const key = Buffer.alloc(32, 0x44);
    const read = vi.fn().mockResolvedValue([candidate(1), { ...candidate(2), hasDatabase: true }]);
    const loadKey = vi.fn().mockResolvedValue(key);
    const activate = vi.fn(async (_env, _version, row, provided) => {
      if (!row.hasDatabase) { expect(provided).toBeNull(); return "frozen" as const; }
      expect(provided).toBe(key);
      expect(provided.every((byte: number) => byte === 0x44)).toBe(true);
      throw new Error("candidate stopped");
    });
    await expect(runCatalogScheduleActivationSweep("qa", 7, { read, loadKey, activate, cursors: new Map() }))
      .resolves.toEqual({ checked: 2, frozen: 1, cancelled: 0, held: 0, failed: 1 });
    expect(loadKey).toHaveBeenCalledExactlyOnceWith("qa", 7);
    expect(loadKey.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]);
    expect(key.every(byte => byte === 0)).toBe(true);
  });
  it("does not seal a mixed scope while one target remains unknown, but accepts explicit partial absence", () => {
    const domain = { kind: "domain", linkId: "d", targetId: "web" };
    const database = { kind: "database", linkId: "s", targetId: "sql" };
    const positive = { kind: domain.kind, linkId: domain.linkId, state: "eligible", verifiedTargetId: domain.targetId };
    expect(hasConclusiveHistoricalCopyScope([domain, database], [positive,
      { kind: database.kind, linkId: database.linkId, state: "unverifiable", verifiedTargetId: null }])).toBe(false);
    expect(hasConclusiveHistoricalCopyScope([domain, database], [positive,
      { kind: database.kind, linkId: database.linkId, state: "absent", verifiedTargetId: null }])).toBe(true);
  });
  it("reports frozen, cancelled, held and failed outcomes without exposing identities or details", async () => {
    const read = vi.fn().mockResolvedValue([1, 2, 3, 4, 5].map(candidate));
    const activate = vi.fn().mockResolvedValueOnce("frozen").mockResolvedValueOnce("cancelled").mockResolvedValueOnce("held")
      .mockRejectedValueOnce(new Error("private diagnostic")).mockResolvedValueOnce("existing");
    const result = await runCatalogScheduleActivationSweep("qa", 7, { read, activate, cursors: new Map() });
    expect(result).toEqual({ checked: 5, frozen: 1, cancelled: 1, held: 1, failed: 1 });
    expect(JSON.stringify(result)).not.toMatch(/private|schedule-/);
  });

  it("advances the cursor beyond held early rows and rotates on completion", async () => {
    const read = vi.fn().mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => candidate(i + 1)))
      .mockResolvedValueOnce([candidate(31)]);
    const io = { read, activate: vi.fn().mockResolvedValue("held"), cursors: new Map() };
    await runCatalogScheduleActivationSweep("qa", 7, io);
    expect(io.cursors.get("qa")).toBe("30");
    await runCatalogScheduleActivationSweep("qa", 7, io);
    expect(read.mock.calls).toEqual([["qa", "0"], ["qa", "30"]]);
    expect(io.cursors.has("qa")).toBe(false);
  });

  it("does not process malformed, duplicate or non-monotonic SQL batches", async () => {
    const io = { read: vi.fn().mockResolvedValue([candidate(2), candidate(1)]), activate: vi.fn(), cursors: new Map() };
    await expect(runCatalogScheduleActivationSweep("qa", 7, io)).rejects.toThrow("catalog_activation_worker_invalid_batch");
    expect(io.activate).not.toHaveBeenCalled();
  });
});
