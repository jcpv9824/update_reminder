import { describe, expect, it, vi } from "vitest";
import { createCatalogScheduleChoicesHttp, type CatalogScheduleChoice } from "../lib/catalogScheduleChoices";
import { parseCatalogScheduleChoicesSqlResult, readCatalogScheduleChoicesSql, readSqlCatalogScheduleChoices } from "../lib/catalogScheduleChoicesSqlRepository";

const requestSpies = vi.hoisted(() => ({ input: vi.fn(), query: vi.fn() }));
vi.mock("mssql", () => ({
  default: {
    Request: class {
      input(...args: unknown[]) { requestSpies.input(...args); return this; }
      query(statement: string) { return requestSpies.query(statement); }
    },
    NVarChar: (len: number) => ["nvarchar", len], VarChar: (len: number) => ["varchar", len],
    Char: (len: number) => ["char", len], MAX: -1, Int: "int", SmallInt: "smallint",
  },
}));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (f: (transaction: unknown) => unknown) => f({}) }));

const customerId = "8e1a2337-be9f-4c78-a28e-070ab8f22bff";
const sourceId = "c905e778-c10e-438f-acb7-f4601ad79643";
const sample: CatalogScheduleChoice = {
  id: "b".repeat(64), customerId, customerName: "Cliente Oficial", domain: "tenant.example.com",
  database: "DB QA", environment: "test", eligibility: "observed_only",
};
const req = (query: string) => ({ query: new URLSearchParams(query) }) as Parameters<ReturnType<typeof createCatalogScheduleChoicesHttp>>[0];
function deps(row: CatalogScheduleChoice = sample) {
  return {
    authorize: vi.fn().mockResolvedValue({ actorId: "the-portal-actor" }),
    readSources: vi.fn().mockResolvedValue(new Set([sourceId])),
    read: vi.fn().mockResolvedValue({ state: "verified", items: [row], total: 1 }),
  };
}

describe("catalog schedule choices", () => {
  it("never resolves sources or data when the schedule preview is unauthorized", async () => {
    const io = deps();
    io.authorize.mockResolvedValue({ status: 403 });
    expect(await createCatalogScheduleChoicesHttp(io)(req("kind=database"))).toMatchObject({ status: 403 });
    expect(io.readSources).not.toHaveBeenCalled();
    expect(io.read).not.toHaveBeenCalled();
  });

  it("uses only actor-derived source scope and returns an explicitly nonoperational display projection", async () => {
    const io = deps({ ...sample, document: "private", targetId: "not allowed", databaseId: "not allowed" } as CatalogScheduleChoice);
    const response = await createCatalogScheduleChoicesHttp(io)(
      req("kind=database&search=literal%25_&page=3&pageSize=10"),
    );
    expect(io.readSources).toHaveBeenCalledWith("the-portal-actor");
    expect(io.read).toHaveBeenCalledWith({
      kind: "database", search: "literal%_", page: 3, pageSize: 10, actorId: "the-portal-actor",
      allowedSourceIds: new Set([sourceId]),
    });
    expect(response).toMatchObject({ status: 200, headers: { "Cache-Control": "no-store" },
      jsonBody: { state: "verified", total: 1, page: 3, pageSize: 10, items: [sample] } });
    expect(JSON.stringify(response)).not.toMatch(/private|targetId|databaseId/);
  });

  it("passes exact client, domain, database and environment together for a manual database selection", async () => {
    const io = deps();
    const response = await createCatalogScheduleChoicesHttp(io)(
      req(`kind=database&customerId=${customerId}&domain=tenant.example.com&database=DB%20QA&environment=test`),
    );
    expect(response.status).toBe(200);
    expect(io.read).toHaveBeenCalledWith(expect.objectContaining({
      customerId, domain: "tenant.example.com", database: "DB QA", environment: "test",
    }));
  });

  it.each([
    "kind=database&sourceIds=*",
    "kind=database&actorId=other",
    "kind=domain&kind=database",
    "kind=database&environment=unknown",
    "kind=database&environment=test ",
    "kind=customer&domain=tenant.example.com",
    "kind=database&domain=tenant.example.com&environment=test",
    `kind=database&customerId=${customerId}&database=DB%20QA&environment=test`,
    `kind=database&customerId=${customerId}&domain=tenant.example.com&database=DB%20QA`,
    "kind=domain&moduleCode=BI",
    "kind=license&pageSize=101",
  ])("rejects invalid or incomplete options (%s)", async query => {
    const io = deps();
    expect(await createCatalogScheduleChoicesHttp(io)(req(query))).toMatchObject({ status: 400 });
    expect(io.read).not.toHaveBeenCalled();
  });

  it("lists only named observed license options, without fake customer choices", async () => {
    const io = deps();
    io.read.mockResolvedValue({ state: "partial", items: [], total: 1,
      licenseOptions: [{ code: "A", name: "Contabilidad", moduleId: "internal" }] });
    const request = req("kind=license&search=Conta&pageSize=5");
    const response = await createCatalogScheduleChoicesHttp(io)(request);
    expect(io.authorize).toHaveBeenCalledWith(request, "license", true);
    expect(io.read).toHaveBeenCalledWith({ kind: "license", search: "Conta", page: 1, pageSize: 5,
      actorId: "the-portal-actor", allowedSourceIds: new Set([sourceId]) });
    expect(response).toMatchObject({ status: 200, jsonBody: { state: "partial", total: 1, items: [],
      licenseOptions: [{ code: "A", name: "Contabilidad" }] } });
    expect(JSON.stringify(response)).not.toContain("moduleId");
  });

  it("authorizes license-filtered target reads and preserves partial state even with no matching positive rows", async () => {
    const io = deps();
    io.read.mockResolvedValueOnce({ state: "partial", items: [], total: 0 });
    const request = req(`kind=database&customerId=${customerId}&domain=tenant.example.com&database=DB%20QA&environment=test&moduleCode=A`);
    const read = createCatalogScheduleChoicesHttp(io);
    expect(await read(request)).toMatchObject({ status: 200, jsonBody: { state: "partial", total: 0, items: [] } });
    expect(io.authorize).toHaveBeenCalledWith(request, "database", true);
    expect(io.read).toHaveBeenCalledWith(expect.objectContaining({
      customerId, domain: "tenant.example.com", database: "DB QA", environment: "test", moduleCode: "A",
    }));
    expect(await read(request)).toMatchObject({ status: 200, jsonBody: { items: [sample] } });
  });

  it("does not resolve license scope after a permission denial", async () => {
    const io = deps();
    io.authorize.mockResolvedValue({ status: 403 });
    expect(await createCatalogScheduleChoicesHttp(io)(req("kind=domain&moduleCode=A"))).toMatchObject({ status: 403 });
    expect(io.readSources).not.toHaveBeenCalled();
    expect(io.read).not.toHaveBeenCalled();
  });

  it("turns a failing read into a sanitized unavailable response", async () => {
    const io = deps();
    io.read.mockRejectedValue(new Error("should not leak server connection"));
    const response = await createCatalogScheduleChoicesHttp(io)(req("kind=database"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(response)).not.toContain("server connection");
  });

  it("keeps exact relational predicates and actor scope ahead of pagination", () => {
    expect(readCatalogScheduleChoicesSql).toContain("i.active_state IN ('active','unverified')");
    expect(readCatalogScheduleChoicesSql).toContain("FROM @observedIdentity i");
    expect(readCatalogScheduleChoicesSql).toContain("d.revision_key=i.revision_key AND d.source_record_id=i.source_record_id");
    expect(readCatalogScheduleChoicesSql).toContain("WHERE q.position>@skip");
    expect(readCatalogScheduleChoicesSql).toContain(
      "SELECT i.id,i.customerId,i.customerName,i.domainName,i.databaseName,i.targetEnvironment\nFROM @choicePage",
    );
  });

  it("accepts only the exact selected relation from the SQL boundary and never gives an operational ID", () => {
    const query = { kind: "database" as const, customerId, actorId: "actor", allowedSourceIds: new Set([sourceId]),
      page: 1, pageSize: 25, domain: "tenant.example.com", database: "DB QA", environment: "test" as const };
    const meta = [{ state: "verified", total: 1 }];
    const dbRow = { id: sample.id, customerId, customerName: sample.customerName, domainName: sample.domain,
      databaseName: sample.database, targetEnvironment: sample.environment, operationalTargetId: "do-not-project" };
    expect(parseCatalogScheduleChoicesSqlResult(query, [meta, [dbRow]])).toEqual({ state: "verified", total: 1, items: [sample] });
    for (const otherEdge of [
      { customerId: sourceId }, { domainName: "other.example.com" }, { databaseName: "Db QA" }, { targetEnvironment: "production" },
      { domainName: "https://user@tenant.example.com" },
    ]) {
      expect(() => parseCatalogScheduleChoicesSqlResult(query, [meta, [{ ...dbRow, ...otherEdge }]]))
        .toThrow("catalog_schedule_choices_unavailable");
    }
  });

  it("returns a positive customer-only observation without inferring a domain or database", () => {
    const io = deps({ id: customerId, customerId, customerName: "Cliente Oficial", eligibility: "observed_only" });
    return expect(createCatalogScheduleChoicesHttp(io)(req("kind=customer"))).resolves.toMatchObject({
      status: 200, jsonBody: { items: [{ id: customerId, customerId, eligibility: "observed_only" }] },
    });
  });

  it("accepts only an approved exact display code/name pair from the license read", () => {
    const query = { kind: "license" as const, actorId: "actor", allowedSourceIds: new Set([sourceId]), page: 1, pageSize: 25 };
    const summary = [{ state: "partial", total: 1 }];
    expect(parseCatalogScheduleChoicesSqlResult(query, [summary, [{ code: "A", name: "Contabilidad" }]]))
      .toEqual({ state: "partial", total: 1, items: [], licenseOptions: [{ code: "A", name: "Contabilidad" }] });
    expect(parseCatalogScheduleChoicesSqlResult(query, [[{ state: "unavailable", total: 0 }], []]))
      .toEqual({ state: "unavailable", total: 0, items: [], licenseOptions: [] });
    for (const option of [{ code: "S", name: "Inventada" }, { code: "A", name: "Inventada" }, { code: "BI", name: "BI" }]) {
      expect(() => parseCatalogScheduleChoicesSqlResult(query, [summary, [option]])).toThrow("catalog_schedule_choices_unavailable");
    }
  });

  it("requires exact same-row licensing and never turns unknown evidence into inherited membership", () => {
    expect(readCatalogScheduleChoicesSql).toContain("d.revision_key=i.revision_key AND d.source_record_id=i.source_record_id");
    expect(readCatalogScheduleChoicesSql).toContain("c.revision_key=l.revision_key AND c.customer_record_id=l.source_record_id");
    expect(readCatalogScheduleChoicesSql).toContain("(@moduleCode IS NULL OR CHARINDEX(@moduleCode,l.licenseCodes)>0)");
    expect(readCatalogScheduleChoicesSql).toContain("l.licenseCodes IS NULL");
    expect(readCatalogScheduleChoicesSql).toContain("CHARINDEX(m.code,l.licenseCodes)>0");
  });

  it("binds exact domain using the published VARCHAR type, and module code separately from the compiled SQL", async () => {
    requestSpies.input.mockClear();
    requestSpies.query.mockResolvedValue({ recordsets: [[{ state: "partial", total: 0 }], []] });
    await expect(readSqlCatalogScheduleChoices({ kind: "database", actorId: "actor", allowedSourceIds: new Set([sourceId]),
      customerId, domain: "tenant.example.com", database: "DB QA", environment: "test", moduleCode: "A",
      portalEnvironment: "qa", matchKeyVersion: 1, page: 2, pageSize: 10 }))
      .resolves.toEqual({ state: "partial", total: 0, items: [] });
    expect(requestSpies.query).toHaveBeenCalledWith(readCatalogScheduleChoicesSql);
    expect(requestSpies.input.mock.calls).toEqual(expect.arrayContaining([
      ["domain", ["varchar", 253], "tenant.example.com"], ["database", ["nvarchar", 128], "DB QA"],
      ["moduleCode", ["char", 1], "A"], ["environment", ["varchar", 10], "qa"],
      ["targetEnvironment", ["varchar", 10], "test"], ["skip", "int", 10],
      ["sourceIds", ["nvarchar", -1], JSON.stringify([sourceId])],
    ]));
  });
});
