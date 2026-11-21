import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { buildCatalogDraftScheduleDefinition, createNewCatalogDraftProposalHttp, normalizeCatalogDraftDefinition,
  verifyStoredCatalogDraft, withCatalogDraftDefinitionForApproval } from "../lib/catalogScheduleDraftProposal";

const actor = { actorId: "actor", allowedKinds: ["domain"] as const, allowLicensing: false };
const checkedAt = new Date("2030-06-22T12:00:00Z");
const doc = { name: "Nueva", previewId: "opaque-scope", linkIds: ["a".repeat(64)],
  calendar: { frequencyType: "once" }, assignment: { mode: "role", domainRole: "domain_updater" },
  scope: { mode: "manual", customerId: "d832a70e-b525-42fa-ab14-a4d54ea5158c", target: "domain", environment: "test", date: "2030-06-22" } } as const;
const req = (body: unknown) => new HttpRequest({ method: "POST", url: "http://localhost/api/schedules/catalog-draft-proposals",
  body: { string: JSON.stringify(body) } });

describe("pending new schedule proposal", () => {
  it("submits only the scoped DTO and cannot transmit approvals or active state", async () => {
    const save = vi.fn().mockResolvedValue({ id: "05d95fc4-21c3-4adc-8c8d-d23716fe679c", status: "pending_approval" });
    const handler = createNewCatalogDraftProposalHttp({ authorize: async () => actor, save, now: () => checkedAt });
    expect((await handler(req({ ...doc, active: true }))).status).toBe(400);
    expect((await handler(req({ ...doc, scope: { ...doc.scope, target: "both" },
      assignment: { ...doc.assignment, databaseRole: "database_updater" } }))).status).toBe(403);
    expect((await handler(req(doc))).status).toBe(202);
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...actor, ...doc, checkedAt });
  });
  it("refuses incomplete assignees and past end dates before touching SQL", async () => {
    const save = vi.fn();
    const handler = createNewCatalogDraftProposalHttp({ authorize: async () => actor, save, now: () => checkedAt });
    expect((await handler(req({ ...doc, assignment: { mode: "users", domainUsers: [] } }))).status).toBe(400);
    expect((await handler(req({ ...doc, calendar: { frequencyType: "weekly", everyNWeeks: 1, weekdays: ["MONDAY"], endDate: "2030-06-19" } }))).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
  it("normalizes weekly days and independently maps people by target kind", () => {
    expect(normalizeCatalogDraftDefinition({ scope: { ...doc.scope, target: "both" },
      calendar: { frequencyType: "weekly", everyNWeeks: 2, weekdays: ["FRIDAY","MONDAY"] },
      assignment: { mode: "users", domainUsers: ["d2","d1"], databaseUsers: ["b1"] } })).toMatchObject({
        mode: "users", frequency: "weekly", days: [1,5], everyNWeeks: 2,
        roles: [{ kind: "domain", id: "domain_updater" }, { kind: "database", id: "database_updater" }],
        users: [{ kind: "domain", id: "d1" }, { kind: "domain", id: "d2" }, { kind: "database", id: "b1" }],
      });
  });
  it("byte pins the inert and history-preserving SQL changes", () => {
    const file = "078_catalog_schedule_draft_proposals.sql";
    const migration = readFileSync(new URL(`../../../migration/sql/${file}`, import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../../../migration/sql/MANIFEST.sha256", import.meta.url), "utf8");
    expect(manifest).toContain(`${createHash("sha256").update(migration).digest("hex")}  ${file}`);
    expect(migration).toContain("included bit NOT NULL");
    expect(migration).toContain("REFERENCES security.users(user_key)");
    expect(migration).toContain("weekday BETWEEN 1 AND 7");
    expect(migration).not.toMatch(/\b(GRANT|REVOKE|EXECUTE AS)\b|INSERT\s+scheduling\.update_schedules/i);
  });
  it("keeps the independent review separate from the app and hash-pins the review migration", () => {
    const file = "079_catalog_schedule_draft_review_receipts.sql";
    const migration = readFileSync(new URL(`../../../migration/sql/${file}`, import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../../../migration/sql/MANIFEST.sha256", import.meta.url), "utf8");
    const script = readFileSync(new URL("../../../migration/tools/Register-PortalSAGWeb-DraftProposalReview.ps1", import.meta.url), "utf8");
    expect(manifest).toContain(`${createHash("sha256").update(migration).digest("hex")}  ${file}`);
    expect(migration).toContain("requester.user_key<>reviewer.user_key");
    expect(migration).toContain("REPLACE(operation_id,N'-',N'') NOT LIKE N'%[^A-Za-z0-9._:]%'");
    expect(migration).toContain("p.proposal_sha256=i.proposal_sha256");
    expect(migration).toContain("proof.reviewed_state_sha256=i.reviewed_state_sha256");
    expect(migration).toContain("transaction_isolation_level=4");
    expect(migration).toContain("DATEADD(minute,10,@now),ORIGINAL_LOGIN()");
    expect(migration).toContain("ln.target_id,ln.kind,ln.included");
    expect(migration).toContain("d.weekday");
    expect(migration).toContain("a.kind,a.user_key");
    expect(migration).not.toMatch(/\b(GRANT|REVOKE|EXECUTE AS)\b|INSERT\s+scheduling\.update_schedules/i);
    expect(script).toContain("$PSCmdlet.ShouldProcess");
    expect(script).toContain("$mode='read'");
    expect(script).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  });
  it("reconstructs only the exact stored manual destinations, recurrence and separate assignee lists", async () => {
    const id = "05d95fc4-21c3-4adc-8c8d-d23716fe679c";
    const scope = { ...doc.scope, target: "both" } as const;
    const pins = [{ linkId: "19000000-0000-0000-0000-000000000000", physicalId: "27000000-0000-0000-0000-000000000000",
      kind: "database", include: true }];
    const users = [{ kind: "domain", id: "dev" }, { kind: "database", id: "support" }];
    const definition = { mode: "users", roles: [{ kind: "domain", id: "domain_updater" }, { kind: "database", id: "database_updater" }],
      users, days: [1,5], frequency: "weekly", endDate: null, everyNWeeks: 2, intervalDays: null, dayOfMonth: null };
    const digest = createHash("sha256").update(JSON.stringify(["catalog-draft-proposal-v2", id, "qa", "actor", "Nueva",
      "manual", scope.date, "both", "test", scope.customerId, null,
      pins.map(pin => [pin.linkId,pin.kind,pin.physicalId,pin.include]), definition])).digest("hex");
    const row = { id, environment: "qa", actorId: "actor", name: "Nueva", scope, moduleId: null, pins,
      digest, assignmentMode: "users", domainRole: "domain_updater", databaseRole: "database_updater", ...{
        users: [...users].reverse(), days: [5,1], frequency: "weekly", endDate: null, everyNWeeks: 2, intervalDays: null, dayOfMonth: null,
      } };
    expect(verifyStoredCatalogDraft(row)).toMatchObject({ pins, definition,
      calendar: { frequencyType: "weekly", everyNWeeks: 2 } });
    const evidence = [{ ...pins[0], kind: "database" as const, targetSourceId: "selected-db",
      customerId: "customer", customerName: "Cliente", domainId: "display-parent", domainName: "parent.example" }];
    const verified = verifyStoredCatalogDraft(row)!;
    expect(buildCatalogDraftScheduleDefinition(verified, evidence, checkedAt)).toEqual({
      record: expect.objectContaining({ domainId: "display-parent", targetIds: [], frequencyType: "weekly", everyNWeeks: 2,
        assignedUserIds: ["dev"], databaseAssignedUserIds: ["support"] }),
      exactManualPins: [{ linkId: pins[0].linkId, targetId: pins[0].physicalId, kind: "database" }],
    });
    expect(buildCatalogDraftScheduleDefinition(verified, [{ ...evidence[0], physicalId: id }], checkedAt)).toBeNull();
    expect(buildCatalogDraftScheduleDefinition(verified, evidence, new Date("2030-06-23T05:00:00Z"))).toBeNull();
    const reprove = vi.fn(async (_input, _expected, use) => use({ locked: true }, { links: evidence, validUntil: checkedAt }));
    const read = vi.fn().mockResolvedValue({ ...verified, digest: "0".repeat(64) });
    const consume = vi.fn().mockResolvedValue("consumed");
    const actorRequest = { ...actor, scope, checkedAt, portalEnvironment: "qa" as const, matchKeyVersion: 1 };
    await expect(withCatalogDraftDefinitionForApproval(actorRequest, verified, consume, reprove, read)).resolves.toBeNull();
    expect(consume).not.toHaveBeenCalled();
    read.mockResolvedValueOnce(verified);
    await expect(withCatalogDraftDefinitionForApproval(actorRequest, verified, consume, reprove, read)).resolves.toBe("consumed");
    expect(read).toHaveBeenCalledWith({ locked: true }, { id, actorId: "actor", portalEnvironment: "qa" });
    expect(consume).toHaveBeenCalledOnce();
    expect(verifyStoredCatalogDraft({ ...row, pins: [...pins, { ...pins[0], kind: "domain",
      linkId: "29000000-0000-0000-0000-000000000000" }] })).toBeNull();
    expect(verifyStoredCatalogDraft({ ...row, users: [{ kind: "database", id: "other" }, users[0]] })).toBeNull();
    expect(verifyStoredCatalogDraft({ ...row, days: [1,2] })).toBeNull();
    expect(verifyStoredCatalogDraft({ ...row, scope: { ...scope, environment: "all" } })).toBeNull();
    expect(verifyStoredCatalogDraft({ ...row, actorId: "other" })).toBeNull();
  });
  it("never turns an omitted licensing alias into an exclusion of an included logical target", () => {
    const id = "05d95fc4-21c3-4adc-8c8d-d23716fe679c", moduleId = "approved-module";
    const scope = { mode: "licensing", date: doc.scope.date, target: "database", environment: "all" } as const;
    const pins = [
      { linkId: "19000000-0000-0000-0000-000000000000", physicalId: "27000000-0000-0000-0000-000000000000", kind: "database" as const, include: true },
      { linkId: "29000000-0000-0000-0000-000000000000", physicalId: "37000000-0000-0000-0000-000000000000", kind: "database" as const, include: false },
    ];
    const definition = normalizeCatalogDraftDefinition({ scope, calendar: { frequencyType: "once" },
      assignment: { mode: "role", databaseRole: "database_updater" } })!;
    const digest = createHash("sha256").update(JSON.stringify(["catalog-draft-proposal-v2", id, "qa", "actor", "Nueva",
      "licensing", scope.date, "database", "all", null, moduleId,
      pins.map(pin => [pin.linkId,pin.kind,pin.physicalId,pin.include]), definition])).digest("hex");
    const verified = verifyStoredCatalogDraft({ id, environment: "qa", actorId: "actor", name: "Nueva", scope, moduleId, pins, digest,
      assignmentMode: "role", domainRole: null, databaseRole: "database_updater", users: [], days: [], frequency: "once",
      endDate: null, everyNWeeks: null, intervalDays: null, dayOfMonth: null })!;
    const evidence = pins.map(pin => ({ ...pin, targetSourceId: "same-db",
      customerId: "customer", customerName: "Cliente", domainId: "display-parent", domainName: "parent.example" }));
    expect(buildCatalogDraftScheduleDefinition(verified, evidence, checkedAt)).toBeNull();
    expect(buildCatalogDraftScheduleDefinition(verified, [evidence[0], { ...evidence[1], targetSourceId: "omitted-db" }], checkedAt))
      .toMatchObject({ record: { licensingScope: { licenseModuleIds: [moduleId], excludedDatabaseIds: ["omitted-db"] } } });
  });
});
