import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  query: vi.fn(), input: vi.fn(), audit: vi.fn(), readDetail: vi.fn(), pool: vi.fn(), transaction: vi.fn(), resolveClient: vi.fn(),
}));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: mock.transaction }));
vi.mock("../lib/sql", () => ({ getSqlPool: mock.pool }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: mock.audit }));
vi.mock("../lib/checklistErpClients", () => ({ resolveChecklistErpClient: mock.resolveClient }));
vi.mock("../lib/checklistSqlRepository", async (original) => ({
  ...(await original<typeof import("../lib/checklistSqlRepository")>()), readChecklist: mock.readDetail,
}));

import { changeChecklistStatus, createChecklist, saveChecklist } from "../lib/checklistSqlWriteRepository";

const id = "10000000-0000-4000-8000-000000000001";
const clientId = "10000000-0000-4000-8000-000000000002";
const templateId = "10000000-0000-4000-8000-000000000003";
const versionId = "10000000-0000-4000-8000-000000000004";
const pointId = "10000000-0000-4000-8000-000000000005";
const imageId = "10000000-0000-4000-8000-000000000006";
const open = new Date("2026-11-26T12:00:00Z");
const actor = { id: "dueño", email: "dueno@example.invalid", canView: true, canCreate: true, isSuperAdmin: false };
const rowVersion = "AAAAAAAAAAE=";
const current = { templateId, clientId, environment: null, status: "in_progress", ownerId: actor.id, rowVersion: Buffer.from(rowVersion, "base64") };
const input = { rowVersion, points: [{ pointId, checked: false, notes: null }], evidence: { add: [], remove: [] } };
const db = { request: () => ({ input: mock.input, query: mock.query }) };
const writes = () => mock.query.mock.calls.filter(([query]: [string]) => /\b(?:UPDATE\s+(?!there)|INSERT\s+(?!into @))/iu.test(query));

beforeEach(() => {
  vi.clearAllMocks();
  mock.input.mockImplementation(() => ({ input: mock.input, query: mock.query }));
  mock.pool.mockResolvedValue(db);
  mock.transaction.mockImplementation(async (run) => run(db));
  mock.resolveClient.mockResolvedValue({ id: clientId, name: "Nombre oficial ERP" });
  mock.readDetail.mockResolvedValue({ id });
  mock.query.mockImplementation(async (statement: string) => {
    if (statement.includes("c.row_version AS rowVersion")) return { recordset: [current] };
    if (statement.includes("template_point_id AS pointId FROM")) return { recordset: [{ pointId }] };
    if (statement.includes("SELECT TOP (2)")) return { recordset: [] };
    if (statement.includes("v.id AS versionId")) return { recordset: [{ versionId, requiresEnvironment: false }] };
    if (statement.includes("SELECT template_id AS templateId")) return { recordset: [{ templateId }] };
    return { recordset: [] };
  });
});

describe("Checklists: límites del repositorio de escritura con transacción simulada", () => {
  it.each(["save", "complete", "reopen", "delete"] as const)("CA-10 no autoriza %s a otro usuario que solo puede ver", async (operation) => {
    const viewer = { ...actor, id: "otro", canCreate: false };
    const result = operation === "save" || operation === "complete" ? saveChecklist(viewer, id, input, operation === "complete") :
      changeChecklistStatus(viewer, id, operation);
    await expect(result).rejects.toMatchObject({ status: 403 });
    expect(writes()).toHaveLength(0);
    expect(mock.audit).not.toHaveBeenCalled();
  });

  it("CA-11 al administrador sí le permite guardar y deja actor de auditoría", async () => {
    const admin = { ...actor, id: "administrador", isSuperAdmin: true };
    await expect(saveChecklist(admin, id, input, false)).resolves.toEqual({ id });
    expect(mock.audit).toHaveBeenCalledWith(db, expect.objectContaining({ action: "checklist_saved", performedBy: admin.id, entityId: id }));
  });

  it("CA-13 no confirma cambios parciales de una finalización incompleta", async () => {
    await expect(saveChecklist(actor, id, input, true)).rejects.toMatchObject({
      status: 422, error: "missing_points", details: { pointIds: [pointId] },
    });
    expect(writes()).toHaveLength(0);
    expect(mock.audit).not.toHaveBeenCalled();
  });

  it("CA-20 conserva una imagen privada verificada y su tamaño en notas del mismo punto", async () => {
    const query = mock.query.getMockImplementation()!;
    mock.query.mockImplementation((statement: string) => statement.includes("e.verified_at AS verifiedAt")
      ? { recordset: [{ id: imageId, pointId, status: "pending", kind: "image", createdBy: actor.id, verifiedAt: open }] }
      : query(statement));
    await saveChecklist(actor, id, {
      ...input, evidence: { add: [imageId], remove: [] },
      points: [{ pointId, checked: false, notes: { type: "doc", content: [{ type: "image", attrs: { fileId: imageId, width: 280 } }] } }],
    }, false);
    const encoded = mock.input.mock.calls.find(([name]) => name === "points")?.[2] as string;
    expect(JSON.parse(JSON.parse(encoded)[0].notesJson)).toMatchObject({
      content: [{ type: "image", attrs: { fileId: imageId, width: 280 } }],
    });
    expect(encoded).not.toContain('"src"');
  });

  it.each(["wrong_point", "not_verified"] as const)("CA-20 rechaza una imagen pendiente insegura (%s) sin escribir", async (scenario) => {
    const query = mock.query.getMockImplementation()!;
    mock.query.mockImplementation((statement: string) => statement.includes("e.verified_at AS verifiedAt")
      ? { recordset: [{ id: imageId, pointId: scenario === "wrong_point" ? versionId : pointId,
        status: "pending", kind: "image", createdBy: actor.id, verifiedAt: scenario === "wrong_point" ? open : null }] }
      : query(statement));
    await expect(saveChecklist(actor, id, {
      ...input, evidence: { add: [imageId], remove: [] },
      points: [{ pointId, checked: false, notes: { type: "doc", content: [{ type: "image", attrs: { fileId: imageId } }] } }],
    }, false)).rejects.toMatchObject({ status: 400, error: scenario === "wrong_point" ? "invalid_notes" : "invalid_evidence" });
    expect(writes()).toHaveLength(0);
    expect(mock.audit).not.toHaveBeenCalled();
  });

  it("CA-21 la creación fija versión y copia de nombre recuperadas en su transacción", async () => {
    await createChecklist(actor, { clientId, templateId });
    expect(mock.resolveClient).toHaveBeenCalledWith(actor, clientId, db);
    expect(mock.input.mock.calls.some(([name, , value]) => name === "versionId" && value === versionId)).toBe(true);
    expect(mock.input.mock.calls.some(([name, , value]) => name === "clientName" && value === "Nombre oficial ERP")).toBe(true);
    expect(writes()[0][0]).toContain("WHERE version_id=@versionId AND deleted_at IS NULL");
    expect(mock.audit).toHaveBeenCalledWith(db, expect.objectContaining({ action: "checklist_created" }));
  });

  it("CA-34 rechaza token obsoleto antes de escribir y de auditar", async () => {
    await expect(saveChecklist(actor, id, { ...input, rowVersion: "AAAAAAAAAAI=" }, false))
      .rejects.toMatchObject({ status: 409, error: "stale" });
    expect(writes()).toHaveLength(0);
    expect(mock.audit).not.toHaveBeenCalled();
  });

  it("CA-35 reapertura con otra instancia en progreso no modifica ninguna", async () => {
    const query = mock.query.getMockImplementation()!;
    mock.query.mockImplementation((statement: string) => {
      if (statement.includes("c.row_version AS rowVersion")) return { recordset: [{ ...current, status: "completed" }] };
      if (statement.includes("SELECT TOP (2)")) return { recordset: [{ id: versionId, status: "in_progress", ownerName: "Persona QA", createdAt: open, completedAt: null }] };
      return query(statement);
    });
    await expect(changeChecklistStatus(actor, id, "reopen")).rejects.toMatchObject({ status: 409, error: "duplicate_in_progress" });
    expect(writes()).toHaveLength(0);
    expect(mock.audit).not.toHaveBeenCalled();
  });
});
