import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogDocumentKey } from "../lib/catalogCustomerDirectory";
import {
  readCatalogExternalSource, verifyCatalogExternalSource,
  type CatalogExternalContract,
  type CatalogExternalReadSession,
  type CatalogExternalReadStatement,
  type CatalogExternalSourceTransport,
} from "../lib/catalogExternalSourceQueries";

const validSchema = [{ compatible: true, readOnly: true }];
const noSagEvidence = { domainCandidate: null, testStartedOn: null, productionStartedOn: null, demoStartedOn: null };
const erpRow = (sourceRecordId: number, activeCode: string | null = "S", documentNumber: string | null = "001234") =>
  ({ sourceRecordId, officialName: "Nombre ERP", activeCode, documentNumber });

function fake(pages: (statement: CatalogExternalReadStatement) => readonly unknown[] | Promise<readonly unknown[]>, options: {
  schema?: readonly unknown[] | (() => Promise<readonly unknown[]>);
  consistency?: CatalogExternalReadSession["consistency"];
  setupMs?: number;
} = {}) {
  const select = vi.fn(async (request: CatalogExternalReadStatement) => request.tag === "schema"
    ? typeof options.schema === "function" ? options.schema() : options.schema ?? validSchema
    : pages(request));
  const withConsistentRead = vi.fn();
  const transport: CatalogExternalSourceTransport = {
    withConsistentRead(request, read) {
      withConsistentRead(request);
      const session = { select, consistency: options.consistency ?? "verified" };
      if (options.setupMs === undefined) return read(session);
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(read(session)), options.setupMs);
        request.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });
    },
  };
  return { transport, select, withConsistentRead };
}

describe("catalog verified external contracts", () => {
  it("probes schema and at most one row without returning data or reading an elevated source", async () => {
    const valid = fake(() => [erpRow(1)]);
    expect(await verifyCatalogExternalSource(valid.transport, "erp_v1")).toBe("verified");
    expect(valid.select.mock.calls.map(([query]) => query.parameters)).toEqual([{}, { afterId: null, pageSize: 1 }]);
    const writable = fake(() => [erpRow(1)], { schema: [{ compatible: true, readOnly: false }] });
    expect(await verifyCatalogExternalSource(writable.transport, "erp_v1")).toBe("not_read_only");
    expect(writable.select).toHaveBeenCalledTimes(1);
  });
  it("checks table shapes and read-only permissions before a parameterized ERP keyset scan", async () => {
    const { transport, select, withConsistentRead } = fake(request => request.parameters.afterId === null
      ? [erpRow(5), erpRow(10, " n ")] : [erpRow(17, "?", "12.34")]);
    const result = await readCatalogExternalSource(transport, "erp_v1", { pageSize: 2 });
    expect(result).toEqual({ status: "complete", records: [erpRow(5), erpRow(10, "N"), erpRow(17, null, null)] });
    expect(withConsistentRead).toHaveBeenCalledTimes(1);
    const requests = select.mock.calls.map(call => call[0]);
    expect(requests[0].sql).toMatch(/sys\.indexes/);
    expect(requests[0].sql).toMatch(/IS_ROLEMEMBER\(N'db_owner'\) = 0/);
    expect(requests[0].sql).toMatch(/sys\.fn_my_permissions\(QUOTENAME\(ownerSchema\.name\)/);
    expect(requests[0].sql).toMatch(/effective\.permission_name IN \('INSERT','UPDATE','DELETE','ALTER','CONTROL','EXECUTE'/);
    expect(requests[1].sql).toMatch(/FROM dbo\.clientes AS c\s+LEFT JOIN dbo\.terceros AS t ON t\.ka_nl_tercero = c\.ka_nl_tercero/);
    expect(requests[1].sql).toMatch(/TOP \(@pageSize\)[\s\S]*> @afterId[\s\S]*ORDER BY c\.ka_nl_tercero ASC/);
    expect(requests.map(request => request.parameters)).toEqual([{}, { afterId: null, pageSize: 2 }, { afterId: 10, pageSize: 2 }]);
    expect(requests.map(request => request.timeoutMs)).toEqual([30_000, 4000, 4000]);
    expect(requests.every(request => request.sql.startsWith("SELECT"))).toBe(true);
  });

  it("returns SAG document and country evidence without inventing the issuer, environment or module membership", async () => {
    const { transport, select } = fake(() => [
      { sourceRecordId: 1, documentNumber: " 00123-A ", reportedCountryId: 4, environment: " Producción ", licensedModules: "B,A;B|D",
        ...noSagEvidence, domainCandidate: "tenant.example", productionStartedOn: "2026-01-01" },
      { sourceRecordId: 2, documentNumber: "00123-A", reportedCountryId: 7, environment: "qa", licensedModules: "", ...noSagEvidence },
      { sourceRecordId: 3, documentNumber: null, reportedCountryId: null, environment: "other", licensedModules: "A9", ...noSagEvidence },
    ]);
    const result = await readCatalogExternalSource(transport, "sag_admin_v1");
    expect(result).toEqual({ status: "complete", records: [
      { sourceRecordId: 1, documentNumber: "00123-A", reportedCountryId: 4, environment: "production", licenseCodes: ["A", "B", "D"],
        ...noSagEvidence, domainCandidate: "tenant.example", productionStartedOn: "2026-01-01" },
      { sourceRecordId: 2, documentNumber: "00123-A", reportedCountryId: 7, environment: "test", licenseCodes: [], ...noSagEvidence },
      { sourceRecordId: 3, documentNumber: null, reportedCountryId: null, environment: "unknown", licenseCodes: null, ...noSagEvidence },
    ] });
    expect(select.mock.calls[1][0].sql).toMatch(/FROM dbo\.Customers/);
    const statement = select.mock.calls[1][0].sql;
    expect(statement).not.toMatch(/StringConnection|Companies|SELECT \*|c\.Url AS|FechasEnvironment AS/i);
    expect(statement).toContain("THEN CONVERT(varchar(253),LOWER(host.candidate");
    expect(statement).toContain("AND DATALENGTH(item.[key])=CASE");
    expect(catalogDocumentKey({ issuer: "", type: "NIT", number: "00123-A" })).toBeNull();
    expect(catalogDocumentKey({ issuer: "CO", type: "NIT", number: "00123-A" })).not.toBe(
      catalogDocumentKey({ issuer: "PE", type: "NIT", number: "00123-A" }));
  });

  it("distinguishes a certified empty catalog from an inaccessible or inconsistent source", async () => {
    const empty = fake(() => []);
    expect(await readCatalogExternalSource(empty.transport, "erp_v1")).toEqual({ status: "complete", records: [] });
    const inconsistent = fake(() => [], { consistency: "unverified" });
    expect(await readCatalogExternalSource(inconsistent.transport, "erp_v1")).toEqual({ status: "unavailable", reason: "consistency_unverified" });
    expect(inconsistent.select).not.toHaveBeenCalled();
  });

  it("rejects unknown contract names, unauthorized schemas, and access with write permissions before reading rows", async () => {
    const unknown = fake(() => []);
    expect(await readCatalogExternalSource(unknown.transport, "dbo.other" as CatalogExternalContract)).toEqual({ status: "unavailable", reason: "contract_unapproved" });
    expect(unknown.withConsistentRead).not.toHaveBeenCalled();
    const incompatible = fake(() => [], { schema: [{ compatible: false, readOnly: false }] });
    expect(await readCatalogExternalSource(incompatible.transport, "erp_v1")).toEqual({ status: "unavailable", reason: "schema_unverified" });
    const malformed = fake(() => [], { schema: [{ compatible: true }] });
    expect(await readCatalogExternalSource(malformed.transport, "erp_v1")).toEqual({ status: "unavailable", reason: "schema_unverified" });
    const writable = fake(() => [], { schema: [{ compatible: true, readOnly: false }] });
    expect(await readCatalogExternalSource(writable.transport, "erp_v1")).toEqual({ status: "unavailable", reason: "write_access" });
    expect(incompatible.select).toHaveBeenCalledTimes(1);
    expect(writable.select).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate or out-of-order rows without publishing the accepted prefix", async () => {
    for (const last of [erpRow(1), erpRow(0)]) {
      const { transport, select } = fake(req => req.parameters.afterId === null ? [erpRow(1)] : [last]);
      expect(await readCatalogExternalSource(transport, "erp_v1", { pageSize: 1 })).toEqual({ status: "unavailable", reason: "invalid_rows" });
      expect(select).toHaveBeenCalledTimes(3);
    }
  });

  it("does not publish unexpected/malformed rows or expose their values", async () => {
    for (const invalid of [{ ...erpRow(1), unexpected: "PRIVATE" }, { ...erpRow(1), sourceRecordId: "1" }]) {
      const { transport } = fake(() => [invalid]);
      expect(await readCatalogExternalSource(transport, "erp_v1")).toEqual({ status: "unavailable", reason: "invalid_rows" });
    }
  });

  it("checks for a sentinel row at the cap instead of publishing a truncated set", async () => {
    const { transport, select } = fake(req => req.parameters.afterId === null ? [erpRow(1), erpRow(2)] : [erpRow(3)]);
    expect(await readCatalogExternalSource(transport, "erp_v1", { maxRows: 2, pageSize: 2 })).toEqual({ status: "unavailable", reason: "row_limit" });
    expect(select.mock.calls[2][0].parameters).toEqual({ afterId: 2, pageSize: 1 });
    const exactly = fake(req => req.parameters.afterId === null ? [erpRow(1), erpRow(2)] : []);
    expect(await readCatalogExternalSource(exactly.transport, "erp_v1", { maxRows: 2, pageSize: 2 })).toEqual({ status: "complete", records: [erpRow(1), erpRow(2)] });
  });

  it("discards partial rows when a later page errors, without leaking the transport error", async () => {
    const { transport } = fake(req => {
      if (req.parameters.afterId === null) return [erpRow(1)];
      throw new Error("INTERNAL HOST, credential and SQL details never belong in the response");
    });
    expect(await readCatalogExternalSource(transport, "erp_v1", { pageSize: 1 })).toEqual({ status: "unavailable", reason: "connection_failed" });
  });

  it("bounds each page and aborts transport even when a response hangs", async () => {
    let interrupted = false;
    const { transport } = fake(req => {
      if (req.parameters.afterId === null) return [erpRow(1)];
      req.signal.addEventListener("abort", () => { interrupted = true; });
      return new Promise(() => {});
    });
    expect(await readCatalogExternalSource(transport, "erp_v1", { pageSize: 1, statementTimeoutMs: 20, totalTimeoutMs: 1000 }))
      .toEqual({ status: "unavailable", reason: "timeout" });
    expect(interrupted).toBe(true);
  });

  it("bounds connection setup and accepts external cancellation", async () => {
    let interrupted = false;
    const transport: CatalogExternalSourceTransport = {
      withConsistentRead: ({ signal }) => {
        signal.addEventListener("abort", () => { interrupted = true; });
        return new Promise(() => {});
      },
    };
    expect(await readCatalogExternalSource(transport, "erp_v1", { totalTimeoutMs: 20 })).toEqual({ status: "unavailable", reason: "timeout" });
    expect(interrupted).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(await readCatalogExternalSource(transport, "erp_v1", { signal: controller.signal })).toEqual({ status: "unavailable", reason: "cancelled" });
  });
});

const delayedSchema = () => new Promise<readonly unknown[]>(resolve => setTimeout(() => resolve(validSchema), 22_393));
const hangs = () => new Promise<readonly unknown[]>(() => {});
const executionModes = [
  ["verification", 45_000, 21_500, "verified", "unavailable"],
  ["refresh", 45_000, 21_500, { status: "complete", records: [erpRow(1)] }, { status: "unavailable", reason: "timeout" }],
] as const;

describe("external schema and page budgets", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe.each(executionModes)("%s", (mode, totalMs, setupMs, complete, timeout) => {
    const run = (transport: CatalogExternalSourceTransport, signal?: AbortSignal) => mode === "verification"
      ? verifyCatalogExternalSource(transport, "erp_v1", signal)
      : readCatalogExternalSource(transport, "erp_v1", { signal });

    it("accepts the observed 22,393ms ERP schema check without relaxing the page or permissions check", async () => {
      const { transport, withConsistentRead, select } = fake(() => [erpRow(1)], { schema: delayedSchema });
      const pending = run(transport);
      await vi.advanceTimersByTimeAsync(22_393);
      expect(await pending).toEqual(complete);
      expect(withConsistentRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ timeoutMs: totalMs }));
      expect(select.mock.calls.map(([statement]) => [statement.tag, statement.timeoutMs]))
        .toEqual([["schema", 30_000], ["page", 4000]]);
    });

    it("cancels a stalled ERP schema after 30 seconds and never reads a page", async () => {
      const { transport, select } = fake(() => [erpRow(1)], { schema: hangs });
      const done = vi.fn();
      const pending = run(transport).then(value => { done(); return value; });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(timeout);
      expect(select.mock.calls.map(([statement]) => statement.tag)).toEqual(["schema"]);
      expect(select.mock.calls[0][0].signal.aborted).toBe(true);
    });

    it("keeps the default deadline for a stalled page at 4 seconds", async () => {
      const { transport, select } = fake(hangs);
      const done = vi.fn();
      const pending = run(transport).then(value => { done(); return value; });
      await vi.advanceTimersByTimeAsync(3999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(timeout);
      expect(select.mock.calls.map(([statement]) => [statement.tag, statement.timeoutMs]))
        .toEqual([["schema", 30_000], ["page", 4000]]);
      expect(select.mock.calls[1][0].signal.aborted).toBe(true);
    });

    it("lets the total and caller cancellation interrupt an in-flight schema first", async () => {
      const { transport, select, withConsistentRead } = fake(() => [erpRow(1)], { schema: hangs, setupMs });
      const done = vi.fn();
      const pending = run(transport).then(value => { done(); return value; });
      await vi.advanceTimersByTimeAsync(totalMs - 1);
      expect(done).not.toHaveBeenCalled();
      expect(select.mock.calls.map(([statement]) => statement.tag)).toEqual(["schema"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(timeout);
      expect(withConsistentRead.mock.calls[0][0].signal.aborted).toBe(true);
      expect(select.mock.calls[0][0].signal.aborted).toBe(true);

      const aborting = fake(() => [erpRow(1)], { schema: hangs });
      const caller = new AbortController();
      const interrupted = run(aborting.transport, caller.signal);
      await vi.advanceTimersByTimeAsync(100);
      caller.abort();
      expect(await interrupted).toEqual(mode === "verification" ? "unavailable" : { status: "unavailable", reason: "cancelled" });
      expect(aborting.select.mock.calls.map(([statement]) => statement.tag)).toEqual(["schema"]);
      expect(aborting.select.mock.calls[0][0].signal.aborted).toBe(true);
    });
  });

  it("applies a statement timeout override to pages only, not the schema", async () => {
    const { transport, select } = fake(hangs, { schema: delayedSchema });
    const pending = readCatalogExternalSource(transport, "erp_v1", { statementTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(22_418);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    expect(select.mock.calls.map(([statement]) => [statement.tag, statement.timeoutMs]))
      .toEqual([["schema", 30_000], ["page", 25]]);
    expect(select.mock.calls[1][0].signal.aborted).toBe(true);
  });
});
