import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSqlCatalogOperationalLinks } from "../lib/catalogOperationalLinksSqlRepository";
import type { CatalogEnvironment } from "../lib/catalogSourceConfiguration";

const fakes = vi.hoisted(() => ({ input: vi.fn(), query: vi.fn(), pool: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: fakes.pool }));
const linkId = "31140f4d-81c3-4938-9ab2-a275473feb17";
const customerId = "41140f4d-81c3-4938-9ab2-a275473feb17";
const sourceId = "51140f4d-81c3-4938-9ab2-a275473feb17";
const expires = new Date("2099-01-01T00:00:00.000Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  link_key: "1", link_id: linkId, catalog_customer_id: customerId,
  portal_environment: "qa", customer_id: "client-A", customer_name: "Local client",
  domain_id: "domain-A", domain_name: "Local domain", database_id: null, database_name: null,
  target_kind: "domain", link_environment: "production", catalog_record_id: "2147483647",
  evidence_state: "verified", catalog_source_id: sourceId, revision_id: "9007199254740993",
  binding_version: "00000000000000ab", profile_version: "00000000000000cd", verified_until: expires,
  ...overrides,
});
const read = () => readSqlCatalogOperationalLinks({ portalEnvironment: "qa" });
const failure = new Error("catalog_operational_links_unavailable");

describe("bounded operational link evidence reader", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const request = { input: fakes.input, query: fakes.query };
    fakes.input.mockReturnValue(request);
    fakes.pool.mockResolvedValue({ request: () => request });
  });

  it("binds an exact environment, reads all open states, and uses trusted local joins and ordered overflow detection", async () => {
    fakes.query.mockResolvedValue({ recordset: [row()] });
    expect(await read()).toEqual([{
      linkId, catalogCustomerId: customerId, customerId: "client-A", customerName: "Local client",
      domainId: "domain-A", domainName: "Local domain", kind: "domain", environment: "production",
      catalogRecordId: "2147483647", evidence: {
        state: "verified", sourceId, revisionId: "9007199254740993", bindingVersion: "00000000000000ab",
        profileVersion: "00000000000000cd", verifiedUntil: expires.toISOString(),
      },
    }]);
    expect(fakes.input).toHaveBeenCalledWith("portalEnvironment", expect.anything(), "qa");
    const statement = fakes.query.mock.calls[0][0] as string;
    expect(statement).toContain("SELECT TOP (5001)");
    expect(statement).toContain("ORDER BY e.link_key");
    expect(statement).toContain("e.portal_environment COLLATE Latin1_General_100_BIN2=@portalEnvironment");
    expect(statement).toContain("DATALENGTH(e.portal_environment)=DATALENGTH(@portalEnvironment)");
    expect(statement).toContain("e.retired_at IS NULL AND e.owner_retired_at IS NULL");
    expect(statement).toContain("JOIN core.catalog_customer_ids AS ci");
    expect(statement).toContain("d.domain_key=e.domain_key AND d.client_key=e.client_key");
    expect(statement).toContain("db.client_key=e.client_key AND db.domain_key=e.domain_key");
    expect(statement).toContain("CONVERT(binary(8),e.binding_version)");
    expect(statement).toContain("CONVERT(binary(8),e.profile_version)");
    expect(statement.slice(statement.indexOf("WHERE"))).not.toMatch(/evidence_state|status='active'/);
    expect(statement).not.toMatch(/password|secret|connection_string|initial_catalog|physical_target|license|SELECT\s+\*/i);
  });

  it("preserves unverifiable database edges without certification, physical targets, licenses or completeness", async () => {
    fakes.query.mockResolvedValue({ recordset: [row({
      target_kind: "database", database_id: "database-A", database_name: "Local company",
      evidence_state: "unverifiable", catalog_source_id: null, revision_id: null,
      binding_version: null, profile_version: null, verified_until: null,
    })] });
    const [link] = await read();
    expect(link).toMatchObject({ kind: "database", databaseId: "database-A", databaseName: "Local company",
      catalogCustomerId: customerId, evidence: { state: "unverifiable" } });
    expect(Object.keys(link.evidence)).toEqual(["state"]);
    for (const property of ["target", "moduleIds", "complete", "state", "sourceId", "revisionId"]) {
      expect(link).not.toHaveProperty(property);
    }
  });

  it("returns empty evidence without claiming population completeness", async () => {
    fakes.query.mockResolvedValue({ recordset: [] });
    expect(await read()).toEqual([]);
  });

  it("accepts 5000 rows and rejects 5001 instead of truncating", async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => row({
      link_key: String(index + 1), link_id: `31140f4d-81c3-4938-9ab2-${String(index).padStart(12, "0")}`,
    }));
    fakes.query.mockResolvedValueOnce({ recordset: rows });
    expect(await read()).toHaveLength(5000);
    fakes.query.mockResolvedValueOnce({ recordset: [...rows, row({ link_key: "5001" })] });
    await expect(read()).rejects.toEqual(failure);
  });

  it.each(["QA", "qa ", "production ", "test", "qa'; SELECT 1;--"])("rejects nonexact environment %s before SQL", async environment => {
    await expect(readSqlCatalogOperationalLinks({ portalEnvironment: environment as CatalogEnvironment })).rejects.toEqual(failure);
    expect(fakes.pool).not.toHaveBeenCalled();
  });

  it.each(["-2147483648", "-1", "0", "2147483647"])("preserves canonical SQL int ERP record %s", async recordId => {
    fakes.query.mockResolvedValue({ recordset: [row({ catalog_record_id: recordId })] });
    expect((await read())[0].catalogRecordId).toBe(recordId);
  });

  it.each(["01", "-0", "+1", "1.0", "1e2", " 1", "1\n", "2147483648", "-2147483649", 1, null])(
    "refuses noncanonical/out-of-range ERP identity %s", async recordId => {
      fakes.query.mockResolvedValue({ recordset: [row({ catalog_record_id: recordId })] });
      await expect(read()).rejects.toEqual(failure);
    },
  );

  it.each(["catalog_source_id", "revision_id", "binding_version", "profile_version", "verified_until"])(
    "requires %s for verified evidence and forbids it for unverifiable evidence", async field => {
      fakes.query.mockResolvedValueOnce({ recordset: [row({ [field]: null })] });
      await expect(read()).rejects.toEqual(failure);
      const unverified = row({ evidence_state: "unverifiable", catalog_source_id: null, revision_id: null,
        binding_version: null, profile_version: null, verified_until: null });
      fakes.query.mockResolvedValueOnce({ recordset: [{ ...unverified, [field]: row()[field as keyof ReturnType<typeof row>] }] });
      await expect(read()).rejects.toEqual(failure);
    },
  );

  it.each([
    { link_id: "not-a-uuid" }, { catalog_customer_id: "client-A" }, { customer_id: " client-A" },
    { domain_id: "" }, { customer_name: null }, { database_id: "unexpected" },
    { target_kind: "database" }, { target_kind: "other" }, { portal_environment: "production" },
    { link_environment: "qa" }, { evidence_state: "active" }, { binding_version: "0x01" },
    { profile_version: "00000000000000CD" }, { binding_version: "00000000000000ab\n" },
    { revision_id: "1\n" }, { revision_id: "01" }, { revision_id: 9007199254740992 },
    { revision_id: "9223372036854775808" }, { verified_until: new Date(NaN) },
    { verified_until: "2099-01-01T00:00:00Z" }, { verified_until: new Date("2000-01-01T00:00:00Z") },
  ])("fails closed on malformed evidence %j", async overrides => {
    fakes.query.mockResolvedValue({ recordset: [row(overrides)] });
    await expect(read()).rejects.toEqual(failure);
  });

  it("rejects duplicate logical identity and missing or out-of-order internal keys", async () => {
    for (const rows of [
      [row(), row({ link_key: "2" })],
      [row({ link_key: "2" }), row({ link_key: "1", link_id: customerId })],
      [row({ link_key: null })],
    ]) {
      fakes.query.mockResolvedValueOnce({ recordset: rows });
      await expect(read()).rejects.toEqual(failure);
    }
  });

  it("sanitizes SQL and malformed result failures without returning partial evidence", async () => {
    fakes.query.mockRejectedValueOnce(new Error("synthetic SQL sensitive detail"));
    await expect(read()).rejects.toEqual(failure);
    fakes.query.mockResolvedValueOnce({ recordset: null });
    await expect(read()).rejects.toEqual(failure);
  });
});
