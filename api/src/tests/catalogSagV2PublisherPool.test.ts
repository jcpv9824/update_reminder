import type sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_SAG_V2_PUBLISHER_READINESS_SQL, createCatalogSagV2PublisherPoolLoader, readCatalogSagV2PublisherPoolSettings,
} from "../lib/catalogSagV2PublisherPool";
import type { SocketConnector } from "../lib/outboundGuard";

const server = "catalogdb.synthetic.host";
const version = "102030405060708090a0b0c0d0e0f012";
const secretName = "synthetic-dedicated-publisher-key";
const username = "svc-catalog-publisher";
const password = "synthetic-password";
const env = () => ({
  PORTAL_SAG_ENVIRONMENT: "qa", SQL_SERVER_HOST: server + ",1433", SQL_DATABASE: "PortalSAGWeb-TEST",
  SQL_USERNAME: "svc-portal-general", SQL_PASSWORD: "synthetic-general-pool-password",
  PORTAL_CATALOG_SAG_V2_PUBLISHER_USERNAME: username,
  PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_NAME: secretName,
  PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: version,
});
const unavailable = "catalog_sag_v2_publisher_unavailable";
const classified = () => new Error("synthetic-driver-sensitive-text");
const ready = { recordsets: [[{ ready: true }]] };

function fakePool(reply: unknown = ready) {
  let report!: (error: unknown) => void;
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => {});
  const cancel = vi.fn();
  const query = vi.fn(async (_text: string) => reply);
  const input = vi.fn();
  const req = { input, query, cancel };
  input.mockReturnValue(req);
  const request = vi.fn(() => req as unknown as sql.Request);
  const on = vi.fn((_event: "error", handle: (error: unknown) => void) => { report = handle; });
  return { close, connect, cancel, input, on, query, request, error: () => report(classified()) };
}

function fakeIO(pool = fakePool()) {
  const getSecret = vi.fn(async (_name: string, _signal: AbortSignal, _version: string) => password);
  const newPool = vi.fn((_config: sql.config) => pool);
  const guardedConnector = vi.fn<SocketConnector>().mockRejectedValue(classified());
  return { pool, io: { getSecret, newPool, guardedConnector } };
}

describe("SAG v2 separate SQL publisher connection", () => {
  it("requires a matching exact deployment environment and database with explicit nonconflicting TCP port", () => {
    expect(readCatalogSagV2PublisherPoolSettings(env())).toMatchObject({ environment: "qa", database: "PortalSAGWeb-TEST", server, port: 1433 });
    expect(readCatalogSagV2PublisherPoolSettings({ ...env(), PORTAL_SAG_ENVIRONMENT: "production", SQL_DATABASE: "PortalSAGWeb",
      SQL_SERVER_HOST: server, SQL_SERVER_PORT: "2411" })).toMatchObject({ environment: "production", database: "PortalSAGWeb", server, port: 2411 });
    expect(readCatalogSagV2PublisherPoolSettings({ ...env(), SQL_SERVER_HOST: server + ":1433", SQL_SERVER_PORT: "1433" }))
      .toMatchObject({ port: 1433 });
    for (const invalid of [
      { SQL_SERVER_HOST: server }, { SQL_SERVER_PORT: "3433" }, { SQL_SERVER_HOST: server + ",0" }, { SQL_SERVER_HOST: server + ",65536" },
      { SQL_SERVER_HOST: server + ",1433\n" }, { SQL_SERVER_HOST: server + ",+1433" }, { SQL_SERVER_HOST: server + ",1e3" },
      { SQL_SERVER_HOST: server + "\\SAG,1433" }, { SQL_SERVER_HOST: "https://" + server + ":1433" }, { SQL_SERVER_HOST: "127.0.0.1,1433" },
      { SQL_SERVER_HOST: "[::1]:1433" }, { SQL_SERVER_HOST: "0x7f.0x1,1433" }, { SQL_SERVER_HOST: "<server>,1433" },
      { SQL_SERVER_HOST: "${SQL_HOST},1433" }, { SQL_SERVER_HOST: "changeme.invalid,1433" }, { SQL_SERVER_HOST: "localhost.localdomain,1433" },
      { SQL_SERVER_HOST: "replace-me.synthetic.host,1433" },
      { SQL_DATABASE: "PortalSAGWeb" }, { SQL_DATABASE: "PortalSAGWeb-TEST " }, { PORTAL_SAG_ENVIRONMENT: undefined },
      { PORTAL_SAG_ENVIRONMENT: "prod" }, { PORTAL_SAG_ENVIRONMENT: " QA " },
    ]) expect(readCatalogSagV2PublisherPoolSettings({ ...env(), ...invalid })).toBeNull();
  });

  it("cannot substitute the general runtime login, an environment password, or a latest Vault secret", async () => {
    for (const invalid of [
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_USERNAME: undefined },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_USERNAME: "SVC-PORTAL-GENERAL" },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_USERNAME: "sa" },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_NAME: undefined, PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD: password },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_NAME: "@Microsoft.KeyVault(...)" },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: undefined },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: "latest" },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: version + "\n" },
    ]) {
      const h = fakeIO();
      const loader = createCatalogSagV2PublisherPoolLoader({ ...env(), ...invalid }, h.io);
      await expect(loader.get()).rejects.toThrow(unavailable);
      expect(h.io.getSecret).not.toHaveBeenCalled();
      expect(h.io.newPool).not.toHaveBeenCalled();
    }
  });

  it("uses only the pinned version and exact config snapshot, coalescing until readiness returns a safe boolean", async () => {
    const h = fakeIO();
    const source = env();
    let release!: (result: unknown) => void;
    h.pool.query.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const loader = createCatalogSagV2PublisherPoolLoader(source, h.io);
    source.SQL_SERVER_HOST = "later.synthetic.host,2000";
    source.PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION = "f".repeat(32);
    const first = loader.get();
    const next = loader.get();
    expect(first).toBe(next);
    await vi.waitFor(() => expect(h.pool.query).toHaveBeenCalledOnce());
    expect(h.io.getSecret).toHaveBeenCalledExactlyOnceWith(secretName, expect.any(AbortSignal), version);
    expect(h.io.newPool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      server, port: 1433, database: "PortalSAGWeb-TEST", user: username, password,
      connectionTimeout: expect.any(Number), requestTimeout: expect.any(Number), pool: expect.objectContaining({ max: 2 }),
      options: expect.objectContaining({ encrypt: true, trustServerCertificate: false, serverName: server,
        fallbackToDefaultDb: false, maxRetriesOnTransientErrors: 0, connector: expect.any(Function) }),
    }));
    expect(h.pool.input.mock.calls.map(args => [args[0], args[2]])).toEqual([
      ["expectedDatabase", "PortalSAGWeb-TEST"], ["expectedLogin", username],
    ]);
    expect(h.pool.query).toHaveBeenCalledExactlyOnceWith(CATALOG_SAG_V2_PUBLISHER_READINESS_SQL);
    release(ready);
    const sink = await first;
    expect(await next).toBe(sink);
    expect(await loader.get()).toBe(sink);
    expect(Object.keys(sink)).toEqual(["request"]);
    await loader.close();
    expect(h.pool.close).toHaveBeenCalledOnce();
    expect(() => sink.request()).toThrow(unavailable);
    await expect(loader.get()).rejects.toThrow(unavailable);
  });

  it("pins both route coordinates and does not dial changed-host/port redirect or an aborted attempt", async () => {
    const h = fakeIO();
    const loader = createCatalogSagV2PublisherPoolLoader(env(), h.io);
    await loader.get();
    const connector = h.io.newPool.mock.calls[0][0].options?.connector as unknown as SocketConnector;
    const signal = new AbortController();
    await expect(connector({ host: "different.synthetic.host", port: 1433 }, null, signal.signal)).rejects.toThrow(unavailable);
    await expect(connector({ host: server, port: 2011 }, null, signal.signal)).rejects.toThrow(unavailable);
    expect(h.io.guardedConnector).not.toHaveBeenCalled();
    await expect(connector({ host: server.toUpperCase(), port: 1433 }, null, signal.signal)).rejects.toThrow(unavailable);
    expect(h.io.guardedConnector).toHaveBeenCalledOnce();
    signal.abort(classified());
    await expect(connector({ host: server, port: 1433 }, null, signal.signal)).rejects.toThrow(unavailable);
    expect(h.io.guardedConnector).toHaveBeenCalledOnce();
    await loader.close();
  });

  it.each([
    undefined, {}, { recordsets: [] }, { recordsets: [[{ ready: false }]] }, { recordsets: [[{ ready: 1 }]] },
    { recordsets: [[{ ready: true, extra: "do not expose" }]] },
    { recordsets: [[Object.assign(Object.create({ extra: true }), { ready: true })]] },
    { recordsets: [[{ ready: true }, { ready: true }]] }, { recordsets: [[{ ready: true }], []] },
  ])("fails closed, closes resources and permits a fresh attempt after invalid proof: %j", async reply => {
    const h = fakeIO(fakePool(reply ?? null));
    const next = fakePool();
    h.io.newPool.mockReturnValueOnce(h.pool).mockReturnValueOnce(next);
    const loader = createCatalogSagV2PublisherPoolLoader(env(), h.io);
    await expect(loader.get()).rejects.toThrow(unavailable);
    expect(h.pool.close).toHaveBeenCalledOnce();
    expect(await loader.get()).toEqual({ request: expect.any(Function) });
    expect(h.io.getSecret).toHaveBeenCalledTimes(2);
    await loader.close();
  });

  it("never starts another dial after bounded secret retrieval or readiness and closes on the latter", async () => {
    vi.useFakeTimers();
    try {
      const slowSecret = fakeIO();
      slowSecret.io.getSecret.mockImplementationOnce(() => new Promise(() => {}));
      const firstLoader = createCatalogSagV2PublisherPoolLoader(env(), slowSecret.io);
      const unavailableSecret = expect(firstLoader.get()).rejects.toThrow(unavailable);
      await vi.advanceTimersByTimeAsync(15_000);
      await unavailableSecret;
      expect(slowSecret.io.getSecret.mock.calls[0][1].aborted).toBe(true);
      expect(slowSecret.io.newPool).not.toHaveBeenCalled();
      await firstLoader.close();

      const slowReady = fakeIO();
      slowReady.pool.query.mockImplementationOnce(() => new Promise(() => {}));
      const secondLoader = createCatalogSagV2PublisherPoolLoader(env(), slowReady.io);
      const unavailableReady = expect(secondLoader.get()).rejects.toThrow(unavailable);
      await vi.advanceTimersByTimeAsync(30_000);
      await unavailableReady;
      expect(slowReady.pool.cancel).toHaveBeenCalledOnce();
      expect(slowReady.pool.close).toHaveBeenCalledOnce();
      await secondLoader.close();
    } finally { vi.useRealTimers(); }
  });

  it("invalidates the old handle on a pool error and ignores the old pool's later error events", async () => {
    const h = fakeIO();
    const replacement = fakePool();
    h.io.newPool.mockReturnValueOnce(h.pool).mockReturnValueOnce(replacement);
    const loader = createCatalogSagV2PublisherPoolLoader(env(), h.io);
    const old = await loader.get();
    h.pool.error();
    const current = await loader.get();
    h.pool.error();
    expect(() => old.request()).toThrow(unavailable);
    expect(() => current.request()).not.toThrow();
    expect(await loader.get()).toBe(current);
    expect(h.pool.close).toHaveBeenCalledOnce();
    await loader.close();
  });

  it("does not run readiness or expose the pool if connect settles after explicit close", async () => {
    const h = fakeIO();
    let release!: () => void;
    h.pool.connect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    h.pool.close.mockRejectedValueOnce(classified()); // mssql refuses to close while connecting.
    const loader = createCatalogSagV2PublisherPoolLoader(env(), h.io);
    const pending = expect(loader.get()).rejects.toThrow(unavailable);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await loader.close();
    await pending;
    release();
    await vi.waitFor(() => expect(h.pool.close).toHaveBeenCalledTimes(2));
    expect(h.pool.query).not.toHaveBeenCalled();
    await expect(loader.get()).rejects.toThrow(unavailable);
  });

  it("never exposes driver or Vault errors, and fails before opening a pool on an empty secret", async () => {
    const h = fakeIO();
    const loader = createCatalogSagV2PublisherPoolLoader(env(), h.io);
    h.io.getSecret.mockRejectedValueOnce(classified()).mockResolvedValueOnce("");
    await expect(loader.get()).rejects.toEqual(new Error(unavailable));
    await expect(loader.get()).rejects.toEqual(new Error(unavailable));
    expect(h.io.newPool).not.toHaveBeenCalled();
    h.pool.connect.mockRejectedValueOnce(classified());
    await expect(loader.get()).rejects.toEqual(new Error(unavailable));
    expect(h.pool.close).toHaveBeenCalledOnce();
    await loader.close();
  });

  it("readiness query performs only metadata reads with exact target and least-privilege checks", () => {
    const text = CATALOG_SAG_V2_PUBLISHER_READINESS_SQL;
    expect(text).toMatch(/^\s*SELECT/i);
    expect(text).not.toMatch(/;\s*(?:EXEC|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
    for (const token of ["@expectedDatabase", "@expectedLogin", "ProductMajorVersion", "150", "Modern_Spanish_CI_AS",
      "portal_catalog_v2_publisher", "portal_runtime", "db_owner", "sysadmin", "IMPERSONATE", "sys.user_token", "sys.login_token",
      "fn_my_permissions", "HAS_PERMS_BY_NAME", "reserve_catalog_sag_v2_attempt", "publish_catalog_sag_v2_revision",
      "fail_catalog_sag_v2_attempt", "catalog_sag_v2_transition_internal", "catalog_customer_attempt_sequence"])
      expect(text).toContain(token);
    expect(text).toContain("HAS_PERMS_BY_NAME(N'settings.publish_catalog_sag_v2_with_targets', N'OBJECT', N'EXECUTE') = 1");
    for (const table of ["catalog_sag_company_location_observations", "catalog_sag_company_location_seals"]) {
      for (const command of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(text).toContain(`COALESCE(HAS_PERMS_BY_NAME(N'core.${table}',N'OBJECT',N'${command}'),0) = 0`);
      }
    }
  });
});
