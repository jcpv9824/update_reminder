import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { conflict, http, renderChecklist, resetHttp, template } from "./checklistTestHelpers";
import ChecklistTemplatesRoutes from "../pages/checklists/ChecklistTemplatesRoutes";
beforeEach(resetHttp); afterEach(cleanup);
describe("P04 · Plantillas", () => {
  it("CA-30 CA-31 oculta eliminar según capacidad del servidor, sin limitar creación al autor", async () => {
    http.get.mockResolvedValue({ items: [template, { ...template, id: "used", name: "En uso", uses: 3, canDelete: false }] });
    renderChecklist(<ChecklistTemplatesRoutes />);
    expect(await screen.findByText("Migración")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Eliminar plantilla/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Nueva plantilla" })).toBeEnabled();
  });
  it("CA-33 valida nombre y muestra el mensaje español de name_taken sin cerrar el diálogo", async () => {
    http.get.mockResolvedValue({ items: [] }); http.post.mockRejectedValue(conflict("name_taken", "Ya existe una plantilla con ese nombre."));
    renderChecklist(<ChecklistTemplatesRoutes />);
    fireEvent.click(await screen.findByRole("button", { name: "Nueva plantilla" }));
    fireEvent.click(screen.getByRole("button", { name: "Crear plantilla" }));
    expect(http.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: " Migración " } });
    fireEvent.click(screen.getByRole("button", { name: "Crear plantilla" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ya existe una plantilla con ese nombre.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(http.post).toHaveBeenCalledWith("/configuration/checklist-templates", { name: "Migración" });
  });
  it("CA-33 búsqueda local sin nuevo parámetro API y nombre máximo 150", async () => {
    http.get.mockResolvedValue({ items: [template] }); renderChecklist(<ChecklistTemplatesRoutes />);
    await screen.findByText("Migración"); fireEvent.change(screen.getByLabelText("Buscar plantilla"), { target: { value: "otra" } });
    expect(screen.queryByText("Migración")).toBeNull();
    await waitFor(() => expect(http.get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Nueva plantilla" }));
    expect(screen.getByLabelText("Nombre")).toHaveAttribute("maxlength", "150");
  });
});
