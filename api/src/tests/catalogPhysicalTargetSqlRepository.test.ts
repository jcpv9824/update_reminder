import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  planCatalogTasksWithVerifiedTargets, readSqlCatalogPhysicalTargets, readSqlCatalogPhysicalTargetsInTransaction,
  readSqlCatalogPhysicalTargetPinsInTransaction,
} from "../lib/catalogPhysicalTargetSqlRepository";
import type { CatalogTaskLink, CatalogTaskRequest } from "../lib/catalogTaskTargetPlanning";

const fakes = vi.hoisted(() => ({ input: vi.fn(), query: vi.fn(), pool: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: fakes.pool }));
const id = "31140f4d-81c3-4938-9ab2-a275473feb17";

const links: CatalogTaskLink[] = ["A", "B", "C"].map(label => ({
  kind: "database", linkId: `link-${label}`, customerId: `customer-${label}`,
  domainId: `domain-${label}`, databaseId: `database-${label}`, environment: "production",
  catalogRecordId: `row-${label}`, state: "active", moduleIds: ["license"],
  target: { status: "verified", id: `untrusted-${label}` },
}));
const requests: CatalogTaskRequest[] = [{
  scheduleId: "manual", operationId: "release", assignment: { kind: "user", id: "operator" },
  scope: { kind: "database" },
}];

describe("physical target registry reader", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const request = { input: fakes.input, query: fakes.query };
    fakes.input.mockReturnValue(request);
    fakes.pool.mockResolvedValue({ request: () => request });
  });

  it("supplies only exact, parameterized logical identities and requires fresh matching evidence", async () => {
    fakes.query.mockResolvedValue({ recordset: [
      { ordinal: 0, target_status: "verified", physical_id: id },
      { ordinal: 1, target_status: "unverifiable", physical_id: null },
      { ordinal: 2, target_status: "not_found", physical_id: null },
    ] });
    expect(await readSqlCatalogPhysicalTargets({ portalEnvironment: "qa", links })).toEqual([
      { status: "verified", id }, { status: "unverifiable" }, { status: "not_found" },
    ]);
    const json = fakes.input.mock.calls.find(([key]) => key === "requestedLinks")?.[2] as string;
    expect(JSON.parse(json)[0]).toEqual({
      kind: "database", customerId: "customer-A", domainId: "domain-A", databaseId: "database-A", environment: "production",
    });
    expect(json).not.toContain("untrusted");
    const statement = fakes.query.mock.calls[0][0] as string;
    expect(statement).toContain("db.client_key=c.client_key");
    expect(statement).toContain("db.domain_key=d.domain_key");
    expect(statement).toContain("l.verified_at<=@now AND l.valid_until>@now");
    expect(statement).toContain("l.access_profile_version=p.row_version");
    expect(statement).toContain("DATALENGTH(d.publishable_domain)");
    expect(statement).not.toMatch(/password_secret_name|server_host_port|fingerprint AS/i);
    expect(statement.slice(statement.indexOf("SELECT w.ordinal"), statement.indexOf("FROM wanted w"))).not.toMatch(/initial_catalog/i);
  });

  it("distinguishes uncertainty from not found and does not reuse an unchecked application target", async () => {
    const resolve = vi.fn(async () => [
      { status: "verified", id } as const, { status: "verified", id } as const, { status: "unverifiable" } as const,
    ]);
    const plan = await planCatalogTasksWithVerifiedTargets("qa", {
      revision: { id: "r1", complete: true }, occurrenceId: "occurrence", links, requests,
    }, resolve);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].sources.map(v => v.link.customerId)).toEqual(["customer-A", "customer-B"]);
    expect(plan.held).toContainEqual({ scheduleId: "manual", linkId: "link-C", reason: "target_unverifiable" });
  });

  it("rejects malformed result ordering and does not classify a SQL outage as confirmed deletion", async () => {
    fakes.query.mockResolvedValueOnce({ recordset: [{ ordinal: 1, target_status: "not_found", physical_id: null }] });
    await expect(readSqlCatalogPhysicalTargets({ portalEnvironment: "qa", links: links.slice(0, 1) }))
      .rejects.toThrow("catalog_physical_inventory_unavailable");
    fakes.query.mockRejectedValueOnce(new Error("synthetic SQL sensitive detail"));
    await expect(readSqlCatalogPhysicalTargets({ portalEnvironment: "qa", links: links.slice(0, 1) }))
      .rejects.toEqual(new Error("catalog_physical_inventory_unavailable"));
  });

  it("binds SQL to the caller's transaction without using the pool or touching its lifecycle", async () => {
    const query = vi.fn().mockResolvedValue({ recordset: [{ ordinal: 0, target_status: "verified", physical_id: id }] });
    const input = vi.fn().mockReturnThis();
    const transaction = { request: vi.fn(() => ({ input, query })), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() };
    const tx = transaction as unknown as Parameters<typeof readSqlCatalogPhysicalTargetsInTransaction>[0];
    await expect(readSqlCatalogPhysicalTargetsInTransaction(tx, { portalEnvironment: "qa", links: links.slice(0, 1) }))
      .resolves.toEqual([{ status: "verified", id }]);
    expect(transaction.request).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("core.catalog_physical_target_links"));
    expect(input).toHaveBeenCalledWith("portalEnvironment", expect.anything(), "qa");
    expect(fakes.pool).not.toHaveBeenCalled();
    expect(transaction.begin).not.toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(transaction.rollback).not.toHaveBeenCalled();
  });

  it("rejects invalid links and resolves empty lists before requesting either SQL path", async () => {
    const request = vi.fn();
    const transaction = { request } as unknown as Parameters<typeof readSqlCatalogPhysicalTargetsInTransaction>[0];
    const invalidLink = { ...links[0], domainId: "  invalid" };
    for (const read of [readSqlCatalogPhysicalTargets, (input: Parameters<typeof readSqlCatalogPhysicalTargets>[0]) =>
      readSqlCatalogPhysicalTargetsInTransaction(transaction, input)]) {
      await expect(read({ portalEnvironment: "qa", links: [] })).resolves.toEqual([]);
      await expect(read({ portalEnvironment: "qa", links: [invalidLink] }))
        .rejects.toThrow("catalog_physical_inventory_unavailable");
    }
    expect(request).not.toHaveBeenCalled();
    expect(fakes.pool).not.toHaveBeenCalled();
  });

  it("preserves the approved physical link only for the internal proof reader", async () => {
    const physicalLinkId = "6b1fc8fb-cbde-4aee-bf4b-e146190ffec5";
    const query = vi.fn().mockResolvedValue({ recordset: [
      { ordinal: 0, target_status: "verified", physical_id: id, physical_link_id: physicalLinkId },
      { ordinal: 1, target_status: "unverifiable", physical_id: null, physical_link_id: null },
    ] });
    const input = vi.fn().mockReturnThis();
    const transaction = { request: vi.fn(() => ({ input, query })) } as unknown as Parameters<typeof readSqlCatalogPhysicalTargetsInTransaction>[0];
    const wanted = { portalEnvironment: "qa" as const, links: links.slice(0, 2) };
    await expect(readSqlCatalogPhysicalTargetPinsInTransaction(transaction, wanted))
      .resolves.toEqual([{ status: "verified", id, physicalLinkId }, { status: "unverifiable" }]);
    await expect(readSqlCatalogPhysicalTargetsInTransaction(transaction, wanted))
      .resolves.toEqual([{ status: "verified", id }, { status: "unverifiable" }]);
    expect(query.mock.calls[0][0]).toContain("l.link_id");
    expect(fakes.pool).not.toHaveBeenCalled();
  });

  it("rejects a missing physical link instead of reporting an absence", async () => {
    const query = vi.fn().mockResolvedValue({ recordset: [
      { ordinal: 0, target_status: "verified", physical_id: id, physical_link_id: null },
    ] });
    const input = vi.fn().mockReturnThis();
    const transaction = { request: () => ({ input, query }) } as unknown as Parameters<typeof readSqlCatalogPhysicalTargetsInTransaction>[0];
    await expect(readSqlCatalogPhysicalTargetPinsInTransaction(transaction, { portalEnvironment: "qa", links: links.slice(0, 1) }))
      .rejects.toThrow("catalog_physical_inventory_unavailable");
  });
});
