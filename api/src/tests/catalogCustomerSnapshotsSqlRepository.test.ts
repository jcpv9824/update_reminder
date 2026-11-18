import { describe, expect, it, vi } from "vitest";
import { buildCatalogCustomerDirectory } from "../lib/catalogCustomerDirectory";
import {
  makeCatalogDocumentNumberToken,
  mapCatalogCustomerSnapshots,
  readSqlCatalogCustomerSnapshots,
  type CatalogCustomerSnapshotsReadScope,
  type CatalogSnapshotCoverageRow,
  type CatalogSnapshotCustomerRow,
  type CatalogSnapshotHeaderRow,
} from "../lib/catalogCustomerSnapshotsSqlRepository";

const sqlMocks = vi.hoisted(() => ({ pool: vi.fn(), query: vi.fn(), input: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: sqlMocks.pool }));
vi.mock("mssql", () => ({ default: { VarChar: vi.fn(), SmallInt: {}, NVarChar: vi.fn(), Int: {} } }));

const erpId = "00000000-0000-4000-8000-000000000001";
const sagId = "00000000-0000-4000-8000-000000000002";
const publicId = "00000000-0000-4000-8000-000000000003";
const date = new Date("2026-01-01T12:34:56.000Z");
const testKey = Buffer.alloc(32, 47);
const documentNumber = "000000000-PROTECTED-FIXTURE";
const token = makeCatalogDocumentNumberToken(testKey, "qa", documentNumber);
const scope: CatalogCustomerSnapshotsReadScope = { environment: "qa", matchKeyVersion: 1, allowedSourceIds: new Set([erpId]) };

const headers: CatalogSnapshotHeaderRow[] = [
  { source_id: erpId, source_role: "erp-customers", display_name: "ERP QA", revision_state: "verified", observed_at: date,
    expected_rows: 1, expected_scopes: 0 },
  { source_id: sagId, source_role: "sag-admin", display_name: "SAG QA", revision_state: "verified", observed_at: date,
    expected_rows: 1, expected_scopes: 1 },
];
const records: CatalogSnapshotCustomerRow[] = [
  { source_id: erpId, source_record_id: 12, customer_id: publicId, official_name: "Cliente ERP", active_code: "S",
    issuer: "CO", document_type: "NIT", document_number_token: token },
  { source_id: sagId, source_record_id: 17, customer_id: null, official_name: null, active_code: null,
    issuer: "CO", document_type: "NIT", document_number_token: token },
];
const coverage: CatalogSnapshotCoverageRow[] = [{ source_id: sagId, issuer: "CO", document_type: "NIT" }];

describe("customer catalog published snapshots", () => {
  it("joins matching protected tokens by scope without exposing the original value, token or SAG records", () => {
    const input = mapCatalogCustomerSnapshots(scope, headers, records, coverage);
    const page = buildCatalogCustomerDirectory(input);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: publicId, name: "Cliente ERP", state: "active", web: "in_web" });
    expect(JSON.stringify(input)).not.toContain(documentNumber);
    expect(JSON.stringify(page)).not.toMatch(/hmac:|SAG QA/);
  });

  it("does not certify an absence when the matching number is unresolved or a SAG row is unidentifiable", () => {
    const unresolved = [{ ...records[0] }, { ...records[1], issuer: null, document_type: null }];
    for (const rows of [unresolved, [records[0], { ...unresolved[1], document_number_token: null }]]) {
      const result = buildCatalogCustomerDirectory(mapCatalogCustomerSnapshots(scope, headers, rows, coverage), { web: "all" });
      expect(result.items[0].web).toBe("unverified");
    }
  });

  it("distinguishes a sealed empty scope from missing or stale SAG data", () => {
    const emptyHeader = { ...headers[1], expected_rows: 0 };
    const validEmpty = mapCatalogCustomerSnapshots(scope, [headers[0], emptyHeader], [records[0]], coverage);
    expect(buildCatalogCustomerDirectory(validEmpty, { web: "all" }).items[0].web).toBe("not_in_web");
    const stale = mapCatalogCustomerSnapshots(scope, [headers[0], { ...emptyHeader, revision_state: "stale" }], [records[0]], coverage);
    expect(buildCatalogCustomerDirectory(stale, { web: "all" }).items[0].web).toBe("unverified");
    const missing = mapCatalogCustomerSnapshots(scope, [headers[0]], [records[0]], []);
    expect(missing.sag.state).toBe("unavailable");
    expect(buildCatalogCustomerDirectory(missing, { web: "all" }).items[0].web).toBe("unverified");
  });

  it("refuses leaked, truncated, or malformed revision material without echoing it", () => {
    expect(() => mapCatalogCustomerSnapshots({ ...scope, allowedSourceIds: new Set() }, headers, records, coverage)).toThrow("inconsistente");
    expect(() => mapCatalogCustomerSnapshots(scope, headers, [records[0]], coverage)).toThrow("inconsistente");
    expect(() => mapCatalogCustomerSnapshots(scope, headers, [records[0], { ...records[1], document_number_token: Buffer.from([9]) }],
      coverage)).toThrow("inconsistente");
    expect(() => mapCatalogCustomerSnapshots(scope, headers, records, [...coverage, coverage[0]])).toThrow("inconsistente");
  });

  it("keys exact trimmed numbers by environment and never returns invalid input", () => {
    expect(makeCatalogDocumentNumberToken(testKey, "qa", ` ${documentNumber} `)).toEqual(token);
    expect(makeCatalogDocumentNumberToken(testKey, "production", documentNumber)).not.toEqual(token);
    expect(makeCatalogDocumentNumberToken(testKey, "qa", documentNumber.replace(/^0+/, ""))).not.toEqual(token);
    expect(makeCatalogDocumentNumberToken(testKey, "qa", "with\0control")).toBeNull();
    expect(() => makeCatalogDocumentNumberToken(Buffer.alloc(8), "qa", documentNumber)).toThrow("inconsistente");
  });

  it("uses trusted parameterized scope and captured heads; no matching key or document is sent into Portal SQL", async () => {
    sqlMocks.query.mockResolvedValueOnce({ recordsets: [headers, records, coverage] });
    sqlMocks.pool.mockResolvedValueOnce({ request: () => ({ input: sqlMocks.input, query: sqlMocks.query }) });
    sqlMocks.input.mockReturnThis();
    const input = await readSqlCatalogCustomerSnapshots(scope);
    expect(input.erp).toHaveLength(1);
    expect(sqlMocks.input.mock.calls.map(([name, _type, value]) => [name, value])).toEqual([
      ["environment", "qa"], ["matchKeyVersion", 1], ["allowedSourceIds", JSON.stringify([erpId])], ["rowLimit", 100000],
    ]);
    const statement = sqlMocks.query.mock.calls[0][0];
    expect(statement).toMatch(/INSERT INTO @eligible/);
    expect(statement).toMatch(/r\.match_key_version=@matchKeyVersion/);
    expect(statement).toMatch(/r\.binding_version=b\.row_version/);
    expect(statement).toMatch(/r\.profile_version=p\.row_version/);
    expect(statement).not.toMatch(/AND h\.revision_key IS NOT NULL/);
    expect(statement).not.toContain(erpId);
    expect(statement).not.toContain(documentNumber);
  });

  it("keeps an authorized ERP with no published revision visible as unavailable", () => {
    const missingId = "b3b3526a-ca84-4c20-b964-0be1bd4183b9";
    const input = mapCatalogCustomerSnapshots({ ...scope, allowedSourceIds: new Set([erpId, missingId]) },
      [...headers, { source_id: missingId, source_role: "erp-customers", display_name: "ERP sin verificar",
        revision_state: "unavailable", observed_at: null, expected_rows: 0, expected_scopes: 0 }],
      [{ ...records[0], active_code: "N" }, records[1]], coverage);
    const page = buildCatalogCustomerDirectory(input, { state: "all" });
    expect(page.partial).toBe(true);
    expect(page.sources).toContainEqual(expect.objectContaining({ sourceId: missingId, revisionState: "unavailable" }));
    expect(page.items[0].state).toBe("unverified");
  });
});
