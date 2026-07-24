import { describe, expect, it, vi } from "vitest";
import { loadRuntimeStatus, TIMER_FUNCTION_NAMES } from "../lib/runtimeStatus";

describe("runtime connection status", () => {
  it("rejects any backend other than SQL", async () => {
    const verify = vi.fn(async () => undefined);
    await expect(loadRuntimeStatus({ DATA_BACKEND: "legacy" }, verify)).rejects.toThrow("DATA_BACKEND debe ser sql");
    expect(verify).not.toHaveBeenCalled();
  });

  it("requires the SQL security runtime gate", async () => {
    const verify = vi.fn(async () => undefined);
    await expect(loadRuntimeStatus({ DATA_BACKEND: "sql" }, verify))
      .rejects.toThrow("SQL_SECURITY_RUNTIME_ENABLED debe ser true");
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
      DATA_BACKEND: "sql",
      SQL_SECURITY_RUNTIME_ENABLED: "true",
      "AzureWebJobs.generateDailyUpdateTasks.Disabled": "true",
    }, async () => undefined)).resolves.toMatchObject({
      timerDisableState: "partial",
    });
  });
});
