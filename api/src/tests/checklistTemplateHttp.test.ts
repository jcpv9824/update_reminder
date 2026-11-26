import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequest } from "@azure/functions";
const auth = vi.hoisted(() => ({ requireUser: vi.fn(), loadUserProfile: vi.fn(), loadRoleDefinitions: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireUser: auth.requireUser, loadUserProfile: auth.loadUserProfile }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: auth.loadRoleDefinitions }));
import { authenticateChecklistTemplateRequest, createChecklistTemplateHandlers } from "../functions/checklistTemplates";
import { ChecklistTemplateError } from "../lib/checklistTemplateDomain";

const id = "11111111-1111-4111-8111-111111111111";
const actor = { id: "user", email: "user@example.invalid", canManageTemplates: true, isSuperAdmin: false };
const service = { list: vi.fn(), create: vi.fn(), get: vi.fn(), remove: vi.fn(), createVersion: vi.fn(), getVersion: vi.fn(), saveVersion: vi.fn(), publishVersion: vi.fn(), removeVersion: vi.fn() };
function req(method: string, body?: unknown, params: Record<string, string> = { id, number: "1" }) {
  return new HttpRequest({ method, url: "https://qa.invalid/api/configuration/checklist-templates", params,
    ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } }) });
}
function handlers(current: typeof actor | null = actor) { return createChecklistTemplateHandlers({ authenticate: async () => current, service }); }

describe("Plantillas API-20…28 · transporte con servicio simulado (sin SQL)", () => {
  beforeEach(() => { Object.values(service).forEach((fn) => fn.mockReset()); Object.values(auth).forEach((fn) => fn.mockReset()); });
  it("CA-32 deriva permisos del perfil persistido actual, no de roles anteriores del token", async () => {
    auth.requireUser.mockResolvedValue({ id: "user", roles: ["super_admin"] });
    auth.loadUserProfile.mockResolvedValue({ id: "user", email: "current@example.invalid", displayName: "Actual", roles: ["custom"] });
    auth.loadRoleDefinitions.mockResolvedValue([{ id: "custom", name: "Sin acceso", permissions: [], taskVisibility: { domain: "none", database: "none" }, system: false, active: true }]);
    expect(await authenticateChecklistTemplateRequest(req("GET"))).toEqual({ id: "user", email: "current@example.invalid", canManageTemplates: false, isSuperAdmin: false });
    const response = await createChecklistTemplateHandlers({ authenticate: authenticateChecklistTemplateRequest, service }).list(req("GET"));
    expect(response.status).toBe(403); expect(service.list).not.toHaveBeenCalled();
  });
  it("CA-32 rechaza perfil inactivo/no registrado y sesión ausente con 401", async () => {
    const h = createChecklistTemplateHandlers({ authenticate: authenticateChecklistTemplateRequest, service });
    auth.requireUser.mockResolvedValue({ id: "user" }); auth.loadUserProfile.mockResolvedValue(null);
    expect((await h.list(req("GET"))).status).toBe(401);
    auth.requireUser.mockRejectedValue(Object.assign(new Error("No autenticado."), { status: 401 }));
    expect((await h.list(req("GET"))).status).toBe(401); expect(service.list).not.toHaveBeenCalled();
  });
  it("CA-32 / API-20…28 rechaza cada ruta sin sesión antes de llamar al servicio", async () => {
    const h = handlers(null);
    for (const handler of Object.values(h)) expect((await handler(req("POST", {}))).status).toBe(401);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
  it("CA-32 rechaza cada ruta sin permiso, sin confiar en el cuerpo", async () => {
    const h = handlers({ ...actor, canManageTemplates: false });
    for (const handler of Object.values(h)) expect((await handler(req("POST", { isSuperAdmin: true }))).status).toBe(403);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
  it("CA-30 solo permite API-23 a superadministradores", async () => {
    expect((await handlers().remove(req("DELETE"))).status).toBe(403);
    const response = await handlers({ ...actor, isSuperAdmin: true }).remove(req("DELETE"));
    expect(response.status).toBe(204); expect(service.remove).toHaveBeenCalledWith(expect.objectContaining({ isSuperAdmin: true }), id);
  });
  it("CA-33 API-21 devuelve 201 y nombre recortado sin aceptar propietario o estado", async () => {
    service.create.mockResolvedValue({ id, name: "Migración" });
    const result = await handlers().create(req("POST", { name: " Migración " }));
    expect(result.status).toBe(201); expect(result.jsonBody).toEqual({ id, name: "Migración" });
    expect(service.create).toHaveBeenCalledWith(actor, { name: "Migración" });
    expect((await handlers().create(req("POST", { name: "Nombre", ownerId: "other" }))).status).toBe(400);
  });
  it("CA-37 API-26 exige ROWVERSION y valida número/UUID y cuerpo estricto", async () => {
    expect((await handlers().saveVersion(req("PUT", { requiresEnvironment: false, points: [] }))).status).toBe(400);
    expect((await handlers().getVersion(req("GET", undefined, { id, number: "1x" }))).status).toBe(400);
    expect((await handlers().get(req("GET", undefined, { id: "bad" }))).status).toBe(400);
    expect(service.saveVersion).not.toHaveBeenCalled(); expect(service.get).not.toHaveBeenCalled();
  });
  it.each([["stale", 409, "saveVersion"], ["in_use", 409, "remove"], ["version_locked", 409, "saveVersion"], ["not_found", 404, "get"], ["no_points", 422, "publishVersion"]] as const)("CA-24/27/31/37 conserva %s y el estado %s en %s sin filtrar internals", async (error, status, operation) => {
    service[operation].mockRejectedValue(new ChecklistTemplateError(status, error, "Mensaje en español."));
    const body = operation === "saveVersion" ? { requiresEnvironment: false, points: [], rowVersion: "AAAAAAAAAAE=" } : undefined;
    const method = operation === "get" ? "GET" : operation === "remove" ? "DELETE" : operation === "saveVersion" ? "PUT" : "POST";
    const response = await handlers({ ...actor, isSuperAdmin: operation === "remove" })[operation](req(method, body));
    expect(response.status).toBe(status); expect(response.jsonBody).toEqual({ error, message: "Mensaje en español." });
    expect(response.headers).toMatchObject({ "Cache-Control": "private, no-store" });
  });
  it("API-20 envuelve los resúmenes en items y API-24 devuelve 201", async () => {
    service.list.mockResolvedValue([{ id }]); service.createVersion.mockResolvedValue({ id });
    expect((await handlers().list(req("GET"))).jsonBody).toEqual({ items: [{ id }] });
    expect((await handlers().createVersion(req("POST"))).status).toBe(201);
  });
  it("API-26 guarda false y el cuerpo completo, sin claves del actor desde JSON", async () => {
    const input = { requiresEnvironment: false, points: [], rowVersion: "AAAAAAAAAAE=" };
    service.saveVersion.mockResolvedValue({ id, requiresEnvironment: false });
    expect((await handlers().saveVersion(req("PUT", input))).status).toBe(200);
    expect(service.saveVersion).toHaveBeenCalledWith(actor, id, 1, input);
  });
  it("no devuelve detalles SQL, secretos ni trazas en fallos inesperados", async () => {
    service.list.mockRejectedValue(new Error("PRIVATE_SQL_PASSWORD"));
    const result = await handlers().list(req("GET")); expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SQL");
  });
});
