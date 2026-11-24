import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProveedorQueHayDeNuevo } from "../pages/queHayDeNuevo/almacen";
import { estadoInicial } from "../pages/queHayDeNuevo/datosSimulados";
import type { EstadoAlmacen } from "../pages/queHayDeNuevo/tipos";

/* Utilidades compartidas por las pruebas del prototipo «Qué hay de nuevo». */

// ProseMirror pide medidas de layout que jsdom no implementa.
export function instalarPolyfillsEditor() {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  }
}

export function estadoCon(cambio: (e: EstadoAlmacen) => EstadoAlmacen = (e) => e): EstadoAlmacen {
  return cambio(estadoInicial());
}

export function renderConAlmacen(
  ui: ReactElement,
  { ruta = "/", patron = "*", estado }: { ruta?: string; patron?: string; estado?: EstadoAlmacen } = {},
) {
  return render(
    <ProveedorQueHayDeNuevo inicial={estado ?? estadoInicial()}>
      <MemoryRouter initialEntries={[ruta]}>
        <Routes>
          <Route path={patron} element={ui} />
        </Routes>
      </MemoryRouter>
    </ProveedorQueHayDeNuevo>,
  );
}
