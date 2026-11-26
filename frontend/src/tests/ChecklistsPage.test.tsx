import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { http, renderChecklist, resetHttp, templateId } from "./checklistTestHelpers";
import ImplementationChecklistsRoutes from "../pages/checklists/ImplementationChecklistsRoutes";
export const checklist = { id: "55555555-5555-4555-8555-555555555555", clientId: "66666666-6666-4666-8666-666666666666", clientName: "Cliente ERP", templateId, templateName: "Migración", versionNumber: 1, environment: "testing", status: "in_progress", ownerId: "user", ownerName: "Responsable", progress: 50, createdAt: "2026-11-26T03:00:00Z", completedAt: null, canEdit: true, canDelete: true };
beforeEach(() => { resetHttp(); localStorage.clear(); }); afterEach(cleanup);
describe("P01 · Checklists", () => {
  it("CA-10 CA-36 lista fechas Bogotá, capacidad por fila y contadores; filtros se envían al servidor", async () => {
    http.get.mockResolvedValue({ items: [checklist, { ...checklist, id: "other", ownerName: "Otra persona", canEdit: false, canDelete: false, status: "completed", completedAt: "2026-11-27T03:00:00Z" }], counts: { all: 2, inProgress: 1, completed: 1 }, total: 2, page: 1, pageSize: 20 });
    renderChecklist(<ImplementationChecklistsRoutes />, "/implementacion/checklists", "/implementacion/checklists/*");
    expect(await screen.findByRole("tab", { name: "Todos (2)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("25/11/2026")).toHaveLength(2); expect(screen.getByText("26/11/2026")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Editar/ })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Nuevo checklist/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Completados (1)" }));
    await waitFor(() => expect(http.get.mock.calls.some(([p]) => p.includes("status=completed"))).toBe(true));
  });
  it("CA-38 muestra Nuevo solo cuando API ofrece plantillas vigentes para crear", async () => {
    http.get.mockResolvedValue({ items: [], counts: { all: 0, inProgress: 0, completed: 0 }, total: 0, page: 1, pageSize: 20, availableTemplates: [] });
    renderChecklist(<ImplementationChecklistsRoutes />, "/implementacion/checklists", "/implementacion/checklists/*");
    expect(await screen.findByRole("link", { name: "Nuevo checklist" })).toHaveAttribute("href", "/implementacion/checklists/nuevo");
  });
});
