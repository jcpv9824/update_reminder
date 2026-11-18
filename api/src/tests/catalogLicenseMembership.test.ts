import { describe, expect, it } from "vitest";
import { resolveCatalogLicenseModuleIds, type CatalogLicenseEvidence } from "../lib/catalogLicenseMembership";
import type { CatalogSagInventoryEvidence } from "../lib/catalogSagInventoryEvidence";

const domain = "qa.example.test";
const scope = { environment: "test" as const, domain };
const row: CatalogSagInventoryEvidence = { domainCandidate: domain, environment: "test", licenseCodes: ["A"],
  testStartedOn: null, productionStartedOn: null, demoStartedOn: null };
const data: CatalogLicenseEvidence = { state: "verified", items: [row], licenseModules: [
  { code: "A", moduleId: "module-a", name: "Módulo A", description: null },
  { code: "B", moduleId: "module-b", name: "Módulo B", description: null },
] };
describe("certified SAG module scope", () => {
  it("does not borrow licenses from another domain or environment", () => {
    const itemWithB = { ...row, licenseCodes: ["B"] };
    expect(resolveCatalogLicenseModuleIds({ ...data, items: [row,
      { ...itemWithB, environment: "production" }, { ...itemWithB, domainCandidate: "other.example.test" }] }, scope)).toEqual(["module-a"]);
    expect(resolveCatalogLicenseModuleIds(data, { ...scope, domain: "other.example.test" })).toBeNull();
  });

  it("does not treat stale, unmapped or conflicting evidence as a known empty set", () => {
    expect(resolveCatalogLicenseModuleIds({ ...data, state: "stale" }, scope)).toBeNull();
    expect(resolveCatalogLicenseModuleIds({ ...data, licenseModules: [] }, scope)).toBeNull();
    expect(resolveCatalogLicenseModuleIds({ ...data, items: [row, { ...row, licenseCodes: ["B"] }] }, scope)).toBeNull();
    expect(resolveCatalogLicenseModuleIds({ ...data, items: [row, { ...row, domainCandidate: null }] }, scope)).toBeNull();
    expect(resolveCatalogLicenseModuleIds({ ...data, items: [{ ...row, licenseCodes: [] }] }, scope)).toEqual([]);
  });
});
