import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogExternalSelectSql, readCatalogExternalSource, readCatalogSagDiscoveryV2, readCatalogSagDiscoveryV2WithTargets, verifyCatalogExternalSource,
  type CatalogExternalContract, type CatalogExternalReadStatement, type CatalogExternalSourceTransport } from "../lib/catalogExternalSourceQueries";

const ok = [{ compatible: true, readOnly: true }];
const counts = (customerCount: string, companyCount: string) => [{ customerCount, companyCount }];
const customer = (id: number) => ({ sourceRecordId: id, documentNumber: "synthetic", reportedCountryId: 1,
  environment: "production", licensedModules: "S", domainCandidate: "tenant.example.test",
  testStartedOn: null, productionStartedOn: null, demoStartedOn: null });
const company = (companyRecordId: number, customerRecordId: number | null, isAvailable: boolean | null = true) =>
  ({ companyRecordId, customerRecordId, displayName: "Synthetic", isAvailable });
const invalidRows = { status: "unavailable", reason: "invalid_rows" };

function fake(replies: readonly unknown[][], consistency: "verified" | "unverified" = "verified") {
  let next = 0;
  const select = vi.fn(async (_: CatalogExternalReadStatement) => {
    const value = replies[next++];
    if (value === undefined) throw new Error("unexpected statement");
    return value;
  });
  const started = vi.fn();
  const transport: CatalogExternalSourceTransport = {
    withConsistentRead(request, read) { started(request); return read({ consistency, select }); },
  };
  return { transport, select, started };
}

describe("SAG Admin v2 metadata discovery", () => {
  afterEach(() => vi.useRealTimers());

  const targetScope = { environment: "qa" as const, sourceId: "84ac4729-ae25-4a43-9e12-338efe4d14de",
    matchKey: Buffer.alloc(32, 15), matchKeyVersion: 2 };
  const locator = { targetState: "candidate", targetHost: "fixture.example.invalid", targetPort: 54100, targetDatabaseName: "Fixture" };

  it("protects the target of every Company in the same snapshot without returning locations or writing legacy evidence", async () => {
    const io = fake([ok, counts("1", "3"), [customer(1)], [
      { ...company(7, 1), ...locator },
      { ...company(8, 1), ...locator },
      { ...company(9, 222, null), targetState: "unverified", targetHost: null, targetPort: null, targetDatabaseName: null },
    ]]);
    const result = await readCatalogSagDiscoveryV2WithTargets(io.transport, targetScope);
    expect(result).toMatchObject({ status: "complete", companies: [company(7, 1), company(8, 1), company(9, 222, null)],
      targetObservations: [
        { companyRecordId: 7, state: "candidate", locationToken: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { companyRecordId: 8, state: "candidate", locationToken: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { companyRecordId: 9, state: "unverified", locationToken: null },
      ] });
    if (result.status !== "complete") throw new Error("expected receipt");
    expect(result.targetObservations[0].locationToken).not.toEqual(result.targetObservations[1].locationToken);
    expect(JSON.stringify(result)).not.toMatch(/fixture\.example\.invalid|targetDatabaseName|targetHost|targetPort|StringConnection/);
    expect(io.started).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ contract: "sag_admin_v2_targets" }));
    expect(io.select.mock.calls[0][0].sql).toContain("StringConnection");
    expect(io.select.mock.calls.at(-1)?.[0].sql).toContain("sagTarget.databaseName AS targetDatabaseName");
  });

  it("fails without returning any rows on incomplete or unsanitized target lists", async () => {
    for (const companyRows of [[company(1, null)], [{ ...company(1, null), ...locator, targetPort: "54100" }],
      [{ ...company(1, null), ...locator, Password: "synthetic" }], []]) {
      const io = fake([ok, counts("0", "1"), [], companyRows]);
      expect(await readCatalogSagDiscoveryV2WithTargets(io.transport, targetScope)).toEqual(invalidRows);
    }
    const badKey = fake([]);
    expect(await readCatalogSagDiscoveryV2WithTargets(badKey.transport, { ...targetScope, matchKey: Buffer.alloc(31) }))
      .toEqual({ status: "unavailable", reason: "invalid_options" });
    expect(badKey.started).not.toHaveBeenCalled();
  });

  it("binds a target observation to the pinned key, key version, source and environment", async () => {
    const read = (scope: Parameters<typeof readCatalogSagDiscoveryV2WithTargets>[1]) =>
      readCatalogSagDiscoveryV2WithTargets(fake([ok, counts("0", "1"), [], [{ ...company(1, null), ...locator }]]).transport, scope);
    const token = async (scope: Parameters<typeof readCatalogSagDiscoveryV2WithTargets>[1]) => {
      const result = await read(scope);
      if (result.status !== "complete") throw new Error("expected receipt");
      return result.targetObservations[0].locationToken;
    };
    const original = await token(targetScope);
    for (const change of [{ environment: "production" as const }, { matchKeyVersion: 3 },
      { sourceId: "94ac4729-ae25-4a43-9e12-338efe4d14de" }, { matchKey: Buffer.alloc(32, 14) }]) {
      expect(await token({ ...targetScope, ...change })).not.toBe(original);
    }
    const key = Buffer.from(targetScope.matchKey);
    const inflight = token({ ...targetScope, matchKey: key });
    key.fill(14);
    expect(await inflight).toBe(original);
  });

  it("collects every Customer and Company with independent ID cursors and no join or enrichment", async () => {
    const io = fake([ok, counts("2", "3"), [customer(1), customer(3)], [],
      [company(1, 1), company(2, null, false)], [company(3, 900, null)]]);
    expect(await readCatalogSagDiscoveryV2(io.transport, { pageSize: 2 })).toEqual({ status: "complete", customers: [
      { sourceRecordId: 1, documentNumber: "synthetic", reportedCountryId: 1, environment: "production", licenseCodes: ["S"],
        domainCandidate: "tenant.example.test", testStartedOn: null, productionStartedOn: null, demoStartedOn: null },
      { sourceRecordId: 3, documentNumber: "synthetic", reportedCountryId: 1, environment: "production", licenseCodes: ["S"],
        domainCandidate: "tenant.example.test", testStartedOn: null, productionStartedOn: null, demoStartedOn: null },
    ], companies: [company(1, 1), company(2, null, false), company(3, 900, null)] });
    expect(io.started).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ contract: "sag_admin_v2", timeoutMs: 20_000 }));
    expect(io.select.mock.calls.map(([stmt]) => [stmt.tag, stmt.parameters, stmt.timeoutMs])).toEqual([
      ["schema", {}, 15_000], ["counts", {}, 4_000], ["customerPage", { afterId: null, pageSize: 2 }, 4_000],
      ["customerPage", { afterId: 3, pageSize: 1 }, 4_000], ["companyPage", { afterId: null, pageSize: 2 }, 4_000],
      ["companyPage", { afterId: 2, pageSize: 2 }, 4_000],
    ]);
    const sql = io.select.mock.calls[4][0].sql;
    expect(sql).toMatch(/TOP \(@pageSize\)[\s\S]*Id AS companyRecordId[\s\S]*CustomerId AS customerRecordId[\s\S]*\.Name[\s\S]* AS displayName[\s\S]*IsAvailable AS isAvailable/);
    expect(sql).toMatch(/FROM dbo\.Companies[\s\S]*\.Id > @afterId[\s\S]*ORDER BY .*\.Id ASC/);
    expect(sql).not.toMatch(/StringConnection|password|server|databaseName|\bJOIN\b|SELECT \*/i);
    expect(io.select.mock.calls[0][0].sql).toMatch(/dbo\.Companies[\s\S]*IsAvailable[\s\S]*sys\.indexes/);
    expect(io.select.mock.calls[1][0].sql).toMatch(/COUNT_BIG\(\*\)[\s\S]*dbo\.Customers[\s\S]*COUNT_BIG\(\*\)[\s\S]*dbo\.Companies/);
  });

  it("probes even declared empty sets; verified zero is not an absent or failed population", async () => {
    const empty = fake([ok, counts("0", "0"), [], []]);
    expect(await readCatalogSagDiscoveryV2(empty.transport)).toEqual({ status: "complete", customers: [], companies: [] });
    expect(empty.select.mock.calls.slice(2).map(([stmt]) => stmt.parameters)).toEqual([
      { afterId: null, pageSize: 1 }, { afterId: null, pageSize: 1 },
    ]);
    expect(await readCatalogSagDiscoveryV2(fake([ok, []]).transport)).toEqual(invalidRows);
    expect(await readCatalogSagDiscoveryV2(fake([ok]).transport)).toEqual({ status: "unavailable", reason: "connection_failed" });
    expect(await readCatalogSagDiscoveryV2(fake([ok, counts("0", "0"), [], [company(1, null)]]).transport)).toEqual(invalidRows);
  });

  it.each([
    [], [{ customerCount: "1" }], [{ customerCount: "1", companyCount: 1 }], counts("00", "0"), counts("-1", "0"),
    counts("1.0", "0"), counts(" 1", "0"), [...counts("0", "0"), ...counts("0", "0")],
  ].map(value => [value]))("rejects missing, duplicate, or noncanonical count evidence", async value => {
    const io = fake([ok, value]);
    expect(await readCatalogSagDiscoveryV2(io.transport)).toEqual(invalidRows);
    expect(io.select).toHaveBeenCalledTimes(2);
  });

  it("enforces the combined row bound before either scan and still checks EOF at the exact cap", async () => {
    const io = fake([ok, counts("2", "2")]);
    expect(await readCatalogSagDiscoveryV2(io.transport, { maxRows: 3 })).toEqual({ status: "unavailable", reason: "row_limit" });
    expect(io.select).toHaveBeenCalledTimes(2);
    const huge = fake([ok, counts("9223372036854775807", "1")]);
    expect(await readCatalogSagDiscoveryV2(huge.transport)).toEqual({ status: "unavailable", reason: "row_limit" });
    const exact = fake([ok, counts("1", "1"), [customer(1)], [], [company(1, 1)], []]);
    expect((await readCatalogSagDiscoveryV2(exact.transport, { maxRows: 2, pageSize: 1 })).status).toBe("complete");
    const extra = fake([ok, counts("1", "1"), [customer(1)], [], [company(1, 1)], [company(2, 1)]]);
    expect(await readCatalogSagDiscoveryV2(extra.transport, { maxRows: 2, pageSize: 1 })).toEqual(invalidRows);
  });

  it("never returns partial results on short pages or invalid rows in either stream", async () => {
    const failures = [
      [ok, counts("2", "0"), [customer(1)]],
      [ok, counts("2", "0"), [customer(1), customer(1)]],
      [ok, counts("2", "0"), [customer(2), customer(1)]],
      [ok, counts("1", "0"), [customer(-2_147_483_649)]],
      [ok, counts("1", "2"), [customer(1)], [company(1, 1)]],
      [ok, counts("1", "2"), [customer(1)], [company(1, 1), company(1, 1)]],
      [ok, counts("1", "2"), [customer(1)], [company(2, 1), company(1, 1)]],
      [ok, counts("1", "1"), [customer(1)], [company(2_147_483_648, 1)]],
      [ok, counts("1", "1"), [customer(1)], [{ ...company(1, 1), customerRecordId: 2_147_483_648 }]],
      [ok, counts("1", "1"), [customer(1)], [{ ...company(1, 1), isAvailable: 1 }]],
      [ok, counts("1", "1"), [customer(1)], [{ ...company(1, 1), StringConnection: "synthetic prohibited field" }]],
      [ok, counts("1", "1"), [customer(1)], [{ ...company(1, 1), databaseName: "synthetic prohibited field" }]],
      [ok, counts("1", "1"), [{ ...customer(1), password: "synthetic prohibited field" }]],
    ];
    for (const replies of failures) expect(await readCatalogSagDiscoveryV2(fake(replies).transport)).toEqual(invalidRows);
  });

  it("rejects inconsistent or unapproved source permissions without a data statement", async () => {
    const inconsistent = fake([], "unverified");
    expect(await readCatalogSagDiscoveryV2(inconsistent.transport)).toEqual({ status: "unavailable", reason: "consistency_unverified" });
    expect(inconsistent.select).not.toHaveBeenCalled();
    const write = fake([[{ compatible: true, readOnly: false }]]);
    expect(await readCatalogSagDiscoveryV2(write.transport)).toEqual({ status: "unavailable", reason: "write_access" });
    expect(write.select).toHaveBeenCalledTimes(1);
    const unknown = fake([[{ compatible: false, readOnly: true }]]);
    expect(await readCatalogSagDiscoveryV2(unknown.transport)).toEqual({ status: "unavailable", reason: "schema_unverified" });
    expect(unknown.select).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "page-timeout", "total-timeout"])("discards the Customer scan on second-stream %s", async mode => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const io = fake([ok, counts("1", "1"), [customer(1)]]);
    if (mode === "total-timeout") io.select.mockImplementationOnce(() =>
      new Promise(resolve => setTimeout(() => resolve(ok), 14_000)))
      .mockResolvedValueOnce(counts("1", "1"))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve([customer(1)]), 3500)));
    else io.select.mockResolvedValueOnce(ok).mockResolvedValueOnce(counts("1", "1")).mockResolvedValueOnce([customer(1)]);
    io.select.mockImplementationOnce(() => new Promise(() => {}));
    const pending = readCatalogSagDiscoveryV2(io.transport, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(mode === "total-timeout" ? 19_999 : mode === "page-timeout" ? 3999 : 25);
    expect(io.select.mock.calls.map(([stmt]) => stmt.tag)).toEqual(["schema", "counts", "customerPage", "companyPage"]);
    const lastSignal = io.select.mock.calls[3][0].signal;
    expect(lastSignal.aborted).toBe(false);
    if (mode === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: "unavailable", reason: mode === "abort" ? "cancelled" : "timeout" });
    expect(lastSignal.aborted).toBe(true);
  });

  it("does not accept v2 through the existing activation-facing readers or expose cross-contract SQL", async () => {
    const io = fake([]);
    const injected = "sag_admin_v2" as CatalogExternalContract;
    expect(await readCatalogExternalSource(io.transport, injected)).toEqual({ status: "unavailable", reason: "contract_unapproved" });
    expect(await verifyCatalogExternalSource(io.transport, injected)).toBe("unavailable");
    expect(io.started).not.toHaveBeenCalled();
    expect(() => catalogExternalSelectSql("erp_v1", "companyPage")).toThrow("contract_unapproved");
    expect(() => catalogExternalSelectSql("sag_admin_v2", "page")).toThrow("contract_unapproved");
  });
});
