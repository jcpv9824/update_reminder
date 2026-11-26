import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChecklistTemplateService } from "../lib/checklistTemplateService";
const id = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const actor = { id: "user", email: "user@example.invalid", canManageTemplates: true, isSuperAdmin: false };
const store = { list: vi.fn(), read: vi.fn(), execute: vi.fn() };
const record = () => ({ id, name: "Migración", deleted: false, createdAt: "2026-11-26T15:00:00.000Z", versions: [{ id: versionId, number: 1, status: "editing" as const,
  requiresEnvironment: false, uses: 0, deleted: false, rowVersion: "AAAAAAAAAAE=", points: [] }], internalSqlKey: 33 });
describe("Plantillas · servicio con puerto simulado (sin HTTP/SQL)", () => {
  beforeEach(() => Object.values(store).forEach((fn) => fn.mockReset()));
  it("CA-32 niega lecturas y escrituras sin acceso antes del repositorio", async () => {
    const service = createChecklistTemplateService(store); const denied = { ...actor, canManageTemplates: false };
    await expect(service.list(denied)).rejects.toMatchObject({ status: 403 });
    await expect(service.create(denied, { name: "Nueva" })).rejects.toMatchObject({ status: 403 });
    expect(store.list).not.toHaveBeenCalled(); expect(store.execute).not.toHaveBeenCalled();
  });
  it("CA-30 no permite borrar a quien solo tiene acceso a configuración", async () => {
    await expect(createChecklistTemplateService(store).remove(actor, id)).rejects.toMatchObject({ status: 403 });
    expect(store.execute).not.toHaveBeenCalled();
  });
  it("API-22 devuelve un DTO explícito, sin claves internas ni versiones eliminadas", async () => {
    const row = record(); store.read.mockResolvedValue({ ...row, versions: [...row.versions, { ...row.versions[0], id: "deleted", number: 2, deleted: true }] });
    const result = await createChecklistTemplateService(store).get(actor, id);
    expect(result).toEqual({ id, name: "Migración", currentVersion: null, uses: 0, createdAt: row.createdAt, canDelete: false,
      versions: [{ id: versionId, number: 1, status: "editing", requiresEnvironment: false, uses: 0, rowVersion: "AAAAAAAAAAE=" }] });
    expect(JSON.stringify(result)).not.toContain("internalSqlKey");
  });
  it("API-25 devuelve puntos, nombre de plantilla y versión con ROWVERSION", async () => {
    store.read.mockResolvedValue(record());
    expect(await createChecklistTemplateService(store).getVersion(actor, id, 1)).toMatchObject({ id: versionId, number: 1, templateId: id, templateName: "Migración", points: [], rowVersion: "AAAAAAAAAAE=" });
  });
  it("API-22/25 devuelve 404 para plantilla eliminada, inexistente o versión ausente", async () => {
    const service = createChecklistTemplateService(store);
    store.read.mockResolvedValue(null); await expect(service.get(actor, id)).rejects.toMatchObject({ status: 404 });
    store.read.mockResolvedValue({ ...record(), deleted: true }); await expect(service.get(actor, id)).rejects.toMatchObject({ status: 404 });
    store.read.mockResolvedValue(record()); await expect(service.getVersion(actor, id, 2)).rejects.toMatchObject({ status: 404 });
  });
  it("CA-32 API-21 no usa autor como dueño y devuelve el recurso releído del repositorio", async () => {
    store.execute.mockResolvedValue(record());
    const result = await createChecklistTemplateService(store).create(actor, { name: " Migración " });
    expect(result.id).toBe(id); expect(store.execute).toHaveBeenCalledWith(actor, "create", { input: { name: "Migración" } });
  });
});
