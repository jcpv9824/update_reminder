import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, resetHttp } from "./checklistTestHelpers";
import { MODULOS, opcionesPermitidas, rutaInicial } from "../menu";
import { PERMISSION_CATALOG, DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../permissionModel";
import App from "../App";
beforeEach(resetHttp); afterEach(cleanup);
const role = (permissions: string[]): RoleDefinition => ({ id: "config_only", name: "Configuración", permissions, active: true, system: false, taskVisibility: { domain: "none", database: "none" } });
function mount(path: string) { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>); }
describe("CA-38 · navegación completa", () => {
  it("CA-38 añade solo Checklists al final de Configuración e Implementación; puntos/versiones no son opciones laterales", () => {
    const config = MODULOS.find(m => m.etiqueta === "Configuración")!;
    expect(config.elementos.at(-1)).toMatchObject({ etiqueta: "Checklists", ruta: "/configuracion/checklists", permiso: "configuration.checklist_templates.view" });
    expect(MODULOS.find(m => m.etiqueta === "Implementación")!.elementos.at(-1)).toMatchObject({ etiqueta: "Checklists", ruta: "/implementacion/checklists", permiso: "implementation.checklists.view" });
    expect(MODULOS.flatMap(m => m.elementos).filter(e => e.ruta.includes("checklists"))).toHaveLength(2);
  });
  it("CA-38 configura solo view, no inventa edit/delete/create para plantillas ni otorga a roles ordinarios", () => {
    const option = PERMISSION_CATALOG.find(m => m.id === "configuration")!.options.find(o => o.permissionPrefix === "configuration.checklist_templates");
    expect(option?.actions.map(a => a.id)).toEqual(["view"]);
    expect(PERMISSION_CATALOG.find(m => m.id === "implementation")!.options.find(o => o.permissionPrefix === "implementation.checklists")?.actions.map(a => a.id)).toEqual(["view", "create"]);
    expect(DEFAULT_ROLE_DEFINITIONS.filter(r => r.id !== "super_admin").every(r => !r.permissions.includes("configuration.checklist_templates.view"))).toBe(true);
  });
  it("CA-38 la única opción lleva a plantillas, Tareas sigue prioritaria y dos opciones llevan a bienvenida", () => {
    const only = [role(["configuration.checklist_templates.view"])];
    expect(rutaInicial(opcionesPermitidas(["config_only"], only))).toBe("/configuracion/checklists");
    expect(rutaInicial(opcionesPermitidas(["config_only"], [role(["configuration.checklist_templates.view", "updates.tasks.view"])]))).toBe("/tareas");
    expect(rutaInicial(opcionesPermitidas(["config_only"], [role(["configuration.checklist_templates.view", "clients.clients.view"])]))).toBeNull();
    expect(rutaInicial(opcionesPermitidas(["config_only"], [role(["implementation.checklists.view"])]))).toBe("/implementacion/checklists");
    expect(rutaInicial(opcionesPermitidas(["config_only"], [role(["configuration.checklist_templates.view", "implementation.checklists.view"])]))).toBeNull();
  });
  it("CA-32 CA-38 abre con solo permiso de configuración sin exigir Implementación", async () => {
    http.get.mockImplementation(async path => path === "/roles" ? [role(["configuration.checklist_templates.view"])] : { items: [] });
    mount("/configuracion/checklists");
    expect(await screen.findByRole("heading", { name: "Plantillas de checklist" }, { timeout: 10000 })).toBeInTheDocument();
    await waitFor(() => expect(http.get).toHaveBeenCalledWith("/configuration/checklist-templates"));
  });
  it("CA-38 rechaza ruta directa sin permiso y no consulta plantillas", async () => {
    http.get.mockResolvedValue([role([])]); mount("/configuracion/checklists");
    expect(await screen.findByRole("heading", { name: "No autorizado" })).toBeInTheDocument();
    await waitFor(() => expect(http.get.mock.calls.every(([p]) => p === "/roles")).toBe(true));
  });
});
