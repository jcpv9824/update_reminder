import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (work: (tx: object) => unknown) => work({}) }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: fakes.audit }));
vi.mock("mssql", async importOriginal => {
  const actual = await importOriginal<typeof import("mssql")>();
  return { ...actual, default: { ...actual.default, Request: class {
    parameters: Record<string, unknown> = {};
    input(name: string, _type: unknown, value: unknown) { this.parameters[name] = value; return this; }
    query(text: string) { return fakes.query(text, this.parameters); }
  } } };
});

import { createSqlDomain, domainSqlConflictMessage, setSqlDomainStatus, updateSqlDomain } from "../lib/domainsSqlWriteRepository";
import { serverError } from "../lib/http";

const actor = { id: "operator", email: "operator@example.test" };
const scopedIndex = "UX_domains_client_environment_name_active";
const legacyIndex = "UX_domains_name_active";
const scopedMessage = "Ya existe un dominio con esta URL para este cliente y ambiente.";
const duplicate = (index: string, number = 2601) => Object.assign(new Error(
  `Cannot insert duplicate key row in object 'core.domains' with unique index '${index}'. The duplicate key value is (SENSITIVE).`,
), { number, code: "EREQUEST" });
const domain = {
  domain_key: 42, source_id: "domain-stable", client_source_id: "client-A", client_name: "Client A",
  domain_name: "https://portal.example.test", environment_id: "production", status: "active",
  created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
  created_by: "operator", updated_by: "operator", deleted_at: null, deleted_by: null,
  last_updated_at: null, last_updated_by: null, current_web_version: null, notes: null,
};
const operations = [
  ["create", () => createSqlDomain("domain-stable", "client-A", { domainName: domain.domain_name, environment: "production" }, actor)],
  ["update", () => updateSqlDomain("domain-stable", { domainName: domain.domain_name }, actor)],
  ["reactivate", () => setSqlDomainStatus("domain-stable", "active", "domain_reactivated", actor)],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  fakes.audit.mockResolvedValue(undefined);
});

function queries(mutationError?: unknown) {
  fakes.query.mockImplementation(async (text: string, parameters: Record<string, unknown>) => {
    if (/INSERT core.domains|UPDATE core.domains/.test(text)) {
      if (mutationError) throw mutationError;
      return { recordset: [{ ...domain, source_id: parameters.sourceId ?? domain.source_id,
        client_source_id: parameters.clientSourceId ?? domain.client_source_id,
        environment_id: parameters.environment ?? domain.environment_id }] };
    }
    if (text.includes("FROM core.clients")) return { recordset: [{ client_key: 7, source_id: "client-A", name: "Client A", status: "active" }] };
    if (text.includes("FROM core.domains")) return { recordset: [domain] };
    return { recordset: [] };
  });
}

describe("domain SQL conflict classification", () => {
  it.each([2601, 2627])("maps only the scoped URL index for SQL error %s", number => {
    expect(domainSqlConflictMessage(duplicate(scopedIndex, number))).toBe(scopedMessage);
    expect(domainSqlConflictMessage({ originalError: { info: { number, message:
      `Violation of UNIQUE KEY constraint '${scopedIndex}'.` } } })).toBe(scopedMessage);
  });

  it("distinguishes a legacy global URL restriction from a same-client/environment duplicate", () => {
    const message = domainSqlConflictMessage(duplicate(legacyIndex));
    expect(message).toMatch(/restricción anterior/);
    expect(message).not.toContain("para este cliente y ambiente");
    expect(message).not.toMatch(/SENSITIVE|UX_domains/);
  });

  it.each([
    { number: 2601, message: `No se puede insertar una fila de clave duplicada en el objeto 'core.domains' con índice único '${scopedIndex}'. El valor de la clave duplicada es (SENSITIVE).` },
    { number: 2627, message: `Infracción de la restricción UNIQUE KEY '${scopedIndex}'. No se puede insertar una clave duplicada en el objeto 'core.domains'.` },
  ])("recognizes the first identifier in Spanish SQL Server diagnostics", error => {
    expect(domainSqlConflictMessage(error)).toBe(scopedMessage);
  });

  it.each([
    duplicate("UQ_domains_source_id", 2627), duplicate("PK_domain_assignees", 2627),
    duplicate("UX_domains_client_environment_name_active_other"),
    { number: 547, message: `unique index '${scopedIndex}'` },
    { number: 2601 }, { message: `unique index '${scopedIndex}'` },
    { number: 2601, message: `unique index 'UQ_domains_source_id'. The duplicate key value is (${scopedIndex}).` },
    { number: 2601, message: `unique index 'UQ_domains_source_id'. The duplicate key value is (unique index '${scopedIndex}').` },
    { number: 2627, message: `UNIQUE KEY constraint 'UQ_domains_source_id'. The duplicate key value is (constraint '${scopedIndex}').` },
    { number: 2601, message: `The duplicate key value is (unique index '${scopedIndex}').` },
    { number: 2601, message: `índice único 'UQ_domains_source_id'. El valor de la clave duplicada es (índice único '${scopedIndex}').` },
    { number: 2627, message: `restricción UNIQUE KEY 'UQ_domains_source_id'. El valor de la clave duplicada es (restricción '${scopedIndex}').` },
    null,
  ])("does not mislabel an unrelated or incomplete SQL error %j", error => {
    expect(domainSqlConflictMessage(error)).toBeNull();
  });
});

describe.each(operations)("%s domain mutation", (_name, mutate) => {
  it("returns a safe HTTP 409 for the scoped URL conflict and does not audit success", async () => {
    queries(duplicate(scopedIndex));
    const error = await mutate().catch(error => error);
    expect(serverError(error)).toEqual({ status: 409, jsonBody: { error: scopedMessage } });
    expect(fakes.audit).not.toHaveBeenCalled();
  });

  it("returns a separate controlled 409 while the legacy index still exists", async () => {
    queries(duplicate(legacyIndex));
    const response = serverError(await mutate().catch(error => error));
    expect(response.status).toBe(409);
    expect(response.jsonBody.error).toMatch(/restricción anterior/);
  });

  it("does not relabel source-ID collisions as URL duplicates or disclose SQL details", async () => {
    const error = duplicate("UQ_domains_source_id", 2627);
    queries(error);
    const response = serverError(await mutate().catch(error => error));
    expect(response).toEqual({ status: 500, jsonBody: { error: "Error interno del servidor." } });
    expect(fakes.audit).not.toHaveBeenCalled();
  });
});

describe("stable logical identity and scope", () => {
  it("binds the client source ID used by INSERT OUTPUT and preserves the supplied domain ID", async () => {
    queries();
    const created = await createSqlDomain("domain-new", "client-A", {
      domainName: " HTTPS://Portal.Example.Test/// ", environment: "production",
    }, actor);
    const [statement, params] = fakes.query.mock.calls.find(([text]) => text.includes("INSERT core.domains"))!;
    expect(statement).toContain("@clientSourceId AS client_source_id");
    expect(params).toMatchObject({ sourceId: "domain-new", clientSourceId: "client-A", clientKey: 7,
      domainNameNormalized: "https://portal.example.test", environment: "production" });
    expect(created.id).toBe("domain-new");
    expect(created.clientId).toBe("client-A");
  });

  it("does not perform a global URL lookup or merge IDs across distinct environments", async () => {
    queries();
    const first = await createSqlDomain("domain-production", "client-A", { domainName: domain.domain_name, environment: "production" }, actor);
    const second = await createSqlDomain("domain-test", "client-A", { domainName: domain.domain_name, environment: "test" }, actor);
    expect(first.id).toBe("domain-production");
    expect(second.id).toBe("domain-test");
    expect(second.environment).toBe("test");
    for (const [query] of fakes.query.mock.calls) expect(query).not.toMatch(/WHERE\s+domain_name_normalized\s*=/i);
  });

  it("updates scope without replacing source_id and keeps status operations ID-addressed", async () => {
    queries();
    expect((await updateSqlDomain("domain-stable", { environment: "test" }, actor))?.id).toBe("domain-stable");
    const update = fakes.query.mock.calls.find(([text]) => text.includes("UPDATE core.domains"))!;
    expect(update[1]).toMatchObject({ domainKey: 42, environment: "test" });
    expect(update[0]).not.toMatch(/SET\s+source_id|source_id\s*=/);
  });
});

describe("domain-local SQL error boundary", () => {
  it.each([
    { number: 547, message: "synthetic FK details" },
    { code: "EREQUEST", message: "synthetic query text" },
    { originalError: { info: { number: 2627 } }, message: "synthetic duplicate value" },
    { name: "ConnectionError", message: "synthetic server credentials" },
  ])("sanitizes unknown SQL failures without claiming a business conflict", async error => {
    queries(error);
    const response = serverError(await operations[0][1]().catch(error => error));
    expect(response).toEqual({ status: 500, jsonBody: { error: "Error interno del servidor." } });
  });

  it("preserves controlled application status and validation text", () => {
    expect(serverError(Object.assign(new Error("Cliente no encontrado."), { status: 400 })))
      .toEqual({ status: 400, jsonBody: { error: "Cliente no encontrado." } });
  });
});
