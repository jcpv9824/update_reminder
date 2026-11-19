import type sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import type { CatalogActiveUserContract } from "../lib/catalogActiveUserSqlReader";
import type { ReportingEnrollmentScope } from "../lib/catalogReportingProfileEnrollment";
import {
  READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL, readCatalogReportingProfileEnrollmentInTransaction,
} from "../lib/catalogReportingProfileEnrollmentSqlReader";

const scope: ReportingEnrollmentScope = {
  portalEnvironment: "qa",
  actorId: "fixture-operator",
  physicalLinkId: "9ac00000-0000-0000-0000-000000000001",
  physicalTargetId: "9bc00000-0000-0000-0000-000000000002",
  reportConnectionId: "fixture-report",
};
const aggregate: CatalogActiveUserContract = { contract: "approved_aggregate_view_v1" };
const statuses: CatalogActiveUserContract = {
  contract: "certified_usuarios_v1", population: "all_rows", activeColumn: "Sc_activo",
  storage: "text", activeValue: "S", inactiveValue: "N",
};
const fixture = () => ({
  ...scope,
  operationalProfileVersion: Buffer.alloc(8, 1), physicalValidUntil: new Date(Date.now() + 60_000),
  expectedIdentityFingerprint: Buffer.alloc(32, 2), profileVersion: Buffer.alloc(8, 3),
  serverHost: "Fixture.Sql.invalid", serverPort: 1433, databaseName: "Fixture",
  username: "fixture_reader", passwordSecretName: "fixture-count-key-ref",
});

const envelope = (...rows: unknown[]) => ({ recordset: rows, recordsets: [rows] });
function driver(result: unknown = envelope(fixture())) {
  const query = vi.fn<(_statement: string) => Promise<unknown>>().mockResolvedValue(result);
  const requests = { query, input: vi.fn((_name: string, _type: unknown, _value: unknown) => undefined) };
  const request = vi.fn(() => requests);
  const transaction = { request } as unknown as sql.Transaction;
  return { transaction, request, input: requests.input, query };
}

describe("locked reporting enrollment snapshot", () => {
  it("binds the entire scope and returns only the saved/authorized server snapshot", async () => {
    const row = fixture();
    const mock = driver(envelope(row));
    const result = await readCatalogReportingProfileEnrollmentInTransaction(mock.transaction, scope, aggregate);
    expect(result).toEqual({
      scope, operationalProfileVersion: Buffer.alloc(8, 1), physicalValidUntil: row.physicalValidUntil,
      expectedIdentityFingerprint: Buffer.alloc(32, 2), evidence: aggregate,
      connection: { profileVersion: Buffer.alloc(8, 3), serverHost: "Fixture.Sql.invalid", serverPort: 1433,
        databaseName: "Fixture", username: "fixture_reader", passwordSecretName: "fixture-count-key-ref" },
    });
    expect(mock.query).toHaveBeenCalledExactlyOnceWith(READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL);
    expect(mock.input.mock.calls.map(([name, _type, value]) => [name, value])).toEqual(Object.entries(scope));
    row.operationalProfileVersion.fill(0);
    row.profileVersion.fill(0);
    row.expectedIdentityFingerprint.fill(0);
    row.physicalValidUntil.setTime(0);
    expect(result?.operationalProfileVersion).toEqual(Buffer.alloc(8, 1));
    expect(result?.expectedIdentityFingerprint).toEqual(Buffer.alloc(32, 2));
    expect(result?.connection.profileVersion).toEqual(Buffer.alloc(8, 3));
    expect(result?.physicalValidUntil.getTime()).toBeGreaterThan(0);
  });

  it("uses fixed SQL, locks current exact identities, and allows a 037 row only for the same target and realm", () => {
    const bound = READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL;
    expect(bound).not.toMatch(/\b(?:EXEC(?:UTE)?|INSERT|UPDATE|DELETE|MERGE|COMMIT|ROLLBACK|OPENROWSET)\b/i);
    expect(bound).toContain("PortalSAGWeb-TEST");
    expect(bound).toContain("N'PortalSAGWeb'");
    expect(bound).toContain("@@TRANCOUNT");
    expect(bound).toContain("transaction_isolation_level=4");
    expect(bound).toContain("(HOLDLOCK)");
    expect(bound).toMatch(/security\.user_roles[\s\S]*r\.protected_role=1/);
    expect(bound).toMatch(/configuration\.integrations\.view[\s\S]*configuration\.integrations\.test_database[\s\S]*configuration\.integrations\.edit_database/);
    expect(bound).toContain("ap.row_version=l.access_profile_version");
    expect(bound).toMatch(/l\.link_id=@physicalLinkId[\s\S]*t\.target_id=@physicalTargetId/);
    expect(bound).toContain("l.valid_until>SYSUTCDATETIME()");
    expect(bound).toContain("p.source_id=@reportConnectionId");
    expect(bound).toContain("p.encrypt_connection=1");
    expect(bound).toContain("t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),ap.initial_catalog))");
    expect(bound).toContain("t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.database_name))");
    expect(bound).toMatch(/settings\.catalog_source_bindings[\s\S]*b\.source_state='active'/);
    expect(bound).toMatch(/settings\.catalog_reporting_profiles[\s\S]*rp\.physical_target_key<>t\.physical_target_key OR rp\.portal_environment<>t\.portal_environment/);
    expect(bound).not.toMatch(/(?:fixture-operator|fixture-report|password_hash|database_guid)/i);
  });

  it("copies the operator's reviewed count contract but never binds it as a SQL identifier", async () => {
    const mock = driver();
    const result = await readCatalogReportingProfileEnrollmentInTransaction(mock.transaction, scope, statuses);
    expect(result?.evidence).toEqual(statuses);
    expect(result?.evidence).not.toBe(statuses);
    expect(mock.query.mock.calls[0][0]).not.toContain("Sc_activo");
    expect(mock.input.mock.calls).toHaveLength(5);
  });

  it.each([
    { ...scope, actorId: " fixture-operator" },
    { ...scope, portalEnvironment: "QUA" },
    { ...scope, physicalLinkId: "00000000-0000-0000-0000-000000000000" },
    { ...scope, reportConnectionId: "fixture-report\n" },
    { ...scope, extra: "fixture" },
  ])("rejects noncanonical or widened scope without SQL", async wrongScope => {
    const mock = driver();
    await expect(readCatalogReportingProfileEnrollmentInTransaction(
      mock.transaction, wrongScope as ReportingEnrollmentScope, aggregate,
    )).resolves.toBeNull();
    expect(mock.request).not.toHaveBeenCalled();
  });

  it.each([
    { contract: "approved_aggregate_view_v1", extra: true },
    { ...statuses, activeColumn: "X]; SELECT 1" },
    { ...statuses, inactiveValue: "S" },
    { contract: "certified_usuarios_v1", population: "all_rows", activeColumn: "Active", storage: "bit", activeValue: true },
  ])("rejects an unknown or broadened count contract without SQL", async badEvidence => {
    const mock = driver();
    await expect(readCatalogReportingProfileEnrollmentInTransaction(
      mock.transaction, scope, badEvidence as CatalogActiveUserContract,
    )).resolves.toBeNull();
    expect(mock.request).not.toHaveBeenCalled();
  });

  it.each([
    ["no match", () => envelope()],
    ["ambiguous match", () => envelope(fixture(), fixture())],
    ["unexpected result set", () => ({ ...envelope(fixture()), recordsets: [[fixture()], []] })],
    ["extra row field", () => envelope({ ...fixture(), unexpected: "fixture-only" })],
    ["invalid profile version", () => envelope({ ...fixture(), profileVersion: "010203" })],
    ["expired link", () => envelope({ ...fixture(), physicalValidUntil: new Date(0) })],
    ["not a DNS route", () => envelope({ ...fixture(), serverHost: "127.0.0.1" })],
    ["wrong scope", () => envelope({ ...fixture(), physicalLinkId: scope.physicalTargetId })],
    ["wrong realm", () => envelope({ ...fixture(), portalEnvironment: "production" })],
    ["secret reference invalid", () => envelope({ ...fixture(), passwordSecretName: "bad/fixture" })],
  ] as const)("fails closed on %s", async (_reason, result) => {
    const mock = driver(result());
    await expect(readCatalogReportingProfileEnrollmentInTransaction(mock.transaction, scope, aggregate)).resolves.toBeNull();
  });

  it("sanitizes transport failures and discards a cancelled result", async () => {
    const first = driver();
    first.query.mockRejectedValueOnce(new Error("fixture driver diagnostic"));
    await expect(readCatalogReportingProfileEnrollmentInTransaction(first.transaction, scope, aggregate)).resolves.toBeNull();
    const second = driver();
    const controller = new AbortController();
    second.query.mockImplementationOnce(async () => { controller.abort(); return envelope(fixture()); });
    await expect(readCatalogReportingProfileEnrollmentInTransaction(
      second.transaction, scope, aggregate, controller.signal,
    )).resolves.toBeNull();
  });
});
