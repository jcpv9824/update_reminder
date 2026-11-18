import { expect, it, vi } from "vitest";

const sql = vi.hoisted(() => ({ query: vi.fn(), input: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: async () => ({ request: () => sql }) }));

import { readSqlCatalogReportingProfiles } from "../lib/catalogReportingProfilesSqlRepository";

it("selects only reporting profiles that agree with the exact recorded SQL namespace, leaving other destinations absent", async () => {
  const included = "2f90d6c9-470f-4c31-ad3d-b404863f7539";
  const missing = "2f90d6c9-470f-4c31-ad3d-b404863f7538";
  const instance = "2f90d6c9-470f-4c31-ad3d-b404863f7537";
  sql.input.mockReturnValue(sql);
  sql.query.mockResolvedValue({ recordset: [{ target_id: included, profile_id: missing, instance_id: instance,
    connection_id: "test-profile", version: "0102030405060708", fingerprint: Buffer.alloc(32, 1),
    count_contract: "approved_aggregate_view_v1", active_column: null, active_storage: null, active_bit: null,
    active_text: null, inactive_text: null }] });
  const profiles = await readSqlCatalogReportingProfiles({ portalEnvironment: "qa", physicalIds: new Set([included, missing]) });
  const statement = sql.query.mock.calls[0][0];
  expect(statement).toContain("JOIN core.catalog_sql_target_instance_identities i");
  for (const clause of ["i.physical_target_key=t.physical_target_key", "i.portal_environment=t.portal_environment",
    "i.target_kind=t.target_kind", "i.trusted_instance_id=r.trusted_instance_id", "i.registered_at<=@now"]) {
    expect(statement).toContain(clause);
  }
  expect(profiles.get(included)?.target.serverGroupId).toBe(instance);
  expect(profiles.has(missing)).toBe(false);
});
