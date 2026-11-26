import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { conflict, http, points, renderChecklist, resetHttp, templateId, version } from "./checklistTestHelpers";
import ChecklistTemplatesRoutes from "../pages/checklists/ChecklistTemplatesRoutes";
import { focusManager } from "@tanstack/react-query";
beforeEach(resetHttp); afterEach(() => { cleanup(); focusManager.setFocused(undefined); vi.useRealTimers(); vi.restoreAllMocks(); });
const mount = () => renderChecklist(<ChecklistTemplatesRoutes />, `/configuracion/checklists/${templateId}/versiones/2`);
describe("P06 · Puntos", () => {
  it("CA-28 CA-29 guarda orden y NULL explícitamente, nunca autoguarda al editar", async () => {
    http.get.mockResolvedValue(version); http.put.mockResolvedValue({ ...version, rowVersion: "AAAAAAAAAAI=" }); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Bajar Primer punto" }));
    fireEvent.change(screen.getByLabelText("Detalle del punto 2"), { target: { value: "   " } });
    expect(http.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(http.put).toHaveBeenCalledWith(`/configuration/checklist-templates/${templateId}/versions/2`, { requiresEnvironment: true, points: [{ id: points[1].id, title: "Segundo punto", detail: "Detalle" }, { id: points[0].id, title: "Primer punto", detail: null }], rowVersion: version.rowVersion }));
  });
  it("CA-24 vigente y congelada son solo lectura sin controles de edición", async () => {
    http.get.mockResolvedValue({ ...version, status: "frozen" }); mount();
    expect(await screen.findByText("Primer punto")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agregar punto" })).toBeNull();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
  it("CA-37 conserva el borrador local y rowVersion original tras stale", async () => {
    http.get.mockResolvedValue(version); http.put.mockRejectedValue(conflict("stale", "Alguien cambió esta versión mientras usted la editaba. Copie lo que necesite y recargue.")); mount();
    fireEvent.change(await screen.findByLabelText("Título del punto 1"), { target: { value: "Mi edición" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Copie lo que necesite y recargue.");
    expect(screen.getByLabelText("Título del punto 1")).toHaveValue("Mi edición");
    expect(http.put.mock.calls[0][1].rowVersion).toBe(version.rowVersion);
  });
  it("CA-37 publicación remota en segundo plano conserva el trabajo y el aviso de salida hasta recargar explícitamente", async () => {
    http.get.mockResolvedValue(version); const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); mount();
    fireEvent.change(await screen.findByLabelText("Título del punto 1"), { target: { value: "Mi trabajo local" } });
    http.get.mockResolvedValue({ ...version, status: "current", rowVersion: "AAAAAAAAAAI=" });
    focusManager.setFocused(false); focusManager.setFocused(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("Alguien cambió esta versión mientras usted la editaba. Copie lo que necesite y recargue.");
    expect(screen.getByLabelText("Título del punto 1")).toHaveValue("Mi trabajo local");
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Recargar versión" })); expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText("Título del punto 1")).toHaveValue("Mi trabajo local");
  });
  it("CA-28 CA-29 valida título y límites del formulario de puntos", async () => {
    http.get.mockResolvedValue(version); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Agregar punto" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Escriba el título del punto");
    expect(screen.getByLabelText("Título del punto")).toHaveAttribute("maxlength", "200");
    expect(screen.getByLabelText("Detalle (opcional)")).toHaveAttribute("maxlength", "1000");
    expect(screen.getByRole("link", { name: "Volver" })).toHaveAttribute("href", `/configuracion/checklists/${templateId}`);
  });
  it("CA-28 arrastrar y subir/bajar usan identidad estable y conservan foco y campos", async () => {
    http.get.mockResolvedValue(version); mount();
    const first = await screen.findByLabelText("Título del punto 1"); const second = screen.getByLabelText("Título del punto 2");
    fireEvent.dragStart(first.closest("li")!, { dataTransfer: { setData: vi.fn() } }); fireEvent.drop(second.closest("li")!);
    expect(screen.getByLabelText("Título del punto 1")).toHaveValue("Segundo punto");
    first.focus(); fireEvent.click(screen.getByRole("button", { name: "Subir Primer punto" }));
    expect(document.activeElement).toBe(first);
    expect(screen.getByLabelText("Título del punto 1")).toBe(first);
    expect(screen.getByRole("button", { name: "Subir Primer punto" })).toBeDisabled();
  });
  it("CA-28 no autoguarda ni al salir de un campo ni al transcurrir un minuto", async () => {
    http.get.mockResolvedValue(version); mount();
    const input = await screen.findByLabelText("Título del punto 1"); vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "Modificado" } }); fireEvent.blur(input); vi.advanceTimersByTime(60000);
    expect(http.put).not.toHaveBeenCalled();
  });
  it("CA-24 CA-29 una vigente muestra detalle solo donde existe y no ofrece reordenar", async () => {
    http.get.mockResolvedValue({ ...version, status: "current" }); const result = mount();
    await screen.findByText("Primer punto");
    expect(result.container.querySelectorAll(".checklists-point-detail")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Subir|Bajar|Quitar/ })).toBeNull();
  });
  it("CA-28 máximo 100 puntos deshabilita agregar sin descartar los existentes", async () => {
    http.get.mockResolvedValue({ ...version, points: Array.from({ length: 100 }, (_,i) => ({ ...points[0], id: `point-${i}`, position: i + 1, title: `Punto ${i + 1}` })) }); const view = mount();
    const adding = await screen.findByRole("group", { name: "Agregar punto" });
    expect(within(adding).getByRole("button", { name: "Agregar punto" })).toBeDisabled();
    expect(view.container.querySelectorAll(".checklists-points > li")).toHaveLength(100);
  });
});
