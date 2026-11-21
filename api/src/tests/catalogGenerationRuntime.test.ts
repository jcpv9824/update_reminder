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
  closeOnce: vi.fn().mockResolvedValue({ checked: 2, completed: 1, skipped: 1, failed: 0 }),
  generate: vi.fn().mockResolvedValue({ status: "evaluated", registered: 0, existing: 0, held: 0, conflicts: 0, accountedOrigins: 1 }),
});

describe("catalog generation activation boundary", () => {
  it("runs the historical sweep once before generation, and only on enabled background invocations", async () => {
    const io = deps();
    const activeEnv = { ...env, PORTAL_CATALOG_SCHEDULE_LIFECYCLE_ENABLED: "true", PORTAL_CATALOG_SCHEDULE_COPY_WRITE_ENABLED: "false" };
    const activate = vi.fn().mockResolvedValue({ checked: 3, frozen: 1, cancelled: 1, held: 1, failed: 0 });
    await expect(runCatalogGeneration({ trigger: "timer" }, io, activeEnv, activate)).resolves.toMatchObject({
      activation: { checked: 3, frozen: 1, cancelled: 1, held: 1, failed: 0 },
    });
    expect(activate).toHaveBeenCalledExactlyOnceWith("qa", 7);
    expect(activate.mock.invocationCallOrder[0]).toBeLessThan(io.generate.mock.invocationCallOrder[0]);
    await runCatalogGeneration({ trigger: "refresh" }, deps(), activeEnv, activate);
    await runCatalogGeneration({ trigger: "timer" }, deps(), env, activate);
    expect(activate).toHaveBeenCalledOnce();
  });

  it("sweeps completed past once schedules once per background window, not once per generated date", async () => {
    const io = deps();
    const result = await runCatalogGeneration({ trigger: "timer" },io,env);
    expect(io.closeOnce).toHaveBeenCalledExactlyOnceWith("qa");
    expect(result).toMatchObject({ completedOneTimeSchedules: 1, onceClosure: { checked: 2, completed: 1, skipped: 1, failed: 0 } });
  });
  it("reports closure failure independently without erasing already generated work", async () => {
    const io = deps();
    io.closeOnce.mockRejectedValue(new Error("synthetic private database detail"));
    const result = await runCatalogGeneration({ trigger: "refresh" },io,env);
    expect(result).toMatchObject({ status: "evaluated", completedOneTimeSchedules: 0,
      onceClosure: { checked: 0, completed: 0, skipped: 0, failed: 1 } });
    expect(JSON.stringify(result)).not.toContain("synthetic private database detail");
  });
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
    expect(io.closeOnce).not.toHaveBeenCalled();
  });

  it("derives the business day/cutoff server-side and reports receipt-only accounting separately", async () => {
    const io = deps();
    const result = await runCatalogGeneration({ trigger: "refresh", body: { date: day } }, io, env);
    expect(io.generate).toHaveBeenCalledExactlyOnceWith({
      date: day, portalEnvironment: "qa", checkedAt: now, cutoffAt, matchKeyVersion: 7,
      activeLicenseIds: new Set(["module-a"]),
    });
    expect(result).toMatchObject({ date: day, created: 0, existing: 0, accountedOrigins: 1, manualIntentsSaved: 0 });
    expect(result).not.toHaveProperty("days");
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
    const result = await runCatalogGeneration({ trigger: "schedule-change" }, io, env);
    expect(result).toMatchObject({ status: "unverified", created: 0, manualIntentsSaved: 0 });
    expect(result.days).toHaveLength(8);
    expect(result.days?.every(row => row.status === "unverified" && row.created === 0)).toBe(true);
    expect(result.message).not.toContain("private database");
    expect(io.readActiveLicenseIds).toHaveBeenCalledOnce();
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

describe("bounded background pre-generation", () => {
  const monthEnd = new Date("2030-07-01T04:59:00.000Z"); // June 30 in Bogotá.
  const expected = ["2030-06-30", "2030-07-01", "2030-07-02", "2030-07-03",
    "2030-07-04", "2030-07-05", "2030-07-06", "2030-07-07"];
  const evaluated = { status: "evaluated", registered: 1, existing: 2, held: 3, conflicts: 4, accountedOrigins: 5 };

  it.each(["timer", "schedule-change"] as const)("uses exactly eight serial dates across a month for %s", async trigger => {
    let inFlight = 0;
    let peak = 0;
    const io = { ...deps(), now: vi.fn().mockReturnValue(monthEnd) };
    io.generate.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      --inFlight;
      return evaluated;
    });
    const result = await runCatalogGeneration({ trigger, actorId: "real-user" }, io, env);
    expect(io.generate.mock.calls.map(([input]) => input.date)).toEqual(expected);
    expect(io.generate.mock.calls.map(([input]) => input.cutoffAt.toISOString())).toEqual(
      [...expected.slice(1), "2030-07-08"].map(date => date + "T05:00:00.000Z"));
    expect(io.generate.mock.calls.every(([input]) => !("manualScheduleIds" in input))).toBe(true);
    expect(peak).toBe(1);
    expect(io.now).toHaveBeenCalledTimes(9);
    expect(io.readActiveLicenseIds).toHaveBeenCalledOnce();
    expect(io.appendIntents).not.toHaveBeenCalled();
    expect(io.readRoster).not.toHaveBeenCalled();
    expect(result).toMatchObject({ date: expected[0], status: "evaluated", created: 8, existing: 16,
      held: 24, conflicts: 32, accountedOrigins: 40, manualIntentsSaved: 0 });
    expect(result.days?.map(row => row.date)).toEqual(expected);
    expect(result.days?.every(row => row.created === 1 && !("days" in row))).toBe(true);
  });

  it("keeps committed dates and continues after both a rejected and unverified date without claiming complete success", async () => {
    const io = { ...deps(), now: () => monthEnd };
    io.generate.mockResolvedValue(evaluated)
      .mockResolvedValueOnce(evaluated)
      .mockRejectedValueOnce(new Error("private driver failure"))
      .mockResolvedValueOnce({ status: "unverified" });
    const result = await runCatalogGeneration({ trigger: "timer" }, io, env);
    expect(result).toMatchObject({ date: expected[0], status: "unverified", created: 6, existing: 12,
      held: 18, conflicts: 24, accountedOrigins: 30, manualIntentsSaved: 0 });
    expect(result.days?.map(row => row.status)).toEqual(
      ["evaluated", "unverified", "unverified", "evaluated", "evaluated", "evaluated", "evaluated", "evaluated"]);
    expect(result.days?.map(row => row.created)).toEqual([1, 0, 0, 1, 1, 1, 1, 1]);
    expect(JSON.stringify(result)).not.toContain("private driver failure");
    expect(result.message).not.toBe("Fecha del catálogo evaluada.");
    expect(io.generate).toHaveBeenCalledTimes(8);
  });

  it("checks the fresh Bogotá midnight while retaining the original horizon of the invocation", async () => {
    const midnight = new Date("2030-07-01T05:00:00.000Z");
    const io = { ...deps(), now: vi.fn().mockReturnValue(midnight).mockReturnValueOnce(monthEnd) };
    const result = await runCatalogGeneration({ trigger: "timer" }, io, env);
    expect(result.days?.map(row => row.date)).toEqual(expected);
    expect(result.days?.[0]).toMatchObject({ date: expected[0], status: "cutoff", created: 0 });
    expect(result.status).toBe("evaluated");
    expect(result.message).toContain("fechas omitidas por corte");
    expect(io.generate.mock.calls.map(([input]) => input.date)).toEqual(expected.slice(1));
    expect(io.generate.mock.calls.every(([input]) => input.checkedAt === midnight)).toBe(true);
  });

  it("preserves the same bounded date keys on a background retry; explicit HTTP retries stay on one date", async () => {
    const io = { ...deps(), now: () => monthEnd };
    io.generate.mockResolvedValue(evaluated);
    await runCatalogGeneration({ trigger: "timer" }, io, env);
    await runCatalogGeneration({ trigger: "timer" }, io, env);
    expect(io.generate.mock.calls.map(([input]) => input.date)).toEqual([...expected, ...expected]);
    expect(io.readActiveLicenseIds).toHaveBeenCalledTimes(2);

    io.generate.mockClear();
    for (const trigger of ["generate", "refresh"] as const) {
      const result = await runCatalogGeneration({ trigger, body: { date: expected[7] } }, io, env);
      expect(result).toMatchObject({ date: expected[7], status: "evaluated", created: 1 });
      expect(result).not.toHaveProperty("days");
    }
    expect(io.generate.mock.calls.map(([input]) => input.date)).toEqual([expected[7], expected[7]]);
    expect(io.appendIntents).not.toHaveBeenCalled();
  });

  it("does not accept a caller-supplied background date, window or manual schedule", async () => {
    for (const body of [{ date: expected[1] }, { windowStart: expected[0] }, { manualScheduleIds: ["manual-1"] }]) {
      const io = { ...deps(), now: () => monthEnd };
      await expect(runCatalogGeneration({ trigger: "schedule-change", body }, io, env)).rejects.toMatchObject({ status: 400 });
      expect(io.readActiveLicenseIds).not.toHaveBeenCalled();
      expect(io.generate).not.toHaveBeenCalled();
      expect(io.appendIntents).not.toHaveBeenCalled();
    }
  });
});
