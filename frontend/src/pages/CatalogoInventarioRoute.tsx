import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Paginacion } from "../components/Comunes";
import { catalogRefreshMessages, catalogRefreshServiceIfEnabled, useCatalogRefresh } from "../hooks/useCatalogRefresh";
import CatalogoInventarioObservado from "./CatalogoInventarioObservado";

const VISTAS = {
  domains: { titulo: "Dominios", columna: "Dominio" },
  databases: { titulo: "Bases de Datos", columna: "Base de datos" },
  licenses: { titulo: "Licenciamiento", columna: "Módulo licenciado" },
} as const;

const AMBIENTES = {
  production: "Producción", test: "Pruebas", demo: "Demostración", unknown: "Ambiente no verificado", multiple: "Varios ambientes",
} as const;

type Vista = keyof typeof VISTAS;
type Modo = "operativo" | "observado";
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
  const modo: Modo | null = import.meta.env.VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED === "true" ? "observado"
    : import.meta.env.VITE_PORTAL_CATALOG_READ_ENABLED === "true" ? "operativo" : null;
  if (modo === null) return legado;
  if (auth.cargando || !auth.usuario) return null;

  const alcance = JSON.stringify([auth.usuario.id, [...auth.usuario.roles].sort()]);
  const clave = JSON.stringify([alcance, vista, modo]);
  if (modo === "observado" && import.meta.env.VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED === "true") {
    return <CatalogoInventarioObservado key={clave} alcance={alcance} vista={vista} titulo={VISTAS[vista].titulo} />;
  }
  return <InventarioCatalogo key={clave} alcance={alcance} vista={vista} modo={modo} />;
}

function InventarioCatalogo({ alcance, vista, modo }: { alcance: string; vista: Vista; modo: Modo }) {
  const [pagina, setPagina] = useState(1);
  const { titulo, columna } = VISTAS[vista];
  const observado = modo === "observado";
  const muestraDominio = observado && vista === "databases";
  const nombreColumna = observado && vista === "licenses" ? "Módulo o código" : columna;
  const detalleColumna = !observado ? "Detalle" : vista === "licenses" ? "Verificación del módulo" : null;
  const queryClient = useQueryClient();
  const consultas = { queryKey: ["catalogo-inventario", alcance, vista, modo] };
  // The independent read-only release never queues an import, even if automation is configured.
  const service = observado ? undefined : catalogRefreshServiceIfEnabled();
  const actualizacion = useCatalogRefresh({
    service,
    scopeKey: alcance,
    onSettled: () => {
      void queryClient.cancelQueries(consultas);
      void queryClient.invalidateQueries(consultas);
    },
    onAccessDenied: () => queryClient.removeQueries(consultas),
  });
  const accesoDenegado = actualizacion.state === "denied";
  const consulta = useQuery({
    queryKey: [...consultas.queryKey, pagina, TAMANO_PAGINA],
    queryFn: ({ signal }) => actualizacion.read(signal, () =>
      api.get<Inventario>(`/catalog/inventory/${vista}?page=${pagina}&pageSize=${TAMANO_PAGINA}`, { signal })),
    enabled: !accesoDenegado,
    retry: false,
    gcTime: 0,
  });
  const consultaPausada = consulta.fetchStatus === "paused";
  const resultado = accesoDenegado || (!service && (consulta.isError || consulta.isFetching || consultaPausada))
    ? undefined : consulta.data;
  const disponible = resultado?.state === "verified" || resultado?.state === "partial" ? resultado : undefined;
  const avisoActualizacion = catalogRefreshMessages[actualizacion.state];

  function actualizarLista() {
    if (service) actualizacion.request();
    else void consulta.refetch();
  }

  return (
    <>
      <div className="encabezado-pagina">
        <h2>{titulo}</h2>
        <button type="button" className="secundario" onClick={actualizarLista}
          disabled={accesoDenegado || (service ? actualizacion.state === "pending" : consulta.isFetching || consultaPausada)}>
          Actualizar lista
        </button>
      </div>
      <p className="texto-ayuda">{observado
        ? "Datos observados en SAG Admin con el nombre oficial del ERP. Consulta de solo lectura."
        : "Catálogo de SAG Web de solo lectura."}</p>
      {avisoActualizacion && (
        <p className={`alerta ${accesoDenegado ? "alerta-error" : "alerta-info"}`} role={accesoDenegado ? "alert" : "status"}>
          {avisoActualizacion}
        </p>
      )}

      {!accesoDenegado && (consulta.isFetching ? (
        <p className="cargando" role="status">Consultando catálogo…</p>
      ) : consulta.isError || consultaPausada ? (
        <div className="alerta alerta-error" role="alert">No se pudo consultar el catálogo.</div>
      ) : resultado && !disponible ? (
        <div className="alerta alerta-info" role="alert">El catálogo no está disponible o todavía no se ha verificado.</div>
      ) : null)}

      {disponible && (
        <>
          {disponible.state === "partial" && (
            <div className="alerta alerta-info" role="status">{observado
              ? "La información del catálogo está incompleta. Puede haber registros que aún no se pueden confirmar."
              : "La información del catálogo está incompleta."}</div>
          )}
          <div className="tabla-contenedor">
            <table aria-label={`${titulo} del catálogo`}>
              <thead><tr>
                <th scope="col">{observado ? "Cliente (ERP)" : "Cliente"}</th>
                {muestraDominio && <th scope="col">Dominio</th>}
                <th scope="col">{nombreColumna}</th>
                <th scope="col">Ambiente</th>
                {detalleColumna && <th scope="col">{detalleColumna}</th>}
              </tr></thead>
              <tbody>
                {disponible.items.length ? disponible.items.map((fila) => (
                  <tr key={fila.id}>
                    <td>{fila.customerName}</td>
                    {muestraDominio && <td>{fila.detail ?? "Dominio no verificado"}</td>}
                    <th scope="row">{fila.name}</th>
                    <td>{AMBIENTES[fila.environment] ?? AMBIENTES.unknown}</td>
                    {detalleColumna && <td>{fila.detail ?? "—"}</td>}
                  </tr>
                )) : (
                  <tr><td colSpan={muestraDominio || detalleColumna ? 4 : 3} className="vacio">
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
