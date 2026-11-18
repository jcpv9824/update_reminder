export type CatalogSourceRole = "erp-customers" | "sag-admin";
export type CatalogEnvironment = "qa" | "production";
export type CatalogSourceState = "draft" | "active" | "retired";

export type CatalogSourceBinding = Readonly<{
  id: string;
  profileId: string;
  label: string;
  role: CatalogSourceRole;
  environment: CatalogEnvironment;
  state: CatalogSourceState;
  profileRevision: string;
  contractVersion: string;
  issuerScope?: string;
}>;

// Evidence produced by the source validator, not accepted from request bodies.
export type CatalogSourceVerification = Readonly<{
  bindingId?: string;
  bindingVersion?: string;
  profileId: string;
  profileRevision: string;
  contractVersion: string;
  role: CatalogSourceRole;
  environment: CatalogEnvironment;
  tlsValidated: boolean;
  canSelectApprovedProjection: boolean;
  hasElevatedOrWriteAccess: boolean | null;
  contractValid: boolean;
  checkedAtMs: number;
}>;

export type CatalogActivationIssue =
  | "invalid-binding" | "retired-binding" | "evidence-mismatch"
  | "evidence-expired" | "tls-unverified" | "not-read-only"
  | "contract-unverified" | "profile-in-use" | "sag-admin-already-active";

function validText(value: string | undefined, max = 150): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !/\p{Cc}/u.test(value);
}

export function getCatalogSourceActivationIssue(args: {
  binding: CatalogSourceBinding;
  verification: CatalogSourceVerification;
  existing: readonly CatalogSourceBinding[];
  nowMs: number;
  maxEvidenceAgeMs: number;
}): CatalogActivationIssue | null {
  const { binding, verification, existing, nowMs, maxEvidenceAgeMs } = args;
  if (![binding.id, binding.profileId, binding.label, binding.profileRevision, binding.contractVersion]
    .every(value => validText(value)) || (binding.role === "erp-customers" && !validText(binding.issuerScope))) {
    return "invalid-binding";
  }
  if (binding.state === "retired") return "retired-binding";
  if (verification.profileId !== binding.profileId || verification.profileRevision !== binding.profileRevision
    || verification.contractVersion !== binding.contractVersion || verification.role !== binding.role
    || verification.environment !== binding.environment) return "evidence-mismatch";
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(verification.checkedAtMs)
    || !Number.isSafeInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs < 1
    || verification.checkedAtMs > nowMs || nowMs - verification.checkedAtMs > maxEvidenceAgeMs) {
    return "evidence-expired";
  }
  if (verification.tlsValidated !== true) return "tls-unverified";
  if (verification.hasElevatedOrWriteAccess !== false || verification.canSelectApprovedProjection !== true) {
    return "not-read-only";
  }
  if (verification.contractValid !== true) return "contract-unverified";
  for (const source of existing) {
    if (source.id === binding.id || source.state !== "active" || source.environment !== binding.environment) continue;
    if (source.profileId === binding.profileId) return "profile-in-use";
    if (source.role === "sag-admin" && binding.role === "sag-admin") return "sag-admin-already-active";
  }
  return null;
}

export function catalogSourcesForCustomerSelector(args: {
  environment: CatalogEnvironment;
  bindings: readonly CatalogSourceBinding[];
  allowedSourceIds: ReadonlySet<string>;
  publishedSourceIds: ReadonlySet<string>;
}): Array<{ id: string; label: string }> {
  return args.bindings
    .filter(source => source.role === "erp-customers" && source.environment === args.environment
      && source.state === "active" && args.allowedSourceIds.has(source.id) && args.publishedSourceIds.has(source.id))
    .map(({ id, label }) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "es") || a.id.localeCompare(b.id, "en"));
}
