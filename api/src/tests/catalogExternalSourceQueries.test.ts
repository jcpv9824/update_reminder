import { describe, expect, it, vi } from "vitest";
import { catalogDocumentKey } from "../lib/catalogCustomerDirectory";
import {
  readCatalogExternalSource,
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
  schema?: readonly unknown[]; consistency?: CatalogExternalReadSession["consistency"];
} = {}) {
  const select = vi.fn(async (request: CatalogExternalReadStatement) => request.tag === "schema" ? options.schema ?? validSchema : pages(request));
  const withConsistentRead = vi.fn();
  const transport: CatalogExternalSourceTransport = {
    withConsistentRead(request, read) {
      withConsistentRead(request);
      return read({ select, consistency: options.consistency ?? "verified" });
    },
  };
  return { transport, select, withConsistentRead };
}

describe("catalog verified external contracts", () => {
  it("checks table shapes and read-only permissions before a parameterized ERP keyset scan", async () => {
    const { transport, select, withConsistentRead } = fake(request => request.parameters.afterId === null
      ? [erpRow(5), erpRow(10, " n ")] : [erpRow(17, "?", "12.34")]);
    const result = await readCatalogExternalSource(transport, "erp_v1", { pageSize: 2 });
    expect(result).toEqual({ status: "complete", records: [erpRow(5), erpRow(10, "N"), erpRow(17, null, null)] });
    expect(withConsistentRead).toHaveBeenCalledTimes(1);
    const requests = select.mock.calls.map(call => call[0]);
    expect(requests[0].sql).toMatch(/sys\.indexes/);
    expect(requests[0].sql).toMatch(/IS_ROLEMEMBER\(N'db_owner'\) = 0/);
    expect(requests[1].sql).toMatch(/FROM dbo\.clientes AS c\s+LEFT JOIN dbo\.terceros AS t ON t\.ka_nl_tercero = c\.ka_nl_tercero/);
    expect(requests[1].sql).toMatch(/TOP \(@pageSize\)[\s\S]*> @afterId[\s\S]*ORDER BY c\.ka_nl_tercero ASC/);
    expect(requests.map(request => request.parameters)).toEqual([{}, { afterId: null, pageSize: 2 }, { afterId: 10, pageSize: 2 }]);
    expect(requests.every(request => request.timeoutMs === 4000)).toBe(true);
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
