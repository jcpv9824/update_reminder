import { lazy, Suspense, type ReactNode } from "react";

/*
 * Punto de entrada del prototipo para App.tsx. Las páginas se cargan bajo demanda,
 * así el editor (TipTap) no entra al paquete principal. App.tsx solo las usa con la bandera encendida.
 */

const Proveedor = lazy(() => import("./almacen").then((m) => ({ default: m.ProveedorQueHayDeNuevo })));
const QueHayDeNuevoPagina = lazy(() => import("./QueHayDeNuevoPage"));
const ConfiguracionPagina = lazy(() => import("./ConfiguracionQueHayDeNuevoPage"));
const NovedadesPagina = lazy(() => import("./NovedadesPublicPage"));

function Carga({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="cargando" role="status">Cargando...</div>}>{children}</Suspense>;
}

/** Almacén simulado compartido por las visiones y /novedades. También se carga bajo demanda: los datos simulados no van al paquete principal. */
export function ProveedorQueHayDeNuevo({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="cargando">Cargando aplicación...</div>}><Proveedor>{children}</Proveedor></Suspense>;
}

export function QueHayDeNuevoRuta() {
  return <Carga><QueHayDeNuevoPagina /></Carga>;
}

export function ConfiguracionQueHayDeNuevoRuta() {
  return <Carga><ConfiguracionPagina /></Carga>;
}

export function NovedadesRuta() {
  return <Carga><NovedadesPagina /></Carga>;
}
