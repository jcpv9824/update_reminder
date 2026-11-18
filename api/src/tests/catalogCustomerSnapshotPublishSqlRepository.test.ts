import { describe, expect, it, vi } from "vitest";
import { createSqlCatalogCustomerSnapshotPublisher } from "../lib/catalogCustomerSnapshotPublishSqlRepository";
import type { CatalogRefreshPublication } from "../lib/catalogCustomerRefresh";

vi.mock("mssql", () => ({
  default: {
    VarChar: vi.fn(), UniqueIdentifier: {}, VarBinary: vi.fn(), SmallInt: {}, DateTime2: vi.fn(),
    NVarChar: vi.fn(), MAX: -1, Int: {}, ISOLATION_LEVEL: { SERIALIZABLE: 99 },
  },
}));

const observation = new Date("2026-11-17T10:01:00.000Z");
const revision: CatalogRefreshPublication = {
  environment: "qa", sourceId: "2a56df91-f51c-4320-a626-67fd22fd3db8",
  bindingRevision: "000000000004f929", profileRevision: "000000000004f930", matchKeyVersion: 1,
  observedAt: observation, attemptOrdinal: "9007199254740993", role: "erp-customers", completeScopes: [],
  rows: [{ sourceRecordId: 54, issuerScope: "CO:NIT", matchToken: Buffer.alloc(32, 171), name: " Synthetic ERP ", activeCode: "S" }],
};

function setup() {
  const input = vi.fn().mockReturnThis();
  const query = vi.fn().mockResolvedValue({ recordset: [{ result: "published" }] });
  const begin = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockResolvedValue(undefined);
  const rollback = vi.fn().mockResolvedValue(undefined);
  const pool = { transaction: vi.fn(() => ({ request: () => ({ input, query }), begin, commit, rollback })) };
  const sink = createSqlCatalogCustomerSnapshotPublisher(pool as unknown as Parameters<typeof createSqlCatalogCustomerSnapshotPublisher>[0]);
  const value = (name: string) => input.mock.calls.find(call => call[0] === name)?.[2];
  return { sink, pool, input, query, begin, commit, rollback, value };
}

describe("catalog customer snapshot SQL publisher", () => {
  it("commits only a sealed revision and sends protected ERP rows in fixed SQL parameters", async () => {
    const fake = setup();
    await expect(fake.sink.publish(revision)).resolves.toBe("published");
    expect(fake.begin).toHaveBeenCalledExactlyOnceWith(99);
    expect(fake.commit).toHaveBeenCalledOnce();
    expect(fake.rollback).not.toHaveBeenCalled();
    expect(fake.value("bindingRevision")).toEqual(Buffer.from(revision.bindingRevision, "hex"));
    expect(fake.value("profileRevision")).toEqual(Buffer.from(revision.profileRevision, "hex"));
    expect(fake.value("observedAt")).toBe(observation);
    expect(fake.value("attemptOrdinal")).toBe("9007199254740993");
    expect(fake.value("scopeCount")).toBe(0);
    const [row] = JSON.parse(fake.value("rows"));
    expect(row).toEqual({
      sourceRecordId: 54, issuer: "CO", documentType: "NIT", token: "ab".repeat(32),
      officialName: "Synthetic ERP", activeCode: "S", allocationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    const batch = fake.query.mock.calls[0][0] as string;
    expect(batch).not.toContain("Synthetic ERP");
    expect(batch).not.toContain(row.token);
    expect(batch).toContain("r.match_key_version=@matchKeyVersion AND r.sealed_at IS NOT NULL");
    expect(batch).toContain("MIN(source_record_id) AS representative");
    expect(batch.indexOf("SET sealed_at=@now")).toBeLessThan(batch.indexOf("SET revision_key=@revisionKey"));
  });

  it("keeps SAG coverage separate and never assigns ERP names or opaque identities from SAG", async () => {
    const fake = setup();
    const saga = { ...revision.rows[0], name: null, activeCode: null };
    await expect(fake.sink.publish({ ...revision, role: "sag-admin", completeScopes: ["CO:NIT", "US:EIN"], rows: [saga] }))
      .resolves.toBe("published");
    expect(JSON.parse(fake.value("scopes"))).toEqual([{ issuer: "CO", documentType: "NIT" }, { issuer: "US", documentType: "EIN" }]);
    expect(JSON.parse(fake.value("rows"))[0]).toMatchObject({ allocationId: null, officialName: null, activeCode: null });
    await expect(fake.sink.publish({ ...revision, role: "sag-admin", rows: [{ ...saga, issuerScope: null }] }))
      .resolves.toBe("published");
    expect(fake.value("inventory")).toBeUndefined();
    for (const [batch] of fake.query.mock.calls) {
      expect(batch).not.toContain("has_sag_inventory_evidence");
      expect(batch).not.toContain("catalog_sag_revision_evidence");
    }
  });

  const sagEvidence = {
    domainCandidate: "qa.example.test", environment: "test" as const, licenseCodes: ["A", "U"],
    testStartedOn: "2026-11-16", productionStartedOn: null, demoStartedOn: null,
  };
  const sag = { ...revision.rows[0], name: null, activeCode: null };
  const certifiedSag = {
    ...revision, role: "sag-admin" as const, includesSagInventory: true,
    rows: [{ ...sag, sagEvidence }],
  } satisfies CatalogRefreshPublication;

  it("binds an allowlisted payload and inserts it after parent rows, before seal and publish", async () => {
    const fake = setup();
    const unchecked = { ...sagEvidence, secret: "ungraded private value" };
    await expect(fake.sink.publish({ ...certifiedSag, rows: [{ ...sag, sagEvidence: unchecked }] }))
      .resolves.toBe("published");
    expect(JSON.parse(fake.value("inventory"))).toEqual([{
      sourceRecordId: 54, domainCandidate: "qa.example.test", environmentKind: "test", licenseCodes: "AU",
      testStartedOn: "2026-11-16", productionStartedOn: null, demoStartedOn: null,
    }]);
    expect(fake.value("rows")).not.toContain("qa.example.test");
    const batch = fake.query.mock.calls[0][0] as string;
    expect(batch).toContain("verified_until,has_sag_inventory_evidence");
    expect(batch).not.toContain("qa.example.test");
    expect(batch.indexOf("INSERT INTO core.catalog_customer_revision_rows"))
      .toBeLessThan(batch.indexOf("INSERT INTO core.catalog_sag_revision_evidence"));
    expect(batch.indexOf("INSERT INTO core.catalog_sag_revision_evidence"))
      .toBeLessThan(batch.indexOf("SET sealed_at=@now"));
    expect(fake.commit).toHaveBeenCalledOnce();
  });

  it("certifies an explicitly empty complete SAG revision and preserves null versus empty module evidence", async () => {
    const fake = setup();
    await expect(fake.sink.publish({ ...certifiedSag, rows: [] })).resolves.toBe("published");
    expect(fake.value("inventory")).toBe("[]");
    expect(fake.query.mock.calls[0][0]).toContain("has_sag_inventory_evidence");
    const another = setup();
    await expect(another.sink.publish({ ...certifiedSag, rows: [
      { ...sag, sagEvidence: { ...sagEvidence, licenseCodes: null } },
      { ...sag, sourceRecordId: 55, sagEvidence: { ...sagEvidence, licenseCodes: [] } },
    ] })).resolves.toBe("published");
    expect(JSON.parse(another.value("inventory")).map((row: { licenseCodes: string | null }) => row.licenseCodes))
      .toEqual([null, ""]);
  });

  it("rejects evidence on ERP, incomplete SAG, and noncanonical or private fields before SQL", async () => {
    const fake = setup();
    const invalid = [
      { ...revision, includesSagInventory: true },
      { ...revision, rows: [{ ...revision.rows[0], sagEvidence }] },
      { ...certifiedSag, includesSagInventory: false },
      { ...certifiedSag, rows: [sag, { ...sag, sourceRecordId: 55, sagEvidence }] },
      ...[
        { ...sagEvidence, domainCandidate: "https://qa.example.test/synthetic" },
        { ...sagEvidence, domainCandidate: "QA.EXAMPLE.TEST" },
        { ...sagEvidence, licenseCodes: ["U", "A"] },
        { ...sagEvidence, licenseCodes: ["T"] },
        { ...sagEvidence, testStartedOn: "2026-02-30" },
      ].map(sagEvidence => ({ ...certifiedSag, rows: [{ ...sag, sagEvidence }] })),
    ] satisfies CatalogRefreshPublication[];
    for (const publication of invalid) {
      await expect(fake.sink.publish(publication)).rejects.toThrow("invalid_catalog_publication");
    }
    expect(fake.pool.transaction).not.toHaveBeenCalled();
  });

  it("does not enter a transaction with malformed evidence", async () => {
    const fake = setup();
    for (const args of [
      { ...revision, bindingRevision: "0001" },
      { ...revision, attemptOrdinal: "9223372036854775808" },
      { ...revision, attemptOrdinal: "01" },
      { ...revision, rows: [...revision.rows, ...revision.rows] },
      { ...revision, rows: [{ ...revision.rows[0], matchToken: Buffer.alloc(31) }] },
      { ...revision, rows: [{ ...revision.rows[0], issuerScope: "x:invalid" }] },
      { ...revision, role: "sag-admin", rows: [{ ...revision.rows[0], name: null, activeCode: null }], completeScopes: ["CO:NIT", "CO:NIT"] },
      { ...revision, role: "sag-admin", rows: [{ ...revision.rows[0], issuerScope: null, name: null, activeCode: null }], completeScopes: ["CO:NIT"] },
    ] satisfies CatalogRefreshPublication[]) {
      await expect(fake.sink.publish(args)).rejects.toThrow("invalid_catalog_publication");
    }
    expect(fake.pool.transaction).not.toHaveBeenCalled();
  });

  it("reserves ordinals within SQL as opaque decimal strings, never JS numbers", async () => {
    const fake = setup();
    fake.query.mockResolvedValueOnce({ recordset: [{ attemptOrdinal: "9007199254740993" }] });
    await expect(fake.sink.reserveAttempt()).resolves.toBe("9007199254740993");
    expect(fake.query.mock.calls[0][0]).toContain("NEXT VALUE FOR settings.catalog_customer_attempt_sequence");
    fake.query.mockResolvedValueOnce({ recordset: [{ attemptOrdinal: 42 }] });
    await expect(fake.sink.reserveAttempt()).rejects.toThrow("catalog_publication_failed");
    expect(fake.rollback).toHaveBeenCalledOnce();
  });

  it("does not advance the head for stale versions or earlier dispatch ordinals", async () => {
    const fake = setup();
    fake.query.mockResolvedValueOnce({ recordset: [{ result: "superseded" }] });
    await expect(fake.sink.publish(revision)).resolves.toBe("superseded");
    const batch = fake.query.mock.calls[0][0] as string;
    expect(batch).toContain("b.row_version=@bindingRevision");
    expect(batch).toContain("p.row_version=@profileRevision");
    expect(batch).toContain("@ordinal<=@headAttemptOrdinal");
    expect(batch).not.toContain("h.attempted_at");
    expect(batch.indexOf("RETURN;")).toBeLessThan(batch.indexOf("INSERT INTO core.catalog_customer"));
    expect(fake.commit).toHaveBeenCalledOnce();
  });

  it("records failure without changing identities or clearing the previous published revision", async () => {
    const fake = setup();
    await expect(fake.sink.recordFailure(revision)).resolves.toBeUndefined();
    const batch = fake.query.mock.calls[0][0] as string;
    expect(batch).toContain("SET attempt_status='failed'");
    expect(batch).toContain("attempted_at=@now,attempt_ordinal=@ordinal");
    expect(batch).toContain("@ordinal<=@headAttemptOrdinal");
    expect(batch).not.toContain("@observedAt");
    expect(batch).not.toContain("SET revision_key");
    expect(batch).not.toContain("INSERT INTO core");
    expect(fake.value("rows")).toBeUndefined();
    expect(fake.commit).toHaveBeenCalledOnce();
  });

  it.each(["query", "begin", "commit", "result"] as const)("rolls back and sanitizes %s failures", async point => {
    const fake = setup();
    const privateMessage = "database driver error with sensitive details";
    if (point === "result") fake.query.mockResolvedValueOnce({ recordset: [{ result: privateMessage }] });
    else fake[point].mockRejectedValueOnce(new Error(privateMessage));
    await expect(fake.sink.publish(revision)).rejects.toEqual(new Error("catalog_publication_failed"));
    expect(fake.rollback).toHaveBeenCalledOnce();
    if (point !== "commit") expect(fake.commit).not.toHaveBeenCalled();
  });
});
