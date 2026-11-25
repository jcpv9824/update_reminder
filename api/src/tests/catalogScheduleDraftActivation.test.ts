import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { activateReviewedCatalogDraft } from "../lib/catalogScheduleDraftActivation";
import { createCatalogScheduleCopyActivateHttp } from "../lib/catalogScheduleCopyActivateHttp";
import { hasExactSameDayDraftCohort } from "../lib/catalogScheduleActivationWorker";

const proposalId = "7a9b6b25-aaf9-4dd3-ac93-43c4dd899a95";
const reviewId = "05d95fc4-21c3-4adc-8c8d-d23716fe679c";
const startDate = "2030-06-22";
const checkedAt = new Date("2030-06-22T12:00:00Z"), approvedAt = new Date("2030-06-22T12:01:00Z");
const validUntil = new Date("2030-06-22T12:05:00Z");
const actor = { actorId: "author", actorEmail: "author@example.invalid", allowedKinds: ["database"] as const, allowLicensing: true };
const input = { ...actor, portalEnvironment: "qa" as const, proposalId, reviewId, checkedAt, matchKeyVersion: 1 };
const manual = { mode: "manual", date: startDate, target: "database", environment: "test", customerId: proposalId } as const;
const pin = { linkId: "link", kind: "database" as const, physicalId: "same-db", include: true };

function fixtures(frequency = "once") {
  const tx = { heldDayLocks: true }, readonly = { read: true };
  const record = { id: `catalog-draft-${proposalId}`, startDate };
  const draft = { id: proposalId, actorId: "author", environment: "qa", scope: { ...manual },
    pins: [pin], definition: { frequency } };
  const version = "0000000000000001", operationId = "CHANGE-1234";
  const approval = { approvedAt, validUntil, operationId };
  const locationKey = Buffer.from("fixture proof key");
  const commit = vi.fn(), rollback = vi.fn(), tightenDeadline = vi.fn(), historical = vi.fn().mockResolvedValue("frozen");
  const io = {
    transaction: vi.fn(async cb => cb(readonly)), read: vi.fn().mockResolvedValue(draft), moduleCode: vi.fn(),
    approve: vi.fn(async (_draftInput, _draft, use) => {
      try {
        const result = await use(tx, { record }, { proposalId, validUntil, tightenDeadline });
        commit();
        return result;
      } catch (error) { rollback(); throw error; }
    }),
    persist: vi.fn(async (sameTx, built, _proof, callbacks) => {
      const frozen = await callbacks.freezeSameDay(sameTx, { draft: built, approval, version });
      if (!frozen) throw Object.assign(new Error("held"), { status: 409 });
      return { id: record.id, status: "created" };
    }),
    historical, locationKey: vi.fn().mockResolvedValue(locationKey),
  };
  return { io, tx, readonly, record, draft, commit, rollback, version, operationId, locationKey };
}

describe("activation for reviewed new catalog schedules", () => {
  it("runs same-day automatic generation only after commit and preserves success when generation fails", async () => {
    const { io, record, commit, locationKey } = fixtures();
    const order: string[] = [];
    commit.mockImplementation(() => { order.push("commit"); });
    const generate = vi.fn(async () => { order.push("generate"); throw new Error("transient"); });
    await expect(activateReviewedCatalogDraft(input, io, generate)).resolves.toEqual({ id: record.id, status: "created" });
    expect(generate).toHaveBeenCalledExactlyOnceWith(startDate);
    expect(order).toEqual(["commit", "generate"]);
    expect(locationKey.every(byte => byte === 0)).toBe(true);
  });

  it("does not trigger generation for a manual frequency or when approval rolls back", async () => {
    const generate = vi.fn();
    const manualFrequency = fixtures("manual");
    await expect(activateReviewedCatalogDraft(input, manualFrequency.io, generate)).resolves.toMatchObject({ status: "created" });
    const failed = fixtures();
    failed.io.historical.mockResolvedValue("held");
    await expect(activateReviewedCatalogDraft(input, failed.io, generate)).rejects.toMatchObject({ status: 409 });
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses one reserved write transaction and only SQL-stamped approval for same-day freeze", async () => {
    const { io, tx, readonly, record, commit, rollback, version, operationId, locationKey } = fixtures();
    await expect(activateReviewedCatalogDraft(input, io)).resolves.toEqual({ id: record.id, status: "created" });
    expect(io.read).toHaveBeenCalledWith(readonly, { id: proposalId, actorId: "author", portalEnvironment: "qa" });
    expect(io.historical).toHaveBeenCalledWith(tx, "qa", 1, { scheduleId: record.id, version, date: startDate },
      locationKey, { proposalId, approvedAt, operationId, expected: [pin] });
    expect(locationKey.every(byte => byte === 0)).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("cannot commit if same-day proof is held, requester differs, or scope is no longer authorized", async () => {
    const { io, commit, rollback, locationKey } = fixtures();
    io.historical.mockResolvedValue("held");
    await expect(activateReviewedCatalogDraft(input, io)).rejects.toMatchObject({ status: 409 });
    expect(rollback).toHaveBeenCalledOnce();
    expect(locationKey.every(byte => byte === 0)).toBe(true);
    await expect(activateReviewedCatalogDraft({ ...input, actorId: "other" }, io)).resolves.toBeNull();
    await expect(activateReviewedCatalogDraft({ ...input, allowedKinds: ["domain"] }, io)).resolves.toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(io.persist).toHaveBeenCalledOnce();
  });

  it("will not substitute a changed physical binding or an extra destination", () => {
    const item = { linkId: pin.linkId, state: "eligible" as const };
    const found = (target: string, targets = [item]) => ({
      previousMembers: [], responsibles: [], evidence: { observedAt: checkedAt.valueOf(), complete: true, targets },
      labelsByLink: new Map([[pin.linkId, { kind: pin.kind, verifiedTargetId: target }]]),
    }) as unknown as Parameters<typeof hasExactSameDayDraftCohort>[0];
    expect(hasExactSameDayDraftCohort(found(pin.physicalId), [pin])).toBe(true);
    expect(hasExactSameDayDraftCohort(found("different-db"), [pin])).toBe(false);
    expect(hasExactSameDayDraftCohort(found(pin.physicalId, [item, { ...item, linkId: "extra" }]), [pin])).toBe(false);
  });

  it("passes only a receipt through the request boundary and never discloses it in results", async () => {
    const activate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: `catalog-draft-${proposalId}`, status: "created" });
    const handler = createCatalogScheduleCopyActivateHttp({ subject: "programación", authorize: async () => actor, activate });
    const request = (body: object) => new HttpRequest({ method: "POST", url: "http://localhost/api/schedules/draft",
      params: { proposalId }, body: { string: JSON.stringify(body) } });
    expect((await handler(request({ reviewId, actorId: "other" }))).status).toBe(400);
    expect(activate).not.toHaveBeenCalled();
    expect((await handler(request({ reviewId }))).status).toBe(409);
    const ok = await handler(request({ reviewId }));
    expect(ok).toMatchObject({ status: 201, jsonBody: { id: `catalog-draft-${proposalId}`, status: "created" },
      headers: { "Cache-Control": "no-store" } });
    expect(JSON.stringify(ok)).not.toContain(reviewId);
  });
});
