import { describe, expect, it } from "vitest";
import { ALLOWED_ENVIRONMENTS, isAllowedEnvironment } from "../lib/environments";

describe("environments", () => {
  it("solo permite Producción, Pruebas y Demo", () => {
    expect(ALLOWED_ENVIRONMENTS).toEqual(["production", "test", "demo"]);
    expect(isAllowedEnvironment("production")).toBe(true);
    expect(isAllowedEnvironment("test")).toBe(true);
    expect(isAllowedEnvironment("demo")).toBe(true);
    expect(isAllowedEnvironment("staging")).toBe(false);
    expect(isAllowedEnvironment("development")).toBe(false);
  });
});
