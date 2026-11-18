import { describe, expect, it } from "vitest";
import { fingerprintCatalogSqlTarget, fingerprintCatalogWebTarget } from "../lib/catalogPhysicalTargetIdentity";

const primaryScope = "e6952006-98ba-4569-aec7-b1f21674c79b";
const otherScope = "1058f5a7-2e30-4713-882f-ec80329d4297";
const nativeId = "0666cc56-c64b-4b6e-ba97-edd16dbae290";

describe("verified destination identity", () => {
  it("groups observations of the same SQL native identity across aliases", () => {
    const first = fingerprintCatalogSqlTarget({ instanceId: primaryScope, databaseGuid: nativeId });
    expect(first).toHaveLength(32);
    expect(fingerprintCatalogSqlTarget({ instanceId: primaryScope.toUpperCase(), databaseGuid: nativeId.toUpperCase() })).toEqual(first);
  });

  it("keeps copied databases in distinct verified namespaces and web deployments separate", () => {
    const first = fingerprintCatalogSqlTarget({ instanceId: primaryScope, databaseGuid: nativeId });
    expect(fingerprintCatalogSqlTarget({ instanceId: otherScope, databaseGuid: nativeId })).not.toEqual(first);
    expect(fingerprintCatalogWebTarget({ providerScopeId: primaryScope, deploymentId: nativeId })).not.toEqual(first);
  });

  it("rejects guesses based on display names or blank IDs", () => {
    expect(() => fingerprintCatalogSqlTarget({ instanceId: "legacy.example", databaseGuid: nativeId }))
      .toThrow("catalog_target_identity_invalid");
    expect(() => fingerprintCatalogWebTarget({
      providerScopeId: primaryScope, deploymentId: "00000000-0000-0000-0000-000000000000",
    })).toThrow("catalog_target_identity_invalid");
  });
});
