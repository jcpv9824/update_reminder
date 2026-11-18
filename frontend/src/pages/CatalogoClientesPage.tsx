import { useEffect, useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Paginacion } from "../components/Comunes";
import CatalogoClienteIndicadores, { type CargadoresIndicadores } from "../components/CatalogoClienteIndicadores";

type Estado = "active" | "inactive" | "unverified";
type Presencia = "in_web" | "not_in_web" | "unverified";
type EstadoFuente = "verified" | "stale" | "unavailable";

export type CatalogoClientesQuery = Readonly<{
  sourceIds?: readonly string[];
  state: Estado | "all";
  web: Presencia | "all";
  search?: string;
  page: number;
  pageSize: number;
}>;

export type FuenteCatalogoCliente = Readonly<{
  sourceId: string;
  label: string;
  revisionState: EstadoFuente;
  verifiedAt: string | null;
}>;

export type ResumenCatalogoCliente = Readonly<{
  id: string;
  name: string;
  state: Estado;
  web: Presencia;
  sources: readonly (FuenteCatalogoCliente & { readonly state: Estado })[];
  stateVaries: boolean;
  requiresReconciliation: boolean;
}>;

export type CatalogoClientesResponse = Readonly<{
  items: readonly ResumenCatalogoCliente[];
  sources: readonly FuenteCatalogoCliente[];
  sag: Readonly<{ state: EstadoFuente; verifiedAt: string | null }>;
  partial: boolean;
  total: number;
  page: number;
  pageSize: number;
}>;

export type CargarCatalogoClientes = (query: CatalogoClientesQuery, signal: AbortSignal) => Promise<CatalogoClientesResponse>;
export type CargarDetalleCliente = (id: string, signal: AbortSignal) => Promise<ResumenCatalogoCliente | null>;

type Props = {
  /** Opaque cache scope; the integration must change it on identity or permission changes. Never a secret. */
  scopeKey: string;
  /** Loaders must enforce authorization server-side, including every source and detail. */
  load: CargarCatalogoClientes;
  loadDetail?: CargarDetalleCliente;
  indicadores?: CargadoresIndicadores;
};

const FILTROS_INICIALES: CatalogoClientesQuery = { state: "active", web: "in_web", page: 1, pageSize: 25 };
const ESTADO: Record<Estado, string> = { active: "Activo", inactive: "Inactivo", unverified: "No verificado" };
const SAG_WEB: Record<Presencia, string> = {
  in_web: "En SAG Web", not_in_web: "Fuera de SAG Web", unverified: "No verificado",
};
const REVISION: Record<EstadoFuente, string> = {
  verified: "Verificada", stale: "Desactualizada", unavailable: "No disponible",
};
const fechaBogota = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota",
});

function UltimaVerificacion({ value }: { value: string | null }) {
  return value && Number.isFinite(Date.parse(value))
    ? <time dateTime={value}>{fechaBogota.format(new Date(value))}</time>
    : <span>Sin fecha verificada</span>;
}

function DetalleFuentes({ cliente, scopeKey, loadDetail, indicadores, panelId }: {
  cliente: ResumenCatalogoCliente;
  scopeKey: string;
  loadDetail?: CargarDetalleCliente;
  indicadores?: CargadoresIndicadores;
  panelId: string;
}) {
  const detalle = useQuery({
    queryKey: ["catalogo-clientes", scopeKey, "detalle", cliente.id],
    queryFn: ({ signal }) => loadDetail ? loadDetail(cliente.id, signal) : Promise.resolve(null),
    enabled: !!loadDetail, retry: false, gcTime: 0,
  });
  const fuentes = loadDetail ? (detalle.isError ? undefined : detalle.data?.sources) : cliente.sources;
  const alcanceIndicadores = JSON.stringify([scopeKey, !!indicadores?.dominios, !!indicadores?.licencias]);
  return (
    <section id={panelId} aria-label={`Fuentes de ${cliente.name}`} className="tarjeta">
      <h3>{loadDetail ? "Procedencias autorizadas" : "Procedencias en este resultado"}</h3>
      {loadDetail && detalle.isPending && <p role="status">Consultando fuentes del cliente…</p>}
      {detalle.isError && <p role="alert">No se pudieron consultar las fuentes del cliente.</p>}
      {loadDetail && detalle.isSuccess && !detalle.data && <p>El cliente ya no está disponible en este catálogo.</p>}
      {fuentes && (fuentes.length ? (
        <ul>
          {fuentes.map(fuente => (
            <li key={fuente.sourceId}>
              <strong>{fuente.label}</strong>{" · "}<span>{ESTADO[fuente.state]}</span>
              {" · "}{REVISION[fuente.revisionState]}{" · Última verificación: "}
              <UltimaVerificacion value={fuente.verifiedAt} />
            </li>
          ))}
        </ul>
      ) : <p>Sin procedencias disponibles.</p>)}
      {indicadores && detalle.isSuccess && detalle.data &&
        <CatalogoClienteIndicadores key={alcanceIndicadores} scopeKey={alcanceIndicadores}
          customerId={cliente.id} indicadores={indicadores} />}
    </section>
  );
}

/** Existing routing and permission gates must wrap this page when its endpoint is enabled. */
export default function CatalogoClientesPage(props: Props) {
  // A scope change discards the filters, source labels and expanded customer from the prior identity.
  return <CatalogoClientesContenido key={props.scopeKey} {...props} />;
}

function CatalogoClientesContenido({ scopeKey, load, loadDetail, indicadores }: Props) {
  const id = useId();
  const [filtros, setFiltros] = useState<CatalogoClientesQuery>(FILTROS_INICIALES);
  const [busqueda, setBusqueda] = useState("");
  const [ultimaListaFuentes, setUltimaListaFuentes] = useState<readonly FuenteCatalogoCliente[]>([]);
  const [detalleAbierto, setDetalleAbierto] = useState<string | null>(null);
  const consulta = useQuery({
    queryKey: ["catalogo-clientes", scopeKey, "lista", filtros],
    queryFn: ({ signal }) => load(filtros, signal),
    retry: false,
    gcTime: 0,
  });
  // A failed query must not display stale results (including results cached before an access change).
  const pagina = consulta.isError ? undefined : consulta.data;
  const nuevasFuentes = pagina?.sources;
  useEffect(() => {
    if (nuevasFuentes) setUltimaListaFuentes(nuevasFuentes);
  }, [nuevasFuentes]);
  const fuentes = consulta.isError ? [] : nuevasFuentes ?? ultimaListaFuentes;
  const todas = filtros.sourceIds === undefined;

  function cambiar(cambios: Partial<CatalogoClientesQuery>) {
    setDetalleAbierto(null);
    setFiltros(anterior => {
      const siguiente = { ...anterior, page: 1, ...cambios };
      if (siguiente.sourceIds === undefined) delete siguiente.sourceIds;
      if (siguiente.search === undefined) delete siguiente.search;
      return siguiente;
    });
  }

  function cambiarFuente(sourceId: string, marcada: boolean) {
    const elegidas = new Set(filtros.sourceIds ?? fuentes.map(fuente => fuente.sourceId));
    if (marcada) elegidas.add(sourceId);
    else elegidas.delete(sourceId);
    cambiar({ sourceIds: [...elegidas].sort() });
  }

  function buscar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    cambiar({ search: busqueda.trim() || undefined });
  }

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Clientes</h2>
        <button type="button" className="secundario" disabled={consulta.isFetching} onClick={() => void consulta.refetch()}>
          Actualizar lista
        </button>
      </div>
      <form className="barra-filtros" onSubmit={buscar} aria-label="Filtros de clientes">
        <div className="campo">
          <label htmlFor={`${id}-buscar`}>Buscar por nombre oficial</label>
          <input id={`${id}-buscar`} value={busqueda} maxLength={200}
            onChange={event => setBusqueda(event.target.value)} />
        </div>
        <button type="submit" className="secundario">Buscar</button>
        <div className="campo">
          <label htmlFor={`${id}-estado`}>Estado del cliente</label>
          <select id={`${id}-estado`} value={filtros.state}
            onChange={event => cambiar({ state: event.target.value as CatalogoClientesQuery["state"] })}>
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
            <option value="all">Todos</option>
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`${id}-web`}>Presencia en SAG Web</label>
          <select id={`${id}-web`} value={filtros.web}
            onChange={event => cambiar({ web: event.target.value as CatalogoClientesQuery["web"] })}>
            <option value="in_web">En SAG Web</option>
            <option value="not_in_web">Fuera de SAG Web</option>
            <option value="all">Todos</option>
          </select>
        </div>
        <fieldset>
          <legend>Fuentes</legend>
          <div className="campo">
            <label htmlFor={`${id}-todas`}>Todas las fuentes autorizadas</label>
            <input id={`${id}-todas`} type="checkbox" checked={todas}
              onChange={event => cambiar({ sourceIds: event.target.checked ? undefined : [] })} />
          </div>
          {fuentes.map((fuente, i) => (
            <div className="campo" key={fuente.sourceId}>
              <label htmlFor={`${id}-fuente-${i}`}>{fuente.label}</label>
              <input id={`${id}-fuente-${i}`} type="checkbox"
                checked={todas || !!filtros.sourceIds?.includes(fuente.sourceId)}
                onChange={event => cambiarFuente(fuente.sourceId, event.target.checked)} />
            </div>
          ))}
        </fieldset>
      </form>

      {consulta.isError ? (
        <div className="alerta alerta-error" role="alert">
          No se pudo consultar el catálogo.{" "}
          <button type="button" className="secundario" onClick={() => void consulta.refetch()}>Reintentar</button>
        </div>
      ) : consulta.isPending ? <p className="cargando" role="status">Cargando clientes…</p> : null}

      {pagina && (
        <>
          {pagina.partial && (
            <div className="alerta alerta-info" role="status">
              <p>La información del catálogo está incompleta. Una fuente no verificada no significa que el cliente esté inactivo o fuera de SAG Web.</p>
              <p>SAG Admin: {REVISION[pagina.sag.state]}. Última verificación:{" "}
                <UltimaVerificacion value={pagina.sag.verifiedAt} />.</p>
              {pagina.sources.filter(fuente => fuente.revisionState !== "verified"
                && (todas || filtros.sourceIds?.includes(fuente.sourceId))).map(fuente => (
                <p key={fuente.sourceId}>{fuente.label}: {REVISION[fuente.revisionState]}. Última verificación:{" "}
                  <UltimaVerificacion value={fuente.verifiedAt} />.</p>
              ))}
            </div>
          )}
          <div className="tabla-contenedor">
            <table aria-label="Clientes del catálogo">
              <thead><tr>
                <th scope="col">Nombre oficial</th>
                <th scope="col">Estado</th>
                <th scope="col">SAG Web</th>
                <th scope="col">Fuentes</th>
              </tr></thead>
              <tbody>
                {!pagina.items.length && (
                  <tr><td colSpan={4} className="vacio">
                    {pagina.partial ? "No hay resultados confirmados para estos filtros." : "No hay clientes para mostrar."}
                  </td></tr>
                )}
                {pagina.items.map(cliente => {
                  const abierto = detalleAbierto === cliente.id;
                  const panelId = `${id}-detalle`;
                  return (
                    <CustomerRows key={cliente.id} cliente={cliente} abierto={abierto} panelId={panelId}
                      onToggle={() => setDetalleAbierto(abierto ? null : cliente.id)} scopeKey={scopeKey}
                      loadDetail={loadDetail} indicadores={indicadores} />
                  );
                })}
              </tbody>
            </table>
          </div>
          <Paginacion page={pagina.page} pageSize={pagina.pageSize} total={pagina.total} onPageChange={page => cambiar({ page })} />
        </>
      )}
    </>
  );
}

function CustomerRows({ cliente, abierto, panelId, onToggle, scopeKey, loadDetail, indicadores }: {
  cliente: ResumenCatalogoCliente;
  abierto: boolean;
  panelId: string;
  onToggle: () => void;
  scopeKey: string;
  loadDetail?: CargarDetalleCliente;
  indicadores?: CargadoresIndicadores;
}) {
  return (
    <>
      <tr>
        <th scope="row">{cliente.name}</th>
        <td>{ESTADO[cliente.state]}{cliente.stateVaries && <small> · Varía por fuente</small>}</td>
        <td>{SAG_WEB[cliente.web]}{cliente.requiresReconciliation && <small> · Requiere conciliación</small>}</td>
        <td>
          <span>{cliente.sources.map(fuente => fuente.label).join(", ") || "Sin procedencias en este resultado"}</span>{" "}
          <button type="button" className="secundario" onClick={onToggle}
            aria-expanded={abierto} aria-controls={abierto ? panelId : undefined}
            aria-label={`${abierto ? "Ocultar" : "Ver"} fuentes de ${cliente.name}`}>
            {abierto ? "Ocultar fuentes" : "Ver fuentes"}
          </button>
        </td>
      </tr>
      {abierto && <tr><td colSpan={4}>
        <DetalleFuentes cliente={cliente} scopeKey={scopeKey} loadDetail={loadDetail} indicadores={indicadores} panelId={panelId} />
      </td></tr>}
    </>
  );
}
