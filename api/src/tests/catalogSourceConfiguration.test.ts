import { describe, expect, it } from "vitest";
import {
  catalogSourcesForCustomerSelector, getCatalogSourceActivationIssue,
  type CatalogSourceBinding, type CatalogSourceVerification,
} from "../lib/catalogSourceConfiguration";

const erp: CatalogSourceBinding = {
  id: "erp", profileId: "existing-profile", label: "Colombia", role: "erp-customers",
  environment: "qa", state: "draft", profileRevision: "1", contractVersion: "v1", issuerScope: "CO-NIT",
};
const proof: CatalogSourceVerification = {
  profileId: erp.profileId, profileRevision: "1", contractVersion: "v1",
  role: "erp-customers", environment: "qa", tlsValidated: true, canSelectApprovedProjection: true,
  hasElevatedOrWriteAccess: false, contractValid: true, checkedAtMs: 1_000,
};
const check = (
  binding = erp, verification = proof, existing: readonly CatalogSourceBinding[] = [],
) => getCatalogSourceActivationIssue({ binding, verification, existing, nowMs: 1_500, maxEvidenceAgeMs: 1_000 });

describe("catalog source configuration", () => {
  it("allows a certified ERP and rejects reachability without contract validation", () => {
    expect(check()).toBeNull();
    expect(check(erp, { ...proof, contractValid: false })).toBe("contract-unverified");
    expect(check(erp, { ...proof, tlsValidated: false })).toBe("tls-unverified");
  });

  it("refuses broad or unknown write permissions", () => {
    expect(check(erp, { ...proof, hasElevatedOrWriteAccess: true })).toBe("not-read-only");
    expect(check(erp, { ...proof, hasElevatedOrWriteAccess: null })).toBe("not-read-only");
    expect(check(erp, { ...proof, canSelectApprovedProjection: false })).toBe("not-read-only");
  });

  it("requires evidence for the same revision, role, contract and environment", () => {
    expect(check({ ...erp, profileRevision: "2" })).toBe("evidence-mismatch");
    expect(check(erp, { ...proof, environment: "production" })).toBe("evidence-mismatch");
    expect(check(erp, { ...proof, role: "sag-admin" })).toBe("evidence-mismatch");
    expect(check(erp, { ...proof, checkedAtMs: 100 })).toBe("evidence-expired");
  });

  it("allows several ERP sources but only one active SAG Admin per environment", () => {
    const sag: CatalogSourceBinding = { ...erp, id: "sag", profileId: "sag-profile", role: "sag-admin" };
    const peer = { ...sag, id: "sag-2", profileId: "sag-profile-2", state: "active" } as const;
    const sagProof = { ...proof, profileId: sag.profileId, role: sag.role };
    expect(check(sag, sagProof, [peer])).toBe("sag-admin-already-active");
    expect(check(sag, sagProof, [{ ...peer, environment: "production" }])).toBeNull();
    expect(check(erp, proof, [{ ...erp, id: "erp-2", profileId: "erp-2", state: "active" }])).toBeNull();
  });

  it("lists only authorized published active ERP profiles, omitting connection fields", () => {
    const bindings = [
      { ...erp, state: "active" },
      { ...erp, id: "draft" },
      { ...erp, id: "restricted", state: "active" },
      { ...erp, id: "loading", state: "active" },
      { ...erp, id: "sag", role: "sag-admin", state: "active" },
      { ...erp, id: "prod", environment: "production", state: "active" },
    ] satisfies CatalogSourceBinding[];
    expect(catalogSourcesForCustomerSelector({
      environment: "qa", bindings,
      allowedSourceIds: new Set(["erp", "draft", "loading", "sag", "prod"]),
      publishedSourceIds: new Set(["erp", "draft", "restricted", "sag", "prod"]),
    })).toEqual([{ id: "erp", label: "Colombia" }]);
  });
});
