import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "../api/client";
import { Paginacion } from "../components/Comunes";
import "./CatalogoClientesPage.css";
import "./CatalogoInventarioObservado.css";

const TAMANO = 25;
const MAX_BUSQUEDA = 120;
const AMBIENTES = {
  production: "Producción", test: "Pruebas", demo: "Demostración", unknown: "Ambiente no verificado",
} as const;
type Ambiente = keyof typeof AMBIENTES;
type Vista = "domains" | "databases" | "licenses";
type Fuente = { id: string; label: string };
type Pagina<T> = {
  items: readonly T[];
  state: "verified" | "partial" | "unavailable";
  page: number;
  pageSize: number;
  total: number;
  sources?: readonly Fuente[];
};
type RegistroCliente = { id: string; customerId: string; customerName: string };
type Entidad = RegistroCliente & { name: string; environment: Ambiente; detail?: string };
type Licencia = { id: string; code: string; name: string };
type LicenciasCliente = RegistroCliente & { licenses: string[] };
type FiltrosClientes = {
  state: "active" | "inactive" | "unverified" | "all";
  web: "in_web" | "not_in_web" | "unverified" | "all";
  search: string;
  sourceIds?: string[];
};
const FILTROS_TODOS: FiltrosClientes = { state: "all", web: "all", search: "" };
const FILTROS_MODAL: FiltrosClientes = { state: "active", web: "in_web", search: "" };

function usePagina<T>(alcance: string, vista: Vista, pagina: number, parametros: Record<string, string> = {},
  fuentes?: string[], habilitada = true) {
  const query = new URLSearchParams({ page: String(pagina), pageSize: String(TAMANO), v: "2" });
  for (const [clave, valor] of Object.entries(parametros)) {
    if (valor) query.set(clave, valor);
  }
  for (const fuente of fuentes ?? []) query.append("sourceId", fuente);
  const url = `/catalog/inventory/${vista}?${query}`;
  return useQuery({
    queryKey: ["catalogo-inventario-observado-v2", alcance, url],
    queryFn: ({ signal }) => api.get<Pagina<T>>(url, { signal }),
    enabled: habilitada && fuentes?.length !== 0,
    retry: false,
    gcTime: 0,
  });
}

function Encabezado({ titulo, actualizar, ocupado }: { titulo: string; actualizar: () => void; ocupado: boolean }) {
  return (
    <>
      <div className="encabezado-pagina">
        <h2>{titulo}</h2>
        <button type="button" className="secundario" onClick={actualizar} disabled={ocupado}>Actualizar lista</button>
      </div>
      <p className="texto-ayuda">Datos observados en SAG Admin con el nombre oficial del ERP. Consulta de solo lectura.</p>
    </>
  );
}

function Resultados<T>({ consulta, onPagina, sinFuentes, children }: {
  consulta: UseQueryResult<Pagina<T>>;
  onPagina: (page: number) => void;
  sinFuentes?: boolean;
  children: (pagina: Pagina<T>) => ReactNode;
}) {
  if (sinFuentes) return <p className="texto-ayuda" role="status">Selecciona al menos una fuente para consultar el catálogo.</p>;
  if (consulta.isError || consulta.fetchStatus === "paused") {
    return <p className="alerta alerta-error" role="alert">No se pudo consultar el catálogo.</p>;
  }
  if (consulta.isPending || consulta.isFetching) return <p className="cargando" role="status">Consultando catálogo…</p>;
  if (consulta.data.state === "unavailable") {
    return <p className="alerta alerta-info" role="alert">El catálogo no está disponible o todavía no se ha verificado.</p>;
  }
  const pagina = consulta.data;
  return (
    <>
      {pagina.state === "partial" && (
        <p className="alerta alerta-info" role="status">
          La información del catálogo está incompleta. Puede haber registros que aún no se pueden confirmar.
        </p>
      )}
      {children(pagina)}
      {pagina.page > 1 && pagina.items.length === 0 ? (
        <button type="button" className="secundario" onClick={() => onPagina(1)}>Volver a la primera página</button>
      ) : <Paginacion page={pagina.page} pageSize={pagina.pageSize} total={pagina.total} onPageChange={onPagina} />}
    </>
  );
}

function Tabla<T extends { id: string }>({ etiqueta, columnas, pagina, celdas }: {
  etiqueta: string; columnas: string[]; pagina: Pagina<T>; celdas: (fila: T) => ReactNode;
}) {
  return (
    <div className="tabla-contenedor">
      <table aria-label={etiqueta}>
        <thead><tr>{columnas.map(columna => <th key={columna} scope="col">{columna}</th>)}</tr></thead>
        <tbody>
          {pagina.items.length ? pagina.items.map(fila => <tr key={fila.id}>{celdas(fila)}</tr>) : (
            <tr><td colSpan={columnas.length} className="vacio">
              {pagina.state === "partial" || pagina.page > 1
                ? "No hay registros confirmados en esta página." : "No hay registros para mostrar."}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function TablaEntidades({ vista, alcance, titulo }: { vista: Exclude<Vista, "licenses">; alcance: string; titulo: string }) {
  const id = useId();
  const [pagina, setPagina] = useState(1);
  const [busqueda, setBusqueda] = useState("");
  const [search, setSearch] = useState("");
  const [environment, setAmbiente] = useState<Ambiente | "">("");
  const consulta = usePagina<Entidad>(alcance, vista, pagina, { search, environment });
  const database = vista === "databases";
  const columnas = database ? ["ID del cliente", "Cliente (ERP)", "Dominio", "Base de datos", "Ambiente"]
    : ["ID del cliente", "Cliente (ERP)", "Dominio", "Ambiente"];

  function buscar(event: FormEvent) {
    event.preventDefault();
    const valor = busqueda.trim();
    if (valor === search && pagina === 1) void consulta.refetch();
    setSearch(valor);
    setPagina(1);
  }

  return (
    <>
      <Encabezado titulo={titulo} actualizar={() => void consulta.refetch()} ocupado={consulta.isFetching} />
      <form className="barra-filtros" aria-label="Filtros del inventario" onSubmit={buscar}>
        <div className="campo">
          <label htmlFor={`${id}-buscar`}>Buscar por ID, cliente, dominio{database && " o base de datos"}</label>
          <input id={`${id}-buscar`} value={busqueda} maxLength={MAX_BUSQUEDA} onChange={event => setBusqueda(event.target.value)} />
        </div>
        <button type="submit" className="secundario">Buscar</button>
        <div className="campo">
          <label htmlFor={`${id}-ambiente`}>Ambiente</label>
          <select id={`${id}-ambiente`} value={environment}
            onChange={event => { setAmbiente(event.target.value as Ambiente | ""); setPagina(1); }}>
            <option value="">Todos</option>
            {Object.entries(AMBIENTES).map(([valor, nombre]) => <option key={valor} value={valor}>{nombre}</option>)}
          </select>
        </div>
      </form>
      <Resultados consulta={consulta} onPagina={setPagina}>
        {datos => (
          <Tabla etiqueta={`${titulo} del catálogo`} columnas={columnas} pagina={datos} celdas={fila => (
            <>
              <td>{fila.customerId}</td>
              <td>{fila.customerName}</td>
              {database && <td>{fila.detail ?? "Dominio no verificado"}</td>}
              <th scope="row">{fila.name}</th>
              <td>{AMBIENTES[fila.environment] ?? AMBIENTES.unknown}</td>
            </>
          )} />
        )}
      </Resultados>
    </>
  );
}

function SelectorFuentes({ fuentes, fuenteIds, cambiar }: {
  fuentes: readonly Fuente[]; fuenteIds?: string[]; cambiar: (ids: string[] | undefined) => void;
}) {
  const panel = useId();
  const [abierto, setAbierto] = useState(false);
  const boton = useRef<HTMLButtonElement>(null);
  const todas = fuenteIds === undefined;
  const repeticiones = new Map<string, number>();
  const ordinales = new Map<string, number>();
  for (const { label } of fuentes) repeticiones.set(label, (repeticiones.get(label) ?? 0) + 1);
  const opciones = fuentes.map(fuente => {
    const ordinal = (ordinales.get(fuente.label) ?? 0) + 1;
    ordinales.set(fuente.label, ordinal);
    return { ...fuente, opcion: (repeticiones.get(fuente.label) ?? 0) > 1 ? `${fuente.label} (${ordinal})` : fuente.label };
  });
  const seleccion = opciones.filter(fuente => fuenteIds?.includes(fuente.id));
  const resumen = todas ? "Todas" : seleccion.length === 0 ? "Ninguna" :
    seleccion.length === 1 ? seleccion[0].opcion : `${seleccion.length} seleccionadas`;
  function alternar(id: string, checked: boolean) {
    const lasFuentes = new Set(fuenteIds ?? fuentes.map(fuente => fuente.id));
    if (checked) lasFuentes.add(id);
    else lasFuentes.delete(id);
    cambiar([...lasFuentes].sort());
  }
  return (
    <div className="catalogo-selector-fuentes"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAbierto(false); }}
      onKeyDown={event => {
        if (event.key !== "Escape" || !abierto) return;
        event.preventDefault();
        event.stopPropagation();
        setAbierto(false);
        boton.current?.focus();
      }}>
      <button ref={boton} type="button" className="secundario catalogo-fuentes-boton" aria-expanded={abierto}
        aria-controls={panel} onClick={() => setAbierto(!abierto)} disabled={todas && fuentes.length === 0}>
        <span className="catalogo-fuentes-resumen">Fuentes: {resumen}</span> <span aria-hidden="true">▾</span>
      </button>
      <fieldset id={panel} className="catalogo-fuentes-panel" hidden={!abierto}>
        <legend className="sr-only">Fuentes autorizadas</legend>
        <label className="catalogo-fuentes-opcion">
          <input type="checkbox" checked={todas} onChange={event => cambiar(event.target.checked ? undefined : [])} />
          Todas las fuentes autorizadas
        </label>
        {opciones.map(fuente => (
          <label className="catalogo-fuentes-opcion" key={fuente.id}>
            <input type="checkbox" checked={todas || !!fuenteIds?.includes(fuente.id)}
              onChange={event => alternar(fuente.id, event.target.checked)} />
            {fuente.opcion}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function CamposClientes({ filtros, fuentes, cambiar, reenviar }: {
  filtros: FiltrosClientes; fuentes: readonly Fuente[];
  cambiar: (cambios: Partial<FiltrosClientes>) => void; reenviar: () => void;
}) {
  const id = useId();
  const [busqueda, setBusqueda] = useState(filtros.search);
  return (
    <form className="barra-filtros" aria-label="Filtros de clientes" onSubmit={event => {
      event.preventDefault();
      const search = busqueda.trim();
      if (search === filtros.search) reenviar();
      cambiar({ search });
    }}>
      <div className="campo">
        <label htmlFor={`${id}-buscar`}>Buscar por ID o nombre oficial</label>
        <input id={`${id}-buscar`} value={busqueda} maxLength={MAX_BUSQUEDA} onChange={event => setBusqueda(event.target.value)} />
      </div>
      <button type="submit" className="secundario">Buscar</button>
      <div className="campo">
        <label htmlFor={`${id}-estado`}>Estado del cliente</label>
        <select id={`${id}-estado`} value={filtros.state}
          onChange={event => cambiar({ state: event.target.value as FiltrosClientes["state"] })}>
          <option value="active">Activos</option>
          <option value="inactive">Inactivos</option>
          <option value="unverified">No verificados</option>
          <option value="all">Todos</option>
        </select>
      </div>
      <div className="campo">
        <label htmlFor={`${id}-web`}>Presencia en SAG Web</label>
        <select id={`${id}-web`} value={filtros.web}
          onChange={event => cambiar({ web: event.target.value as FiltrosClientes["web"] })}>
          <option value="in_web">En SAG Web</option>
          <option value="not_in_web">Fuera de SAG Web</option>
          <option value="unverified">No verificado</option>
          <option value="all">Todos</option>
        </select>
      </div>
      <SelectorFuentes fuentes={fuentes} fuenteIds={filtros.sourceIds} cambiar={sourceIds => cambiar({ sourceIds })} />
    </form>
  );
}

function DetalleLicencia({ alcance, licencia, fuentes, cerrar }: {
  alcance: string; licencia: Licencia; fuentes: readonly Fuente[]; cerrar: () => void;
}) {
  const titulo = useId();
  const dialogo = useRef<HTMLDialogElement>(null);
  const [pagina, setPagina] = useState(1);
  const [filtros, setFiltros] = useState(FILTROS_MODAL);
  const { state, web, search, sourceIds } = filtros;
  const consulta = usePagina<RegistroCliente>(alcance, "licenses", pagina, {
    tab: "licenseCustomers", code: licencia.code, state, web, search,
  }, sourceIds);
  const sinFuentes = sourceIds?.length === 0;

  useLayoutEffect(() => {
    const elemento = dialogo.current;
    elemento?.showModal();
    return () => elemento?.close();
  }, []);

  function salir() {
    dialogo.current?.close();
    cerrar();
  }

  return (
    <dialog ref={dialogo} className="modal catalogo-modal-licencia" aria-labelledby={titulo}
      onCancel={event => { event.preventDefault(); salir(); }}>
      <div className="encabezado-pagina">
        <h3 id={titulo}>Clientes con {licencia.name || `código ${licencia.code}`}</h3>
        <button type="button" onClick={salir}>Cerrar</button>
      </div>
      <CamposClientes filtros={filtros} fuentes={consulta.isError ? [] : fuentes}
        cambiar={cambios => { setFiltros(actual => ({ ...actual, ...cambios })); setPagina(1); }}
        reenviar={() => { if (pagina === 1 && !sinFuentes) void consulta.refetch(); }} />
      <Resultados consulta={consulta} onPagina={setPagina} sinFuentes={sinFuentes}>
        {datos => <Tabla etiqueta="Clientes con la licencia" columnas={["ID", "Nombre"]} pagina={datos}
          celdas={fila => <><td>{fila.customerId}</td><th scope="row">{fila.customerName}</th></>} />}
      </Resultados>
    </dialog>
  );
}

const TABS = ["available", "customers"] as const;
type Tab = typeof TABS[number];
const NOMBRE_TABS: Record<Tab, string> = { available: "Licencias disponibles", customers: "Licencias por cliente" };

function TablaLicencias({ alcance }: { alcance: string }) {
  const id = useId();
  const [tab, setTab] = useState<Tab>("available");
  const [paginaDisponible, setPaginaDisponible] = useState(1);
  const [paginaClientes, setPaginaClientes] = useState(1);
  const [filtros, setFiltros] = useState(FILTROS_TODOS);
  const [licencia, setLicencia] = useState<Licencia>();
  const origen = useRef<HTMLButtonElement | null>(null);
  const botones = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const disponibles = usePagina<Licencia>(alcance, "licenses", paginaDisponible, { tab: "available" }, undefined, tab === "available");
  const { state, web, search, sourceIds } = filtros;
  const clientes = usePagina<LicenciasCliente>(alcance, "licenses", paginaClientes, { tab: "customers", state, web, search },
    sourceIds, tab === "customers");
  const consulta = tab === "available" ? disponibles : clientes;
  const sinFuentes = sourceIds?.length === 0;
  const fuentes = clientes.isError || disponibles.isError ? [] : disponibles.data?.sources ?? clientes.data?.sources ?? [];

  useEffect(() => { if (disponibles.isError) setLicencia(undefined); }, [disponibles.isError]);

  return (
    <>
      <Encabezado titulo="Licenciamiento" actualizar={() => void consulta.refetch()}
        ocupado={consulta.isFetching || (tab === "customers" && sinFuentes)} />
      <div className="pestanas" role="tablist" aria-label="Licenciamiento">
        {TABS.map(opcion => (
          <button key={opcion} id={`${id}-${opcion}`} ref={elemento => { botones.current[opcion] = elemento; }}
            type="button" className={tab === opcion ? "activo" : ""} role="tab" aria-selected={tab === opcion}
            aria-controls={`${id}-panel-${opcion}`} tabIndex={tab === opcion ? 0 : -1} onClick={() => setTab(opcion)}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const siguiente = event.key === "Home" ? "available" : event.key === "End" ? "customers" :
                opcion === "available" ? "customers" : "available";
              setTab(siguiente);
              botones.current[siguiente]?.focus();
            }}>
            {NOMBRE_TABS[opcion]}
          </button>
        ))}
      </div>
      <section id={`${id}-panel-available`} role="tabpanel" aria-labelledby={`${id}-available`} hidden={tab !== "available"}>
        {tab === "available" && (
          <Resultados consulta={disponibles} onPagina={setPaginaDisponible}>
            {datos => (
              <Tabla etiqueta="Licencias disponibles" columnas={["Código", "Licencia", "Clientes"]} pagina={datos} celdas={fila => {
                const nombre = fila.name || `Código ${fila.code}`;
                return (
                  <>
                    <td>{fila.code}</td><th scope="row">{nombre}</th>
                    <td><button type="button" className="secundario" aria-label={`Ver clientes de ${nombre}`}
                      onClick={event => { origen.current = event.currentTarget; setLicencia(fila); }}>Ver clientes</button></td>
                  </>
                );
              }} />
            )}
          </Resultados>
        )}
      </section>
      <section id={`${id}-panel-customers`} role="tabpanel" aria-labelledby={`${id}-customers`} hidden={tab !== "customers"}>
        {tab === "customers" && (
          <>
            <CamposClientes filtros={filtros} fuentes={fuentes}
              cambiar={cambios => { setFiltros(actual => ({ ...actual, ...cambios })); setPaginaClientes(1); }}
              reenviar={() => { if (paginaClientes === 1 && !sinFuentes) void clientes.refetch(); }} />
            <Resultados consulta={clientes} onPagina={setPaginaClientes} sinFuentes={sinFuentes}>
              {datos => <Tabla etiqueta="Licencias por cliente" columnas={["ID del cliente", "Cliente (ERP)", "Licencias"]}
                pagina={datos} celdas={fila => (
                  <>
                    <td>{fila.customerId}</td><th scope="row">{fila.customerName}</th>
                    <td>{fila.licenses.length ? fila.licenses.join(", ") : "Sin licencias identificadas"}</td>
                  </>
                )} />}
            </Resultados>
          </>
        )}
      </section>
      {licencia && !disponibles.isError && <DetalleLicencia key={licencia.code} licencia={licencia} alcance={alcance} fuentes={fuentes}
        cerrar={() => {
          setLicencia(undefined);
          (origen.current?.isConnected ? origen.current : botones.current[tab])?.focus();
        }} />}
    </>
  );
}

export default function CatalogoInventarioObservado({ vista, alcance, titulo }: { vista: Vista; alcance: string; titulo: string }) {
  return vista === "licenses" ? <TablaLicencias alcance={alcance} /> : <TablaEntidades vista={vista} alcance={alcance} titulo={titulo} />;
}
