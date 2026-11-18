import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogRefreshQueueSqlBatches as batches, claimCatalogRefreshJobs, completeCatalogRefreshClaim,
  enqueueCatalogRefreshRequest, readCatalogRefreshStatus } from "../lib/catalogRefreshQueueSqlRepository";

const d = vi.hoisted(() => ({ input: vi.fn(), query: vi.fn(), audit: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: d.transaction }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: d.audit }));

const settings = { environment: "qa" as const, matchKeyVersion: 2, includeSag: true };
const actor = { actorId: "authenticated-requester", sourceIds: ["4a56df91-f51c-4320-a626-67fd22fd3db8"] };
const raw = { jobId: "1a56df91-f51c-4320-a626-67fd22fd3db8", workerId: "2a56df91-f51c-4320-a626-67fd22fd3db8",
  leaseToken: "3a56df91-f51c-4320-a626-67fd22fd3db8", sourceId: actor.sourceIds[0], attempt: 3, environment: "qa" as const,
  bindingRevision: Buffer.alloc(8, 0xab), profileRevision: Buffer.alloc(8, 0xac), matchKeyVersion: 2 };
const value = (key: string) => d.input.mock.calls.findLast(([name]) => name === key)?.[2];

describe("catalog refresh queue SQL contracts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const request = { input: d.input, query: d.query };
    d.input.mockReturnValue(request);
    d.transaction.mockImplementation(async work => work({ request: () => request }));
  });

  it("validates the whole submitted ERP scope before any queue transition, then audits only safe ERP counts", async () => {
    d.query.mockResolvedValueOnce({ recordset: [{ allowed: false, accepted: 0, coalesced: 0 }] });
    expect(await enqueueCatalogRefreshRequest({ ...settings, ...actor })).toBeNull();
    expect(d.audit).not.toHaveBeenCalled();
    expect(d.query).toHaveBeenLastCalledWith(batches.enqueueRequest);
    const batch = batches.enqueueRequest;
    expect(batch).toContain("u.active=1");
    expect(batch).toContain("reader.revoked_at IS NULL");
    expect(batch).toContain("b.source_role='erp-customers'");
    expect(batch.indexOf("IF @allowed=0")).toBeLessThan(batch.indexOf("UPDATE j SET job_status='cancelled'"));
    expect(batch).toContain("AND e.source_role='erp-customers'");
    expect(batch).not.toContain(actor.actorId);
    expect(value("sourceIds")).toBe(JSON.stringify(actor.sourceIds));
    d.query.mockResolvedValueOnce({ recordset: [{ allowed: true, accepted: 1, coalesced: 0 }] });
    expect(await enqueueCatalogRefreshRequest({ ...settings, ...actor })).toEqual({ accepted: 1, coalesced: 0 });
    expect(d.audit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ performedBy: actor.actorId,
      metadata: { accepted: 1, coalesced: 0 } }));
  });

  it("rechecks source grants on status and exposes SAG only as a pending dependency", async () => {
    const updatedAt = new Date("2026-11-18T12:00:00Z");
    const result = { recordsets: [[{ allowed: true, sagPending: true }], [
      { sourceId: actor.sourceIds[0].toUpperCase(), status: "succeeded", updatedAt, leaseToken: "not a DTO field" },
    ]] };
    d.query.mockResolvedValueOnce(result);
    expect(await readCatalogRefreshStatus({ ...settings, ...actor })).toEqual({ pending: true,
      items: [{ sourceId: actor.sourceIds[0], status: "succeeded", updatedAt: updatedAt.toISOString() }] });
    d.query.mockResolvedValueOnce({ recordsets: [[{ allowed: false, sagPending: false }], result.recordsets[1]] });
    expect(await readCatalogRefreshStatus({ ...settings, ...actor })).toBeNull();
    expect(batches.status).toContain("reader.revoked_at IS NULL");
    expect(batches.status).toContain("@includeSag=1 AND EXISTS(SELECT 1 FROM @scope)");
    expect(batches.status).not.toMatch(/(?:DELETE|UPDATE|INSERT)\s+settings\./);
  });

  it("claims at most two, uses SQL time and a unique lease, and completes only the entire exact fence", async () => {
    expect(() => claimCatalogRefreshJobs(settings, raw.workerId, 3)).toThrow("invalid_catalog_refresh_claim_count");
    expect(d.transaction).not.toHaveBeenCalled();
    d.query.mockResolvedValueOnce({ recordset: [raw] });
    const jobs = await claimCatalogRefreshJobs(settings, raw.workerId, 2);
    expect(jobs).toEqual([{ ...raw, bindingRevision: "ab".repeat(8), profileRevision: "ac".repeat(8) }]);
    expect(batches.claim).toContain("j.available_at<=@now");
    expect(batches.claim).toContain("lease_token=NEWID(),lease_expires_at=DATEADD(second,120,@now)");
    expect(batches.claim).toContain("j.lease_expires_at<=@now");
    expect(batches.claim).toContain("WHEN 1 THEN 30 WHEN 2 THEN 60 WHEN 3 THEN 120 WHEN 4 THEN 240 ELSE 300");
    d.query.mockResolvedValueOnce({ recordset: [{ completed: false }] });
    expect(await completeCatalogRefreshClaim(jobs[0], "retry")).toBe(false);
    expect(value("leaseToken")).toBe(raw.leaseToken);
    expect(value("jobAttempt")).toBe(3);
    expect(batches.complete).toContain("j.job_id=@jobId AND j.worker_id=@workerId AND j.lease_token=@leaseToken");
    expect(batches.complete).toContain("WHEN j.attempt_no>=5 THEN 'failed' ELSE 'retry'");
    expect(batches.complete).toContain("IF @leaseUntil<=SYSUTCDATETIME() THROW");
    expect(batches.enqueueDue).toContain("h.attempted_at<=DATEADD(minute,-5,@now)");
    expect(batches.enqueueDue).not.toContain("verified_until");
  });

  it("does not report a superseded job as successful unless a higher exact sealed head is still verified", () => {
    const sql = batches.completePublication;
    expect(sql).toContain("DECLARE @verifiedHead bit=0;");
    expect(sql).toContain("h.attempt_status='succeeded'");
    expect(sql).toContain("@outcome='superseded' AND h.attempt_ordinal>CONVERT(bigint,@reservedOrdinal)");
    for (const condition of ["r.binding_version=@binding", "r.profile_version=@profile", "r.match_key_version=@currentKeyVersion",
      "r.sealed_at IS NOT NULL", "r.verified_until>@now"]) expect(sql).toContain(condition);
    expect(sql).toContain("WHEN @outcome='superseded' AND @verifiedHead=1 THEN 'succeeded'");
    expect(sql).toContain("WHEN @outcome IN ('stale','superseded') THEN 'cancelled'");
    expect(sql).toContain("IF @outcome='succeeded' AND @verifiedHead=0 THROW");
  });
});
