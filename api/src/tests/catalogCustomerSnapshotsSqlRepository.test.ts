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

const sqlMocks = vi.hoisted(() => ({ pool: vi.fn(), query: vi.fn(), input: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: sqlMocks.pool }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: sqlMocks.transaction }));
vi.mock("mssql", () => ({ default: { VarChar: vi.fn(), VarBinary: vi.fn(), SmallInt: {}, NVarChar: vi.fn(), Int: {}, MAX: -1,
  Request: class { input = sqlMocks.input; query = sqlMocks.query; } } }));

const erpId = "00000000-0000-4000-8000-000000000001";
const sagId = "00000000-0000-4000-8000-000000000002";
const publicId = "00000000-0000-4000-8000-000000000003";
const date = new Date("2026-01-01T12:34:56.000Z");
const testKey = Buffer.alloc(32, 47);
const documentNumber = "000000000-PROTECTED-FIXTURE";
const token = makeCatalogDocumentNumberToken(testKey, "qa", documentNumber);
const scope: CatalogCustomerSnapshotsReadScope = { environment: "qa", matchKeyVersion: 1, allowedSourceIds: new Set([erpId]) };

const headers: CatalogSnapshotHeaderRow[] = [
  { source_id: erpId, source_role: "erp-customers", display_name: "ERP_QA_Catalog", revision_state: "verified", observed_at: date,
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
  it("requires actor authorization and verified common graph evidence for V2 without altering ERP identity", () => {
    const v2 = { ...scope, includeSagDirectory: true, actorId: "actor-prueba" };
    const reconciled = { rows: [{ customer_id: publicId, display_name: "Cliente ERP",
      sag_record_id: 17, sag_only: false }], sagReady: true, partial: false };
    // Deliberately different SAG exact token: the shared SQL projection has
    // reconciled the scoped CO:NIT alias to the canonical ERP UUID.
    const different = [{ ...records[0] }, { ...records[1], document_number_token: Buffer.alloc(32, 52) }];
    const input = mapCatalogCustomerSnapshots(v2, headers, different, coverage, reconciled);
    expect(buildCatalogCustomerDirectory(input).items[0]).toMatchObject({
      id: publicId, name: "Cliente ERP", state: "active", web: "in_web",
    });
    expect(() => mapCatalogCustomerSnapshots(v2, headers, records, coverage)).toThrow("inconsistente");
    expect(() => mapCatalogCustomerSnapshots({ ...v2, actorId: undefined }, headers, records, coverage, reconciled))
      .toThrow("inconsistente");
  });

  it("does not let withheld or unavailable V2 graph evidence imply positive or negative presence", () => {
    const v2 = { ...scope, includeSagDirectory: true, actorId: "actor-prueba" };
    const input = mapCatalogCustomerSnapshots(v2, headers, records, coverage,
      { rows: [], sagReady: true, partial: true });
    const page = buildCatalogCustomerDirectory(input, { web: "all" });
    expect(page.items[0].web).toBe("unverified");
    expect(page.partial).toBe(true);
    expect(buildCatalogCustomerDirectory(input, { web: "not_in_web" }).items).toHaveLength(0);
    const unavailable = mapCatalogCustomerSnapshots(v2, headers, records, coverage,
      { rows: [{ customer_id: "00000000-0000-4000-8000-000000000099", display_name: "SAG no vigente",
        sag_record_id: 17, sag_only: true }], sagReady: false, partial: true });
    expect(unavailable.sagOnlyCustomers).toEqual([]);
    expect(unavailable.sag.state).toBe("unavailable");
  });

  it("renders only SQL-authorized SAG-only UUIDs and does not leak internal normalized material", () => {
    const v2 = { ...scope, includeSagDirectory: true, actorId: "actor-prueba" };
    const orphan = { customer_id: "00000000-0000-5000-8000-000000000099", display_name: "SAG solamente",
      sag_record_id: 17, sag_only: true };
    const orphanRecords = [records[0], { ...records[1], document_number_token: Buffer.alloc(32, 51) }];
    const input = mapCatalogCustomerSnapshots(v2, headers, orphanRecords, coverage,
      { rows: [orphan], sagReady: true, partial: false });
    const page = buildCatalogCustomerDirectory(input, { state: "unverified" });
    expect(page.items).toMatchObject([{ id: orphan.customer_id, name: orphan.display_name, state: "unverified", sagOnly: true }]);
    expect(JSON.stringify(page)).not.toMatch(/hmac:|normalized|sag_record_id|document/);
  });

  it("revalidates V2 actor ACLs and captured heads in one transactional Portal read", async () => {
    sqlMocks.input.mockReturnThis();
    sqlMocks.transaction.mockImplementationOnce(async work => work({}));
    sqlMocks.query.mockResolvedValueOnce({ recordsets: [headers, records, coverage, [{
      customer_id: publicId, display_name: "Cliente ERP", sag_record_id: 17, sag_only: false,
    }], [{ sag_ready: true, partial: false }]] });
    const input = await readSqlCatalogCustomerSnapshots({ ...scope, actorId: "actor-v2", includeSagDirectory: true });
    expect(buildCatalogCustomerDirectory(input).items[0].id).toBe(publicId);
    expect(sqlMocks.transaction).toHaveBeenCalledTimes(1);
    expect(sqlMocks.input.mock.calls.some(([name, _type, value]) => name === "actorId" && value === "actor-v2")).toBe(true);
    expect(sqlMocks.input.mock.calls.some(([name, _type, value]) => name === "selectedSourceIds" && value === null)).toBe(true);
    const statement = sqlMocks.query.mock.calls.at(-1)![0] as string;
    expect(statement).toContain("@observedAllowed authorized");
    expect(statement).toContain("captured.revision_key=r.revision_key");
    expect(statement).toContain("security.catalog_source_readers");
    expect(statement).toContain("core.catalog_sag_customer_directory_rows");
    expect(statement).not.toMatch(/p\.(?:server_host|server_port|login_name|password_secret_name)\b/);
  });

  it("reads only verified ERP bodies for the V2 Novedades picker under the same live authorization gates", async () => {
    sqlMocks.input.mockReturnThis();
    const tx = {};
    sqlMocks.query.mockResolvedValueOnce({ recordsets: [[{ fingerprint: Buffer.alloc(32, 6), cache_hit: false }], [headers[0]], [records[0]], []] });
    const result = await readSqlCatalogCustomerSnapshots({
      ...scope, actorId: "actor-autocomplete", includeSagDirectory: true, erpAutocomplete: true,
    }, tx as never);
    expect(result.erp[0].customers[0].customerId).toBe(publicId);
    expect(result.sag.state).toBe("unavailable");
    expect(sqlMocks.input.mock.calls.some(([name, _type, value]) => name === "actorId" && value === "actor-autocomplete")).toBe(true);
    const statement = sqlMocks.query.mock.calls.at(-1)![0] as string;
    expect(statement).toContain("security.catalog_source_readers");
    expect(statement).toContain("role.protected_role=1");
    expect(statement).toContain("captured.revision_key=r.revision_key");
    expect(statement).toContain("r.verified_until>@observedNow");
    expect(statement).toContain("WHERE e.source_role='erp-customers'");
    expect(statement).not.toMatch(/INSERT @observed(?:Erp|Sag|Identity)\b/);
    expect(statement).not.toMatch(/p\.(?:server_host|server_port|login_name|password_secret_name)\b/);
  });

  it("revalidates immutable memo bodies on each read, with no cross-actor or revoked revision fallback", async () => {
    sqlMocks.input.mockReturnThis();
    const tx = {} as never;
    const stampA = Buffer.alloc(32, 5), stampB = Buffer.alloc(32, 7), stampC = Buffer.alloc(32, 9);
    const qa = { ...scope, actorId: "memo-actor-a", includeSagDirectory: true, erpAutocomplete: true };
    const loaded = (fingerprint: Buffer, cache_hit: boolean, head = headers[0], rows = [records[0]]) => ({
      recordsets: [[{ fingerprint, cache_hit }], [head], rows, []],
    });
    const sentFingerprint = () => sqlMocks.input.mock.calls.filter(([name]) => name === "pickerFingerprint").at(-1)?.[2];
    sqlMocks.query.mockResolvedValueOnce(loaded(stampA, false));
    await readSqlCatalogCustomerSnapshots(qa, tx);
    expect(sentFingerprint()).toBeNull();
    sqlMocks.query.mockResolvedValueOnce(loaded(stampA, true, headers[0], []));
    expect((await readSqlCatalogCustomerSnapshots(qa, tx)).erp[0].customers[0].customerId).toBe(publicId);
    expect(sentFingerprint()).toEqual(stampA);
    sqlMocks.query.mockResolvedValueOnce(loaded(stampB, false));
    await readSqlCatalogCustomerSnapshots({ ...qa, actorId: "memo-actor-b" }, tx);
    expect(sentFingerprint()).toBeNull();
    sqlMocks.query.mockResolvedValueOnce(loaded(stampC, false, {
      ...headers[0], revision_state: "unavailable", observed_at: null, expected_rows: 0,
    }, []));
    expect((await readSqlCatalogCustomerSnapshots(qa, tx)).erp[0].customers).toEqual([]);
    expect(sentFingerprint()).toEqual(stampA);
    sqlMocks.query.mockRejectedValueOnce(new Error("QA simulated outage"));
    await expect(readSqlCatalogCustomerSnapshots(qa, tx)).rejects.toThrow("inconsistente");
    expect(sentFingerprint()).toBeNull();
  });
  it("joins matching protected tokens by scope without exposing the original value, token or SAG records", () => {
    const input = mapCatalogCustomerSnapshots(scope, headers, records, coverage);
    const page = buildCatalogCustomerDirectory(input);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: publicId, name: "Cliente ERP", state: "active", web: "in_web" });
    expect(page.sources).toEqual([{ sourceId: erpId, label: "ERP_QA_Catalog", revisionState: "verified", verifiedAt: date.toISOString() }]);
    expect(page.items[0].sources).toEqual([expect.objectContaining({ sourceId: erpId, label: "ERP_QA_Catalog" })]);
    expect(JSON.stringify(input)).not.toContain(documentNumber);
    expect(JSON.stringify(page)).not.toMatch(/hmac:|SAG QA/);
    expect(JSON.stringify(page)).not.toContain(sagId);
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
    expect(sqlMocks.input.mock.calls.slice(-4).map(([name, _type, value]) => [name, value])).toEqual([
      ["environment", "qa"], ["matchKeyVersion", 1], ["allowedSourceIds", JSON.stringify([erpId])], ["rowLimit", 100000],
    ]);
    const statement = sqlMocks.query.mock.calls.at(-1)![0];
    expect(statement).toMatch(/INSERT INTO @eligible/);
    expect(statement).toMatch(/CASE WHEN b\.source_role='erp-customers' THEN p\.database_name ELSE b\.display_name END/);
    expect(statement).toMatch(/b\.source_role='sag-admin' OR \(b\.source_role='erp-customers'\s+AND EXISTS \(SELECT 1 FROM OPENJSON\(@allowedSourceIds\)/);
    expect(statement).not.toMatch(/p\.(?:server_host|server_port|login_name|password_secret_name)\b/);
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
