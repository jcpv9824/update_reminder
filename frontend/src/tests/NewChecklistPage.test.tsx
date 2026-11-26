import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { conflict, http, renderChecklist, resetHttp, templateId } from "./checklistTestHelpers";
import ImplementationChecklistsRoutes from "../pages/checklists/ImplementationChecklistsRoutes";
const clientId = "66666666-6666-4666-8666-666666666666";
const available = [{ id: templateId, name: "Migración", number: 2, requiresEnvironment: true }, { id: "77777777-7777-4777-8777-777777777777", name: "Local", number: 1, requiresEnvironment: false }];
function mount() { return renderChecklist(<ImplementationChecklistsRoutes />, "/implementacion/checklists/nuevo", "/implementacion/checklists/*"); }
async function selectClient() { fireEvent.change(await screen.findByRole("combobox", { name: "Clientes" }), { target: { value: "cli" } }); fireEvent.click(await screen.findByRole("option", { name: "Cliente ERP" })); }
beforeEach(() => { resetHttp(); http.get.mockImplementation(async path => path.includes("client-search") ? { items: [{ id: clientId, name: "Cliente ERP" }] } : { items: [], availableTemplates: available }); }); afterEach(cleanup);
describe("P02 · Nuevo checklist", () => {
  it("CA-01 CA-03 CA-04 menos de tres letras no busca, escribir no selecciona y no preselecciona plantilla", async () => {
    mount(); const input = await screen.findByRole("combobox", { name: "Clientes" });
    fireEvent.change(input, { target: { value: "cl" } });
    expect(http.get.mock.calls.some(([p]) => p.includes("client-search"))).toBe(false);
    expect(screen.getByLabelText("Plantilla")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Crear checklist" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Seleccione un cliente de la lista"); expect(http.post).not.toHaveBeenCalled();
  });
  it("CA-02 CA-03 teclear después de elegir invalida la identidad seleccionada", async () => {
    mount(); await selectClient(); fireEvent.change(screen.getByRole("combobox", { name: "Clientes" }), { target: { value: "otra" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear checklist" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Seleccione un cliente de la lista"); expect(http.post).not.toHaveBeenCalled();
  });
  it("CA-04 CA-05 cambiar a plantilla sin ambiente lo oculta y no lo conserva al volver", async () => {
    mount(); await selectClient(); fireEvent.change(screen.getByLabelText("Plantilla"), { target: { value: templateId } });
    expect(screen.getByLabelText("Ambiente")).toHaveValue(""); fireEvent.change(screen.getByLabelText("Ambiente"), { target: { value: "testing" } });
    fireEvent.change(screen.getByLabelText("Plantilla"), { target: { value: available[1].id } }); expect(screen.queryByLabelText("Ambiente")).toBeNull();
    fireEvent.change(screen.getByLabelText("Plantilla"), { target: { value: templateId } }); expect(screen.getByLabelText("Ambiente")).toHaveValue("");
  });
  it("CA-06 bloqueo de repetido en progreso incluye enlace y no reintenta automáticamente", async () => {
    http.post.mockRejectedValue(Object.assign(conflict("duplicate_in_progress", "Ya hay un checklist en progreso"), { data: { error: "duplicate_in_progress", message: "Ya hay un checklist en progreso", details: { existing: { id: "existing", ownerName: "Otra persona", createdAt: "2026-11-26T03:00:00Z" } } } }));
    mount(); await selectClient(); fireEvent.change(screen.getByLabelText("Plantilla"), { target: { value: available[1].id } }); fireEvent.click(screen.getByRole("button", { name: "Crear checklist" }));
    expect(await screen.findByRole("link", { name: "Abrir el checklist existente" })).toHaveAttribute("href", "/implementacion/checklists/existing"); expect(http.post).toHaveBeenCalledTimes(1);
  });
  it("CA-07 cancelar repetido completado no crea; confirmar agrega confirmDuplicate sin autor", async () => {
    http.post.mockRejectedValue(Object.assign(conflict("duplicate_completed", "¿Crear otro de todos modos?"), { data: { error: "duplicate_completed", message: "¿Crear otro de todos modos?", details: { existing: { id: "existing", completedAt: "2026-11-26T03:00:00Z" } } } }));
    mount(); await selectClient(); fireEvent.change(screen.getByLabelText("Plantilla"), { target: { value: available[1].id } }); fireEvent.click(screen.getByRole("button", { name: "Crear checklist" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar confirmación" })); expect(http.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Crear checklist" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sí, crear otro" }));
    await waitFor(() => expect(http.post).toHaveBeenLastCalledWith("/implementation/checklists", { clientId, templateId: available[1].id, confirmDuplicate: true }));
  });
  it("CA-05 CA-08 CA-09 creación permitida respeta el ambiente elegido y abre su snapshot", async () => {
    const created = { id: "88888888-8888-4888-8888-888888888888", clientId, clientName: "Cliente ERP", templateId, templateName: "Migración", versionNumber: 2, environment: "production", status: "in_progress", ownerId: "user", ownerName: "Responsable", progress: 0, createdAt: "2026-11-26T03:00:00Z", completedAt: null, canEdit: true, canDelete: true, canReopen: false, rowVersion: "AAAAAAAAAAE=", points: [] };
    http.get.mockImplementation(async path => path.includes("client-search") ? { items: [{ id: clientId, name: "Cliente ERP" }] } : path.endsWith(created.id) ? created : { items: [], availableTemplates: available }); http.post.mockResolvedValue(created);
    mount(); await selectClient(); fireEvent.change(screen.getByLabelText("Plantilla"), { target: { value: templateId } }); fireEvent.change(screen.getByLabelText("Ambiente"), { target: { value: "production" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear checklist" }));
    expect(await screen.findByRole("heading", { name: "Migración · v2.0" })).toBeInTheDocument();
    expect(http.post).toHaveBeenCalledWith("/implementation/checklists", { clientId, templateId, environment: "production" });
  });
});
