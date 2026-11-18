import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  pool: vi.fn(), connectPool: vi.fn(), closePool: vi.fn(), onPool: vi.fn(),
  query: vi.fn(), cancel: vi.fn(), guard: vi.fn(), guardedDial: vi.fn(), tcpDial: vi.fn(),
}));

vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(), connect: fakes.tcpDial,
}));
vi.mock("../lib/outboundGuard", () => ({ createGuardedSqlConnector: fakes.guard, resolveHost: vi.fn() }));
vi.mock("mssql", () => ({ default: {
  ConnectionPool: class {
    constructor(config: object) { fakes.pool(config); }
    on(event: string, handler: () => void) { fakes.onPool(event, handler); }
    connect() { return fakes.connectPool(); }
    close() { return fakes.closePool(); }
    request() { return { query: fakes.query, cancel: fakes.cancel }; }
  },
} }));

import { fingerprintCatalogSqlTarget } from "../lib/catalogPhysicalTargetIdentity";
import { readCatalogSqlTargetIdentity, type CertifiedSqlIdentityTarget } from "../lib/catalogSqlTargetIdentityReader";

const target: CertifiedSqlIdentityTarget = {
  instanceId: "fb8ae79a-b218-4f95-850e-ef2eba003393",
  connection: { server: "sql.example.test", port: 1433, database: "CompanyFixture",
    username: "fixture_reader", password: "fictitious-credential" },
};
const databaseGuid = "670e1be6-08fa-4924-867a-b2266e057dda";
const row = { databaseName: target.connection.database, databaseGuid };
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.resetAllMocks();
  fakes.connectPool.mockResolvedValue(undefined);
  fakes.closePool.mockResolvedValue(undefined);
  fakes.guard.mockReturnValue(fakes.guardedDial);
  fakes.query.mockResolvedValue({ recordset: [row] });
});

describe("SQL catalogue physical identity reader", () => {
  it("runs exactly one approved metadata SELECT under strict TLS and returns only the opaque fingerprint", async () => {
    const actual = await readCatalogSqlTargetIdentity(target, signal());
    expect(actual).toEqual(fingerprintCatalogSqlTarget({ instanceId: target.instanceId, databaseGuid }));
    expect(actual).toBeInstanceOf(Buffer);
    expect(actual).toHaveLength(32);
    expect(fakes.query).toHaveBeenCalledExactlyOnceWith(
      "SELECT DB_NAME() AS databaseName, database_guid AS databaseGuid\nFROM sys.database_recovery_status WHERE database_id = DB_ID()",
    );
    expect(fakes.pool).toHaveBeenCalledWith(expect.objectContaining({
      server: target.connection.server, port: target.connection.port, database: target.connection.database,
      options: expect.objectContaining({ encrypt: true, trustServerCertificate: false,
        serverName: target.connection.server, fallbackToDefaultDb: false, connector: expect.any(Function) }),
    }));
    expect(fakes.closePool).toHaveBeenCalledOnce();
  });

  it("does not fuse identically named databases across different certified instances", async () => {
    const first = await readCatalogSqlTargetIdentity(target, signal());
    const second = await readCatalogSqlTargetIdentity({ ...target,
      instanceId: "8b228b20-5f5f-4c33-8b49-14a1628d2a84",
    }, signal());
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toEqual(first);
  });

  it("accepts a certified rename without changing identity, but never accepts a differently connected database", async () => {
    const existing = await readCatalogSqlTargetIdentity(target, signal());
    fakes.query.mockResolvedValue({ recordset: [{ ...row, databaseName: "Renamed" }] });
    await expect(readCatalogSqlTargetIdentity(target, signal())).resolves.toBeNull();
    const renamed = await readCatalogSqlTargetIdentity({ ...target,
      connection: { ...target.connection, database: "Renamed" },
    }, signal());
    expect(renamed).not.toBeNull();
    expect(renamed).toEqual(existing);
  });

  it("leaves unavailable metadata unresolved without retry, fallback queries, or grant changes", async () => {
    for (const recordset of [[], [row, row], [{ ...row, databaseGuid: null }], [{ ...row, databaseGuid: "no" }],
      [{ ...row, databaseName: row.databaseName.toUpperCase() }], [{ ...row, unexpected: "not user data" }]]) {
      fakes.query.mockResolvedValueOnce({ recordset });
      await expect(readCatalogSqlTargetIdentity(target, signal())).resolves.toBeNull();
    }
    fakes.query.mockRejectedValueOnce(new Error("fictitious private query diagnostic"));
    await expect(readCatalogSqlTargetIdentity(target, signal())).resolves.toBeNull();
    expect(fakes.query).toHaveBeenCalledTimes(7);
    expect(new Set(fakes.query.mock.calls.map(([query]) => query)).size).toBe(1);
  });

  it("rejects unapproved endpoints, missing instance namespaces, and pre-cancelled reads before connecting", async () => {
    await expect(readCatalogSqlTargetIdentity({ ...target, instanceId: target.connection.server }, signal())).resolves.toBeNull();
    await expect(readCatalogSqlTargetIdentity({ ...target,
      connection: { ...target.connection, server: "127.0.0.1" },
    }, signal())).resolves.toBeNull();
    await expect(readCatalogSqlTargetIdentity(target, AbortSignal.abort())).resolves.toBeNull();
    expect(fakes.pool).not.toHaveBeenCalled();
  });

  it("does not dial a driver redirect that differs from the certified hostname or port", async () => {
    await readCatalogSqlTargetIdentity(target, signal());
    const connector = fakes.pool.mock.calls[0][0].options.connector;
    await expect(connector({ host: "other.example.test", port: target.connection.port }, vi.fn(), signal()))
      .rejects.toThrow(/^catalog_identity_route_unapproved$/);
    await expect(connector({ host: target.connection.server, port: 1500 }, vi.fn(), signal()))
      .rejects.toThrow(/^catalog_identity_route_unapproved$/);
    expect(fakes.guardedDial).not.toHaveBeenCalled();
  });

  it("cancels and closes a stalled request at its deadline", async () => {
    vi.useFakeTimers();
    try {
      fakes.query.mockImplementationOnce(() => new Promise(() => {}));
      const pending = readCatalogSqlTargetIdentity(target, signal(), { timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(21);
      await expect(pending).resolves.toBeNull();
      expect(fakes.query).toHaveBeenCalledOnce();
      expect(fakes.cancel).toHaveBeenCalledOnce();
      expect(fakes.closePool).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null on cancellation during login and prevents late DNS from dialing a socket", async () => {
    const cancellation = new AbortController();
    let dialAfterLookup!: (parameters: { host: string; port: number }) => unknown;
    fakes.guard.mockImplementation((_resolver, dial) => { dialAfterLookup = dial; return fakes.guardedDial; });
    fakes.connectPool.mockImplementationOnce(() => new Promise(() => {}));
    const pending = readCatalogSqlTargetIdentity(target, cancellation.signal);
    cancellation.abort();
    await expect(pending).resolves.toBeNull();
    expect(() => dialAfterLookup({ host: target.connection.server, port: target.connection.port })).toThrow();
    expect(fakes.tcpDial).not.toHaveBeenCalled();
    expect(fakes.query).not.toHaveBeenCalled();
    expect(fakes.closePool).toHaveBeenCalledOnce();
  });
});
