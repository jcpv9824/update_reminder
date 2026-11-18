import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Paginacion } from "../components/Comunes";

const VISTAS = {
  domains: { titulo: "Dominios", columna: "Dominio" },
  databases: { titulo: "Bases de Datos", columna: "Base de datos" },
  licenses: { titulo: "Licenciamiento", columna: "Módulo licenciado" },
} as const;

const AMBIENTES = {
  production: "Producción", test: "Pruebas", demo: "Demostración", unknown: "Ambiente no verificado",
} as const;

type Vista = keyof typeof VISTAS;
type Inventario = {
  items: { id: string; customerName: string; name: string; environment: keyof typeof AMBIENTES; detail?: string }[];
  state: "verified" | "partial" | "unavailable";
  page: number;
  pageSize: number;
  total: number;
};

const TAMANO_PAGINA = 25;

/** Used only inside the existing per-option permission guard. */
export default function CatalogoInventarioRoute({ vista, legado }: { vista: Vista; legado: ReactElement }) {
  const auth = useAuth();
  if (import.meta.env.VITE_PORTAL_CATALOG_READ_ENABLED !== "true") return legado;
  if (auth.cargando || !auth.usuario) return null;

  const alcance = JSON.stringify([auth.usuario.id, [...auth.usuario.roles].sort()]);
  return <InventarioCatalogo key={JSON.stringify([alcance, vista])} alcance={alcance} vista={vista} />;
}

function InventarioCatalogo({ alcance, vista }: { alcance: string; vista: Vista }) {
  const [pagina, setPagina] = useState(1);
  const { titulo, columna } = VISTAS[vista];
  const consulta = useQuery({
    queryKey: ["catalogo-inventario", alcance, vista, pagina, TAMANO_PAGINA],
    queryFn: ({ signal }) => api.get<Inventario>(`/catalog/inventory/${vista}?page=${pagina}&pageSize=${TAMANO_PAGINA}`, { signal }),
    retry: false,
    gcTime: 0,
  });
  // Refreshes recheck authorization and source coverage; never leave previous data on screen while waiting or after an error.
  const consultaPausada = consulta.fetchStatus === "paused";
  const resultado = consulta.isError || consulta.isFetching || consultaPausada ? undefined : consulta.data;
  const disponible = resultado?.state === "verified" || resultado?.state === "partial" ? resultado : undefined;

  return (
    <>
      <div className="encabezado-pagina">
        <h2>{titulo}</h2>
        <button type="button" className="secundario" disabled={consulta.isFetching || consultaPausada} onClick={() => void consulta.refetch()}>
          Actualizar lista
        </button>
      </div>
      <p className="texto-ayuda">Catálogo de SAG Web de solo lectura.</p>

      {consulta.isFetching ? (
        <p className="cargando" role="status">Consultando catálogo…</p>
      ) : consulta.isError || consultaPausada ? (
        <div className="alerta alerta-error" role="alert">No se pudo consultar el catálogo.</div>
      ) : resultado && !disponible ? (
        <div className="alerta alerta-info" role="alert">El catálogo no está disponible o todavía no se ha verificado.</div>
      ) : null}

      {disponible && (
        <>
          {disponible.state === "partial" && (
            <div className="alerta alerta-info" role="status">La información del catálogo está incompleta.</div>
          )}
          <div className="tabla-contenedor">
            <table aria-label={`${titulo} del catálogo`}>
              <thead><tr>
                <th scope="col">Cliente</th>
                <th scope="col">{columna}</th>
                <th scope="col">Ambiente</th>
                <th scope="col">Detalle</th>
              </tr></thead>
              <tbody>
                {disponible.items.length ? disponible.items.map((fila) => (
                  <tr key={fila.id}>
                    <td>{fila.customerName}</td>
                    <th scope="row">{fila.name}</th>
                    <td>{AMBIENTES[fila.environment] ?? AMBIENTES.unknown}</td>
                    <td>{fila.detail ?? "—"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={4} className="vacio">
                    {disponible.state === "partial" || pagina > 1
                      ? "No hay registros confirmados en esta página."
                      : "No hay registros para mostrar."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {pagina > 1 && disponible.items.length === 0 ? (
            <button type="button" className="secundario" onClick={() => setPagina(1)}>Volver a la primera página</button>
          ) : (
            <Paginacion page={disponible.page} pageSize={disponible.pageSize} total={disponible.total} onPageChange={setPagina} />
          )}
        </>
      )}
    </>
  );
}
