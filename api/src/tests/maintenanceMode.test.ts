import { describe, expect, it } from "vitest";
import {
  maintenanceAction,
  maintenanceModeEnabled,
  maintenanceUnavailableResponse,
} from "../lib/maintenanceMode";

describe("production maintenance mode", () => {
  it("is disabled by default and accepts only the explicit true value", () => {
    expect(maintenanceModeEnabled({})).toBe(false);
    expect(maintenanceModeEnabled({ PORTAL_MAINTENANCE_MODE: "false" })).toBe(false);
    expect(maintenanceModeEnabled({ PORTAL_MAINTENANCE_MODE: "1" })).toBe(false);
    expect(maintenanceModeEnabled({ PORTAL_MAINTENANCE_MODE: "TRUE" })).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("allows read-only HTTP method %s", (method) => {
    expect(maintenanceAction({
      env: { PORTAL_MAINTENANCE_MODE: "true" },
      triggerType: "httpTrigger",
      method,
    })).toBe("allow");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("blocks mutating HTTP method %s", (method) => {
    expect(maintenanceAction({
      env: { PORTAL_MAINTENANCE_MODE: "true" },
      triggerType: "httpTrigger",
      method,
    })).toBe("block-http");
  });

  it("blocks timers independently from their Azure disabled settings", () => {
    expect(maintenanceAction({
      env: { PORTAL_MAINTENANCE_MODE: "true" },
      triggerType: "timerTrigger",
    })).toBe("block-timer");
  });

  it("returns a sanitized retryable response for blocked HTTP calls", () => {
    expect(maintenanceUnavailableResponse()).toEqual({
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "300",
      },
      jsonBody: {
        error: "El portal está temporalmente en mantenimiento.",
        code: "PORTAL_MAINTENANCE",
      },
    });
  });
});
