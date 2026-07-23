import { afterEach, describe, expect, it } from "vitest";
import { assertCosmosRuntimeMutation, getDataBackend, sqlReadsEnabled, sqlSecurityRuntimeEnabled, sqlWritesEnabled } from "../lib/dataBackend";
import { buildSqlConfigFromEnv, closeSqlPool } from "../lib/sql";

const validEnv: NodeJS.ProcessEnv = {
  SQL_SERVER_HOST: "data14.sagerp.co,54103",
  SQL_DATABASE: "PortalSAGWeb",
  SQL_USERNAME: "portal_runtime",
  SQL_PASSWORD: "test-only-password",
};

afterEach(async () => {
  await closeSqlPool();
});

describe("SQL runtime configuration", () => {
  it("enforces strict TLS and parses the certified TCP endpoint", () => {
    const config = buildSqlConfigFromEnv(validEnv);
    expect(config).toMatchObject({
      server: "data14.sagerp.co",
      port: 54103,
      database: "PortalSAGWeb",
      options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true,
      },
      pool: { max: 10, min: 0 },
    });
  });

  it("rejects a wrong database, named instance or malformed pool settings", () => {
    expect(() => buildSqlConfigFromEnv({ ...validEnv, SQL_DATABASE: "master" }))
      .toThrow(/PortalSAGWeb/);
    expect(() => buildSqlConfigFromEnv({ ...validEnv, SQL_SERVER_HOST: "host\\instance" }))
      .toThrow(/host TCP/);
    expect(() => buildSqlConfigFromEnv({ ...validEnv, SQL_POOL_MAX: "0" }))
      .toThrow(/SQL_POOL_MAX/);
  });
});

describe("data backend gate", () => {
  it("keeps Cosmos as the safe default until cutover", () => {
    expect(getDataBackend({})).toBe("cosmos");
    expect(sqlReadsEnabled({})).toBe(false);
    expect(sqlWritesEnabled({})).toBe(false);
  });

  it("separates dual-read verification from SQL writes", () => {
    expect(sqlReadsEnabled({ DATA_BACKEND: "dual-read" })).toBe(true);
    expect(sqlWritesEnabled({ DATA_BACKEND: "dual-read" })).toBe(false);
    expect(sqlWritesEnabled({ DATA_BACKEND: "sql" })).toBe(true);
    expect(sqlSecurityRuntimeEnabled({ DATA_BACKEND: "sql" })).toBe(false);
    expect(sqlSecurityRuntimeEnabled({ DATA_BACKEND: "sql", SQL_SECURITY_RUNTIME_ENABLED: "true" })).toBe(true);
    expect(sqlSecurityRuntimeEnabled({ DATA_BACKEND: "dual-read", SQL_SECURITY_RUNTIME_ENABLED: "true" })).toBe(false);
  });

  it("rejects unknown backend modes", () => {
    expect(() => getDataBackend({ DATA_BACKEND: "automatic" })).toThrow(/DATA_BACKEND/);
  });

  it("blocks mixed-database side effects after the SQL read cutover", () => {
    expect(() => assertCosmosRuntimeMutation("El temporizador", { DATA_BACKEND: "sql" }))
      .toThrow(/escritura SQL/);
    expect(() => assertCosmosRuntimeMutation("El temporizador", { DATA_BACKEND: "dual-read" }))
      .not.toThrow();
  });
});
