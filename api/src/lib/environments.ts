export const ALLOWED_ENVIRONMENTS = ["production", "test", "demo"] as const;

export function isAllowedEnvironment(value: unknown): value is typeof ALLOWED_ENVIRONMENTS[number] {
  return typeof value === "string" && (ALLOWED_ENVIRONMENTS as readonly string[]).includes(value);
}
