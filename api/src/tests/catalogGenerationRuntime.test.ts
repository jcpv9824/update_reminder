import { describe, expect, it, vi } from "vitest";
import { getTaskGenerationMode, runCatalogGeneration } from "../lib/catalogGenerationRuntime";

const env = { PORTAL_CATALOG_GENERATION_MODE: "catalog", PORTAL_SAG_ENVIRONMENT: "qa",
  PORTAL_CATALOG_READ_ENABLED: "true", PORTAL_CATALOG_CUTOFF_ENABLED: "true", PORTAL_CATALOG_MATCH_KEY_VERSION: "7" };
const now = new Date("2030-06-23T04:59:00.000Z"); // Still June 22 in Bogotá.
const day = "2030-06-22";
const cutoffAt = new Date("2030-06-23T05:00:00.000Z");
const version = "0000000000000001";
const deps = () => ({
  now: () => now,
  readActiveLicenseIds: vi.fn().mockResolvedValue(new Set(["module-a"])),
  readRoster: vi.fn().mockResolvedValue([{ schedule: { id: "manual-1", active: true, frequencyType: "manual",
    startDate: day }, version }]),
  appendIntents: vi.fn().mockResolvedValue(undefined),
  generate: vi.fn().mockResolvedValue({ status: "evaluated", registered: 0, existing: 0, held: 0, conflicts: 0, accountedOrigins: 1 }),
});

describe("catalog generation activation boundary", () => {
  it("defaults to legacy only for absent or explicit legacy mode; rejects broken configuration", async () => {
    expect(getTaskGenerationMode({})).toBe("legacy");
    expect(getTaskGenerationMode({ PORTAL_CATALOG_GENERATION_MODE: "legacy" })).toBe("legacy");
    for (const invalid of ["other", "", "   "]) {
      expect(() => getTaskGenerationMode({ PORTAL_CATALOG_GENERATION_MODE: invalid })).toThrow("catalog_generation_configuration_invalid");
    }
    const io = deps();
    await expect(runCatalogGeneration({ trigger: "timer" }, io, { ...env, PORTAL_CATALOG_CUTOFF_ENABLED: "false" }))
      .rejects.toMatchObject({ status: 503 });
    expect(io.generate).not.toHaveBeenCalled();
    expect(io.readActiveLicenseIds).not.toHaveBeenCalled();
  });

  it("derives the business day/cutoff server-side and reports receipt-only accounting separately", async () => {
    const io = deps();
    const result = await runCatalogGeneration({ trigger: "timer" }, io, env);
    expect(io.generate).toHaveBeenCalledExactlyOnceWith({
      date: day, portalEnvironment: "qa", checkedAt: now, cutoffAt, matchKeyVersion: 7,
      activeLicenseIds: new Set(["module-a"]),
    });
    expect(result).toMatchObject({ date: day, created: 0, existing: 0, accountedOrigins: 1, manualIntentsSaved: 0 });
    expect(io.appendIntents).not.toHaveBeenCalled();
  });

  it("persists explicit intent using the trusted actor and exact current schedule version before generation", async () => {
    const io = deps();
    const result = await runCatalogGeneration({ trigger: "generate", actorId: "real-user",
      body: { date: day, manualScheduleIds: ["manual-1"] } }, io, env);
    expect(io.appendIntents).toHaveBeenCalledExactlyOnceWith({
      date: day, portalEnvironment: "qa", actorId: "real-user", cutoffAt,
      selected: [{ scheduleId: "manual-1", scheduleVersion: version }],
    });
    expect(io.appendIntents.mock.invocationCallOrder[0]).toBeLessThan(io.generate.mock.invocationCallOrder[0]);
    expect(io.generate).toHaveBeenCalledWith(expect.objectContaining({ manualScheduleIds: ["manual-1"] }));
    expect(result.manualIntentsSaved).toBe(1);
  });

  it.each([
    { trigger: "refresh", actorId: "real-user", body: { manualScheduleIds: ["manual-1"] } },
    { trigger: "generate", actorId: "real-user", body: { date: "2030-06-21" } },
    { trigger: "generate", actorId: "real-user", body: { date: "2030-07-30" } },
    { trigger: "generate", actorId: "real-user", body: { actorId: "other" } },
    { trigger: "generate", actorId: "real-user", body: { cutoffAt: "2031-01-01" } },
    { trigger: "generate", actorId: "real-user", body: null },
    { trigger: "generate", actorId: "real-user", body: { windowStart: day } },
    { trigger: "generate", actorId: "real-user", body: { manualScheduleIds: ["manual-1", "manual-1"] } },
  ] as const)("rejects invalid or unauthorized caller input: %j", async input => {
    const io = deps();
    await expect(runCatalogGeneration(input, io, env)).rejects.toMatchObject({ status: 400 });
    expect(io.generate).not.toHaveBeenCalled();
    expect(io.appendIntents).not.toHaveBeenCalled();
  });

  it("does not attempt generation if the selected schedule does not match a current manual schedule", async () => {
    const io = deps();
    await expect(runCatalogGeneration({ trigger: "generate", actorId: "real-user",
      body: { manualScheduleIds: ["unknown"] } }, io, env)).rejects.toMatchObject({ status: 409 });
    expect(io.appendIntents).not.toHaveBeenCalled();
    expect(io.generate).not.toHaveBeenCalled();
  });

  it("returns an already persisted intent distinctly even if planning cannot evaluate the day", async () => {
    const io = deps();
    io.generate.mockRejectedValue(new Error("private SQL detail"));
    const result = await runCatalogGeneration({ trigger: "generate", actorId: "real-user",
      body: { manualScheduleIds: ["manual-1"] } }, io, env);
    expect(result).toMatchObject({ status: "unverified", manualIntentsSaved: 1, created: 0, accountedOrigins: 0 });
    expect(JSON.stringify(result)).not.toContain("private SQL");
  });

  it("fails closed before evaluation when the active module source cannot be read", async () => {
    const io = deps();
    io.readActiveLicenseIds.mockRejectedValue(new Error("private database details"));
    await expect(runCatalogGeneration({ trigger: "schedule-change" }, io, env))
      .resolves.toMatchObject({ status: "unverified", created: 0, manualIntentsSaved: 0 });
    expect(io.generate).not.toHaveBeenCalled();
  });

  it("rejects the previous Bogotá day at exact midnight before any SQL", async () => {
    const io = { ...deps(), now: () => cutoffAt };
    await expect(runCatalogGeneration({ trigger: "generate", actorId: "real-user",
      body: { date: day, manualScheduleIds: ["manual-1"] } }, io, env)).rejects.toMatchObject({ status: 400 });
    expect(io.readRoster).not.toHaveBeenCalled();
    expect(io.appendIntents).not.toHaveBeenCalled();
    expect(io.generate).not.toHaveBeenCalled();
  });

  it("preserves the independent saved-encounter and cutoff outcomes if the clock changes after append", async () => {
    const io = deps();
    io.generate.mockResolvedValue({ status: "cutoff" });
    await expect(runCatalogGeneration({ trigger: "generate", actorId: "real-user",
      body: { date: day, manualScheduleIds: ["manual-1"] } }, io, env))
      .resolves.toMatchObject({ status: "cutoff", manualIntentsSaved: 1, message: expect.stringContaining("quedó registrada") });
  });

  it("does not hide held destinations when the same evaluation also reconciled receipts", async () => {
    const io = deps();
    io.generate.mockResolvedValue({ status: "evaluated", registered: 0, existing: 0, held: 1, conflicts: 1, accountedOrigins: 2 });
    const result = await runCatalogGeneration({ trigger: "refresh" }, io, env);
    expect(result).toMatchObject({ held: 1, conflicts: 1, accountedOrigins: 2, created: 0, existing: 0 });
    expect(result.message).toContain("retenidos");
    expect(result.message).toContain("no son tareas nuevas");
  });
});
