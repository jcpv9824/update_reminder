import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogScheduleLicenseProofLimits, readCatalogScheduleLicenseProof,
  type CatalogScheduleLicenseProofScope } from "../lib/catalogScheduleLicenseProof";
import type { CatalogOperationalLink } from "../lib/catalogOperationalLinksSqlRepository";
import type { CatalogSagCustomerEvidence } from "../lib/catalogSagCustomerEvidenceSqlRepository";

const now = new Date("2026-11-18T14:00:00.000Z");
const customer = "71d304e9-21d9-4acd-a34f-c26222b31b77";
const source = "117fdc31-5137-49db-8109-e881442554d5";
const otherSource = "217fdc31-5137-49db-8109-e881442554d5";
const id = (n: number) => `b1000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const operationalLink = (n = 1, changes: Partial<CatalogOperationalLink> = {}): CatalogOperationalLink => ({
  kind: "domain", linkId: id(n), catalogCustomerId: customer, customerId: "local-client",
  customerName: "Local name is not an identity", domainId: "local-domain", domainName: "https://qa.example.test",
  catalogRecordId: "19", environment: "test", evidence: { state: "verified", sourceId: source,
    revisionId: "9007199254740993", bindingVersion: "0000000000000001", profileVersion: "0000000000000002",
    verifiedUntil: "2026-11-18T15:00:00.000Z" }, ...changes,
} as CatalogOperationalLink);
const claim = { domainCandidate: "qa.example.test", environment: "test" as const, licenseCodes: ["A"],
  testStartedOn: "2026-11-17", productionStartedOn: null, demoStartedOn: null };
const data: CatalogSagCustomerEvidence = { state: "verified", verifiedAt: "2026-11-18T13:59:00.000Z",
  items: [claim], licenseModules: [{ code: "A", moduleId: "module-a", name: "A", description: null },
    { code: "B", moduleId: "module-b", name: "B", description: null }] };
const scope = (links: readonly CatalogOperationalLink[] = [operationalLink()]): CatalogScheduleLicenseProofScope => ({
  portalEnvironment: "qa", matchKeyVersion: 7, date: "2026-11-18", checkedAt: now, links,
});
const reader = (value: CatalogSagCustomerEvidence | null = data) => ({ readEvidence: vi.fn().mockResolvedValue(value) });

describe("bounded schedule license proof adapter", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => vi.useRealTimers());

  it("uses the exact opaque customer, trusted portal environment, explicit key version and singleton verified ERP source", async () => {
    const io = reader();
    const result = await readCatalogScheduleLicenseProof(scope(), io);
    expect(result).toEqual(new Map([[id(1), ["module-a"]]]));
    expect(io.readEvidence).toHaveBeenCalledExactlyOnceWith({ customerId: customer, environment: "qa",
      matchKeyVersion: 7, allowedSourceIds: new Set([source]) });
    expect(JSON.stringify(io.readEvidence.mock.calls)).not.toContain("local-client");
    expect(result.get(id(1))).not.toBe(data.licenseModules);
  });

  it("queries once per customer/source and resolves aliases separately by exact hostname and business environment", async () => {
    const io = reader({ ...data, items: [claim, { ...claim, environment: "production", licenseCodes: ["B"] },
      { ...claim, domainCandidate: "other.example.test", licenseCodes: [] }] });
    const links = [operationalLink(1), operationalLink(2, { environment: "production" }),
      operationalLink(3, { domainName: "https://other.example.test/" }),
      operationalLink(4, { kind: "database", databaseId: "db-4", databaseName: "DB" }),
      operationalLink(5, { domainName: "https://missing.example.test" }), operationalLink(6, { environment: "demo" })];
    expect(await readCatalogScheduleLicenseProof(scope(links), io)).toEqual(new Map([
      [id(1), ["module-a"]], [id(2), ["module-b"]], [id(3), []], [id(4), ["module-a"]], [id(5), null], [id(6), null],
    ]));
    expect(io.readEvidence).toHaveBeenCalledTimes(1);
  });

  it("does not share a customer result across ERP source IDs or different opaque customers", async () => {
    const second = operationalLink(2);
    const third = operationalLink(3, { catalogCustomerId: id(300) });
    const firstProof = operationalLink().evidence;
    expect(firstProof.state).toBe("verified");
    const links = [operationalLink(), { ...second, evidence: { ...firstProof, sourceId: otherSource } } as CatalogOperationalLink, third];
    const io = reader();
    await readCatalogScheduleLicenseProof(scope(links), io);
    expect(io.readEvidence).toHaveBeenCalledTimes(3);
    expect(io.readEvidence.mock.calls.map(([input]) => [input.customerId, [...input.allowedSourceIds]])).toEqual([
      [customer, [source]], [customer, [otherSource]], [id(300), [source]],
    ]);
  });

  it("keeps caches request-local including failures", async () => {
    const io = reader();
    io.readEvidence.mockRejectedValueOnce(new Error("private provider detail"));
    const input = scope([operationalLink(), operationalLink(2)]);
    expect(await readCatalogScheduleLicenseProof(input, io)).toEqual(new Map([[id(1), null], [id(2), null]]));
    expect(await readCatalogScheduleLicenseProof(input, io)).toEqual(new Map([[id(1), ["module-a"]], [id(2), ["module-a"]]]));
    expect(io.readEvidence).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", null], ["stale", { ...data, state: "stale" }],
    ["unavailable", { state: "unavailable", verifiedAt: null, items: [] }],
    ["absent claim", { ...data, items: [] }], ["unknown environment", { ...data, items: [{ ...claim, environment: "unknown" }] }],
    ["unresolved domain", { ...data, items: [{ ...claim, domainCandidate: null }] }],
    ["unknown codes", { ...data, items: [{ ...claim, licenseCodes: null }] }],
    ["missing mappings", { ...data, licenseModules: [] }],
    ["equal duplicate claims", { ...data, items: [claim, { ...claim }] }],
    ["conflicting duplicate claims", { ...data, items: [claim, { ...claim, licenseCodes: ["B"] }] }],
    ["duplicate mappings", { ...data, licenseModules: [data.licenseModules![0], data.licenseModules![0]] }],
    ["noncanonical codes", { ...data, items: [{ ...claim, licenseCodes: ["A", "A"] }] }],
    ["future observation", { ...data, verifiedAt: "2026-11-18T14:01:00.000Z" }],
    ["malformed observation", { ...data, verifiedAt: "invalid" }],
    ["malformed item", { ...data, items: [null] }],
    ["item overflow", { ...data, items: Array.from({ length: 129 }, () => claim) }],
  ])("holds %s instead of interpreting it as an empty license set", async (_label, value) => {
    const io = reader(value as CatalogSagCustomerEvidence | null);
    expect((await readCatalogScheduleLicenseProof(scope(), io)).get(id(1))).toBeNull();
  });

  it("returns [] only for a single verified exact explicitly empty claim", async () => {
    const io = reader({ ...data, items: [{ ...claim, licenseCodes: [] }], licenseModules: undefined });
    expect((await readCatalogScheduleLicenseProof(scope(), io)).get(id(1))).toEqual([]);
  });

  it.each(["http://qa.example.test", "qa.example.test", "https://user@qa.example.test", "https://qa.example.test:443",
    "https://qa.example.test/path", "https://qa.example.test?query=x", "https://qa.example.test#fragment",
    "https://127.0.0.1", "https://localhost", "https://[::1]", "https://qa.example.test.",
    " https://qa.example.test", "https://qa.example.test\n", "https://qa%2eexample.test", "https://éxample.test",
    "https://qa.example.test\\ignored", "https://qa..example.test",
  ])("does not infer a hostname license from unsafe or noncanonical URL %j", async domainName => {
    const io = reader();
    expect((await readCatalogScheduleLicenseProof(scope([operationalLink(1, { domainName })]), io)).get(id(1))).toBeNull();
    expect(io.readEvidence).not.toHaveBeenCalled();
  });

  it("canonicalizes DNS casing and permits only the optional root slash", async () => {
    const io = reader();
    expect((await readCatalogScheduleLicenseProof(scope([operationalLink(1, { domainName: "https://QA.Example.Test/" })]), io)).get(id(1)))
      .toEqual(["module-a"]);
  });

  it("retains unverified/expired/malformed source rows as holds without querying SAG", async () => {
    const base = operationalLink();
    const links = [operationalLink(1, { evidence: { state: "unverifiable" } }),
      operationalLink(2, { evidence: { ...base.evidence, verifiedUntil: now.toISOString() } as CatalogOperationalLink["evidence"] }),
      operationalLink(3, { evidence: { ...base.evidence, sourceId: "wrong" } as CatalogOperationalLink["evidence"] }),
      operationalLink(4, { catalogCustomerId: "wrong" }),
      operationalLink(5, { evidence: { ...base.evidence, revisionId: "9223372036854775808" } as CatalogOperationalLink["evidence"] })];
    const io = reader();
    expect([...(await readCatalogScheduleLicenseProof(scope(links), io)).values()]).toEqual([null, null, null, null, null]);
    expect(io.readEvidence).not.toHaveBeenCalled();
  });

  it("rechecks every 042 expiry after all awaited groups, not merely after its own read", async () => {
    const expires = operationalLink(1, { evidence: { ...operationalLink().evidence,
      verifiedUntil: "2026-11-18T14:00:05.000Z" } as CatalogOperationalLink["evidence"] });
    const other = operationalLink(2, { catalogCustomerId: id(200) });
    const io = reader();
    io.readEvidence.mockImplementationOnce(async () => data).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-11-18T14:00:10.000Z"));
      return data;
    });
    expect(await readCatalogScheduleLicenseProof(scope([expires, other]), io)).toEqual(new Map([
      [id(1), null], [id(2), ["module-a"]],
    ]));
  });

  it("caps concurrent unique-customer queries at four", async () => {
    const links = Array.from({ length: 11 }, (_, i) => operationalLink(i + 1, { catalogCustomerId: id(i + 100) }));
    let active = 0, peak = 0;
    const release: Array<() => void> = [];
    const io = { readEvidence: vi.fn(() => new Promise<CatalogSagCustomerEvidence>(resolve => {
      active++; peak = Math.max(peak, active);
      release.push(() => { active--; resolve(data); });
    })) };
    const pending = readCatalogScheduleLicenseProof(scope(links), io);
    expect(io.readEvidence).toHaveBeenCalledTimes(4);
    for (let batch = 0; batch < 3; batch++) {
      release.splice(0).forEach(done => done());
      await Promise.resolve();
    }
    const result = await pending;
    expect(peak).toBe(4);
    expect(io.readEvidence).toHaveBeenCalledTimes(11);
    expect([...result.values()]).toEqual(links.map(() => ["module-a"]));
  });

  it("holds all groups on workload overflow before the first read, never truncating or partially resolving", async () => {
    expect(catalogScheduleLicenseProofLimits).toEqual({ links: 5000, customerSources: 500, concurrency: 4 });
    const links = Array.from({ length: 501 }, (_, i) => operationalLink(i + 1, { catalogCustomerId: id(i + 1000) }));
    const io = reader();
    const result = await readCatalogScheduleLicenseProof(scope(links), io);
    expect(result.size).toBe(501);
    expect([...result.values()].every(value => value === null)).toBe(true);
    expect(io.readEvidence).not.toHaveBeenCalled();
  });

  it("accepts the exact unique-customer workload bound", async () => {
    const io = reader();
    const links = Array.from({ length: 500 }, (_, i) => operationalLink(i + 1, { catalogCustomerId: id(i + 1000) }));
    expect((await readCatalogScheduleLicenseProof(scope(links), io)).size).toBe(500);
    expect(io.readEvidence).toHaveBeenCalledTimes(500);
  });

  it.each([0, -1, 1.5, 32768, undefined, "7"])("rejects invalid or implicit match-key version %j before querying", async matchKeyVersion => {
    const io = reader();
    await expect(readCatalogScheduleLicenseProof({ ...scope(), matchKeyVersion } as CatalogScheduleLicenseProofScope, io))
      .rejects.toThrow("catalog_schedule_license_scope_unavailable");
    expect(io.readEvidence).not.toHaveBeenCalled();
  });

  it("rejects duplicate link IDs, overall link overflow and absent portal environment before querying", async () => {
    const io = reader();
    for (const input of [scope([operationalLink(), operationalLink()]),
      scope(Array.from({ length: 5001 }, (_, i) => operationalLink(i + 1))),
      { ...scope(), portalEnvironment: undefined }, { ...scope(), checkedAt: new Date("invalid") }]) {
      await expect(readCatalogScheduleLicenseProof(input as CatalogScheduleLicenseProofScope, io))
        .rejects.toThrow("catalog_schedule_license_scope_unavailable");
    }
    expect(io.readEvidence).not.toHaveBeenCalled();
  });
});
