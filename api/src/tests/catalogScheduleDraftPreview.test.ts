import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { catalogDraftDomainChoiceId, createNewCatalogSchedulePreviewHttp, previewNewCatalogSchedule, withReprovedCatalogDraft,
  withVerifiedNewCatalogDraft } from "../lib/catalogScheduleDraftPreview";

const checkedAt = new Date("2030-06-22T12:00:00Z"), date = "2030-06-22";
const customerId = "d832a70e-b525-42fa-ab14-a4d54ea5158c";
const actor = { actorId: "actor", allowedKinds: ["domain", "database"] as const, allowLicensing: true };
const scope = { mode: "manual", customerId, target: "both", environment: "test", date } as const;
const input = { ...actor, scope, portalEnvironment: "qa" as const, matchKeyVersion: 1, checkedAt };
const req = (body: unknown) => new HttpRequest({ method: "POST", url: "http://localhost/api/schedules/catalog-draft-preview",
  body: { string: JSON.stringify(body) } });

describe("new catalog schedule preview", () => {
  it("does not read with insufficient permissions or client-supplied operational identifiers", async () => {
    const read = vi.fn();
    const handler = createNewCatalogSchedulePreviewHttp({ authorize: async () => ({ ...actor, allowedKinds: ["domain"] }),
      read, now: () => checkedAt });
    expect((await handler(req(scope))).status).toBe(403);
    expect((await handler(req({ ...scope, operationId: "forged" }))).status).toBe(400);
    expect((await handler(req({ ...scope, target: "domain", date: "2030-06-21" }))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("groups exact test-environment database aliases by physical proof and hides other sources and environments", async () => {
    const parent = { linkId: "parent", catalogCustomerId: customerId, customerId: "client-internal", domainId: "domain-internal",
      domainName: "https://tenant.example.test/", kind: "domain", environment: "test", evidence: { state: "verified", sourceId: "allowed" } };
    const db = { ...parent, kind: "database", databaseId: "db-internal", linkId: "one" };
    const alias = { ...db, linkId: "two", databaseId: "alias-internal" };
    const other = { ...db, linkId: "three", evidence: { state: "verified", sourceId: "not-allowed" } };
    const prod = { ...db, linkId: "another-environment", environment: "production" };
    const links = [parent, db, alias, other, prod];
    const preview = vi.fn().mockResolvedValue({ coverage: "verified", candidates: [
      { linkId: "one", kind: "database", targetId: "same-physical", state: "ready" },
      { linkId: "two", kind: "database", targetId: "same-physical", state: "conflict" },
    ] });
    const io = { links: vi.fn().mockResolvedValue(links), roster: vi.fn().mockResolvedValue([]), intents: vi.fn().mockResolvedValue(new Map()),
      sources: vi.fn().mockResolvedValue(new Set(["allowed"])), certify: vi.fn(), module: vi.fn(), preview,
      evidence: vi.fn().mockResolvedValue({ revision: { complete: true }, populationFence: {},
        inventory: links.map(link => ({ link, domainName: link.domainName, targetName: "Base de prueba", clientName: "Cliente de prueba" })) }),
    };
    const result = await previewNewCatalogSchedule({ ...input, scope: { ...scope, target: "database",
      domainChoiceId: catalogDraftDomainChoiceId(customerId, "tenant.example.test", "test") } }, io);
    expect(preview.mock.calls[0][0].rules[0].scope.linkIds).toEqual(["one", "two"]);
    expect(result).toMatchObject({ coverage: "verified", groups: [
      { kind: "database", label: "Base de prueba", state: "reserved", links: [{ environment: "test" }, { environment: "test" }] },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/db-internal|same-physical|not-allowed|client-internal/);
    preview.mockResolvedValueOnce({ coverage: "verified", candidates: [
      { linkId: "three", kind: "database", targetId: "same-physical", state: "ready" },
    ] });
    expect(await previewNewCatalogSchedule(input, io)).toBeNull();
    io.evidence.mockResolvedValueOnce({ revision: { complete: false } });
    expect(await previewNewCatalogSchedule(input, io)).toBeNull();
  });

  it("accepts only reviewed real modules, with no name or display code sent as an operational ID", async () => {
    const read = vi.fn().mockResolvedValue(null);
    const handler = createNewCatalogSchedulePreviewHttp({ authorize: async () => actor, read, now: () => checkedAt });
    expect((await handler(req({ mode: "licensing", moduleCode: "invented", date, target: "both", environment: "all" }))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect((await handler(req({ mode: "licensing", moduleCode: "I", date, target: "both", environment: "all" }))).status).toBe(409);
    expect(read).toHaveBeenCalledOnce();
  });

  it("seals exact licensed inclusions and exclusions; changes to the preview prevent saving", async () => {
    const base = { catalogCustomerId: customerId, customerId: "local-client", domainId: "local-domain",
      domainName: "tenant.example.test", kind: "domain", environment: "test", evidence: { state: "verified", sourceId: "allowed" } };
    const links = [{ ...base, linkId: "ready" }, { ...base, linkId: "reserved" }];
    const candidate = { coverage: "verified", heldLinkIds: [], candidates: [
      { kind: "domain", linkId: "ready", targetId: "a", state: "ready" },
      { kind: "domain", linkId: "reserved", targetId: "b", state: "conflict" },
    ] };
    const preview = vi.fn().mockResolvedValue(candidate);
    const withPreview = vi.fn(async (_day, use) => use({ fixture: true }, candidate, new Date(checkedAt.valueOf() + 60_000)));
    const io = { links: vi.fn().mockResolvedValue(links), roster: vi.fn().mockResolvedValue([]), intents: vi.fn().mockResolvedValue(new Map()),
      sources: vi.fn().mockResolvedValue(new Set(["allowed"])), certify: vi.fn(), module: vi.fn().mockResolvedValue("licensed-module"),
      preview, withPreview, secret: () => "d".repeat(48), now: () => checkedAt,
      evidence: vi.fn().mockResolvedValue({ revision: { id: "catalog-population-v1:reviewed", complete: true }, populationFence: {},
        inventory: links.map(link => ({ link, domainName: link.domainName, targetName: link.domainName, clientName: "Cliente de prueba" })) }),
    };
    const licensed = { ...input, scope: { mode: "licensing", moduleCode: "I", target: "domain", environment: "test", date } } as const;
    const result = (await previewNewCatalogSchedule(licensed, io))!;
    const take = result.groups.find(group => group.state === "ready")!.links[0].id;
    const blocked = result.groups.find(group => group.state === "reserved")!.links[0].id;
    const save = vi.fn().mockResolvedValue("saved");
    await expect(withVerifiedNewCatalogDraft({ ...licensed, previewId: result.previewId!, linkIds: [take] }, save, io)).resolves.toBe("saved");
    expect(save.mock.calls[0][1]).toMatchObject({ moduleId: "licensed-module", pins: [
      { kind: "domain", linkId: "ready", physicalId: "a", include: true },
      { kind: "domain", linkId: "reserved", physicalId: "b", include: false },
    ] });
    await expect(withVerifiedNewCatalogDraft({ ...licensed, previewId: result.previewId!, linkIds: [take, blocked] }, save, io)).resolves.toBeNull();
    await expect(withVerifiedNewCatalogDraft({ ...licensed, scope: { ...licensed.scope, environment: "all" }, previewId: result.previewId!, linkIds: [take] }, save, io))
      .resolves.toBeNull();
    expect(save).toHaveBeenCalledOnce();
    const use = vi.fn().mockResolvedValue("reproved");
    const expected = save.mock.calls[0][1];
    await expect(withReprovedCatalogDraft(licensed, expected, use, io)).resolves.toBe("reproved");
    expect(use).toHaveBeenCalledWith({ fixture: true }, expect.objectContaining({ links: [
      expect.objectContaining({ linkId: "ready", physicalId: "a", targetSourceId: "local-domain" }),
      expect.objectContaining({ linkId: "reserved", physicalId: "b" }),
    ] }));
    await expect(withReprovedCatalogDraft(licensed, { ...expected, pins: [expected.pins[0]] }, use, io)).resolves.toBeNull();
    withPreview.mockImplementationOnce(async (_day, consume) => consume({ fixture: true }, { ...candidate, candidates: [
      { ...candidate.candidates[0], state: "conflict" }, candidate.candidates[1],
    ] }, new Date(checkedAt.valueOf() + 60_000)));
    await expect(withReprovedCatalogDraft(licensed, expected, use, io)).resolves.toBeNull();
    expect(use).toHaveBeenCalledOnce();
  });
});
