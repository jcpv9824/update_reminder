import { describe, expect, it, vi } from "vitest";
import { loadRuntimeStatus } from "../lib/runtimeStatus";

describe("runtime connection status", () => {
  it("does not open SQL when Cosmos is the selected backend", async () => {
    const verify = vi.fn(async () => undefined);
    await expect(loadRuntimeStatus({ DATA_BACKEND: "cosmos" }, verify)).resolves.toEqual({
      backend: "cosmos", sqlConnected: false, sqlSecurityEnabled: false, timersExpectedDisabled: true,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("verifies SQL for dual-read without enabling SQL security", async () => {
    const verify = vi.fn(async () => undefined);
    await expect(loadRuntimeStatus({ DATA_BACKEND: "dual-read" }, verify)).resolves.toEqual({
      backend: "dual-read", sqlConnected: true, sqlSecurityEnabled: false, timersExpectedDisabled: true,
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
});
