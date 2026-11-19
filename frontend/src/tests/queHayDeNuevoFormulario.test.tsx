import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { FormularioEntrada } from "../pages/queHayDeNuevo/FormularioEntrada";
import { instalarPolyfillsEditor, renderConAlmacen } from "./queHayDeNuevoHelpers";

const RUTA = "/actualizaciones/que-hay-de-nuevo/nueva";

function renderFormulario() {
  return renderConAlmacen(<FormularioEntrada modo="nueva" />, { ruta: RUTA, patron: RUTA });
}

describe("Qué hay de nuevo · formulario de nueva entrada", () => {
  beforeAll(instalarPolyfillsEditor);

  it("el constructor de rutas va de 3 a 5 niveles, todos escritos a mano salvo la vía", () => {
    renderFormulario();
    const ruta = screen.getByRole("group", { name: "Ruta principal" });
    expect(within(ruta).getByLabelText("Vía")).toHaveDisplayValue("Barra de navegación");
    expect(within(ruta).getByRole("option", { name: "Barra lateral" })).toBeInTheDocument();
    expect(within(ruta).queryByRole("option", { name: /Otro/ })).toBeNull();
    expect(within(ruta).getByLabelText("Submenú").tagName).toBe("INPUT");
    expect(within(ruta).getByLabelText("Opción").tagName).toBe("INPUT");

    const agregar = screen.getByRole("button", { name: "Agregar submenú a Ruta principal" });
    const quitar = screen.getByRole("button", { name: "Quitar último submenú de Ruta principal" });
    expect(quitar).toBeDisabled();

    fireEvent.change(within(ruta).getByLabelText("Opción"), { target: { value: "Factura de venta" } });
    fireEvent.click(agregar);
    fireEvent.click(agregar);
    expect(agregar).toBeDisabled();
    expect(within(ruta).getByLabelText("Submenú 3")).toBeInTheDocument();
    expect(within(ruta).getByLabelText("Opción")).toHaveValue("Factura de venta");
    expect(screen.getByText("5 de 5 niveles · mínimo 3")).toBeInTheDocument();

    fireEvent.click(quitar);
    fireEvent.click(quitar);
    expect(quitar).toBeDisabled();
    expect(within(ruta).getByLabelText("Opción")).toHaveValue("Factura de venta");
  });

  it("muestra «Solo desarrollos nuevos» únicamente para el tipo Nuevo", () => {
    renderFormulario();
    expect(screen.queryByRole("heading", { name: "Solo desarrollos nuevos" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Nuevo" }));
    expect(screen.getByRole("heading", { name: "Solo desarrollos nuevos" })).toBeInTheDocument();
    expect(screen.getByLabelText(/6\. Cliente/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /8\. Documento de reglas de negocio/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Regla de negocio" }));
    expect(screen.queryByRole("heading", { name: "Solo desarrollos nuevos" })).toBeNull();
  });

  it("el desarrollador es siempre el autor y no se puede elegir", () => {
    renderFormulario();
    expect(screen.getByText("Desarrollador")).toBeInTheDocument();
    expect(screen.getByText("Laura Méndez")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Desarrollador/ })).toBeNull();
  });

  it("Publicar a Soporte valida todo y lista lo que falta", () => {
    renderFormulario();
    fireEvent.click(screen.getByRole("button", { name: "Publicar a Soporte" }));
    const resumen = screen.getByRole("alert", { name: /Para publicar falta/ });
    expect(within(resumen).getByText("Elige el tipo de entrada.")).toBeInTheDocument();
    expect(within(resumen).getByText("Completa todos los niveles de cada ruta.")).toBeInTheDocument();
    expect(within(resumen).getByText("Describe qué cambió.")).toBeInTheDocument();
    expect(within(resumen).getByText("Marca al menos una acción requerida.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Nuevo" }));
    expect(within(resumen).getByText(/Escribe el cliente/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Dar permiso a la opción" }));
    expect(within(resumen).getByText("Escribe el detalle de «Dar permiso a la opción».")).toBeInTheDocument();
    expect(within(resumen).queryByText("Marca al menos una acción requerida.")).toBeNull();
  });

  it("Guardar borrador no exige campos y muestra el aviso de guardado", () => {
    renderFormulario();
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    expect(screen.queryByRole("alert", { name: /falta/ })).toBeNull();
    expect(screen.getByText("Guardado hace un momento")).toBeInTheDocument();
  });

  it("la barra del editor tiene nombres accesibles y una sola parada de tabulación", () => {
    renderFormulario();
    const barra = screen.getByRole("toolbar", { name: "Formato de Qué cambió" });
    const negrita = within(barra).getByRole("button", { name: "Negrita" });
    expect(negrita).toHaveAttribute("aria-pressed", "false");
    expect(within(barra).getByRole("button", { name: "Insertar imagen" })).toBeInTheDocument();
    expect(within(barra).getByRole("button", { name: "Mencionar a un usuario" })).toBeInTheDocument();
    expect(within(barra).getByRole("combobox", { name: "Estilo de párrafo" })).toHaveAttribute("tabindex", "0");
    expect(negrita).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("textbox", { name: /Qué cambió/ })).toBeInTheDocument();
  });
});
