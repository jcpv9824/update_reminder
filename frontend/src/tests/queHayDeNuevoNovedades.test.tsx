import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import NovedadesPublicPage from "../pages/queHayDeNuevo/NovedadesPublicPage";
import { estadoCon, instalarPolyfillsEditor, renderConAlmacen } from "./queHayDeNuevoHelpers";

const AHORA = "2026-11-18T15:00:00.000Z";

function renderPagina(publicacionActiva = true) {
  const estado = estadoCon((e) => ({ ...e, configuracion: { ...e.configuracion, publicacionActiva } }));
  return renderConAlmacen(<NovedadesPublicPage ahora={AHORA} />, { ruta: "/novedades", patron: "/novedades", estado });
}

describe("Qué hay de nuevo · página pública /novedades", () => {
  beforeAll(instalarPolyfillsEditor);

  it("muestra solo lo probado y marcado para clientes, sin barra lateral ni datos internos", () => {
    renderPagina();
    expect(screen.getByRole("heading", { level: 1, name: "Novedades de SAG Web" })).toBeInTheDocument();
    const lista = screen.getByRole("list", { name: "Novedades" });
    const titulos = within(lista).getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titulos).toEqual(["Cotiza en segundos con Cotización rápida", "Traslados entre bodegas en un solo paso"]);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    const texto = document.body.textContent ?? "";
    for (const prohibido of ["Comercializadora del Valle", "Camilo Rojas", "Diana Torres", "Andrés Gómez", "tilde faltante", "Intereses de mora", "cierre anual"]) {
      expect(texto).not.toContain(prohibido);
    }
    expect(screen.queryByText(/Marcar todo como leído|Pedir asesoría/)).toBeNull();
  });

  it("filtra por tipo y por fecha de liberación", () => {
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: "Opciones nuevas" }));
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Cotiza en segundos con Cotización rápida"]);
    fireEvent.click(screen.getByRole("button", { name: "Mejoras" }));
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Traslados entre bodegas en un solo paso"]);
    fireEvent.click(screen.getByRole("button", { name: "Todo" }));

    const fecha = screen.getByLabelText("Fecha de liberación");
    fireEvent.change(fecha, { target: { value: "mes_actual" } });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Cotiza en segundos con Cotización rápida"]);
    fireEvent.change(fecha, { target: { value: "rango" } });
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-10-31" } });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Traslados entre bodegas en un solo paso"]);
  });

  it("Ver detalle abre un diálogo con el texto para clientes", () => {
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle de Traslados entre bodegas en un solo paso" }));
    const dialogo = screen.getByRole("dialog", { name: "Traslados entre bodegas en un solo paso" });
    expect(within(dialogo).getByText(/confirmas el traslado en un solo paso/)).toBeInTheDocument();
    expect(within(dialogo).getByRole("img", { name: "Pantalla de traslados entre bodegas" })).toBeInTheDocument();
  });

  it("con la publicación apagada muestra «Sin novedades por ahora»", () => {
    renderPagina(false);
    expect(screen.getByText("Sin novedades por ahora.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Novedades" })).toBeNull();
  });
});
