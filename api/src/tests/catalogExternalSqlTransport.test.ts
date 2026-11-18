import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  config: vi.fn(), connectPool: vi.fn(), close: vi.fn(), begin: vi.fn(), rollback: vi.fn(),
  bind: vi.fn(), query: vi.fn(), cancel: vi.fn(), guard: vi.fn(), netConnect: vi.fn(), onPool: vi.fn(),
}));
vi.mock("node:net", () => ({ connect: fakes.netConnect }));
vi.mock("../lib/outboundGuard", () => ({ createGuardedSqlConnector: fakes.guard, resolveHost: vi.fn() }));
vi.mock("mssql", () => ({ default: {
  ConnectionPool: class {
    constructor(config: object) { fakes.config(config); }
    on(event: string, handler: () => void) { fakes.onPool(event, handler); }
    connect() { return fakes.connectPool(); }
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
  Int: Symbol.for("Int"), ISOLATION_LEVEL: { SNAPSHOT: Symbol.for("Snapshot") },
} }));

import { createCatalogExternalSqlTransport } from "../lib/catalogExternalSqlTransport";
import { catalogExternalSelectSql, readCatalogExternalSource, type CatalogExternalReadStatement } from "../lib/catalogExternalSourceQueries";

const target = { server: "db.example.test", port: 15433, database: "fixture-db", username: "fixture-user", password: "fixture-secret" };
const proof = { recordset: [{ compatible: true, readOnly: true }] };
const runOptions = { contract: "erp_v1", timeoutMs: 1000, signal: new AbortController().signal } as const;
const statement = (tag: "schema" | "page", options?: Partial<CatalogExternalReadStatement>): CatalogExternalReadStatement => ({
  tag, sql: catalogExternalSelectSql("erp_v1", tag), timeoutMs: 500,
  parameters: tag === "page" ? { afterId: null, pageSize: 1 } : {}, signal: new AbortController().signal, ...options,
});

beforeEach(() => {
  vi.resetAllMocks();
  fakes.connectPool.mockResolvedValue(undefined);
  fakes.close.mockResolvedValue(undefined);
  fakes.begin.mockResolvedValue(undefined);
  fakes.rollback.mockResolvedValue(undefined);
  fakes.guard.mockReturnValue(vi.fn());
});

describe("external catalog SQL transport", () => {
  it("uses verified TLS, no default database fallback and one SNAPSHOT transaction for schema and all pages", async () => {
    fakes.query.mockResolvedValueOnce(proof).mockResolvedValueOnce({ recordset: [{ sourceRecordId: 12, officialName: "Fixture", documentNumber: "123", activeCode: "S" }] })
      .mockResolvedValueOnce({ recordset: [] });
    const result = await readCatalogExternalSource(createCatalogExternalSqlTransport(target), "erp_v1", { pageSize: 1 });
    expect(result).toMatchObject({ status: "complete", records: [{ sourceRecordId: 12 }] });
    expect(fakes.config).toHaveBeenCalledWith(expect.objectContaining({ server: target.server, database: target.database, port: target.port,
      pool: expect.objectContaining({ max: 1 }), options: expect.objectContaining({ encrypt: true, trustServerCertificate: false,
        serverName: target.server, fallbackToDefaultDb: false, connector: expect.any(Function) }) }));
    expect(fakes.begin).toHaveBeenCalledExactlyOnceWith(Symbol.for("Snapshot"));
    expect(fakes.query.mock.calls.map(([text]) => text)).toEqual([catalogExternalSelectSql("erp_v1", "schema"),
      catalogExternalSelectSql("erp_v1", "page"), catalogExternalSelectSql("erp_v1", "page")]);
    expect(fakes.query.mock.calls.every(([, transaction]) => transaction === fakes.query.mock.calls[0][1])).toBe(true);
    expect(fakes.bind.mock.calls).toEqual([["afterId", Symbol.for("Int"), null], ["pageSize", Symbol.for("Int"), 1],
      ["afterId", Symbol.for("Int"), 12], ["pageSize", Symbol.for("Int"), 1]]);
    expect(fakes.rollback).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("fails unavailable without ever opening a read-committed fallback when snapshot is disabled", async () => {
    fakes.query.mockRejectedValueOnce(Object.assign(new Error(target.password), { number: 3952 }));
    await expect(readCatalogExternalSource(createCatalogExternalSqlTransport(target), "erp_v1"))
      .resolves.toEqual({ status: "unavailable", reason: "consistency_unverified" });
    expect(fakes.begin).toHaveBeenCalledOnce();
    expect(fakes.query).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("does not query customer data until the schema proves compatibility and read-only access", async () => {
    fakes.query.mockResolvedValueOnce({ recordset: [{ compatible: true, readOnly: false }] });
    await expect(readCatalogExternalSource(createCatalogExternalSqlTransport(target), "erp_v1"))
      .resolves.toEqual({ status: "unavailable", reason: "write_access" });
    expect(fakes.query).toHaveBeenCalledOnce();
    expect(fakes.rollback).toHaveBeenCalledOnce();
  });

  it("rejects changed, cross-contract, premature, or unbounded SQL without invoking it", async () => {
    const transport = createCatalogExternalSqlTransport(target);
    fakes.query.mockResolvedValueOnce(proof);
    await expect(transport.withConsistentRead(runOptions, async session => {
      await expect(session.select(statement("schema", { sql: "SELECT GETDATE()" }))).rejects.toThrow("contract_unapproved");
      await expect(session.select(statement("schema", { sql: catalogExternalSelectSql("sag_admin_v1", "schema") })))
        .rejects.toThrow("contract_unapproved");
      await expect(session.select(statement("page"))).rejects.toThrow("schema_unverified");
      await session.select(statement("schema"));
      await expect(session.select(statement("page", { parameters: { afterId: 0, pageSize: 1001 } }))).rejects.toThrow("invalid_options");
      await expect(session.select(statement("page", { parameters: { pageSize: 1 } }))).rejects.toThrow("invalid_options");
      return "ok";
    })).resolves.toBe("ok");
    expect(fakes.query).toHaveBeenCalledOnce();
    expect(fakes.bind).not.toHaveBeenCalled();
  });

  it("cancels and closes a hung request at its local deadline", async () => {
    fakes.query.mockImplementationOnce(() => new Promise(() => {}));
    await expect(createCatalogExternalSqlTransport(target).withConsistentRead(runOptions,
      session => session.select(statement("schema", { timeoutMs: 10 })))).rejects.toThrow(/^timeout$/);
    expect(fakes.cancel).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("aborts a pending connect and stops any late connector answer from opening a socket", async () => {
    let late!: (socket: { host: string; port: number; family: number }) => void;
    fakes.guard.mockImplementation((_resolver, dial) => { late = dial; return vi.fn(); });
    fakes.connectPool.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const work = createCatalogExternalSqlTransport(target).withConsistentRead({ ...runOptions, signal: controller.signal }, vi.fn());
    controller.abort(new Error(target.password));
    await expect(work).rejects.toThrow(/^cancelled$/);
    expect(() => late({ host: "192.0.2.1", port: 15433, family: 4 })).toThrow(/^cancelled$/);
    expect(fakes.netConnect).not.toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(fakes.begin).not.toHaveBeenCalled();
  });

  it("keeps the outer deadline during rollback and destroys owned sockets even if close hangs", async () => {
    const ownedSocket = { once: vi.fn(), destroy: vi.fn() };
    fakes.netConnect.mockReturnValue(ownedSocket);
    fakes.guard.mockImplementation((_resolver, dial) => {
      dial({ host: "192.0.2.1", port: 15433, family: 4 });
      return vi.fn();
    });
    fakes.query.mockResolvedValueOnce(proof);
    fakes.rollback.mockImplementationOnce(() => new Promise(() => {}));
    fakes.close.mockImplementationOnce(() => new Promise(() => {}));
    await expect(createCatalogExternalSqlTransport(target).withConsistentRead({ ...runOptions, timeoutMs: 20 },
      session => session.select(statement("schema")))).rejects.toThrow(/^timeout$/);
    expect(fakes.rollback).toHaveBeenCalledOnce();
    expect(ownedSocket.destroy).toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("does not return driver errors, connection details, or secret causes", async () => {
    fakes.connectPool.mockRejectedValueOnce(new Error(`${target.server} ${target.database} ${target.username} ${target.password}`));
    const error = await createCatalogExternalSqlTransport(target).withConsistentRead(runOptions, vi.fn()).catch(error => error);
    expect(error.message).toBe("connection_failed");
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(() => createCatalogExternalSqlTransport({ ...target, server: "bad\\instance" })).toThrow(/^connection_failed$/);
    expect(fakes.close).toHaveBeenCalledOnce();
  });
});
