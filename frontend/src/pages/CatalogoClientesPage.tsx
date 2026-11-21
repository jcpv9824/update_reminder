import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient, type QueryFilters } from "@tanstack/react-query";
import { Paginacion } from "../components/Comunes";
import CatalogoClienteIndicadores, { type CargadoresIndicadores } from "../components/CatalogoClienteIndicadores";
import { catalogRefreshMessages, useCatalogRefresh, type CatalogRefreshService } from "../hooks/useCatalogRefresh";
import "./CatalogoClientesPage.css";

type Estado = "active" | "inactive" | "unverified";
type Presencia = "in_web" | "not_in_web" | "unverified";
type EstadoFuente = "verified" | "stale" | "unavailable";

export type CatalogoClientesQuery = Readonly<{
  sourceIds?: readonly string[];
  state: Estado | "active_or_unverified" | "all";
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
  displayDocument?: string | null;
  name: string;
  state: Estado;
  web: Presencia;
  sources: readonly (FuenteCatalogoCliente & { readonly state: Estado })[];
  stateVaries: boolean;
  requiresReconciliation: boolean;
  /** Absent in older payloads; never inferred from an unavailable ERP source. */
  sagOnly?: boolean;
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
  refreshService?: CatalogRefreshService;
};

const FILTROS_INICIALES: CatalogoClientesQuery = { state: "active_or_unverified", web: "in_web", page: 1, pageSize: 25 };
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
      ) : <p>{(loadDetail ? detalle.data?.sagOnly : cliente.sagOnly) ? "Solo SAG Admin" : "Sin procedencias disponibles."}</p>)}
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

function CatalogoClientesContenido({ scopeKey, load, loadDetail, indicadores, refreshService }: Props) {
  const id = useId();
  const queryClient = useQueryClient();
  const [filtros, setFiltros] = useState<CatalogoClientesQuery>(FILTROS_INICIALES);
  const [busqueda, setBusqueda] = useState("");
  const [ultimaListaFuentes, setUltimaListaFuentes] = useState<readonly FuenteCatalogoCliente[]>([]);
  const [fuentesAbiertas, setFuentesAbiertas] = useState(false);
  const botonFuentes = useRef<HTMLButtonElement>(null);
  const [detalleAbierto, setDetalleAbierto] = useState<string | null>(null);
  const sinFuentes = filtros.sourceIds?.length === 0;
  const alcancesIndicadores = new Set([true, false].flatMap(dominios => [true, false].map(licencias =>
    JSON.stringify([scopeKey, dominios, licencias]))));
  const consultas: QueryFilters = {
    queryKey: ["catalogo-clientes"],
    predicate: ({ queryKey }) => queryKey[1] === scopeKey
      || (queryKey[2] === "indicadores" && typeof queryKey[1] === "string" && alcancesIndicadores.has(queryKey[1])),
  };
  const actualizacion = useCatalogRefresh({
    service: refreshService,
    scopeKey,
    sourceIds: filtros.sourceIds,
    criteria: filtros.search,
    onSettled: () => {
      // Reread even if an initial request started before the revision was published.
      void queryClient.cancelQueries(consultas);
      void queryClient.invalidateQueries(consultas);
    },
    onAccessDenied: () => {
      setUltimaListaFuentes([]);
      setFuentesAbiertas(false);
      setDetalleAbierto(null);
      queryClient.removeQueries(consultas);
    },
  });
  const accesoDenegado = actualizacion.state === "denied";
  const consulta = useQuery({
    queryKey: ["catalogo-clientes", scopeKey, "lista", filtros],
    queryFn: ({ signal }) => actualizacion.read(signal, () => load(filtros, signal)),
    // The read endpoint interprets an omitted source filter as all, not none.
    enabled: !sinFuentes && !accesoDenegado,
    retry: false,
    gcTime: 0,
  });
  const pagina = sinFuentes || accesoDenegado || consulta.isError ? undefined : consulta.data;
  const nuevasFuentes = pagina?.sources;
  useEffect(() => {
    if (accesoDenegado || consulta.isError) setUltimaListaFuentes([]);
    else if (nuevasFuentes) setUltimaListaFuentes(nuevasFuentes);
  }, [accesoDenegado, consulta.isError, nuevasFuentes]);
  const fuentes = accesoDenegado || consulta.isError ? [] : nuevasFuentes ?? ultimaListaFuentes;
  const todas = filtros.sourceIds === undefined;
  const conteoEtiquetas = new Map<string, number>();
  const ordinalEtiquetas = new Map<string, number>();
  for (const fuente of fuentes) conteoEtiquetas.set(fuente.label, (conteoEtiquetas.get(fuente.label) ?? 0) + 1);
  const opcionesFuentes = fuentes.map(fuente => {
    const ordinal = (ordinalEtiquetas.get(fuente.label) ?? 0) + 1;
    ordinalEtiquetas.set(fuente.label, ordinal);
    return { ...fuente, opcion: (conteoEtiquetas.get(fuente.label) ?? 0) > 1 ? `${fuente.label} (${ordinal})` : fuente.label };
  });
  const elegidas = opcionesFuentes.filter(fuente => filtros.sourceIds?.includes(fuente.sourceId));
  const resumenFuentes = todas ? "Todas" : elegidas.length === 0 ? "Ninguna" :
    elegidas.length === 1 ? elegidas[0].opcion : `${elegidas.length} seleccionadas`;
  const puedeVerSinSAG = (filtros.state === "active" || filtros.state === "active_or_unverified") &&
    filtros.web === "in_web" && filtros.page === 1 &&
    pagina?.page === 1 && pagina.total === 0 && pagina.sag.state === "unavailable"
    && pagina.sources.some(fuente => todas || filtros.sourceIds?.includes(fuente.sourceId));
  const avisoActualizacion = catalogRefreshMessages[actualizacion.state];

  function vigilarAcceso<T>(cargar?: (id: string, signal: AbortSignal) => Promise<T>) {
    return !refreshService || !cargar ? cargar :
      (id: string, signal: AbortSignal) => actualizacion.read(signal, () => cargar(id, signal));
  }
  const detalleVigilado = vigilarAcceso(loadDetail);
  const indicadoresVigilados = indicadores && {
    dominios: vigilarAcceso(indicadores.dominios), licencias: vigilarAcceso(indicadores.licencias),
  };

  function actualizarLista() {
    if (refreshService) actualizacion.request();
    else void consulta.refetch();
  }

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
    const search = busqueda.trim() || undefined;
    cambiar({ search });
    // Unchanged criteria do not restart the hook's automatic refresh effect.
    if (search === filtros.search) actualizacion.request();
  }

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Clientes</h2>
        <button type="button" className="secundario" onClick={actualizarLista}
          disabled={sinFuentes || accesoDenegado || (refreshService ? actualizacion.state === "pending" : consulta.isFetching)}>
          Actualizar lista
        </button>
      </div>
      {avisoActualizacion && (
        <p className={`alerta ${accesoDenegado ? "alerta-error" : "alerta-info"}`} role={accesoDenegado ? "alert" : "status"}>
          {avisoActualizacion}
        </p>
      )}
      <form className="barra-filtros" onSubmit={buscar} aria-label="Filtros de clientes">
        <div className="campo">
          <label htmlFor={`${id}-buscar`}>Buscar por ID o nombre</label>
          <input id={`${id}-buscar`} value={busqueda} maxLength={120} autoComplete="off"
            onChange={event => setBusqueda(event.target.value)} />
        </div>
        <button type="submit" className="secundario">Buscar</button>
        <div className="campo">
          <label htmlFor={`${id}-estado`}>Estado del cliente</label>
          <select id={`${id}-estado`} value={filtros.state}
            onChange={event => cambiar({ state: event.target.value as CatalogoClientesQuery["state"] })}>
            <option value="active_or_unverified">Activos y no verificados</option>
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
            <option value="unverified">No verificados</option>
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
        {!accesoDenegado && (
          <div className="catalogo-selector-fuentes"
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFuentesAbiertas(false); }}
            onKeyDown={event => {
              if (event.key !== "Escape" || !fuentesAbiertas) return;
              event.preventDefault();
              event.stopPropagation();
              setFuentesAbiertas(false);
              botonFuentes.current?.focus();
            }}>
            <button ref={botonFuentes} type="button" className="secundario catalogo-fuentes-boton"
              aria-expanded={fuentesAbiertas} aria-controls={`${id}-fuentes`}
              onClick={() => setFuentesAbiertas(abiertas => !abiertas)}>
              <span className="catalogo-fuentes-resumen">Fuentes: {resumenFuentes}</span> <span aria-hidden="true">▾</span>
            </button>
            <fieldset id={`${id}-fuentes`} className="catalogo-fuentes-panel" hidden={!fuentesAbiertas}>
              <legend className="sr-only">Fuentes autorizadas</legend>
              <label className="catalogo-fuentes-opcion">
                <input type="checkbox" checked={todas}
                  onChange={event => cambiar({ sourceIds: event.target.checked ? undefined : [] })} />
                Todas las fuentes autorizadas
              </label>
              {opcionesFuentes.map(fuente => (
                <label className="catalogo-fuentes-opcion" key={fuente.sourceId}>
                  <input type="checkbox" checked={todas || !!filtros.sourceIds?.includes(fuente.sourceId)}
                    onChange={event => cambiarFuente(fuente.sourceId, event.target.checked)} />
                  {fuente.opcion}
                </label>
              ))}
            </fieldset>
          </div>
        )}
      </form>

      {sinFuentes && <p className="texto-ayuda" role="status">Selecciona al menos una fuente para consultar el catálogo.</p>}
      {!sinFuentes && !accesoDenegado && (
        consulta.isError ? (
          <div className="alerta alerta-error" role="alert">
            No se pudo consultar el catálogo.{" "}
            <button type="button" className="secundario" onClick={() => void consulta.refetch()}>Reintentar</button>
          </div>
        ) : consulta.isPending ? <p className="cargando" role="status">Cargando clientes…</p> : null
      )}

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
          {puedeVerSinSAG && (
            <p className="catalogo-sag-sin-filtro">
              <button type="button" className="secundario" onClick={() => cambiar({ web: "all" })}>
                Ver clientes sin filtrar por presencia en SAG Web
              </button>
            </p>
          )}
          <div className="tabla-contenedor">
            <table aria-label="Clientes del catálogo">
              <thead><tr>
                <th scope="col">ID</th>
                <th scope="col">Nombre</th>
                <th scope="col">Estado</th>
                <th scope="col">SAG Web</th>
                <th scope="col" className="catalogo-clientes-origen">Origen</th>
              </tr></thead>
              <tbody>
                {!pagina.items.length && (
                  <tr><td colSpan={5} className="vacio">
                    {pagina.partial ? "No hay resultados confirmados para estos filtros." : "No hay clientes para mostrar."}
                  </td></tr>
                )}
                {pagina.items.map(cliente => {
                  const abierto = detalleAbierto === cliente.id;
                  const panelId = `${id}-detalle`;
                  return (
                    <CustomerRows key={cliente.id} cliente={cliente} abierto={abierto} panelId={panelId}
                      onToggle={() => setDetalleAbierto(abierto ? null : cliente.id)} scopeKey={scopeKey}
                      loadDetail={detalleVigilado} indicadores={indicadoresVigilados} />
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
        <td>{cliente.displayDocument ?? "No disponible"}</td>
        <th scope="row">{cliente.name}</th>
        <td>{ESTADO[cliente.state]}{cliente.stateVaries && <small> · Varía por fuente</small>}</td>
        <td>{SAG_WEB[cliente.web]}{cliente.requiresReconciliation && <small> · Requiere conciliación</small>}</td>
        <td className="catalogo-clientes-origen">
          <span>{cliente.sagOnly ? "Solo SAG Admin" : cliente.sources.map(fuente => fuente.label).join(", ") || "Sin procedencias en este resultado"}</span>{" "}
          <button type="button" className="secundario" onClick={onToggle}
            aria-expanded={abierto} aria-controls={abierto ? panelId : undefined}
            aria-label={`${abierto ? "Ocultar" : "Ver"} fuentes de ${cliente.name}`}>
            {abierto ? "Ocultar fuentes" : "Ver fuentes"}
          </button>
        </td>
      </tr>
      {abierto && <tr><td colSpan={5}>
        <DetalleFuentes cliente={cliente} scopeKey={scopeKey} loadDetail={loadDetail} indicadores={indicadores} panelId={panelId} />
      </td></tr>}
    </>
  );
}
