import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createCatalogScheduleCopyActivateHttp } from "../lib/catalogScheduleCopyActivateHttp";
import { confirmReviewedCatalogCopyReplayInTransaction, consumeSqlCatalogCopyReviewInTransaction } from "../lib/catalogScheduleCopyReviewSqlRepository";

const proposalId = "7a9b6b25-aaf9-4dd3-ac93-43c4dd899a95";
const reviewId = "05d95fc4-21c3-4adc-8c8d-d23716fe679c";
const copyVersion = "0000000000000031";
const path = `/api/schedules/catalog-copy-proposals/${proposalId}/activate`;
const request = (body: unknown) => new HttpRequest({ method: "POST", url: `http://localhost${path}`,
  params: { proposalId }, body: { string: JSON.stringify(body) } });
const actor = { actorId: "requester", actorEmail: "requester@example.test", allowedKinds: ["database"] as const, allowLicensing: false };
function sqlTransaction(rows: readonly unknown[]) {
  const query = vi.fn().mockResolvedValue({ recordset: rows });
  const execute = vi.fn().mockResolvedValue({ recordset: rows });
  const input = vi.fn().mockReturnValue({ query, execute, get input() { return input; } });
  return { tx: { request: () => ({ input }) } as unknown as Parameters<typeof consumeSqlCatalogCopyReviewInTransaction>[0], query, execute, input };
}

describe("consuming one independently approved catalog copy receipt", () => {
  it("requires an authenticated actor and refuses reviewer identities or execution fields supplied by the client", async () => {
    const activate = vi.fn();
    const anonymous = createCatalogScheduleCopyActivateHttp({ authorize: async () => ({ status: 401 }), activate });
    expect((await anonymous(request({ reviewId }))).status).toBe(401);
    const authorized = createCatalogScheduleCopyActivateHttp({ authorize: async () => actor, activate });
    for (const body of [{ reviewId, approver: "other" }, { reviewId, active: true }, { reviewId: "wrong" }]) {
      expect((await authorized(request(body))).status).toBe(400);
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not leak evidence and does not call a stale/conflicting copy successful", async () => {
    const activate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: `catalog-copy-${proposalId}`, status: "created", secret: "not a DTO" });
    const handler = createCatalogScheduleCopyActivateHttp({ authorize: async () => actor, activate });
    expect((await handler(request({ reviewId }))).status).toBe(409);
    expect(await handler(request({ reviewId }))).toEqual({ status: 201, headers: { "Cache-Control": "no-store" },
      jsonBody: { id: `catalog-copy-${proposalId}`, status: "created" } });
    expect(activate).toHaveBeenLastCalledWith(actor, proposalId, reviewId);
  });

  it("supplies only opaque IDs and SQL version and checks the authoritative deadline", async () => {
    const approvedAt = new Date("2030-01-02T15:00:00Z"), validUntil = new Date("2030-01-02T15:10:00Z");
    const args = { environment: "qa" as const, proposalId, reviewId, copyVersion };
    const { tx, execute, input } = sqlTransaction([{ approvedAt, validUntil }]);
    await expect(consumeSqlCatalogCopyReviewInTransaction(tx, args)).resolves.toEqual(validUntil);
    expect(execute).toHaveBeenCalledExactlyOnceWith("settings.consume_catalog_schedule_copy_review");
    expect(input.mock.calls.map(call => call[0])).toEqual(["environment", "proposal", "review", "copyVersion"]);
    await expect(consumeSqlCatalogCopyReviewInTransaction(sqlTransaction([{ approvedAt, validUntil: approvedAt }]).tx, args))
      .rejects.toMatchObject({ status: 409 });
  });

  it("requires the exact approval and same-day snapshot before treating a replay as confirmed", async () => {
    const { tx, query } = sqlTransaction([]);
    const args = { environment: "qa" as const, proposalId, copyId: `catalog-copy-${proposalId}` };
    await expect(confirmReviewedCatalogCopyReplayInTransaction(tx, args)).resolves.toBe(false);
    expect(query.mock.calls[0][0]).toContain("a.schedule_version=s.row_version");
    expect(query.mock.calls[0][0]).toContain("proof.activation_at=a.approved_at");
    query.mockResolvedValueOnce({ recordset: [{ confirmed: true }] });
    await expect(confirmReviewedCatalogCopyReplayInTransaction(tx, args)).resolves.toBe(true);
  });

  it("keeps direct denials, validates the shape, consumes once and checks the final Bogotá business day", () => {
    const filename = "077_catalog_schedule_copy_review_consumption.sql";
    const migration = readFileSync(new URL(`../../../migration/sql/${filename}`, import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../../../migration/sql/MANIFEST.sha256", import.meta.url), "utf8");
    expect(manifest).toContain(`${createHash("sha256").update(migration).digest("hex")}  ${filename}`);
    expect(migration).toContain("SET XACT_ABORT ON;");
    expect(migration).toContain("requester.user_key<>approver.user_key");
    expect(migration).toContain("proof.reviewed_state_sha256=r.reviewed_state_sha256");
    expect(migration).toContain("PRIMARY KEY REFERENCES scheduling.catalog_schedule_copy_proposals");
    expect(migration).toContain("review_id uniqueidentifier NOT NULL UNIQUE");
    expect(migration).toContain("ORDER BY ol.link_key");
    expect(migration).toContain("@requestedDate<CONVERT(date,DATEADD(hour,-5,@approvalAt))");
    expect(migration).not.toMatch(/EXECUTE AS|REVOKE|ALTER ROLE/);
    expect([...migration.matchAll(/\bGRANT ([^\r\n]+)/g)].map(match => match[1])).toEqual([
      "EXECUTE ON OBJECT::settings.consume_catalog_schedule_copy_review TO portal_runtime;",
    ]);
  });
});
