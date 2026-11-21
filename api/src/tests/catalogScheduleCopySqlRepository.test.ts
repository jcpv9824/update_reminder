import { describe, expect, it, vi } from "vitest";
import { insertSqlCatalogRemainingCopyInTransaction } from "../lib/catalogScheduleCopySqlRepository";
import type { UpdateSchedule } from "../types/models";

const intentId = "d832a70e-b525-42fa-ab14-a4d54ea5158c";
const linkId = "cd20054c-1449-48a2-8c85-9ce6e9b25320";
const targetId = "437b679c-b6a5-486a-bd43-227ce11cc9c9";
const intent = { intentId, taskDate: "2030-06-22", portalEnvironment: "qa", originalScheduleId: "original",
  originalDefinitionVersion: "0000000000000001", operationId: "approved-operation",
  links: [{ linkId, targetId, kind: "database" }] } as const;
const actor = { id: "operator", email: "operator@example.test" };
const record = { id: `catalog-copy-${intentId}`, name: "Copia", startDate: intent.taskDate, timezone: "America/Bogota",
  active: true, selectionMode: "manual", targetIds: [], clientId: "client", origin: "special", targetType: "database",
  frequencyType: "once", assignedRole: "database_updater" } as unknown as UpdateSchedule;
const physicalUntil = new Date("2030-06-22T22:00:00Z");

function setup() {
  const bindings: Record<string, unknown> = {};
  const query = vi.fn().mockResolvedValueOnce({ recordset: [] }).mockResolvedValueOnce({ recordset: [{ count: 1, validUntil: physicalUntil }] });
  const request = { input: vi.fn((name, _type, value) => { bindings[name] = value; return request; }), query };
  const tx = { request: () => request } as unknown as Parameters<typeof insertSqlCatalogRemainingCopyInTransaction>[0];
  const insert = vi.fn().mockResolvedValue({ key: 42, record, version: "0000000000000002" });
  const finalize = vi.fn();
  return { tx, insert, finalize, bindings, query };
}

describe("exact idempotent catalog-copy persistence", () => {
  it("uses the same transaction for parent, exact verified links, and required finalization", async () => {
    const { tx, insert, finalize, bindings, query } = setup();
    await expect(insertSqlCatalogRemainingCopyInTransaction(tx, intent, record, actor, finalize, insert))
      .resolves.toEqual({ status: "created", id: record.id });
    expect(insert).toHaveBeenCalledExactlyOnceWith(tx, record, actor, { catalogLifecycle: true });
    expect(JSON.parse(String(bindings.links))).toEqual(intent.links);
    expect(query.mock.calls[1][0]).toContain("p.database_key=l.database_key");
    expect(query.mock.calls[1][0]).toContain("s.row_version=@version");
    expect(finalize).toHaveBeenCalledExactlyOnceWith(tx, record, intent, "0000000000000002", physicalUntil);
  });

  it("returns the same copy on a retry, but does not overwrite a changed or deleted copy", async () => {
    const { tx, insert, finalize, bindings, query } = setup();
    await insertSqlCatalogRemainingCopyInTransaction(tx, intent, record, actor, finalize, insert);
    const prior = { id: record.id, actorId: actor.id, originalId: intent.originalScheduleId, version: intent.originalDefinitionVersion,
      operationId: intent.operationId, environment: intent.portalEnvironment, deleted: false, digest: bindings.digest };
    query.mockResolvedValueOnce({ recordset: [prior] });
    await expect(insertSqlCatalogRemainingCopyInTransaction(tx, intent, record, actor, finalize, insert))
      .resolves.toEqual({ status: "replayed", id: record.id });
    query.mockResolvedValueOnce({ recordset: [prior] });
    await expect(insertSqlCatalogRemainingCopyInTransaction(tx, intent, { ...record, name: "Otro nombre" }, actor, finalize, insert))
      .rejects.toMatchObject({ status: 409 });
    query.mockResolvedValueOnce({ recordset: [{ ...prior, deleted: true }] });
    await expect(insertSqlCatalogRemainingCopyInTransaction(tx, intent, record, actor, finalize, insert)).rejects.toMatchObject({ status: 409 });
    expect(insert).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("throws on a lost link or final approval so the transaction owner rolls back", async () => {
    const { tx, insert, finalize, query } = setup();
    query.mockReset().mockResolvedValueOnce({ recordset: [] }).mockResolvedValueOnce({ recordset: [{ count: 0 }] });
    await expect(insertSqlCatalogRemainingCopyInTransaction(tx, intent, record, actor, finalize, insert)).rejects.toMatchObject({ status: 409 });
    expect(finalize).not.toHaveBeenCalled();
    const good = setup();
    await expect(insertSqlCatalogRemainingCopyInTransaction(good.tx, intent, record, actor, async () => {
      throw new Error("approval pending");
    }, good.insert)).rejects.toThrow("approval pending");
  });
});
