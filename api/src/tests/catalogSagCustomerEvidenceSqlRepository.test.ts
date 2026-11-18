import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSqlCatalogSagCustomerEvidence } from "../lib/catalogSagCustomerEvidenceSqlRepository";

const fake = vi.hoisted(() => ({ pool: vi.fn(), request: vi.fn(), input: vi.fn(), query: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: fake.pool }));

const authorized = "117fdc31-5137-49db-8109-e881442554d5";
const scope = {
  customerId: "71d304e9-21d9-4acd-a34f-c26222b31b77", environment: "qa" as const,
  matchKeyVersion: 1, allowedSourceIds: new Set([authorized]),
};
const time = new Date("2026-11-17T15:00:00.000Z");
const evidence = {
  domain_candidate: "qa.example.test", environment_kind: "test", license_codes: "AS",
  test_started_on: "2026-11-16", production_started_on: null, demo_started_on: null,
};

describe("SAG per-customer evidence read", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake.pool.mockResolvedValue({ request: fake.request });
    fake.request.mockReturnValue({ input: fake.input, query: fake.query });
    fake.input.mockReturnThis();
    fake.query.mockResolvedValue({ recordsets: [[{ evidence_state: "verified", verified_at: time }], [evidence], []] });
  });

  it("passes only bound parameters, exposes allowlisted details and queries authorized exact identities", async () => {
    fake.query.mockResolvedValueOnce({ recordsets: [[{ evidence_state: "verified", verified_at: time }], [{
      ...evidence, source_record_id: 19, document_number_token: Buffer.alloc(32, 200), database_name: "not a projection",
    }], []] });
    await expect(readSqlCatalogSagCustomerEvidence(scope)).resolves.toEqual({
      state: "verified", verifiedAt: time.toISOString(), items: [{
        domainCandidate: "qa.example.test", environment: "test", licenseCodes: ["A", "S"], testStartedOn: "2026-11-16",
        productionStartedOn: null, demoStartedOn: null,
      }],
    });
    expect(fake.input).toHaveBeenCalledWith("allowedSourceIds", expect.anything(), JSON.stringify([authorized]));
    expect(fake.input).toHaveBeenCalledWith("customerId", expect.anything(), scope.customerId);
    const statement = fake.query.mock.calls[0][0] as string;
    expect(statement).toContain("TRY_CONVERT(uniqueidentifier,a.[value])=b.source_id");
    expect(statement).toContain("r.catalog_customer_key=@customerKey");
    expect(statement).toContain("r.catalog_customer_key<>@customerKey");
    expect(statement).toMatch(/h\.source_role='erp-customers' AND r\.catalog_customer_key=@customerKey\s+GROUP BY h\.revision_key HAVING COUNT_BIG\(\*\)>1/);
    expect(statement).toContain("r.issuer=@issuer AND r.document_type=@documentType");
    expect(statement).toContain("r.document_number_token=@token");
    expect(statement).toContain("r.issuer IS NULL AND r.document_number_token=@token");
    expect(statement).toContain("r.match_key_version=@matchKeyVersion");
    expect(statement).toContain("r.profile_version=p.row_version AND r.binding_version=b.row_version");
    expect(statement).toContain("h.attempt_status='succeeded' AND h.attempted_at<=@now AND r.verified_until>@now");
    expect(statement).toContain("FROM core.catalog_customer_revision_scopes AS s");
    expect(statement).toContain("TOP (@itemLimit+1)");
    expect(statement.slice(statement.lastIndexOf("SELECT domain_candidate"))).not.toMatch(/customer_id|source_record_id,|document_number_token|@token|issuer/);
    expect(statement).not.toContain(scope.customerId);
    expect(statement).not.toContain(authorized);
  });

  it("does not distinguish hidden and unknown customers and skips SQL when authorization is empty", async () => {
    await expect(readSqlCatalogSagCustomerEvidence({ ...scope, allowedSourceIds: new Set() })).resolves.toBeNull();
    await expect(readSqlCatalogSagCustomerEvidence({ ...scope, customerId: "invalid" })).resolves.toBeNull();
    expect(fake.pool).not.toHaveBeenCalled();
    fake.query.mockResolvedValue({ recordsets: [[], [], []] });
    await expect(readSqlCatalogSagCustomerEvidence(scope)).resolves.toBeNull();
  });

  it("keeps stale exact evidence labeled and distinguishes verified empty from unavailable", async () => {
    fake.query.mockResolvedValueOnce({ recordsets: [[{ evidence_state: "stale", verified_at: time }], [{ ...evidence, license_codes: "" }], []] });
    await expect(readSqlCatalogSagCustomerEvidence(scope)).resolves.toMatchObject({
      state: "stale", verifiedAt: time.toISOString(), items: [{ licenseCodes: [] }],
    });
    fake.query.mockResolvedValueOnce({ recordsets: [[{ evidence_state: "verified", verified_at: time }], [], []] });
    await expect(readSqlCatalogSagCustomerEvidence(scope)).resolves.toEqual({ state: "verified", verifiedAt: time.toISOString(), items: [] });
    fake.query.mockResolvedValueOnce({ recordsets: [[{ evidence_state: "unavailable", verified_at: null }], [], []] });
    await expect(readSqlCatalogSagCustomerEvidence(scope)).resolves.toEqual({ state: "unavailable", verifiedAt: null, items: [] });
  });

  it("rejects malformed result shapes, noncanonical fields, or overflow instead of returning partial data", async () => {
    const validHeader = [{ evidence_state: "verified", verified_at: time }];
    for (const recordsets of [
      [[{ evidence_state: "verified", verified_at: "2026-11-17" }], [evidence], []],
      [[{ evidence_state: "unavailable", verified_at: null }], [evidence], []],
      [[], [evidence], []], [validHeader, Array.from({ length: 129 }, () => evidence), []],
      [validHeader, [{ ...evidence, domain_candidate: "https://qa.example.test/path" }], []],
      [validHeader, [{ ...evidence, license_codes: "T" }], []],
    ]) {
      fake.query.mockResolvedValueOnce({ recordsets });
      await expect(readSqlCatalogSagCustomerEvidence(scope)).rejects.toThrow("catalog_sag_customer_evidence_unavailable");
    }
  });

  it("resolves approved modules only for codes in the authorized SAG revision", async () => {
    const approved = { sag_code: "A", module_id: "module-a", module_name: "Operación", module_description: "Descripción" };
    fake.query.mockResolvedValueOnce({ recordsets: [[{ evidence_state: "verified", verified_at: time }], [evidence], [approved]] });
    await expect(readSqlCatalogSagCustomerEvidence(scope)).resolves.toMatchObject({ licenseModules: [{ code: "A", moduleId: "module-a",
      name: "Operación", description: "Descripción" }] });
    const query = fake.query.mock.calls[0][0];
    expect(query).toContain("mapping.catalog_source_key=sag.catalog_source_key");
    expect(query).toContain("mapping.binding_version=sag.binding_version AND mapping.profile_version=sag.profile_version");
    expect(query).toContain("module.status='active' AND module.deleted_at IS NULL");
    fake.query.mockResolvedValueOnce({ recordsets: [[{ evidence_state: "verified", verified_at: time }], [evidence], [{ ...approved, sag_code: "B" }]] });
    await expect(readSqlCatalogSagCustomerEvidence(scope)).rejects.toThrow("catalog_sag_customer_evidence_unavailable");
  });

  it("validates service scope and hides all driver failures", async () => {
    await expect(readSqlCatalogSagCustomerEvidence({ ...scope, allowedSourceIds: new Set(["bad"]) }))
      .rejects.toThrow("catalog_sag_customer_evidence_unavailable");
    expect(fake.pool).not.toHaveBeenCalled();
    fake.query.mockRejectedValueOnce(new Error("private server error with data"));
    await expect(readSqlCatalogSagCustomerEvidence(scope)).rejects.toEqual(new Error("catalog_sag_customer_evidence_unavailable"));
  });
});
