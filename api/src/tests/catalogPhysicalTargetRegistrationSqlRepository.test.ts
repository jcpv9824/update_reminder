import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), waitForBegin: vi.fn(), transaction: {} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    inputs: Record<string, unknown> = {};
    constructor(readonly transaction: object) {}
    input(key: string, _type: unknown, value: unknown) { this.inputs[key] = value; return this; }
    query(text: string) { return mock.query(this.transaction, text, this.inputs); }
  },
  NVarChar: vi.fn(), VarChar: vi.fn(), VarBinary: vi.fn(), DateTime2: vi.fn(), BigInt: Symbol(), UniqueIdentifier: Symbol(),
} }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (fn: (tx: object) => Promise<unknown>) => {
  mock.begin();
  try { await mock.waitForBegin(); const result = await fn(mock.transaction); mock.commit(); return result; }
  catch (error) { mock.rollback(); throw error; }
} }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: mock.audit }));

import { catalogDomainRouteFingerprintSql } from "../lib/catalogPhysicalTargetIdentity";
import { REGISTER_CATALOG_PHYSICAL_TARGET_SQL, registerSqlCatalogPhysicalTarget, type CatalogPhysicalTargetRegistration } from "../lib/catalogPhysicalTargetRegistrationSqlRepository";

const proofId = "00000000-0000-0000-0000-000000000001";
const targetId = "00000000-0000-0000-0000-000000000002";
const linkId = "00000000-0000-0000-0000-000000000003";
const priorId = "00000000-0000-0000-0000-000000000004";
const base = { portalEnvironment: "qa" as const, clientId: "client1", domainId: "domain1", proofId, actor: { id: "verifier1" },
  identityFingerprint: Buffer.alloc(32, 4), verifiedAt: new Date("2030-08-19T19:45:00.000Z"), validUntil: new Date("2030-08-26T19:45:00.000Z") };
const database = { ...base, kind: "database" as const, databaseId: "database1", accessProfileKey: "9223372036854775807", accessProfileVersion: Buffer.alloc(8, 2) };
const domain = { ...base, kind: "domain" as const, domainRouteFingerprint: Buffer.alloc(32, 3) };
const registered = { result: "registered", target_id: targetId, link_id: linkId, replaced_link_id: null };
const rows = (...recordset: object[]) => mock.query.mockResolvedValueOnce({ recordset });

beforeEach(() => { vi.resetAllMocks(); });

describe("verified catalog physical target registration", () => {
  it("binds the exact logical hierarchy and profile version, returns opaque ids, and audits inside that same transaction", async () => {
    rows(registered);
    await expect(registerSqlCatalogPhysicalTarget(database)).resolves.toEqual({ status: "registered", targetId, linkId });
    expect(mock.query.mock.calls[0]).toEqual([mock.transaction, REGISTER_CATALOG_PHYSICAL_TARGET_SQL, {
      environment: "qa", kind: "database", clientId: "client1", domainId: "domain1", databaseId: "database1", verifiedProfileKey: database.accessProfileKey,
      profileVersion: database.accessProfileVersion, routeFingerprint: null, identityFingerprint: base.identityFingerprint,
      proofId, verifiedAt: base.verifiedAt, validUntil: base.validUntil, actorId: "verifier1",
    }]);
    expect(mock.audit).toHaveBeenCalledExactlyOnceWith(mock.transaction, { entityType: "catalog_physical_target_link", entityId: linkId,
      action: "catalog_physical_target_registered", performedBy: "verifier1", performedByEmail: "" });
    expect(mock.query.mock.invocationCallOrder[0]).toBeLessThan(mock.audit.mock.invocationCallOrder[0]);
    expect(mock.audit.mock.invocationCallOrder[0]).toBeLessThan(mock.commit.mock.invocationCallOrder[0]);
    expect(mock.rollback).not.toHaveBeenCalled();
  });

  it("reverifies a web link without reading a profile or emitting previous evidence", async () => {
    rows({ ...registered, replaced_link_id: priorId });
    await expect(registerSqlCatalogPhysicalTarget(domain)).resolves.toEqual({ status: "registered", targetId, linkId });
    expect(mock.query.mock.calls[0][2]).toMatchObject({ kind: "domain", databaseId: null, verifiedProfileKey: null,
      profileVersion: null, routeFingerprint: domain.domainRouteFingerprint });
    expect(mock.audit).toHaveBeenCalledExactlyOnceWith(mock.transaction, { entityType: "catalog_physical_target_link", entityId: linkId,
      action: "catalog_physical_target_reverified", performedBy: "verifier1", performedByEmail: "" });
  });

  it.each(["proof-replayed", "proof-stale", "reference-changed", "identity-collision"])("does not audit or produce a link for %s", async reason => {
    rows({ result: reason });
    await expect(registerSqlCatalogPhysicalTarget(domain)).resolves.toEqual({ status: "conflict", reason });
    expect(mock.audit).not.toHaveBeenCalled();
  });

  it("fails closed before opening SQL for invalid, ambiguous, or expired-range evidence", async () => {
    const invalid = [{ ...domain, identityFingerprint: Buffer.alloc(32) }, { ...domain, domainRouteFingerprint: Buffer.alloc(31, 2) },
      { ...domain, validUntil: domain.verifiedAt }, { ...database, accessProfileKey: "9223372036854775808" },
      { ...database, accessProfileVersion: Buffer.alloc(9, 1) }, { ...database, clientId: " client1" },
      { ...database, domainRouteFingerprint: domain.domainRouteFingerprint }] as CatalogPhysicalTargetRegistration[];
    for (const input of invalid) {
      await expect(registerSqlCatalogPhysicalTarget(input)).resolves.toEqual({ status: "conflict", reason: "invalid-proof" });
    }
    expect(mock.begin).not.toHaveBeenCalled();
  });

  it("rolls back target/link registration when audit fails, without exposing driver errors", async () => {
    rows(registered);
    mock.audit.mockRejectedValueOnce(new Error("fixture driver detail"));
    await expect(registerSqlCatalogPhysicalTarget(database)).rejects.toThrow(/^catalog_physical_target_registration_failed$/);
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect(mock.commit).not.toHaveBeenCalled();
  });

  it("cannot substitute mutable proof data while the transaction is waiting to begin", async () => {
    let continueBegin!: () => void;
    mock.waitForBegin.mockReturnValueOnce(new Promise<void>(resolve => { continueBegin = resolve; }));
    rows(registered);
    const supplied = { ...domain, identityFingerprint: Buffer.alloc(32, 7), verifiedAt: new Date(domain.verifiedAt),
      actor: { id: domain.actor.id } };
    const result = registerSqlCatalogPhysicalTarget(supplied);
    supplied.identityFingerprint.fill(9);
    supplied.verifiedAt.setUTCFullYear(2031);
    supplied.actor.id = "changed";
    continueBegin();
    await expect(result).resolves.toMatchObject({ status: "registered" });
    expect(mock.query.mock.calls[0][2]).toMatchObject({
      identityFingerprint: Buffer.alloc(32, 7), verifiedAt: domain.verifiedAt, actorId: domain.actor.id,
    });
  });

  it("has explicit lock, CAS, monotonic and trigger-compatible append-only SQL boundaries", () => {
    const sql = REGISTER_CATALOG_PHYSICAL_TARGET_SQL;
    const index = (clause: string) => sql.indexOf(clause);
    const ownership = index("d.client_key=c.client_key");
    const profile = index("p.access_profile_key=@verifiedProfileKey AND p.row_version=CONVERT(binary(8),@profileVersion)");
    const nonce = index("WHERE proof_id=@proofId");
    const monotonic = index("MAX(verified_at)");
    const naturalTarget = index("portal_environment=@environment AND target_kind=@kind AND identity_fingerprint=");
    const aliasVeto = index("SELECT 'identity-collision' AS result");
    const insertTarget = index("INSERT core.catalog_physical_targets(");
    const retirement = index("SET retired_at=@now");
    const insertLink = index("INSERT core.catalog_physical_target_links(");
    expect(ownership).toBeGreaterThan(0);
    expect([ownership, profile, nonce, monotonic, naturalTarget, aliasVeto, insertTarget, retirement, insertLink]).toEqual(
      [...[ownership, profile, nonce, monotonic, naturalTarget, aliasVeto, insertTarget, retirement, insertLink]].sort((a, b) => a - b));
    expect(sql).toContain(`${catalogDomainRouteFingerprintSql}=CONVERT(binary(32),@routeFingerprint)`);
    expect(sql).toContain("IF @latestVerifiedAt>=@verifiedAt");
    expect(sql).toContain("IF @verifiedAt>@now OR @validUntil<=@now");
    expect(sql).toContain("DATALENGTH(db.source_id)=DATALENGTH(@databaseId)");
    expect(sql).toContain("DECLARE @newLinkId uniqueidentifier=NEWID()");
    expect(sql).toContain("WHERE inserted.link_id=@newLinkId AND inserted.proof_id=@proofId");
    expect(sql).toContain("@databaseNameFingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.initial_catalog))");
    expect(sql).toContain("@storedDatabaseNameFingerprint=database_name_fingerprint");
    expect(sql).toContain("@databaseNameFingerprint<>@storedDatabaseNameFingerprint");
    expect(sql).toContain("INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint,database_name_fingerprint)");
    expect(sql.match(/initial_catalog/g)).toHaveLength(1);
    expect(sql).not.toMatch(/DELETE\s+core\.|CONNECTION_STRING|PASSWORD|PASSWORD_SECRET/i);
  });
});
