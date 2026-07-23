import { describe, expect, it, vi } from "vitest";
import { loadRuntimeStatus, TIMER_FUNCTION_NAMES } from "../lib/runtimeStatus";

describe("runtime connection status", () => {
  it("does not open SQL when Cosmos is the selected backend", async () => {
    const verify = vi.fn(async () => undefined);
    await expect(loadRuntimeStatus({ DATA_BACKEND: "cosmos" }, verify)).resolves.toEqual({
      backend: "cosmos", sqlConnected: false, sqlSecurityEnabled: false,
      maintenanceMode: false, timersExpectedDisabled: true, timerDisableState: "none",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("verifies SQL for dual-read without enabling SQL security", async () => {
    const verify = vi.fn(async () => undefined);
    await expect(loadRuntimeStatus({ DATA_BACKEND: "dual-read" }, verify)).resolves.toEqual({
      backend: "dual-read", sqlConnected: true, sqlSecurityEnabled: false,
      maintenanceMode: false, timersExpectedDisabled: true, timerDisableState: "none",
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  it("reports the security gate only for the complete SQL backend", async () => {
    await expect(loadRuntimeStatus({
      DATA_BACKEND: "sql", SQL_SECURITY_RUNTIME_ENABLED: "true",
    }, async () => undefined)).resolves.toMatchObject({
      backend: "sql", sqlConnected: true, sqlSecurityEnabled: true, timersExpectedDisabled: false,
    });
  });

  it("expects timers to stay disabled while SQL is in maintenance mode", async () => {
    const disabledTimers = Object.fromEntries(
      TIMER_FUNCTION_NAMES.map((name) => [`AzureWebJobs.${name}.Disabled`, "true"]),
    );
    await expect(loadRuntimeStatus({
      DATA_BACKEND: "sql",
      SQL_SECURITY_RUNTIME_ENABLED: "true",
      PORTAL_MAINTENANCE_MODE: "true",
      ...disabledTimers,
    }, async () => undefined)).resolves.toMatchObject({
      backend: "sql",
      maintenanceMode: true,
      timersExpectedDisabled: true,
      timerDisableState: "all",
    });
  });

  it("reports partially disabled timers instead of hiding a configuration gap", async () => {
    await expect(loadRuntimeStatus({
      DATA_BACKEND: "dual-read",
      "AzureWebJobs.generateDailyUpdateTasks.Disabled": "true",
    }, async () => undefined)).resolves.toMatchObject({
      timerDisableState: "partial",
    });
  });
});
