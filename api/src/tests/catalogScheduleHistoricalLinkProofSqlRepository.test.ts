import { describe, expect, it, vi } from "vitest";
import type sql from "mssql";
import { deriveCatalogSagCompanyLocationToken } from "../lib/catalogSagCompanyLocationProof";
import {
  catalogScheduleHistoricalLinkProofSql,
  readCatalogScheduleHistoricalLinkProofInTransaction,
  readCatalogScheduleHistoricalPopulationInTransaction,
} from "../lib/catalogScheduleHistoricalLinkProofSqlRepository";

const asOf = new Date("2026-11-20T05:00:00.000Z");
const before = new Date("2026-11-20T04:45:00.000Z");
const after = new Date("2026-11-20T06:00:00.000Z");
const linkId = "783f6120-4b22-4aeb-a85f-ab82be17189a";
const targetId = "49ccc921-0f74-4064-8409-8c910cafc72a";
const erpId = "5020d7f4-be74-4170-b268-75defad81516";
const sagId = "85f1acd0-68d4-4164-bc7f-e679149a7430";
const scope = { environment: "qa" as const, asOf,
  heads: [{ sourceId: erpId, role: "erp-customers" as const, revisionId: "9007199254740993" },
    { sourceId: sagId, role: "sag-admin" as const, revisionId: "11" }],
  links: [{ linkId, kind: "domain" as const, targetId }] };
const physicalLinkId = "ebda6b19-5d51-48f9-8c7d-b0411c8877b3";
const matchKey = Buffer.alloc(32, 0x42);
const scopeV2 = { ...scope, links: [{ linkId, kind: "database" as const, targetId }],
  scheduleKey: "42", matchKeyVersion: 9, matchKey };
const base = {
  linkId, kind: "domain", environment: "test", clientId: "client_local", clientName: "Cliente",
  domainId: "domain_local", domainName: "tenant.example.test", targetId: "domain_local", targetName: "tenant.example.test",
  linkRegisteredAt: before, ownerRegisteredAt: before, linkRetiredAt: null, ownerRetiredAt: null,
  erpProved: 1, sagContract: "sag_admin_v1", sagDomainProofCount: 1, physicalCount: 1, physicalId: targetId, physicalCreatedAt: before,
  physicalRegisteredAt: before, physicalVerifiedAt: before, physicalValidUntil: after, physicalRetiredAt: null,
  otherPrivateField: "must not be projected",
};
const dbV2 = { ...base, kind: "database", targetId: "database_local", targetName: "Mi base",
  sagContract: "sag_admin_v2", physicalLinkId, v2LocationReaderReady: 1,
  v2ProfileVersion: "000000000000000a", v2SagSourceId: sagId, v2SagRevisionId: "11", v2SagCustomerRecordId: -7,
  v2MatchKeyVersion: 9, v2CompanyIds: JSON.stringify([{ companyRecordId: 8 }, { companyRecordId: 9 }]),
  v2ServerHostPort: "Sql.Example.test,51433", v2InitialCatalog: "Db_Context" };
function mock(rows: object[], error?: Error, matchRows: object[] | Error = []) {
  const req = { input: vi.fn().mockReturnThis(), query: error ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue({ recordset: rows }),
    execute: matchRows instanceof Error ? vi.fn().mockRejectedValue(matchRows) : vi.fn().mockResolvedValue({ recordset: matchRows }) };
  return { tx: { request: () => req } as unknown as sql.Transaction, req };
}

describe("certified historical schedule link proof", () => {
  it("discovers a unique physical pin for a certified cutoff link, but not a competing pin", async () => {
    const { tx, req } = mock([base]);
    expect(await readCatalogScheduleHistoricalPopulationInTransaction(tx, scope, [linkId]))
      .toMatchObject([{ linkId, state: "eligible", verifiedTargetId: targetId }]);
    expect(req.input).toHaveBeenCalledWith("discoverPopulation", expect.anything(), true);
    expect(req.input).toHaveBeenCalledWith("links", expect.anything(), JSON.stringify([{ linkId, kind: null, targetId: null }]));
    const ambiguous = mock([{ ...base, physicalCount: 2 }]);
    expect(await readCatalogScheduleHistoricalPopulationInTransaction(ambiguous.tx, scope, [linkId]))
      .toMatchObject([{ linkId, state: "unverifiable", verifiedTargetId: null }]);
    const unpinnedV2 = mock([dbV2], undefined, [{ linkId, matchCount: 1 }]);
    expect(await readCatalogScheduleHistoricalPopulationInTransaction(unpinnedV2.tx, scope, [linkId]))
      .toMatchObject([{ linkId, state: "unverifiable", verifiedTargetId: null }]);
    expect(unpinnedV2.req.execute).not.toHaveBeenCalled();
  });

  it("requires independent protected proof even for a cutoff-certified dynamic V2 database", async () => {
    for (const matchCount of [0, 1, 2]) {
      const { tx, req } = mock([dbV2], undefined, [{ linkId, matchCount }]);
      expect(await readCatalogScheduleHistoricalPopulationInTransaction(tx, scopeV2, [linkId])).toMatchObject([
        { linkId, kind: "database", state: matchCount === 1 ? "eligible" : "unverifiable",
          verifiedTargetId: matchCount === 1 ? targetId : null },
      ]);
      expect(req.execute).toHaveBeenCalledWith("settings.verify_catalog_historical_schedule_company_locations");
    }
  });
  it("passes exact bounded pins and bigint revisions unchanged, emitting only historical display fields", async () => {
    const { tx, req } = mock([base]);
    expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, scope)).toEqual([{
      linkId, state: "eligible", kind: "domain", environment: "test", clientId: "client_local", clientName: "Cliente",
      domainId: "domain_local", domainName: "tenant.example.test", targetId: "domain_local",
      targetName: "tenant.example.test", verifiedTargetId: targetId,
    }]);
    expect(req.query).toHaveBeenCalledWith(catalogScheduleHistoricalLinkProofSql);
    expect(req.input).toHaveBeenCalledWith("heads", expect.anything(), JSON.stringify(scope.heads));
    expect(req.input).toHaveBeenCalledWith("links", expect.anything(), JSON.stringify(scope.links));
  });

  it.each([
    { linkRegisteredAt: after, linkRetiredAt: after }, { ownerRegisteredAt: after }, { physicalRegisteredAt: after },
    { physicalVerifiedAt: after }, { physicalValidUntil: asOf }, { physicalRetiredAt: asOf },
    { erpProved: 0 }, { sagContract: null }, { sagDomainProofCount: 0 }, { sagDomainProofCount: 2 },
    { physicalCount: 2 }, { physicalCount: 0 }, { physicalId: sagId },
  ])("holds late, expired, ambiguous, or missing proof (%j)", async override => {
    const { tx } = mock([{ ...base, ...override }]);
    expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, scope)).toMatchObject([
      { linkId, state: "unverifiable", verifiedTargetId: null },
    ]);
  });

  it.each([{ linkRetiredAt: asOf }, { ownerRetiredAt: before }])(
    "treats only exact links or owners explicitly retired by the boundary as absent (%j)", async override => {
      const { tx } = mock([{ ...base, ...override, erpProved: 0, sagContract: null }]);
      expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, scope)).toMatchObject([
        { linkId, state: "absent", verifiedTargetId: null },
      ]);
    },
  );

  it("does not treat a later retirement as absence at the cutoff", async () => {
    const { tx } = mock([{ ...base, linkRetiredAt: after, ownerRetiredAt: after, physicalRetiredAt: after }]);
    expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, scope)).toMatchObject([{ state: "eligible" }]);
  });

  it.each([
    ['[{"id":"module-a"},{"id":"module-b"}]', ["module-a", "module-b"]],
    ["[]", []],
    [null, null],
    ['[{"id":"module-a"},{"id":"module-a"}]', null],
    ['[{"id":"module-a","raw":"A"}]', null],
  ])("distinguishes verified historical module membership from missing proof (%j)", async (historicalModules, expected) => {
    const { tx, req } = mock([{ ...base, historicalModules }]);
    const rows = await readCatalogScheduleHistoricalLinkProofInTransaction(tx, { ...scope, includeLicenses: true });
    expect(rows).toMatchObject([{ state: "eligible", historicalModuleIds: expected }]);
    expect(req.input).toHaveBeenCalledWith("includeLicenses", expect.anything(), true);
  });

  it("does not use license-shaped data without exact historical SAG and physical evidence", async () => {
    for (const row of [{ ...base, sagDomainProofCount: 2 }, { ...base, linkRetiredAt: asOf }, dbV2]) {
      const { tx } = mock([{ ...row, historicalModules: '[{"id":"module-a"}]' }]);
      const input = row.kind === "database" ? scopeV2 : scope;
      const rows = await readCatalogScheduleHistoricalLinkProofInTransaction(tx, { ...input, includeLicenses: true });
      expect(rows).toMatchObject([{ historicalModuleIds: null }]);
    }
  });

  it("holds if input heads do not include both source roles, even if the driver supplies proof-shaped data", async () => {
    for (const heads of [[], scope.heads.slice(0, 1), scope.heads.slice(1)]) {
      const { tx } = mock([base]);
      expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, { ...scope, heads })).toMatchObject([
        { state: "unverifiable", verifiedTargetId: null },
      ]);
    }
  });

  it("holds a SAG v2 database even when current 036-style proof is present", async () => {
    const { tx } = mock([{ ...base, kind: "database", targetId: "db_local", targetName: "DB",
      sagContract: "sag_admin_v2" }]);
    expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, {
      ...scope, links: [{ ...scope.links[0], kind: "database" }],
    })).toMatchObject([{ kind: "database", state: "unverifiable", verifiedTargetId: null }]);
  });

  it("derives only exact pinned SAG v2 claims and confirms using the protected historical RPC", async () => {
    const { tx, req } = mock([dbV2], undefined, [{ linkId, matchCount: 1 }]);
    const proof = await readCatalogScheduleHistoricalLinkProofInTransaction(tx, scopeV2);
    expect(proof).toEqual([{ linkId, state: "eligible", kind: "database", environment: "test", clientId: "client_local",
      clientName: "Cliente", domainId: "domain_local", domainName: "tenant.example.test", targetId: "database_local",
      targetName: "Mi base", verifiedTargetId: targetId }]);
    const type = expect.anything();
    expect(req.execute).toHaveBeenCalledWith("settings.verify_catalog_historical_schedule_company_locations");
    expect(req.input).toHaveBeenCalledWith("matchKeyVersion", type, 9);
    expect(req.input).toHaveBeenCalledWith("scheduleKey", type, "42");
    expect(req.input).toHaveBeenCalledWith("asOf", type, asOf);
    const claims = JSON.parse(req.input.mock.calls.find(call => call[0] === "claims")?.[2]);
    expect(claims).toEqual([8, 9].map(companyRecordId => ({ linkId, physicalTargetId: targetId, physicalLinkId,
      profileVersion: "000000000000000a", sagSourceId: sagId, sagRevisionId: "11", sagCustomerRecordId: -7, companyRecordId,
      locationTokenHex: deriveCatalogSagCompanyLocationToken({ environment: "qa", sourceId: sagId, matchKeyVersion: 9, companyRecordId },
        matchKey, { status: "candidate", host: "sql.example.test", port: 51433, databaseName: "Db_Context" }) })));
    expect(JSON.stringify(proof)).not.toMatch(/Sql\.Example|Db_Context|locationToken|sagSourceId|profileVersion/);
  });

  it.each([[], [{ linkId, matchCount: 0 }], [{ linkId, matchCount: 2 }], [{ linkId: sagId, matchCount: 1 }],
    [{ linkId, matchCount: 1 }, { linkId, matchCount: 1 }], new Error("no protected module access")].map(matchRows => ({ matchRows })))(
    "holds when the historical comparison cannot demonstrate exactly one ($matchRows)", async ({ matchRows }) => {
      const { tx } = mock([dbV2], undefined, matchRows);
      await expect(readCatalogScheduleHistoricalLinkProofInTransaction(tx, scopeV2))
        .resolves.toMatchObject([{ state: "unverifiable", verifiedTargetId: null }]);
    },
  );

  it("does not call the verifier without exact local pins, bounded Company IDs, key, and RPC access", async () => {
    for (const [row, context] of [
      [dbV2, { ...scopeV2, matchKey: undefined }],
      [{ ...dbV2, v2LocationReaderReady: 0 }, scopeV2],
      [{ ...dbV2, v2SagRevisionId: "12" }, scopeV2],
      [{ ...dbV2, v2MatchKeyVersion: 10 }, scopeV2],
      [{ ...dbV2, v2CompanyIds: JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ companyRecordId: i }))) }, scopeV2],
      [{ ...dbV2, v2ServerHostPort: "Sql.Example.test" }, scopeV2],
      [{ ...dbV2, physicalValidUntil: asOf }, scopeV2],
      [{ ...dbV2, linkRetiredAt: asOf }, scopeV2],
    ] as const) {
      const { tx, req } = mock([row]);
      await expect(readCatalogScheduleHistoricalLinkProofInTransaction(tx, context))
        .resolves.toMatchObject([{ state: row.linkRetiredAt === asOf ? "absent" : "unverifiable" }]);
      expect(req.execute).not.toHaveBeenCalled();
    }
  });

  it("never substitutes a late snapshot, unrelated row, absent row or query failure", async () => {
    const inputs = [mock([]), mock([{ ...base, linkId: erpId }]), mock([base, base]),
      mock([{ ...base, linkRegisteredAt: after, linkRetiredAt: asOf }]), mock([], new Error("private provider error"))];
    for (const { tx } of inputs) expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, scope)).toBeNull();
    const invalid = mock([]);
    expect(await readCatalogScheduleHistoricalLinkProofInTransaction(invalid.tx, {
      ...scope, links: [scope.links[0], scope.links[0]],
    })).toBeNull();
    expect(invalid.req.query).not.toHaveBeenCalled();
  });

  it("fails closed if a URL with credential-like userinfo would escape as a label", async () => {
    const unsafe = "https://user:private@tenant.example.test";
    const { tx } = mock([{ ...base, domainName: unsafe, targetName: unsafe }]);
    expect(await readCatalogScheduleHistoricalLinkProofInTransaction(tx, scope)).toBeNull();
  });

  it("uses source events, protected registration, historical edges and exact route/profile evidence", () => {
    const statement = catalogScheduleHistoricalLinkProofSql;
    expect(statement).toContain("SELECT TOP (1)");
    expect(statement).toContain("e.recorded_at<=@asOf");
    expect(statement).toContain("h.attempt_status='succeeded'");
    expect(statement).toContain("r.sealed_at<=@asOf AND r.verified_until>@asOf");
    expect(statement).toContain("a.approved_at BETWEEN l.registered_at AND @asOf");
    expect(statement).toContain("rr.catalog_customer_key=o.catalog_customer_key");
    expect(statement).toContain("ownerRecord.document_number_token=erp.document_number_token");
    expect(statement).toContain("sh.match_key_version=erp.match_key_version");
    expect(statement).toContain("domainRecord.environment_kind=l.link_environment");
    expect(statement).toContain("domainRecord.domain_candidate COLLATE Latin1_General_100_BIN2=LOWER(safeDomain.label)");
    expect(statement).toContain("pt.registered_at<=@asOf");
    expect(statement).toContain("pt.verified_at<=@asOf");
    expect(statement).toContain("p.updated_at<=@asOf");
    expect(statement).toContain("d.updated_at<=@asOf");
    expect(statement).not.toMatch(/password_secret_name|sql_user_id|catalog_sag_company_location_(observations|seals)|SYSUTCDATETIME\(\).*verified_until/i);
  });
});
