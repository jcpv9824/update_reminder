import { describe, expect, it } from "vitest";
import { assessCatalogSchedulePopulation, catalogSchedulePopulationDigest, readCatalogSchedulePopulationSql } from "../lib/catalogSchedulePopulationCoverage";

const sourceId = "00000000-0000-0000-0000-000000000001";
const sagId = "00000000-0000-0000-0000-000000000002";
const alternate = "00000000-0000-0000-0000-000000000003";
const first = "00000000-0000-0000-0000-000000000011";
const second = "00000000-0000-0000-0000-000000000012";
const populationId = "00000000-0000-0000-0000-000000000099";
const bindingVersion = "0000000000000001";
const profileVersion = "0000000000000002";
const at = new Date("2030-01-01T00:00:00Z");
const until = new Date("2030-01-02T00:00:00Z");
const observed = { state: "verified" as const, sourceId, revisionId: "12", bindingVersion, profileVersion, verifiedUntil: until.toISOString() };
const unknown = { state: "unverifiable" as const };
const sources = [
  { sourceId, role: "erp-customers" as const, bindingVersion, profileVersion, certified: true },
  { sourceId: sagId, role: "sag-admin" as const, bindingVersion, profileVersion, certified: true },
];
const edges = [{ linkId: first, sourceId, evidence: observed }, { linkId: second, sourceId, evidence: unknown }];
const digest = catalogSchedulePopulationDigest("qa", sources, edges.map(edge => edge.linkId));
const valid = {
  portalEnvironment: "qa" as const, checkedAt: at, now: at,
  plannedLinks: edges, sources, edges,
  approvals: [{ populationId, portalEnvironment: "qa", sourceCount: 2, linkCount: 2, digest,
    approvedAt: new Date("2029-12-30T00:00:00Z"), validUntil: until }],
};

describe("schedule inventory coverage independent of the operational reader", () => {
  it("converts SQL rowversion to binary bytes before rendering canonical hexadecimal text", () => {
    for (const source of ["b.row_version", "p.row_version", "e.binding_version", "e.profile_version"]) {
      expect(readCatalogSchedulePopulationSql).toContain(`CONVERT(char(16),CONVERT(binary(8),${source}),2)`);
    }
  });
  it("certifies a reviewed, exact population while keeping a known unverified edge explicit", () => {
    expect(assessCatalogSchedulePopulation(valid)).toEqual({
      id: `catalog-population-v1:${populationId}`, complete: true, validUntil: until,
    });
  });
  it("uses canonical ordering but binds the deployment and each source/profile version", () => {
    expect(digest).toHaveLength(32);
    expect(catalogSchedulePopulationDigest("qa", [...sources].reverse(), [second, first])).toEqual(digest);
    expect(catalogSchedulePopulationDigest("production", sources, [first, second])).not.toEqual(digest);
    expect(catalogSchedulePopulationDigest("qa", [{ ...sources[0], profileVersion: bindingVersion }, sources[1]], [first, second]))
      .not.toEqual(digest);
  });
  it.each([
    ["no approval", { approvals: [] }],
    ["an empty inventory", { plannedLinks: [], edges: [] }],
    ["a subset of planning links", { plannedLinks: edges.slice(0, 1) }],
    ["an added or unreviewed live link", { edges: [...edges, { linkId: alternate, sourceId, evidence: unknown }] }],
    ["repeated approval", { approvals: [...valid.approvals, ...valid.approvals] }],
    ["an expired approval", { now: until }],
    ["a future approval", { approvals: [{ ...valid.approvals[0], approvedAt: until }] }],
    ["a different portal environment", { portalEnvironment: "production" }],
    ["an expired link that the planner still sees as verified", { now: new Date(until.valueOf() - 1),
      edges: [{ ...edges[0], evidence: { ...observed, verifiedUntil: at.toISOString() } }, edges[1]] }],
    ["a changed head even if all IDs match", { edges: [{ ...edges[0], evidence: { ...observed, revisionId: "13" } }, edges[1]] }],
    ["a currently unverifiable edge treating a former valid observation as current", { edges: [{ ...edges[0], evidence: unknown }, edges[1]] }],
    ["wrong membership even with same count", { edges: [edges[0], { ...edges[1], linkId: alternate }],
      plannedLinks: [edges[0], { ...edges[1], linkId: alternate }] }],
    ["duplicate IDs on both reads", { plannedLinks: [edges[0], edges[0]], edges: [edges[0], edges[0]] }],
    ["link mapped to a source outside reviewed ERP", { edges: [edges[0], { ...edges[1], sourceId: sagId }] }],
    ["an unvalidated active connection", { sources: [{ ...sources[0], certified: false }, sources[1]] }],
    ["a new active source", { sources: [...sources, { ...sources[0], sourceId: alternate }] }],
  ])("does not certify %s", (_name, patch) => {
    expect(assessCatalogSchedulePopulation({ ...valid, ...patch } as Parameters<typeof assessCatalogSchedulePopulation>[0]))
      .toEqual({ id: "catalog-population-unverified", complete: false });
  });
  it("does not construct certification hashes for duplicate or empty populations", () => {
    expect(() => catalogSchedulePopulationDigest("qa", sources, [first, first])).toThrow("catalog_population_invalid");
    expect(() => catalogSchedulePopulationDigest("qa", [sources[0]], [first])).toThrow("catalog_population_invalid");
    expect(() => catalogSchedulePopulationDigest("qa", sources, [])).toThrow("catalog_population_invalid");
  });
});
