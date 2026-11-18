import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSqlCatalogSourceBindings } from "../lib/catalogSourceBindingsSqlRepository";

const pool = vi.hoisted(() => {
  const query = vi.fn();
  const input = vi.fn();
  const request = vi.fn();
  return { query, input, request };
});
vi.mock("../lib/sql", () => ({
  getSqlPool: vi.fn(async () => ({ request: pool.request })),
}));

describe("readSqlCatalogSourceBindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pool.request.mockReturnValue({ input: pool.input });
    pool.input.mockReturnValue({ query: pool.query });
  });

  it("only returns service configuration and validates the current profile version in SQL", async () => {
    pool.query.mockResolvedValue({
      recordset: [{
        catalog_source_id: "00000000-0000-0000-0000-000000000010", profile_id: "profile-10",
        display_name: "Empresa Colombia", source_role: "erp-customers", portal_environment: "qa",
        source_state: "active", issuer_scope: "CO-NIT", contract_version: "erp_v1",
        binding_version: Buffer.from("0000000000000001", "hex"),
        profile_version: Buffer.from("0000000000000002", "hex"),
        can_read_current_profile: false,
        server_host: "forbidden-not-a-projection", password_secret_name: "forbidden-not-a-projection",
      }],
    });
    const projected = await readSqlCatalogSourceBindings("qa");
    expect(projected).toEqual([{
      id: "00000000-0000-0000-0000-000000000010", profileId: "profile-10", label: "Empresa Colombia",
      role: "erp-customers", environment: "qa", state: "active", issuerScope: "CO-NIT",
      contractVersion: "erp_v1", bindingVersion: "0000000000000001",
      profileRevision: "0000000000000002", canReadCurrentProfile: false,
    }]);
    expect(pool.input).toHaveBeenCalledWith("environment", expect.anything(), "qa");
    const [statement] = pool.query.mock.calls[0];
    expect(statement).toContain("WHERE b.portal_environment=@environment");
    expect(statement).toContain("b.validated_profile_version=p.row_version");
    expect(statement).not.toMatch(/server_host|login_name|database_name|password_secret_name/i);
  });
});
