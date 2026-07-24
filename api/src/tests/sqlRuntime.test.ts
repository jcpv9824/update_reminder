import { afterEach, describe, expect, it } from "vitest";
import { getDataBackend, sqlReadsEnabled, sqlSecurityRuntimeEnabled, sqlWritesEnabled } from "../lib/dataBackend";
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
  it("fails closed when the backend is not explicitly configured", () => {
    expect(() => getDataBackend({})).toThrow(/Falta DATA_BACKEND/);
    expect(() => sqlReadsEnabled({})).toThrow(/Falta DATA_BACKEND/);
    expect(() => sqlWritesEnabled({})).toThrow(/Falta DATA_BACKEND/);
  });

  it("enables reads and writes only for the SQL backend", () => {
    expect(() => sqlReadsEnabled({ DATA_BACKEND: "legacy" })).toThrow(/debe ser sql/);
    expect(() => sqlWritesEnabled({ DATA_BACKEND: "legacy" })).toThrow(/debe ser sql/);
    expect(sqlReadsEnabled({ DATA_BACKEND: "sql" })).toBe(true);
    expect(sqlWritesEnabled({ DATA_BACKEND: "sql" })).toBe(true);
    expect(() => sqlSecurityRuntimeEnabled({ DATA_BACKEND: "sql" })).toThrow(/SQL_SECURITY_RUNTIME_ENABLED/);
    expect(sqlSecurityRuntimeEnabled({ DATA_BACKEND: "sql", SQL_SECURITY_RUNTIME_ENABLED: "true" })).toBe(true);
  });

  it("rejects unknown backend modes", () => {
    expect(() => getDataBackend({ DATA_BACKEND: "automatic" })).toThrow(/DATA_BACKEND/);
  });

  it("rejects retired backend modes", () => {
    expect(() => getDataBackend({ DATA_BACKEND: "dual-read" })).toThrow(/debe ser sql/);
    expect(() => getDataBackend({ DATA_BACKEND: "cosmos" })).toThrow(/debe ser sql/);
  });
});
