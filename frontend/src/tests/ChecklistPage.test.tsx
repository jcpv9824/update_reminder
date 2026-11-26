import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { conflict, http, points, renderChecklist, resetHttp, templateId } from "./checklistTestHelpers";
import ImplementationChecklistsRoutes from "../pages/checklists/ImplementationChecklistsRoutes";
import { checklistsApi } from "../pages/checklists/api";
const id = "55555555-5555-4555-8555-555555555555";
const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Texto conservado" }] }] };
const saved = { id, clientId: "66666666-6666-4666-8666-666666666666", clientName: "Cliente ERP", templateId, templateName: "Migración anterior", versionNumber: 1, environment: "testing", status: "in_progress", ownerId: "user", ownerName: "Responsable", progress: 50, createdAt: "2026-11-26T03:00:00Z", completedAt: null, canEdit: true, canDelete: true, canReopen: false, rowVersion: "AAAAAAAAAAE=", points: points.map((p,i) => ({ ...p, checked: i === 0, notes: i === 0 ? doc : null, evidence: [] })) };
const mount = () => renderChecklist(<ImplementationChecklistsRoutes />, `/implementacion/checklists/${id}`, "/implementacion/checklists/*");
beforeEach(() => { resetHttp(); http.get.mockResolvedValue(saved); }); afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("P03 · Trabajar o consultar", () => {
  it("CA-15 frontera de notas conserva fileId y elimina src de presentación al guardar y finalizar", async () => {
    http.put.mockResolvedValue(saved); http.post.mockResolvedValue(saved);
    const note = { type: "doc", content: [{ type: "image", attrs: { fileId: points[0].id, src: "blob:private-view-only", width: 240 } }] };
    const body = { points: [{ pointId: points[0].id, checked: true, notes: note }], evidence: { add: [], remove: [] }, rowVersion: saved.rowVersion };
    await checklistsApi.save(id, body); await checklistsApi.complete(id, body);
    expect(JSON.stringify(http.put.mock.calls[0][1])).not.toContain("blob:"); expect(JSON.stringify(http.post.mock.calls[0][1])).not.toContain("blob:");
    expect(http.put.mock.calls[0][1].points[0].notes.content[0].attrs).toEqual({ fileId: points[0].id, width: 240 });
    expect(note.content[0].attrs.src).toBe("blob:private-view-only");
  });
  it("CA-15 desmarcar oculta el editor y remarcar conserva notas; guardar desmarcado mantiene JSON", async () => {
    http.put.mockResolvedValue({ ...saved, rowVersion: "AAAAAAAAAAI=" }); mount();
    const checkbox = await screen.findByRole("checkbox", { name: "Primer punto" });
    expect(screen.getByRole("textbox", { name: "Notas de Primer punto" })).toHaveTextContent("Texto conservado");
    fireEvent.click(checkbox); expect(screen.queryByRole("textbox", { name: "Notas de Primer punto" })).toBeNull();
    fireEvent.click(checkbox); expect(screen.getByRole("textbox", { name: "Notas de Primer punto" })).toHaveTextContent("Texto conservado");
    fireEvent.click(checkbox); fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(http.put.mock.calls[0][1].points[0]).toEqual({ pointId: points[0].id, checked: false, notes: doc }));
  });
  it("CA-12 no autoguarda y pide confirmación al salir y recargar", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Segundo punto" }));
    vi.useFakeTimers(); vi.advanceTimersByTime(60000); expect(http.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Volver" })); expect(confirm).toHaveBeenCalledWith("Tiene cambios sin guardar. ¿Salir sin guardar?");
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByRole("button", { name: "Evidencia" })).toHaveLength(2);
  });
  it("CA-13 finalizar incompleto destaca puntos y no manda un guardado parcial", async () => {
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Finalizar checklist" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Faltan 1 puntos por marcar");
    expect(screen.getByRole("checkbox", { name: "Segundo punto" })).toHaveAttribute("aria-invalid", "true"); expect(http.post).not.toHaveBeenCalled(); expect(http.put).not.toHaveBeenCalled();
  });
  it("CA-14 finalizar todo marcado envía todos los puntos y rowVersion sin dueño en cuerpo", async () => {
    http.post.mockResolvedValue({ ...saved, status: "completed", canEdit: false, canReopen: true, completedAt: "2026-11-27T03:00:00Z" }); mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Segundo punto" })); fireEvent.click(screen.getByRole("button", { name: "Finalizar checklist" }));
    expect(await screen.findByText("Checklist completado")).toBeInTheDocument();
    expect(http.post).toHaveBeenCalledWith(`/implementation/checklists/${id}/complete`, { points: [{ pointId: points[0].id, checked: true, notes: doc }, { pointId: points[1].id, checked: true, notes: null }], evidence: { add: [], remove: [] }, rowVersion: saved.rowVersion });
  });
  it("CA-10 CA-21 CA-29 consulta ajena conserva versión antigua sin controles ni detalle vacío", async () => {
    http.get.mockResolvedValue({ ...saved, canEdit: false, canDelete: false }); const view = mount();
    expect(await screen.findByRole("heading", { name: "Migración anterior · v1.0" })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: "Guardar borrador" })).toBeNull(); expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(view.container.querySelectorAll(".checklists-point-detail")).toHaveLength(1);
    expect(http.get).toHaveBeenCalledTimes(1);
  });
  it("CA-34 conflicto stale conserva marcas y notas locales sin adoptar otra versión", async () => {
    http.put.mockRejectedValue(conflict("stale", "Alguien guardó este checklist mientras usted lo editaba. Copie lo que necesite y recargue.")); mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Segundo punto" })); fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Copie lo que necesite y recargue."); expect(screen.getByRole("checkbox", { name: "Segundo punto" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Notas de Primer punto" })).toHaveTextContent("Texto conservado");
  });
  it("CA-35 reabrir con duplicado muestra enlace y conserva el completado", async () => {
    http.get.mockResolvedValue({ ...saved, status: "completed", canEdit: false, canReopen: true });
    http.post.mockRejectedValue(Object.assign(conflict("duplicate_in_progress", "Ya hay un checklist en progreso."), { data: { error: "duplicate_in_progress", message: "Ya hay un checklist en progreso.", details: { existing: { id: "other" } } } })); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reabrir" }));
    expect(await screen.findByRole("link", { name: "Abrir el checklist existente" })).toHaveAttribute("href", "/implementacion/checklists/other"); expect(screen.getByText("Completado")).toBeInTheDocument();
  });
  it("CA-12 CA-17 evidencia pendiente solo se promueve con Guardar borrador", async () => {
    const evidenceId = "88888888-8888-4888-8888-888888888888";
    http.post.mockResolvedValue({ id: evidenceId, pointId: points[0].id, kind: "link", status: "pending", url: "https://example.test/" }); http.put.mockResolvedValue(saved); mount();
    fireEvent.click((await screen.findAllByRole("button", { name: "Evidencia" }))[0]); fireEvent.click(screen.getByRole("menuitem", { name: "Enlace" }));
    fireEvent.change(screen.getByLabelText("URL del enlace"), { target: { value: "https://example.test/" } }); fireEvent.click(screen.getByRole("button", { name: "Agregar evidencia" }));
    await screen.findByText("Pendiente de guardar"); expect(http.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(http.put.mock.calls[0][1].evidence).toEqual({ add: [evidenceId], remove: [] }));
  });
  it("CA-12 CA-17 quitar evidencia guardada es local hasta guardar y no llama DELETE", async () => {
    const evidenceId = "88888888-8888-4888-8888-888888888888";
    http.get.mockResolvedValue({ ...saved, points: [{ ...saved.points[0], evidence: [{ id: evidenceId, pointId: points[0].id, kind: "link", status: "saved", url: "https://example.test/" }] }, saved.points[1]] }); http.put.mockResolvedValue(saved); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Quitar https://example.test/" })); expect(http.put).not.toHaveBeenCalled(); expect(http.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(http.put.mock.calls[0][1].evidence).toEqual({ add: [], remove: [evidenceId] }));
  });
});
