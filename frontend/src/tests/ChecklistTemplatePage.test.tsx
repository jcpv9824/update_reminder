import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { conflict, http, renderChecklist, resetHttp, template, templateId, version } from "./checklistTestHelpers";
import ChecklistTemplatesRoutes from "../pages/checklists/ChecklistTemplatesRoutes";
beforeEach(resetHttp); afterEach(cleanup);
const mount = () => renderChecklist(<ChecklistTemplatesRoutes />, `/configuracion/checklists/${templateId}`);
describe("P05 · Versiones", () => {
  it("CA-22 impide crear si existe edición y explica la regla", async () => {
    http.get.mockResolvedValue(template); mount();
    expect(await screen.findByText("Ya hay una versión en edición. Publíquela o descártela antes de crear otra.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Crear versión/ })).toBeDisabled();
  });
  it("CA-24 CA-25 congelada nunca se edita ni elimina y vigente no se retira con edición superior", async () => {
    http.get.mockResolvedValue({ ...template, versions: [{ ...version, number: 1, status: "frozen" }, { ...version, number: 2, status: "current" }, { ...version, number: 3 }] }); mount();
    await screen.findByRole("heading", { name: "Migración" });
    expect(screen.queryByRole("button", { name: /Retirar versión/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: /Editar puntos/ })).toHaveLength(1);
  });
  it("CA-23 CA-27 publicación pide confirmación y muestra no_points sin fingir éxito", async () => {
    http.get.mockResolvedValue(template); http.post.mockRejectedValue(Object.assign(conflict("no_points", "Agregue al menos un punto antes de publicar."), { status: 422 })); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Publicar versión 2.0" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Los que ya usan la 1.0 siguen en la 1.0.");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Publicar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Agregue al menos un punto antes de publicar.");
  });
  it("CA-26 CA-32 una persona de configuración crea versión ajena sin permiso de Implementación", async () => {
    http.get.mockImplementation(async path => path.includes("/versions/") ? version : { ...template, versions: [{ ...version, number: 1, status: "current" }] }); http.post.mockResolvedValue(version); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Crear versión 2.0" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Nadie la puede usar hasta que la publique.");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Crear versión 2.0" }));
    await screen.findByRole("heading", { name: "Puntos de la versión 2.0" });
    expect(http.post).toHaveBeenCalledWith(`/configuration/checklist-templates/${templateId}/versions`);
  });
  it("CA-23 tras publicar refresca estados de la versión vigente y la anterior", async () => {
    http.get.mockResolvedValue(template);
    http.post.mockImplementation(async () => { http.get.mockResolvedValue({ ...template, currentVersion: 2, versions: [{ ...version, number: 1, status: "frozen" }, { ...version, status: "current" }] }); return { ...version, status: "current" }; });
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Publicar versión 2.0" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Publicar" }));
    expect(await screen.findByText(/Congelada/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Editar puntos" })).toBeNull();
    expect(http.post).toHaveBeenCalledWith(`/configuration/checklist-templates/${templateId}/versions/2/publish`);
  });
  it("CA-25 retirar la primera vigente sin usos deja la plantilla sin vigente", async () => {
    http.get.mockResolvedValue({ ...template, versions: [{ ...version, number: 1, status: "current" }] });
    http.del.mockImplementation(async () => { http.get.mockResolvedValue({ ...template, currentVersion: null, versions: [] }); });
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Retirar versión 1.0" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText("Sin versiones. Cree la versión 1.0 para empezar.")).toBeInTheDocument();
    expect(http.del).toHaveBeenCalledWith(`/configuration/checklist-templates/${templateId}/versions/1`);
  });
  it("CA-26 descartar la edición libera su número para crear de nuevo", async () => {
    http.get.mockResolvedValue(template);
    http.del.mockImplementation(async () => { http.get.mockResolvedValue({ ...template, versions: [{ ...version, number: 1, status: "current" }] }); });
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Descartar versión 2.0" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("button", { name: "Crear versión 2.0" })).toBeEnabled();
    expect(http.del).toHaveBeenCalledWith(`/configuration/checklist-templates/${templateId}/versions/2`);
  });
});
