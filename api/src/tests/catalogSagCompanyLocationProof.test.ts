import { describe, expect, it, vi } from "vitest";
import { deriveCatalogSagCompanyLocationToken, matchesCatalogSagCompanyLocation } from "../lib/catalogSagCompanyLocationProof";

const scope = Object.freeze({ environment: "qa" as const, sourceId: "04734EC7-5A82-445A-A3FA-1B2DB7DFC500",
  companyRecordId: -2147483648, matchKeyVersion: 4 });
const profile = Object.freeze({ serverHost: "SAG-Tenant.Example.Invalid", serverPort: 15433, databaseName: "Tenant_A QA" });
const location = Object.freeze({ status: "candidate", host: "sag-tenant.example.invalid", port: 15433, databaseName: "Tenant_A QA" });
const fixtureDigest = "8173075cfc423327c3c982d12f28379d51fb3f5eb2d799dcbb06c26d8a1fc54e";
const key = () => Buffer.alloc(32, 7);

describe("SAG Company approved SQL location proof", () => {
  it("reproduces the pre-extraction format byte-for-byte and matches an explicit canonical profile", () => {
    const matchingKey = key();
    expect(deriveCatalogSagCompanyLocationToken(scope, matchingKey, location)).toBe(fixtureDigest);
    expect(matchesCatalogSagCompanyLocation(scope, matchingKey, fixtureDigest, profile)).toBe(true);
    expect(matchesCatalogSagCompanyLocation(scope, matchingKey, Buffer.from(fixtureDigest, "hex"), profile)).toBe(true);
    expect(matchingKey.equals(key())).toBe(true);
  });

  it.each([
    { ...scope, environment: "production" }, { ...scope, sourceId: "de150de0-0739-40fb-a6ae-89d3735eb2c8" },
    { ...scope, companyRecordId: -2147483647 }, { ...scope, matchKeyVersion: 5 },
  ])("cannot reuse a proof outside its exact scope %j", changed => {
    expect(matchesCatalogSagCompanyLocation(changed, key(), fixtureDigest, profile)).toBe(false);
  });

  it("requires the exact observed host, explicit port, catalog spelling and match-key bytes", () => {
    for (const changed of [{ ...profile, serverHost: "alias.example.invalid" }, { ...profile, serverPort: 1433 },
      { ...profile, databaseName: "tenant_A QA" }, { ...profile, databaseName: "Tenant_A  QA" }]) {
      expect(matchesCatalogSagCompanyLocation(scope, key(), fixtureDigest, changed)).toBe(false);
    }
    expect(matchesCatalogSagCompanyLocation(scope, Buffer.alloc(32, 8), fixtureDigest, profile)).toBe(false);
  });

  it("rejects malformed tokens, missing observations or unsupported profile notation without attempting alternatives", () => {
    for (const token of [null, undefined, fixtureDigest.toUpperCase(), fixtureDigest + " ", fixtureDigest + "\n",
      fixtureDigest.slice(0, 62), Buffer.alloc(31, 7), Buffer.alloc(33, 7), Buffer.alloc(32, 7), new Uint8Array(32)]) {
      expect(matchesCatalogSagCompanyLocation(scope, key(), token, profile)).toBe(false);
    }
    for (const changed of [null, { ...profile, serverHost: "sag-tenant.example.invalid." },
      { ...profile, serverHost: " SAG-Tenant.Example.Invalid " }, { ...profile, serverHost: "sag-tenant.example.invalid,15433" },
      { ...profile, serverHost: "tcp:sag-tenant.example.invalid" }, { ...profile, serverHost: "sag-tenant.example.invalid\\Instance" },
      { ...profile, serverHost: "127.0.0.1" }, { ...profile, serverHost: "localhost" },
      { ...profile, serverHost: "Ｓag-tenant.example.invalid" }, { ...profile, serverPort: undefined },
      { ...profile, serverPort: "15433" }, { ...profile, serverPort: 0 }, { ...profile, serverPort: 65536 },
      { ...profile, databaseName: " Tenant_A QA" }, { ...profile, databaseName: "Tenant_A QA\n" },
      { ...profile, password: "synthetic-not-a-profile-field" }]) {
      expect(matchesCatalogSagCompanyLocation(scope, key(), fixtureDigest, changed)).toBe(false);
    }
  });

  it("fails closed for malformed scope, key and location evidence without invoking property getters", () => {
    for (const invalidScope of [null, { ...scope, sourceId: "00000000-0000-0000-0000-000000000000" },
      { ...scope, sourceId: scope.sourceId + "\n" }, { ...scope, environment: "QA" },
      { ...scope, matchKeyVersion: 0 }, { ...scope, matchKeyVersion: "4" }, { ...scope, matchKeyVersion: 32768 },
      { ...scope, companyRecordId: -2147483649 }, { ...scope, companyRecordId: 1.5 }]) {
      expect(deriveCatalogSagCompanyLocationToken(invalidScope, key(), location)).toBeNull();
      expect(matchesCatalogSagCompanyLocation(invalidScope, key(), fixtureDigest, profile)).toBe(false);
    }
    expect(deriveCatalogSagCompanyLocationToken(scope, Buffer.alloc(31), location)).toBeNull();
    expect(deriveCatalogSagCompanyLocationToken(scope, new Uint8Array(32), location)).toBeNull();
    const get = vi.fn(() => { throw new Error("synthetic prohibited accessor"); });
    const accessor = Object.defineProperty({ ...profile }, "serverHost", { get, enumerable: true });
    expect(matchesCatalogSagCompanyLocation(scope, key(), fixtureDigest, accessor)).toBe(false);
    expect(deriveCatalogSagCompanyLocationToken(scope, key(), Object.defineProperty({ ...location }, "host", { get, enumerable: true }))).toBeNull();
    expect(deriveCatalogSagCompanyLocationToken(scope, key(), { status: "unverified", host: null, port: null, databaseName: null })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
