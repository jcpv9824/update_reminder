import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createCatalogScheduleCopyProposalHttp, readStoredCatalogCopyProposalInTransaction, requestCatalogScheduleCopyProposal } from "../lib/catalogScheduleCopyProposal";

const now = new Date("2030-06-22T12:00:00Z");
const proposalId = "d44005d7-15c4-4089-8397-6e0ce6f3bd7a";
const selection = { name: "Mi copia", date: "2030-06-22", previewId: "v1.synthetic", linkIds: ["a".repeat(64)] };
const actor = { actorId: "actor-1", allowedKinds: ["database"] as const, allowLicensing: false };
const result = { proposalId, status: "pending_approval" } as const;
const req = (body: object = selection, id = "origin-1") => new HttpRequest({
  method: "POST", url: "http://localhost/api/schedules/origin-1/catalog-copy-proposals",
  params: { id }, body: { string: JSON.stringify(body) },
});

describe("catalog copy proposal boundary", () => {
  it("requires access before preparing or persisting the proposal", async () => {
    const submit = vi.fn();
    for (const status of [401, 403] as const) {
      const handler = createCatalogScheduleCopyProposalHttp({ authorize: async () => ({ status }), submit, now: () => now });
      expect(await handler(req())).toMatchObject({ status, headers: { "Cache-Control": "no-store" } });
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("accepts the exact permitted subset as pending and does not return evidence IDs", async () => {
    const submit = vi.fn().mockResolvedValue(result);
    const handler = createCatalogScheduleCopyProposalHttp({ authorize: async () => actor, submit, now: () => now });
    expect(await handler(req())).toMatchObject({ status: 202, jsonBody: result, headers: { "Cache-Control": "no-store" } });
    expect(submit).toHaveBeenCalledExactlyOnceWith({ ...actor, ...selection, scheduleId: "origin-1", checkedAt: now });
  });

  it.each([{ ...selection, approverId: "untrusted" }, { ...selection, active: true },
    { ...selection, linkIds: [] }, { ...selection, linkIds: [selection.linkIds[0], selection.linkIds[0]] },
    { ...selection, linkIds: [proposalId] }])("rejects ambiguous or authority-bearing input", async body => {
    const submit = vi.fn();
    const handler = createCatalogScheduleCopyProposalHttp({ authorize: async () => actor, submit, now: () => now });
    expect((await handler(req(body))).status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not persist stale or unverified inputs", async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const handler = createCatalogScheduleCopyProposalHttp({ authorize: async () => actor, submit, now: () => now });
    expect((await handler(req({ ...selection, date: "2030-06-21" }))).status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
    expect((await handler(req())).status).toBe(409);
  });

  it("persists only verified exact pins, never a preview token, executable schedule, approval or notice", async () => {
    const query = vi.fn().mockResolvedValue({ recordset: [{ persisted: true }] });
    const bind = { query, input: vi.fn().mockReturnThis() };
    const physicalId = "d661ec82-bbec-42f3-b956-e06cb4ac3a47";
    const verify = vi.fn(async (_input, cb) => cb({ request: () => bind }, {
      intentId: proposalId, day: { date: selection.date, portalEnvironment: "qa",
        previewOrigin: { scheduleId: "origin-1", scheduleVersion: "1234567890abcdef", operationId: "update-prices" } },
      selected: [{ linkId: proposalId, kind: "database", targetId: physicalId, state: "ready" }],
      proofValidUntil: new Date(now.valueOf() + 60_000),
    }));
    await expect(requestCatalogScheduleCopyProposal({ ...actor, ...selection, scheduleId: "origin-1", checkedAt: now,
      portalEnvironment: "qa", matchKeyVersion: 1 }, verify)).resolves.toEqual(result);
    expect(bind.input).toHaveBeenCalledWith("links", expect.anything(),
      JSON.stringify([{ linkId: proposalId, kind: "database", physicalId }]));
    expect(bind.input.mock.calls.flat()).not.toContain(selection.previewId);
    const batch = query.mock.calls[0][0];
    expect(batch).toMatch(/INSERT scheduling\.catalog_schedule_copy_proposals/);
    expect(batch).toMatch(/p\.request_sha256/);
    expect(batch).not.toMatch(/INSERT\s+(?:scheduling\.update_schedules|scheduling\.catalog_schedule_operation_approvals|workflow\.|notifications\.)/i);
    const digest = bind.input.mock.calls.find(call => call[0] === "digest")?.[2];
    const meta = { scheduleId: "origin-1", scheduleVersion: "1234567890abcdef", requesterId: actor.actorId,
      operationId: "update-prices", date: selection.date, name: selection.name, digest };
    const storedLink = { linkId: proposalId, kind: "database", physicalId };
    const tx = { request: () => bind } as unknown as Parameters<typeof readStoredCatalogCopyProposalInTransaction>[0];
    query.mockResolvedValueOnce({ recordsets: [[meta], [storedLink]] });
    await expect(readStoredCatalogCopyProposalInTransaction(tx, proposalId, "qa")).resolves.toMatchObject({ links: [storedLink] });
    query.mockResolvedValueOnce({ recordsets: [[meta], [{ ...storedLink, physicalId: proposalId }]] });
    await expect(readStoredCatalogCopyProposalInTransaction(tx, proposalId, "qa")).resolves.toBeNull();
  });

  it("pins the inert SQL migration without changing grants", () => {
    const filename = "075_catalog_schedule_copy_proposals.sql";
    const path = (name: string) => new URL(`../../../migration/sql/${name}`, import.meta.url);
    const migration = readFileSync(path(filename));
    expect(readFileSync(path("MANIFEST.sha256"), "utf8")).toContain(`${createHash("sha256").update(migration).digest("hex")}  ${filename}`);
    expect(migration.toString()).toMatch(/catalog_schedule_copy_proposal_links AFTER UPDATE,DELETE/);
    expect(migration.toString()).not.toMatch(/\b(GRANT|DENY|REVOKE|EXECUTE AS)\b/i);
  });
});
