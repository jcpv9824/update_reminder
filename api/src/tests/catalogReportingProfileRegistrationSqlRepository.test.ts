import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), tx: {} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    inputs: Record<string, unknown> = {};
    constructor(readonly tx: object) {}
    input(name: string, _type: unknown, value: unknown) { this.inputs[name] = value; return this; }
    query(statement: string) { return mock.query(this.tx, statement, Object.fromEntries(Object.entries(this.inputs)
      .map(([key, value]) => [key, Buffer.isBuffer(value) ? Buffer.from(value) : value]))); }
  },
  VarChar: vi.fn(), NVarChar: vi.fn(), VarBinary: vi.fn(), DateTime2: vi.fn(), UniqueIdentifier: Symbol(), Bit: Symbol(),
} }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: mock.audit }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (work: (tx: object) => Promise<unknown>) => {
  mock.begin();
  try { const value = await work(mock.tx); mock.commit(); return value; }
  catch (error) { mock.rollback(); throw error; }
} }));

import { REGISTER_CATALOG_REPORTING_PROFILE_SQL, registerSqlCatalogReportingProfile,
  registerSqlCatalogReportingProfileInTransaction,
  type CatalogReportingProfileRegistration } from "../lib/catalogReportingProfileRegistrationSqlRepository";

const guid = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const base: CatalogReportingProfileRegistration = { portalEnvironment: "qa", targetId: guid(1), connectionId: "configured-connection",
  profileVersion: Buffer.alloc(8, 2), trustedInstanceId: guid(2), identityFingerprint: Buffer.alloc(32, 3), proofId: guid(3),
  verifiedAt: new Date("2030-02-01T01:00:00Z"), validUntil: new Date("2030-02-02T01:00:00Z"), actor: { id: "catalog-verifier" },
  evidence: { contract: "approved_aggregate_view_v1" } };
const registered = { result: "registered", profile_id: guid(4), replaced_profile_id: null };
const respond = (...recordset: object[]) => mock.query.mockResolvedValueOnce({ recordset });
beforeEach(() => { vi.resetAllMocks(); });

describe("catalog reporting profile registration", () => {
  it("uses the supplied operator transaction without opening or committing another transaction", async () => {
    respond(registered);
    const tx = { operator: true } as unknown as Parameters<typeof registerSqlCatalogReportingProfileInTransaction>[0];
    await expect(registerSqlCatalogReportingProfileInTransaction(tx, base)).resolves
      .toEqual({ status: "registered", reportingProfileId: guid(4) });
    expect(mock.query.mock.calls[0]?.[0]).toBe(tx);
    expect(mock.audit.mock.calls[0]?.[0]).toBe(tx);
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
  });

  it("does not swallow an audited write failure in an operator-owned transaction", async () => {
    respond(registered);
    mock.audit.mockRejectedValueOnce(new Error("fixture diagnostic"));
    const tx = mock.tx as unknown as Parameters<typeof registerSqlCatalogReportingProfileInTransaction>[0];
    await expect(registerSqlCatalogReportingProfileInTransaction(tx, base)).rejects
      .toThrow(/^catalog_reporting_profile_registration_failed$/);
    expect(mock.commit).not.toHaveBeenCalled();
  });
  it("uses an opaque profile identifier and transaction-bound audit without target or profile evidence", async () => {
    respond(registered);
    await expect(registerSqlCatalogReportingProfile(base)).resolves.toEqual({ status: "registered", reportingProfileId: guid(4) });
    expect(mock.query.mock.calls[0]).toEqual([mock.tx, REGISTER_CATALOG_REPORTING_PROFILE_SQL, {
      environment: "qa", targetId: base.targetId, connectionId: base.connectionId, profileVersion: base.profileVersion,
      identityFingerprint: base.identityFingerprint, instanceId: base.trustedInstanceId, proofId: base.proofId,
      actor: base.actor.id, verifiedAt: base.verifiedAt, validUntil: base.validUntil,
      contract: "approved_aggregate_view_v1", column: null, storage: null, activeBit: null, activeText: null, inactiveText: null,
    }]);
    expect(mock.audit).toHaveBeenCalledWith(mock.tx, { entityType: "catalog_reporting_profile", entityId: guid(4),
      action: "catalog_reporting_profile_registered", performedBy: "catalog-verifier", performedByEmail: "" });
    expect(mock.query.mock.invocationCallOrder[0]).toBeLessThan(mock.audit.mock.invocationCallOrder[0]);
    expect(mock.audit.mock.invocationCallOrder[0]).toBeLessThan(mock.commit.mock.invocationCallOrder[0]);
  });

  it("binds both certified status variants exactly and reports rotation instead of deleting history", async () => {
    for (const evidence of [
      { contract: "certified_usuarios_v1", population: "all_rows", activeColumn: "sc_activo", storage: "bit", activeValue: 0 },
      { contract: "certified_usuarios_v1", population: "all_rows", activeColumn: "sc_activo", storage: "text", activeValue: "S ", inactiveValue: "S" },
    ] as const) {
      respond({ ...registered, replaced_profile_id: guid(5) });
      await expect(registerSqlCatalogReportingProfile({ ...base, evidence })).resolves.toMatchObject({ status: "registered" });
    }
    expect(mock.query.mock.calls[0][2]).toMatchObject({ column: "sc_activo", storage: "bit", activeBit: false, activeText: null, inactiveText: null });
    expect(mock.query.mock.calls[1][2]).toMatchObject({ column: "sc_activo", storage: "text", activeBit: null, activeText: "S ", inactiveText: "S" });
    expect(mock.audit.mock.calls.map(([tx, audit]) => [tx, audit.action])).toEqual([
      [mock.tx, "catalog_reporting_profile_reverified"], [mock.tx, "catalog_reporting_profile_reverified"],
    ]);
  });

  it.each(["authority-changed", "proof-replayed", "proof-stale", "reference-changed", "connection-in-use"])("does not audit rejected evidence (%s)", async reason => {
    respond({ result: reason });
    await expect(registerSqlCatalogReportingProfile(base)).resolves.toEqual({ status: "conflict", reason });
    expect(mock.audit).not.toHaveBeenCalled();
  });

  it("rejects unapproved SQL, non-finite/ambiguous evidence and invalid IDs before opening SQL", async () => {
    for (const bad of [
      { ...base, profileVersion: Buffer.alloc(7) }, { ...base, targetId: guid(0) },
      { ...base, verifiedAt: base.validUntil }, { ...base, trustedInstanceId: "not-an-instance-id" },
      { ...base, evidence: { contract: "approved_aggregate_view_v1", query: "SELECT 1" } },
      { ...base, evidence: { contract: "certified_usuarios_v1", population: "all_rows", activeColumn: "d.status", storage: "bit", activeValue: 1 } },
      { ...base, evidence: { contract: "certified_usuarios_v1", population: "all_rows", activeColumn: "status", storage: "text", activeValue: "S", inactiveValue: "S" } },
    ]) await expect(registerSqlCatalogReportingProfile(bad as CatalogReportingProfileRegistration)).resolves.toMatchObject({ reason: "invalid-proof" });
    expect(mock.begin).not.toHaveBeenCalled();
  });

  it("rolls back if the audit write fails and does not propagate its driver detail", async () => {
    respond(registered);
    mock.audit.mockRejectedValueOnce(new Error("private diagnostic"));
    await expect(registerSqlCatalogReportingProfile(base)).rejects.toThrow(/^catalog_reporting_profile_registration_failed$/);
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).toHaveBeenCalledOnce();
  });

  it("locks ownership, verifies the current operational link and both name anchors, then rotates in one batch", () => {
    const stmt = REGISTER_CATALOG_REPORTING_PROFILE_SQL;
    const anchors = ["t.target_id=@targetId AND t.portal_environment=@environment", "p.row_version=CONVERT(binary(8),@profileVersion)",
      "@nameFingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.database_name))", "WHERE proof_id=@proofId",
      "SELECT 'connection-in-use' AS result", "MAX(verified_at)", "l.verified_at<=@now AND l.valid_until>@now",
      "operational.initial_catalog", "SET retired_at=@now,retired_by=@actor", "INSERT settings.catalog_reporting_profiles("];
    for (const part of anchors) expect(stmt).toContain(part);
    expect(anchors.map(s => stmt.indexOf(s))).toEqual(anchors.map(s => stmt.indexOf(s)).sort((a, b) => a - b));
    expect(stmt).toContain("operational.row_version=l.access_profile_version");
    expect(stmt).toContain("OUTPUT inserted.reporting_profile_id INTO @newProfile(profile_id)");
    expect(stmt).not.toMatch(/DELETE\s+settings\.catalog_reporting_profiles|password_secret|server_host|sql_user|UPDATE\s+core\./i);
  });

  it("revalidates the exact active protected super administrator before reading the target or rotating evidence", () => {
    const stmt = REGISTER_CATALOG_REPORTING_PROFILE_SQL;
    const end = stmt.indexOf("SELECT 'authority-changed' AS result");
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThan(stmt.indexOf("FROM core.catalog_physical_targets"));
    const guard = stmt.slice(0, end);
    for (const clause of ["security.users AS u WITH (HOLDLOCK)", "security.user_roles AS ur WITH (HOLDLOCK)",
      "security.roles AS r WITH (HOLDLOCK)", "u.active=1", "r.active=1", "r.system_role=1", "r.protected_role=1",
      "r.role_id=N'super_admin'", "u.source_id COLLATE Latin1_General_100_BIN2=@actor COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(u.source_id)=DATALENGTH(@actor)"]) expect(guard).toContain(clause);
  });

  it("requires the locked namespace of that exact SQL destination before modifying reporting profiles", () => {
    const guard = REGISTER_CATALOG_REPORTING_PROFILE_SQL.split("SELECT @connectionKey=")[0];
    expect(guard).toContain("JOIN core.catalog_sql_target_instance_identities AS i WITH (HOLDLOCK)");
    for (const clause of ["i.physical_target_key=t.physical_target_key", "i.portal_environment=t.portal_environment",
      "i.target_kind=t.target_kind", "i.trusted_instance_id=@instanceId", "i.registered_at<=@now"]) expect(guard).toContain(clause);
  });
});
