import { describe, expect, it } from "vitest";
import { resolveCatalogSqlInstanceRoute } from "../lib/catalogSqlInstanceRegistry";

const id = "5a4f726d-117f-460f-be03-b5c2085a4492";
const other = "733fa106-417e-4a6d-acf8-ceec3fe1e753";
const entry = { environment: "qa", host: "sql.example.invalid", port: 1433, instanceId: id };
const resolve = (entries: unknown, host = entry.host, port = entry.port, environment: "qa" | "production" = "qa") =>
  resolveCatalogSqlInstanceRoute(JSON.stringify(entries), environment, host, port);

describe("server-owned catalog SQL instance routes", () => {
  it("resolves an exact DNS route case-insensitively and only in its environment", () => {
    expect(resolve([entry], "SQL.EXAMPLE.INVALID")).toBe(id);
    expect(resolve([entry], entry.host, 1444)).toBeNull();
    expect(resolve([entry], entry.host, entry.port, "production")).toBeNull();
    expect(resolve([entry], "sub.sql.example.invalid")).toBeNull();
    expect(resolve([entry], "sql.example.invalid.")).toBeNull();
  });

  it("allows aliases only in separate explicitly configured routes", () => {
    expect(resolve([entry], "alias.example.invalid")).toBeNull();
    expect(resolve([entry, { ...entry, host: "alias.example.invalid" }], "alias.example.invalid")).toBe(id);
    expect(resolve([entry, { ...entry, environment: "production", instanceId: other }], entry.host, 1433, "production")).toBe(other);
  });

  it("rejects duplicate routes even when their UUIDs agree", () => {
    expect(resolve([entry, { ...entry, host: "SQL.EXAMPLE.INVALID" }])).toBeNull();
    expect(resolve([entry, { ...entry, instanceId: other }])).toBeNull();
  });

  it.each([
    { host: "*.example.invalid" }, { host: "127.0.0.1" }, { host: "127.1" }, { host: "example.invalid;User=ignored" },
    { host: "sql..example.invalid" }, { host: "sql.example.invalid " }, { port: 0 }, { port: null },
    { port: "1433" }, { port: 65536 }, { instanceId: "00000000-0000-0000-0000-000000000000" },
    { instanceId: "sql.example.invalid" }, { instanceId: `${id}\n` }, { environment: "dev" }, { unknown: true },
  ])("does not silently skip an invalid registry row: %j", patch => {
    expect(resolve([entry, { ...entry, host: "other.example.invalid", ...patch }])).toBeNull();
  });

  it("fails closed for missing, malformed or unbounded configuration", () => {
    expect(resolveCatalogSqlInstanceRoute(undefined, "qa", entry.host, 1433)).toBeNull();
    expect(resolveCatalogSqlInstanceRoute("{broken", "qa", entry.host, 1433)).toBeNull();
    expect(resolve({ entry })).toBeNull();
    expect(resolve(Array.from({ length: 257 }, (_, n) => ({ ...entry, host: `sql${n}.example.invalid` })))).toBeNull();
  });
});
