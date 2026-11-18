import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  pool: vi.fn(), open: vi.fn(), close: vi.fn(), poolOn: vi.fn(), begin: vi.fn(), rollback: vi.fn(),
  bind: vi.fn(), query: vi.fn(), cancel: vi.fn(), guard: vi.fn(), protectedConnect: vi.fn(), netConnect: vi.fn(),
}));
vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(), connect: fakes.netConnect,
}));
vi.mock("../lib/outboundGuard", () => ({ createGuardedSqlConnector: fakes.guard, resolveHost: vi.fn() }));
vi.mock("mssql", () => ({ default: {
  ConnectionPool: class {
    constructor(config: object) { fakes.pool(config); }
    on(event: string, handler: () => void) { fakes.poolOn(event, handler); }
    connect() { return fakes.open(); }
    close() { return fakes.close(); }
  },
  Transaction: class {
    begin(isolation: object) { return fakes.begin(isolation); }
    rollback() { return fakes.rollback(); }
  },
  Request: class {
    constructor(readonly owner: object) {}
    input(name: string, type: symbol, value: unknown) { fakes.bind(name, type, value); }
    query(statement: string) { return fakes.query(statement, this.owner); }
    cancel() { fakes.cancel(); }
  },
  NVarChar: () => Symbol.for("nvarchar"),
  TinyInt: Symbol.for("tinyint"),
  ISOLATION_LEVEL: { READ_COMMITTED: Symbol.for("ReadCommitted") },
} }));

import { createCatalogActiveUserSqlReader, type CertifiedCatalogActiveUserSqlTarget } from "../lib/catalogActiveUserSqlReader";
import { fingerprintCatalogSqlTarget } from "../lib/catalogPhysicalTargetIdentity";
import { CATALOG_SQL_TARGET_IDENTITY_SELECT } from "../lib/catalogSqlTargetIdentityReader";

const reference = { physicalDatabaseId: "fixture-id", reportingProfileId: "reports-only", serverGroupId: "fixture-group" };
const instanceId = "fb8ae79a-b218-4f95-850e-ef2eba003393";
const databaseGuid = "670e1be6-08fa-4924-867a-b2266e057dda";
const view: CertifiedCatalogActiveUserSqlTarget = {
  target: reference,
  connection: {
    server: "sql.example.test", database: "CompanyFixture", port: 1443,
    username: "fixture_reader", password: "fixture-value-not-for-output",
  },
  identity: { instanceId, expectedFingerprint: fingerprintCatalogSqlTarget({ instanceId, databaseGuid }) },
  evidence: { contract: "approved_aggregate_view_v1" },
};
const table: CertifiedCatalogActiveUserSqlTarget = {
  ...view,
  evidence: {
    contract: "certified_usuarios_v1", population: "all_rows",
    activeColumn: "certified_status", storage: "text", activeValue: "S", inactiveValue: "N",
  },
};
const run = (target: CertifiedCatalogActiveUserSqlTarget | null, signal = new AbortController().signal) =>
  createCatalogActiveUserSqlReader(async () => target)(reference, signal);
const observedIdentity = { recordset: [{ databaseName: view.connection.database, databaseGuid }] };
const proof = { recordset: [{ certified: true }] };
const withIdentity = () => fakes.query.mockResolvedValueOnce(observedIdentity);

beforeEach(() => {
  vi.resetAllMocks();
  for (const operation of [fakes.open, fakes.close, fakes.begin, fakes.rollback]) operation.mockResolvedValue(undefined);
  fakes.guard.mockReturnValue(fakes.protectedConnect);
});

describe("guarded SQL reader for certified active-user counts", () => {
  it("reads the fixed aggregate view in the same authenticated session as TLS/schema/permission proof", async () => {
    withIdentity().mockResolvedValueOnce(proof).mockResolvedValueOnce({ recordset: [{ activeUsers: "0" }] });
    await expect(run(view)).resolves.toBe(0);
    expect(fakes.pool).toHaveBeenCalledWith(expect.objectContaining({
      server: view.connection.server, database: view.connection.database,
      options: expect.objectContaining({
        encrypt: true, trustServerCertificate: false, serverName: view.connection.server,
        fallbackToDefaultDb: false, connector: expect.any(Function),
      }),
    }));
    expect(fakes.begin).toHaveBeenCalledExactlyOnceWith(Symbol.for("ReadCommitted"));
    expect(fakes.query.mock.calls[0][0]).toBe(CATALOG_SQL_TARGET_IDENTITY_SELECT);
    expect(fakes.query.mock.calls[1][0]).toContain("IS_ROLEMEMBER(N'db_datawriter') = 0");
    expect(fakes.query.mock.calls[1][0]).toContain("c.system_type_id = 127");
    expect(fakes.query.mock.calls[2][0]).toBe("SELECT TOP (2) [active_user_count] AS activeUsers FROM [dbo].[v_portal_usuarios_activos]");
    expect(fakes.query.mock.calls[0][1]).toBe(fakes.query.mock.calls[1][1]);
    expect(fakes.query.mock.calls[0][1]).toBe(fakes.query.mock.calls[2][1]);
    expect(fakes.pool).toHaveBeenCalledOnce();
    expect(fakes.bind.mock.calls).toEqual([
      ["expectedDatabase", Symbol.for("nvarchar"), view.connection.database],
      ["statusColumn", Symbol.for("nvarchar"), "active_user_count"],
    ]);
    expect(fakes.rollback).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("uses destination-certified column metadata and bound status codes, never user row data", async () => {
    withIdentity().mockResolvedValueOnce(proof).mockResolvedValueOnce({ recordset: [{ activeUsers: "12", unknownStatuses: "0" }] });
    await expect(run(table)).resolves.toBe(12);
    const [, schema, select] = fakes.query.mock.calls.map(([statement]) => statement);
    expect(schema).toContain("HAS_PERMS_BY_NAME(N'dbo.usuarios', 'OBJECT', 'SELECT') = 0");
    expect(schema).toContain("c.system_type_id IN (167,175,231,239)");
    expect(select).toContain("COUNT_BIG");
    expect(select).toContain("FROM [dbo].[usuarios]");
    expect(select).toContain("[certified_status]");
    expect(select).not.toContain("'S'");
    expect(fakes.bind.mock.calls.slice(1)).toEqual([
      ["statusColumn", Symbol.for("nvarchar"), "certified_status"],
      ["activeValue", Symbol.for("nvarchar"), "S"], ["inactiveValue", Symbol.for("nvarchar"), "N"],
    ]);
  });

  it("permits a certified bit status and rejects unexpected statuses rather than undercounting", async () => {
    withIdentity().mockResolvedValueOnce(proof).mockResolvedValueOnce({ recordset: [{ activeUsers: "12", unknownStatuses: "1" }] });
    await expect(run({ ...table, evidence: {
      contract: "certified_usuarios_v1", population: "all_rows",
      activeColumn: "checked_flag", storage: "bit", activeValue: 1,
    } })).rejects.toThrow(/^invalid_count$/);
    expect(fakes.query.mock.calls[1][0]).toContain("c.system_type_id = 104");
    expect(fakes.bind).toHaveBeenCalledWith("activeValue", Symbol.for("tinyint"), 1);
  });

  it("does not connect for missing certifications, mismatched registry identities or invalid identifiers", async () => {
    await expect(run(null)).rejects.toThrow(/^uncertified$/);
    await expect(run({ ...view, target: { ...reference, reportingProfileId: "unapproved-profile" } }))
      .rejects.toThrow(/^uncertified$/);
    await expect(run({ ...table, evidence: {
      contract: "certified_usuarios_v1", population: "all_rows", activeColumn: "unapproved identifier",
      storage: "bit", activeValue: 1,
    } })).rejects.toThrow(/^uncertified$/);
    await expect(run({ ...view, connection: { ...view.connection, server: "127.0.0.1" } }))
      .rejects.toThrow(/^uncertified$/);
    await expect(run({ ...view, identity: { ...view.identity, expectedFingerprint: Buffer.alloc(31) } }))
      .rejects.toThrow(/^uncertified$/);
    await expect(run({ ...view, identity: { ...view.identity, instanceId: "not-certified" } }))
      .rejects.toThrow(/^uncertified$/);
    expect(fakes.pool).not.toHaveBeenCalled();
  });

  it("rejects the same database label with a different observed GUID before any other SELECT", async () => {
    fakes.query.mockResolvedValueOnce({ recordset: [{
      databaseName: view.connection.database, databaseGuid: "f14d28cf-e5c6-4b53-832d-42632b7581e5",
    }] });
    await expect(run(view)).rejects.toThrow(/^identity_unverified$/);
    expect(fakes.query).toHaveBeenCalledExactlyOnceWith(CATALOG_SQL_TARGET_IDENTITY_SELECT, expect.any(Object));
    expect(fakes.rollback).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("rejects an unexpected exact database label or missing metadata before reading counts", async () => {
    fakes.query.mockResolvedValueOnce({ recordset: [{
      databaseName: view.connection.database.toUpperCase(), databaseGuid,
    }] }).mockResolvedValueOnce({ recordset: [] });
    await expect(run(view)).rejects.toThrow(/^identity_unverified$/);
    await expect(run(view)).rejects.toThrow(/^identity_unverified$/);
    expect(fakes.query.mock.calls.map(([statement]) => statement))
      .toEqual([CATALOG_SQL_TARGET_IDENTITY_SELECT, CATALOG_SQL_TARGET_IDENTITY_SELECT]);
  });

  it("never reads an aggregate before the schema and read-only proof succeeds", async () => {
    withIdentity().mockResolvedValueOnce({ recordset: [{ certified: false }] });
    await expect(run(view)).rejects.toThrow(/^schema_unverified$/);
    expect(fakes.query).toHaveBeenCalledTimes(2);
    expect(fakes.rollback).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("rejects additional records, unexpected aggregate data and unsafe bigint values", async () => {
    for (const recordset of [
      [{ activeUsers: "3" }, { activeUsers: "7" }],
      [{ activeUsers: 3, unexpected: "private content" }],
      [{ activeUsers: "9007199254740992" }],
      [{ activeUsers: null }],
    ]) {
      withIdentity().mockResolvedValueOnce(proof).mockResolvedValueOnce({ recordset });
      await expect(run(view)).rejects.toThrow(/^invalid_count$/);
    }
  });

  it("rejects SQL driver routing away from the approved host/port before another guarded dial", async () => {
    withIdentity().mockResolvedValueOnce(proof).mockResolvedValueOnce({ recordset: [{ activeUsers: 1 }] });
    await expect(run(view)).resolves.toBe(1);
    const connector = fakes.pool.mock.calls[0][0].options.connector;
    const signal = new AbortController().signal;
    await expect(connector({ host: "other.example.test", port: view.connection.port }, vi.fn(), signal))
      .rejects.toThrow(/^uncertified$/);
    await expect(connector({ host: view.connection.server, port: 1444 }, vi.fn(), signal))
      .rejects.toThrow(/^uncertified$/);
    expect(fakes.protectedConnect).not.toHaveBeenCalled();
  });

  it("sanitizes driver's failures and never leaks private diagnostics from the registry", async () => {
    fakes.open.mockRejectedValueOnce(new Error(view.connection.password));
    await expect(run(view)).rejects.toThrow(/^connection_failed$/);
    await expect(createCatalogActiveUserSqlReader(async () => { throw new Error(view.connection.password); })(
      reference, new AbortController().signal,
    )).rejects.toThrow(/^connection_failed$/);
    expect(fakes.query).not.toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("cancels stalled active reads and closes the SQL pool at the deadline", async () => {
    vi.useFakeTimers();
    try {
      withIdentity().mockResolvedValueOnce(proof).mockImplementationOnce(() => new Promise(() => {}));
      const read = createCatalogActiveUserSqlReader(async () => view, { timeoutMs: 20 });
      const rejected = expect(read(reference, new AbortController().signal)).rejects.toThrow(/^timeout$/);
      await vi.advanceTimersByTimeAsync(21);
      await rejected;
      expect(fakes.query).toHaveBeenCalledTimes(3);
      expect(fakes.cancel).toHaveBeenCalledOnce();
      expect(fakes.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
