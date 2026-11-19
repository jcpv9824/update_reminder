import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import QueHayDeNuevoPage from "../pages/queHayDeNuevo/QueHayDeNuevoPage";
import { docDeTexto } from "../pages/queHayDeNuevo/logica";
import type { EstadoAlmacen } from "../pages/queHayDeNuevo/tipos";
import { estadoCon, instalarPolyfillsEditor, renderConAlmacen } from "./queHayDeNuevoHelpers";

const BASE = "/actualizaciones/que-hay-de-nuevo";

function renderBandeja(cambio?: (e: EstadoAlmacen) => EstadoAlmacen, usuarioId = "u-laura") {
  const estado = estadoCon((e) => ({ ...(cambio ? cambio(e) : e), vision: "asesor", usuarioActualId: usuarioId }));
  return renderConAlmacen(<QueHayDeNuevoPage />, { ruta: BASE, patron: `${BASE}/*`, estado });
}

const pestana = (nombre: RegExp) => screen.getByRole("tab", { name: nombre });
const elegir = (texto: RegExp) => fireEvent.click(screen.getByRole("button", { name: texto }));

describe("Qué hay de nuevo · bandeja del asesor", () => {
  beforeAll(instalarPolyfillsEditor);

  it("tiene solo las pestañas Sin probar, En pruebas y Probadas, y la ayuda de tres pasos", () => {
    renderBandeja();
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+/g, "").trim())).toEqual(["Sin probar", "En pruebas", "Probadas"]);
    expect(pestana(/Sin probar/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Tómala para probar.")).toBeInTheDocument();
  });

  it("no deja tomar una entrada propia", () => {
    renderBandeja();
    elegir(/Cierre mensual/);
    expect(screen.getByRole("button", { name: "Tomar para probar" })).toBeDisabled();
    expect(screen.getAllByText("No puedes probar una entrada que creaste.").length).toBeGreaterThan(0);
  });

  it("tomar, marcar checklist y soltar reinicia la prueba", () => {
    renderBandeja();
    elegir(/Factura de venta/);
    fireEvent.click(screen.getByRole("button", { name: "Tomar para probar" }));
    expect(pestana(/En pruebas/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Marcar probado" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Marcar fallida" })).toBeDisabled();
    expect(screen.getByText(/registra al menos un hallazgo/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Dar permiso a la opción" }));
    expect(screen.getByRole("checkbox", { name: "Dar permiso a la opción" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Soltar" }));
    const dialogo = screen.getByRole("dialog", { name: "Soltar la entrada" });
    fireEvent.click(within(dialogo).getByRole("button", { name: "Soltar" }));
    expect(pestana(/Sin probar/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/la prueba empezará de nuevo/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tomar para probar" }));
    expect(screen.getByRole("checkbox", { name: "Dar permiso a la opción" })).not.toBeChecked();
    expect(screen.getByText("Asesores que han probado")).toBeInTheDocument();
  });

  it("con un hallazgo de la ronda actual permite marcar fallida y la entrada queda en Probadas", () => {
    renderBandeja((e) => ({
      ...e,
      entradas: e.entradas.map((x) => (x.id === "e-105"
        ? { ...x, hallazgos: [{ numero: 1, ronda: 1, fecha: "2026-11-17T15:00:00.000Z", autorId: "u-laura", texto: docDeTexto("Totales distintos"), anulacion: null }] }
        : x)),
    }));
    fireEvent.click(pestana(/En pruebas/));
    elegir(/Liquidación de nómina/);
    fireEvent.click(screen.getByRole("button", { name: "Marcar fallida" }));
    expect(pestana(/Probadas/)).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "fallidas" } });
    const lista = screen.getByRole("list", { name: /Entradas probadas/ });
    expect(within(lista).getByText(/Liquidación de nómina/)).toBeInTheDocument();
    expect(within(lista).getByText("Barra lateral › Inventarios › Consultas › Kardex")).toBeInTheDocument();
    expect(within(lista).queryByText(/Traslados entre bodegas/)).toBeNull();
  });

  it("SP crítico nunca se puede mostrar a clientes", () => {
    renderBandeja();
    fireEvent.click(pestana(/En pruebas/));
    elegir(/Liquidación de nómina/);
    expect(screen.getByRole("switch", { name: "Mostrar esta novedad a los clientes" })).toBeDisabled();
    expect(screen.getByText(/nunca se muestran a los clientes/)).toBeInTheDocument();
  });

  it("una entrada Nuevo con cliente sí se puede mostrar, a todos los clientes", () => {
    renderBandeja(undefined, "u-felipe");
    fireEvent.click(pestana(/En pruebas/));
    elegir(/Aprobación de órdenes/);
    const interruptor = screen.getByRole("switch", { name: "Mostrar esta novedad a los clientes" });
    expect(interruptor).toBeEnabled();
    fireEvent.click(interruptor);
    expect(screen.getByLabelText("Título para clientes")).toBeInTheDocument();
    expect(screen.queryByText(/Disponible para todos los clientes/)).toBeNull();
    expect(screen.getByText(/Se muestra a todos los clientes/)).toBeInTheDocument();
  });

  it("el reporte solo existe en Probadas y se envía a varios usuarios con el enlace al reporte completo", () => {
    renderBandeja();
    expect(screen.queryByRole("button", { name: /Enviar reporte/ })).toBeNull();
    fireEvent.click(pestana(/En pruebas/));
    elegir(/Liquidación de nómina/);
    expect(screen.queryByRole("button", { name: /Reporte/ })).toBeNull();

    fireEvent.click(pestana(/Probadas/));
    fireEvent.click(screen.getByRole("button", { name: /Enviar reporte/ }));
    const dialogo = screen.getByRole("dialog", { name: "Enviar reporte de pruebas" });
    expect(within(dialogo).getByRole("radio", { name: /Todas/ })).toBeChecked();
    expect(within(dialogo).getByRole("radio", { name: /Solo aprobadas/ })).toBeInTheDocument();
    fireEvent.click(within(dialogo).getByRole("radio", { name: /Solo fallidas \(1\)/ }));
    expect(within(dialogo).queryByText(/Solo hallazgos|Completo/)).toBeNull();

    const enviar = within(dialogo).getByRole("button", { name: /Enviar a 0 personas/ });
    expect(enviar).toBeDisabled();
    fireEvent.change(within(dialogo).getByLabelText("Buscar usuario por nombre o correo"), { target: { value: "diana" } });
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Diana Torres/ }));
    fireEvent.change(within(dialogo).getByLabelText("Buscar usuario por nombre o correo"), { target: { value: "" } });
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Martha Ruiz/ }));
    expect(within(dialogo).queryByText(/no tiene acceso/)).toBeNull();
    fireEvent.click(within(dialogo).getByRole("button", { name: /Enviar a 2 personas/ }));

    const enviado = screen.getByRole("dialog", { name: "Reporte enviado" });
    expect(within(enviado).getByText(/Correo enviado/)).toBeInTheDocument();
    expect(within(enviado).getByText(/Diana Torres <diana.torres@empresa.com>, Martha Ruiz/)).toBeInTheDocument();
    expect(within(enviado).getByText(/Para ver el reporte completo, abra el enlace/)).toBeInTheDocument();
    expect(within(enviado).getByRole("link", { name: "Ver reporte completo" }).getAttribute("href")).toMatch(/^\/actualizaciones\/que-hay-de-nuevo\/reportes\//);
  });
});
