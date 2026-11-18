import { describe, expect, it } from "vitest";
import { normalizeCatalogSagInventoryEvidence } from "../lib/catalogSagInventoryEvidence";

const asOf = "2026-11-17";
const row = {
  domainCandidate: "WEB-APP.Example.COM",
  environment: " Pruebas ",
  licenseCodes: ["Z", "A", "S", "A"],
  testStartedOn: "2026-10-29",
  productionStartedOn: null,
  demoStartedOn: "2024-02-29",
};

describe("SAG Admin inventory evidence display projection", () => {
  it("only returns contracted evidence; strips unrelated metadata by shape", () => {
    const unchecked = {
      ...row, document: "synthetic-private", connection: "synthetic-private",
      companyRecordId: 925, anotherPayload: { synthetic: "private" },
    };
    expect(normalizeCatalogSagInventoryEvidence(unchecked, asOf)).toEqual({
      domainCandidate: "web-app.example.com", environment: "test", licenseCodes: ["A", "S", "Z"],
      testStartedOn: "2026-10-29", productionStartedOn: null, demoStartedOn: "2024-02-29",
    });
  });

  it.each([
    "https://example.test", "user@example.test", "example.test:8443", "example.test/path",
    "example.test?session=private", "example.test#anchor", "example.test\\path", "exa_mple.test",
    "example.test\n", "éxample.test", "127.0.0.1", "::1", "localhost",
    "example..test", "example.test.", "-example.test", "example-.test", "a".repeat(64) + ".test",
  ])("rejects non-host evidence %s instead of exposing it", domainCandidate => {
    expect(normalizeCatalogSagInventoryEvidence({ ...row, domainCandidate }, asOf).domainCandidate).toBeNull();
  });

  it("marks unsupported environment unknown and preserves demos as distinct", () => {
    expect(normalizeCatalogSagInventoryEvidence({ ...row, environment: "PRODUCCIÓN" }, asOf).environment).toBe("production");
    expect(normalizeCatalogSagInventoryEvidence({ ...row, environment: "Demo" }, asOf).environment).toBe("demo");
    expect(normalizeCatalogSagInventoryEvidence({ ...row, environment: "active" }, asOf).environment).toBe("unknown");
  });

  it("distinguishes empty verified module evidence from unsupported or malformed encodings", () => {
    expect(normalizeCatalogSagInventoryEvidence({ ...row, licenseCodes: [] }, asOf).licenseCodes).toEqual([]);
    for (const licenseCodes of [null, ["T"], ["A", "T"], ["a"], ["AZ"], ["A;B"], new Array(2)]) {
      expect(normalizeCatalogSagInventoryEvidence({ ...row, licenseCodes }, asOf).licenseCodes).toBeNull();
    }
  });

  it("does not infer dates from raw datetime, timestamps, wrong calendar days or later evidence", () => {
    for (const testStartedOn of [
      "0001-01-01", "2025-02-29", "2026-02-31", "2026-04-31", "2026-11-18", "2026-11-17T01:00:00Z",
      " 2026-11-17", new Date(asOf), { FechaInicioPruebas: asOf },
    ]) {
      expect(normalizeCatalogSagInventoryEvidence({ ...row, testStartedOn }, asOf).testStartedOn).toBeNull();
    }
    expect(normalizeCatalogSagInventoryEvidence({ ...row, testStartedOn: asOf }, asOf).testStartedOn).toBe(asOf);
    expect(() => normalizeCatalogSagInventoryEvidence(row, "2026-02-30")).toThrow("invalid_catalog_inventory_date");
  });
});
