import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ getSqlPool: vi.fn(), execute: vi.fn(), transaction: vi.fn(), input: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: mock.getSqlPool }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: mock.transaction }));
import { readChecklist } from "../lib/checklistSqlRepository";

const id = "10000000-0000-4000-8000-000000000001";
const templateId = "10000000-0000-4000-8000-000000000002";
const actor = { id: "viewer", email: "viewer@example.invalid", canView: true, canCreate: false, isSuperAdmin: false };
const head = { id, templateId, clientId: id, clientName: "ERP", templateName: "QA", versionNumber: 1, environment: null,
  status: "in_progress", ownerId: "owner", ownerName: "Responsable", createdAt: new Date("2026-11-26T14:00:00Z"),
  completedAt: null, checkedCount: 1, pointCount: 1, rowVersion: Buffer.from("AAAAAAAAAAE=", "base64") };
const request = { input: mock.input, query: mock.execute };
const source = { request: () => request };

describe("Checklists API-04 · snapshot de lectura", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.input.mockReturnValue(request);
    mock.getSqlPool.mockResolvedValue(source);
    mock.transaction.mockImplementation(async (run) => run(source));
    mock.execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT template_id AS templateId")) return { recordset: [{ templateId }] };
      if (sql.includes("notesJson")) return { recordsets: [[head], [], []] };
      return { recordset: [{ id }] };
    });
  });
  it("CA-21 lee cabecera y versión fijada con una transacción; adquiere bloqueos en el orden del escritor", async () => {
    const result = await readChecklist(actor, id);
    expect(result).toMatchObject({ versionNumber: 1, rowVersion: "AAAAAAAAAAE=", canEdit: false });
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    const steps = mock.execute.mock.calls.map(([sql]) => sql as string);
    expect(steps[0]).toContain("SELECT template_id AS templateId");
    expect(steps[1]).toContain("implementation.checklist_templates WITH(HOLDLOCK)");
    expect(steps[2]).toContain("implementation.implementation_checklists WITH(HOLDLOCK)");
    expect(steps[3]).toContain("tp.id=p.template_point_id AND tp.version_id=p.version_id");
    expect(steps[3]).toContain("e.status='saved'");
  });
  it("CA-10 no consulta cabecera sin permiso de lectura", async () => {
    await expect(readChecklist({ ...actor, canView: false }, id)).rejects.toMatchObject({ status: 403 });
    expect(mock.getSqlPool).not.toHaveBeenCalled();
    expect(mock.execute).not.toHaveBeenCalled();
  });
});
