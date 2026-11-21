import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createCatalogScheduleCopyPreviewHttp, readCatalogScheduleCopyPreview, withVerifiedCatalogCopySelection } from "../lib/catalogScheduleCopyPreview";
import type { UpdateSchedule } from "../types/models";

const date = "2030-06-22";
const checkedAt = new Date(`${date}T14:00:00Z`);
const actor = { actorId: "operator", allowedKinds: ["domain", "database"] as const, allowLicensing: true };
const request = (query: string) => new HttpRequest({ url: `https://example.test/api/schedules/original/catalog-copy-preview?${query}`,
  method: "GET", params: { id: "original" } });

describe("authenticated copy preview", () => {
  it("rejects unauthenticated or invalid callers before loading any catalog evidence", async () => {
    const read = vi.fn();
    const unauthorized = createCatalogScheduleCopyPreviewHttp({ read, authorize: async () => ({ status: 403 }) });
    expect(await unauthorized(request(`date=${date}`))).toMatchObject({ status: 403, headers: { "Cache-Control": "no-store" } });
    const authorized = createCatalogScheduleCopyPreviewHttp({ read, authorize: async () => actor, now: () => checkedAt });
    for (const query of [`date=${date}&operator=forged`, `date=${date}&date=${date}`, "date=2030-02-30", "date=2030-06-21"]) {
      expect(await authorized(request(query))).toMatchObject({ status: 400 });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("does not copy a snapshot or expose task/source/physical/operational IDs", async () => {
    const version = "0000000000000001";
    const schedule = { id: "original", origin: "special", active: true, targetType: "domain", frequencyType: "once", startDate: date,
      timezone: "America/Bogota", targetIds: ["old-dest"], assignedRole: "domain_updater", assignedUserIds: [],
      clientId: "client-internal" } as unknown as UpdateSchedule;
    const day = { date, checkedAt, cutoffAt: new Date("2030-06-23T05:00:00Z"), portalEnvironment: "qa" as const,
      revision: { id: "catalog-population-v1:approved", complete: true }, operationsBySchedule: new Map([[schedule.id,
        { scheduleVersion: version, operationId: "approved-op" }]]), activeLicenseIds: new Set<string>(), inventory: [{
        link: { linkId: "real-link-id", customerId: schedule.clientId, domainId: "old-dest", catalogRecordId: "erp-row", kind: "domain" as const,
          environment: "production" as const, state: "active" as const, moduleIds: [], target: { status: "unverifiable" as const } },
        sourceId: "source-internal", clientName: "Cliente de prueba", domainName: "demo.example.test",
        targetName: "https://private-user:private-password@demo.example.test/private-path?private-query=1",
      }] };
    const preview = vi.fn().mockResolvedValue({ coverage: "partial", heldLinkIds: ["private-held"], candidates: [
      { linkId: "real-link-id", kind: "domain", targetId: "physical-internal", state: "conflict" },
    ] });
    const dep = { readRoster: vi.fn().mockResolvedValue([{ schedule, version, activation: { phase: "cancelled", targets: [] } }]),
      readOrigin: vi.fn().mockResolvedValue({ schedule: { ...schedule, startDate: "2030-06-25" }, version }),
      readOperations: vi.fn().mockResolvedValue(day.operationsBySchedule), readIntents: vi.fn().mockResolvedValue(new Map()),
      licenses: vi.fn(), evidence: vi.fn().mockResolvedValue(day), preview,
      secret: () => "test-only-copy-intent-secret-at-least-32-bytes" };
    const result = await readCatalogScheduleCopyPreview({ ...actor, scheduleId: schedule.id, date, checkedAt,
      portalEnvironment: "qa", matchKeyVersion: 1 }, dep);
    expect(result).toMatchObject({ coverage: "partial", groups: [{ kind: "domain", label: "demo.example.test",
      conflict: { reason: expect.any(String) }, links: [{ label: "Cliente de prueba · demo.example.test", verified: true }] }] });
    expect(JSON.stringify(result)).not.toMatch(/real-link-id|source-internal|physical-internal|private-held|approved-op|private-user|private-password|private-path|private-query/);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ previewActorId: actor.actorId,
      previewOrigin: { scheduleId: "original", scheduleVersion: version, operationId: "approved-op" },
      rules: [expect.objectContaining({ scope: expect.objectContaining({ linkIds: ["real-link-id"] }) })] }));
    expect(dep.licenses).not.toHaveBeenCalled();
    dep.readRoster.mockResolvedValueOnce([]);
    await expect(readCatalogScheduleCopyPreview({ ...actor, scheduleId: schedule.id, date, checkedAt,
      portalEnvironment: "qa", matchKeyVersion: 1 }, dep)).resolves.toMatchObject({ coverage: "partial" });
    expect(dep.readOrigin).toHaveBeenCalledExactlyOnceWith(schedule.id, date);

    const ready = { coverage: "verified", heldLinkIds: [], candidates: [
      { linkId: "real-link-id", kind: "domain", targetId: "physical-internal", state: "ready" },
    ] };
    preview.mockResolvedValueOnce(ready);
    const input = { ...actor, scheduleId: schedule.id, date, checkedAt, portalEnvironment: "qa" as const, matchKeyVersion: 1 };
    const bound = await readCatalogScheduleCopyPreview(input, dep);
    const transaction = {};
    const withPreview = vi.fn(async (_day, consume) => consume(transaction, ready, day.cutoffAt));
    const write = vi.fn().mockResolvedValue({ id: "new-independent-copy" });
    const save = { ...input, previewId: bound!.previewId, linkIds: [bound!.groups[0].links[0].id] };
    const boundIo = { ...dep, withPreview, now: () => new Date(checkedAt.getTime() + 1000) };
    await expect(withVerifiedCatalogCopySelection(save, write, boundIo)).resolves.toEqual({ id: "new-independent-copy" });
    expect(write).toHaveBeenCalledExactlyOnceWith(transaction, expect.objectContaining({
      selected: [expect.objectContaining({ linkId: "real-link-id", targetId: "physical-internal" })],
    }));
    withPreview.mockImplementationOnce(async (_day, consume) => consume(transaction, { ...ready,
      candidates: [{ ...ready.candidates[0], state: "conflict" }] }, day.cutoffAt));
    await expect(withVerifiedCatalogCopySelection(save, write, boundIo)).resolves.toBeNull();
    expect(write).toHaveBeenCalledOnce();
  });
});
