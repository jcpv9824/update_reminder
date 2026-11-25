import { useId, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { ETIQUETAS_AMBIENTE, type Usuario } from "../types";
import type { RoleDefinition } from "../permissionModel";
import DefinicionSolicitudCatalogo, { type DraftDefinitionSelection } from "./DefinicionSolicitudCatalogo";
import { Paginacion } from "./Comunes";
import { hoyEnBogotaIso, sumarDiasIso } from "../utils/fechas";

type Ambiente = "production" | "test" | "demo";
type Tipo = "customer" | "domain" | "database" | "license";
type Opcion = { id: string; customerId: string; customerName: string; eligibility: "observed_only";
  environment?: Ambiente; domain?: string; database?: string };
type PaginaOpciones = { state: "verified" | "partial" | "unavailable"; total: number; page: number; pageSize: number;
  items: Opcion[]; licenseOptions?: { code: string; name: string }[] };
type Filtros = { customerId?: string; environment?: Ambiente; domain?: string; moduleCode?: string; search?: string };
const pageSize = 25;
type DraftSelection = { mode: "manual"; customerId: string; domainChoiceId?: string } | { mode: "licensing"; moduleCode: string };
type DraftRequest = DraftSelection & { date: string; target: string; environment: string };
type Preview = { previewId?: string; coverage: "verified" | "partial"; groups: { id: string; kind: "domain" | "database"; label: string;
  state: "ready" | "reserved"; links: { id: string; customerName: string; environment: Ambiente }[] }[] };
type Prepare = { show: (selected: DraftSelection) => void; reset: () => void; busy: boolean };

function useOpciones(tipo: Tipo, filtros: Filtros, page: number, enabled: boolean) {
  const params = new URLSearchParams({ kind: tipo, page: String(page), pageSize: String(pageSize) });
  for (const [key, value] of Object.entries(filtros)) if (value) params.set(key, value);
  return useQuery({ queryKey: ["schedules", "catalog-choices", params.toString()], enabled,
    queryFn: () => api.get<PaginaOpciones>(`/schedules/catalog-choices?${params}`), retry: false, gcTime: 0 });
}

type Opciones = ReturnType<typeof useOpciones>;
const disponible = (query: Opciones) => !query.isError &&
  (query.data?.state === "verified" || query.data?.state === "partial");
function EstadoCatalogo({ query }: { query: Opciones }) {
  if (query.isPending) return <p role="status">Consultando opciones del catálogo…</p>;
  if (!disponible(query)) return <p role="alert">No se pudo verificar el catálogo para estos filtros.</p>;
  if (query.data?.state === "partial") return <p role="status">Datos parciales: se muestran solo las coincidencias confirmadas.</p>;
  if (query.data?.total === 0) return <p role="status">No hay coincidencias para estos filtros.</p>;
  return null;
}

function Paginas({ query, onPageChange }: { query: Opciones; onPageChange: (page: number) => void }) {
  const data = disponible(query) && query.data;
  return data && data.total > data.pageSize ? <Paginacion page={data.page} pageSize={data.pageSize}
    total={data.total} onPageChange={onPageChange} /> : null;
}

function Destinos({ tipo, filtros }: { tipo: "domain" | "database"; filtros: Filtros }) {
  const [page, setPage] = useState(1);
  const query = useOpciones(tipo, filtros, page, true);
  const items = disponible(query) ? query.data?.items ?? [] : [];
  return <section>
    <h4>{tipo === "domain" ? "Dominios asociados" : "Bases de datos asociadas"}</h4>
    <EstadoCatalogo query={query} />
    {items.length > 0 && <ul>{items.map(item => <li key={item.id}>
      <strong>{tipo === "database" ? item.database : item.domain}</strong>{" — "}
      {item.customerName}{tipo === "database" && ` · ${item.domain}`}{item.environment && ` · ${ETIQUETAS_AMBIENTE[item.environment]}`}
    </li>)}</ul>}
    <Paginas query={query} onPageChange={setPage} />
  </section>;
}

function AlcanceManual({ environment, prepare }: { environment?: Ambiente; prepare?: Prepare }) {
  const uid = useId();
  const [search, setSearch] = useState("");
  const [customerPage, setCustomerPage] = useState(1);
  const [domainPage, setDomainPage] = useState(1);
  const [customerId, setCustomerId] = useState("");
  const [domain, setDomain] = useState<Opcion | null>(null);
  const clientes = useOpciones("customer", { search: search.trim() }, customerPage, true);
  const clienteVigente = disponible(clientes) && clientes.data?.items.some(item => item.customerId === customerId);
  const dominios = useOpciones("domain", { customerId, environment }, domainPage, Boolean(clienteVigente));
  const dominioVigente = disponible(dominios) && dominios.data?.items.find(item => item.id === domain?.id);
  return <>
    <div className="campo">
      <label htmlFor={`${uid}-buscar`}>Buscar cliente</label>
      <input id={`${uid}-buscar`} maxLength={120} value={search} onChange={event => {
        setSearch(event.target.value); setCustomerPage(1); setDomainPage(1); setCustomerId(""); setDomain(null);
      }} />
      <label htmlFor={`${uid}-cliente`}>Cliente del catálogo</label>
      <select id={`${uid}-cliente`} value={customerId} onChange={event => {
        setCustomerId(event.target.value); setDomain(null); setDomainPage(1);
      }}>
        <option value="">Seleccione un cliente</option>
        {disponible(clientes) && clientes.data?.items.map(item => <option key={item.id} value={item.customerId}>{item.customerName}</option>)}
      </select>
      <EstadoCatalogo query={clientes} />
      <Paginas query={clientes} onPageChange={value => { prepare?.reset(); setCustomerId(""); setDomain(null); setDomainPage(1); setCustomerPage(value); }} />
    </div>
    {clienteVigente && <div className="campo">
      <label htmlFor={`${uid}-dominio`}>Dominio del catálogo</label>
      <select id={`${uid}-dominio`} value={domain?.id ?? ""} onChange={event =>
        setDomain(dominios.data?.items.find(item => item.id === event.target.value) ?? null)}>
        <option value="">Seleccione un dominio</option>
        {disponible(dominios) && dominios.data?.items.map(item => <option key={item.id} value={item.id}>
          {item.domain}{item.environment && ` · ${ETIQUETAS_AMBIENTE[item.environment]}`}</option>)}
      </select>
      <EstadoCatalogo query={dominios} />
      <Paginas query={dominios} onPageChange={value => { prepare?.reset(); setDomain(null); setDomainPage(value); }} />
    </div>}
    {clienteVigente && dominioVigente && dominioVigente.domain && dominioVigente.environment &&
      <Destinos key={dominioVigente.id} tipo="database" filtros={{ customerId, environment: dominioVigente.environment, domain: dominioVigente.domain }} />}
    {prepare && <button type="button" disabled={!clienteVigente || !disponible(dominios) || prepare.busy || Boolean(domain && !dominioVigente)}
      onClick={() => prepare.show({ mode: "manual", customerId, ...(dominioVigente && { domainChoiceId: dominioVigente.id }) })}>
      Previsualizar alcance operativo
    </button>}
  </>;
}

function AlcanceLicencias({ environment, prepare }: { environment?: Ambiente; prepare?: Prepare }) {
  const id = useId();
  const [moduleCode, setModuleCode] = useState("");
  const [page, setPage] = useState(1);
  const licencias = useOpciones("license", {}, page, true);
  const vigente = Boolean(moduleCode && disponible(licencias) && licencias.data?.licenseOptions?.some(item => item.code === moduleCode));
  return <>
    <div className="campo">
      <label htmlFor={id}>Licencia del catálogo</label>
      <select id={id} value={moduleCode} onChange={event => setModuleCode(event.target.value)}>
        <option value="">Seleccione una licencia</option>
        {disponible(licencias) && licencias.data?.licenseOptions?.map(item => <option key={item.code} value={item.code}>{item.name} ({item.code})</option>)}
      </select>
      <EstadoCatalogo query={licencias} />
      <Paginas query={licencias} onPageChange={value => { prepare?.reset(); setModuleCode(""); setPage(value); }} />
    </div>
    {vigente && <>
      <Destinos key={`domain-${environment}-${moduleCode}`} tipo="domain" filtros={{ environment, moduleCode }} />
      <Destinos key={`database-${environment}-${moduleCode}`} tipo="database" filtros={{ environment, moduleCode }} />
    </>}
    {prepare && <button type="button" disabled={!vigente || prepare.busy}
      onClick={() => prepare.show({ mode: "licensing", moduleCode })}>Previsualizar alcance operativo</button>}
  </>;
}

/** Observed inputs cannot be submitted through the legacy schedule contract. */
export default function AlcanceCatalogoProgramacion({ roles, usuarios, onOpenRequests }: {
  roles: RoleDefinition[]; usuarios: Usuario[]; onOpenRequests?: () => void;
}) {
  const uid = useId();
  const [modo, setModo] = useState<"manual" | "licensing">("manual");
  const [environment, setEnvironment] = useState<Ambiente | "all">("all");
  const [date, setDate] = useState(hoyEnBogotaIso);
  const [target, setTarget] = useState<"domain" | "database" | "both">("both");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState("");
  const currentRequest = useRef<DraftRequest | null>(null);
  const showPreview = import.meta.env.VITE_PORTAL_CATALOG_DRAFT_PREVIEW_ENABLED === "true";
  const canSave = showPreview && import.meta.env.VITE_PORTAL_CATALOG_DRAFT_PROPOSALS_ENABLED === "true";
  const query = useMutation({
    mutationFn: (scope: DraftRequest) =>
      api.post<Preview>("/schedules/catalog-draft-preview", scope),
    onSuccess: (data, scope) => {
      if (currentRequest.current === scope) setPicked(new Set(data.groups.filter(group => group.state === "ready").map(group => group.id)));
    },
    retry: false,
  });
  const save = useMutation({
    mutationFn: async (draft: { scope: DraftRequest; previewId: string; linkIds: string[]; name: string } & DraftDefinitionSelection) => {
      const result = await api.post<{ id: string; status: string }>("/schedules/catalog-draft-proposals", draft);
      if (result.status !== "pending_approval" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.id)) {
        throw new Error("invalid_draft_proposal");
      }
      return result.id;
    },
    retry: false,
  });
  function reset() {
    currentRequest.current = null;
    query.reset(); save.reset(); setPicked(new Set());
  }
  const strictScope = modo !== "licensing" || query.data?.coverage === "verified";
  const canSubmit = canSave && Boolean(query.data?.previewId) && Boolean(query.variables) && !query.isPending &&
    !save.isPending && !save.isSuccess && strictScope && picked.size > 0 && name.trim().length > 0 && !/\p{C}/u.test(name);
  function submit(definition: DraftDefinitionSelection) {
    if (!canSubmit || !query.variables || !query.data?.previewId) return;
    const linkIds = query.data.groups.filter(group => group.state === "ready" && picked.has(group.id)).flatMap(group => group.links.map(link => link.id));
    if (linkIds.length) save.mutate({ scope: query.variables, previewId: query.data.previewId, linkIds, name: name.trim(), ...definition });
  }
  const today = hoyEnBogotaIso(), last = sumarDiasIso(today, 7);
  const prepare = showPreview ? { busy: query.isPending || save.isPending || date < today || date > last, reset,
    show: (scope: DraftSelection) => {
      reset();
      const next = { ...scope, date, target, environment };
      currentRequest.current = next;
      query.mutate(next);
    } } : undefined;
  return <section aria-label="Alcance del catálogo de SAG Web">
    <p className="texto-ayuda">{showPreview ? "La vista previa verifica destinos y reservas. No crea una programación."
      : "Consulta los candidatos del catálogo. Confirmar el alcance operativo y guardar aún no está habilitado."}</p>
    <div className="fila-formulario">
      <div className="campo"><label htmlFor={`${uid}-modo`}>Tipo de alcance</label>
        <select id={`${uid}-modo`} value={modo} disabled={save.isPending} onChange={event => { reset(); setModo(event.target.value === "manual" ? "manual" : "licensing"); }}>
          <option value="manual">Selección manual</option><option value="licensing">Por licenciamiento</option>
        </select>
      </div>
      <div className="campo"><label htmlFor={`${uid}-ambiente`}>Ambiente</label>
        <select id={`${uid}-ambiente`} value={environment} disabled={save.isPending} onChange={event => { reset(); setEnvironment(event.target.value as Ambiente | "all"); }}>
          <option value="all">Todos</option>
          <option value="production">Producción</option><option value="test">Pruebas</option><option value="demo">Demo</option>
        </select>
      </div>
    </div>
    {showPreview && <div className="fila-formulario">
      <div className="campo"><label htmlFor={`${uid}-target`}>Objetivo de la actualización</label>
        <select id={`${uid}-target`} value={target} disabled={save.isPending} onChange={event => { reset(); setTarget(event.target.value as typeof target); }}>
          <option value="both">Dominios y bases de datos</option><option value="domain">Dominios</option><option value="database">Bases de datos</option>
        </select>
      </div>
      <div className="campo"><label htmlFor={`${uid}-date`}>Fecha de inicio</label>
        <input id={`${uid}-date`} type="date" min={today} max={last} value={date} disabled={save.isPending} onChange={event => { reset(); setDate(event.target.value); }} />
      </div>
    </div>}
    <fieldset disabled={save.isPending} onChange={event => { if ((event.target as HTMLElement).matches("select,input")) reset(); }}>
      <legend className="sr-only">Selección del alcance</legend>
      {modo === "manual" ? <AlcanceManual key={environment} environment={environment === "all" ? undefined : environment} prepare={prepare} />
        : <AlcanceLicencias environment={environment === "all" ? undefined : environment} prepare={prepare} />}
    </fieldset>
    {query.isPending && <p role="status">Verificando destinos y reservas…</p>}
    {query.isError && <p role="alert">No se pudo verificar el alcance operativo para estos filtros.</p>}
    {query.data && <section aria-label="Vista previa operativa">
      <h4>Vista previa operativa</h4>
      {query.data.coverage === "partial" && <p role="status">Cobertura parcial: no se pudieron verificar todos los destinos.</p>}
      {!query.data.groups.length ? <p>No se encontraron destinos operativos confirmados.</p> :
        <ul>{query.data.groups.map(group => <li key={group.id}>
          {canSave && group.state === "ready" && <label className="fila-seleccion">
            <input type="checkbox" checked={picked.has(group.id)} disabled={save.isPending || save.isSuccess}
              onChange={event => { const next = new Set(picked); if (event.target.checked) next.add(group.id); else next.delete(group.id); setPicked(next); }} />
            Seleccionar {group.label}
          </label>}
          <strong>{group.kind === "database" ? "Base de datos" : "Dominio"}: {group.label}</strong>
          {" — "}{group.state === "reserved" ? "Hay una reserva existente; requiere revisión" : "Verificado"}
          <ul>{group.links.map(link => <li key={link.id}>{link.customerName} · {ETIQUETAS_AMBIENTE[link.environment]}</li>)}</ul>
        </li>)}</ul>}
      {canSave && query.data.previewId && <div className="campo">
        <label htmlFor={`${uid}-name`}>Nombre de la programación</label>
        <input id={`${uid}-name`} maxLength={200} value={name} disabled={save.isPending || save.isSuccess} onChange={event => setName(event.target.value)} />
        {!strictScope && <p>El alcance por licenciamiento requiere una vista previa completa antes de guardar.</p>}
        <DefinicionSolicitudCatalogo kinds={target === "both" ? ["domain", "database"] : [target]}
          roles={roles} usuarios={usuarios} startDate={date} disabled={save.isPending || save.isSuccess} canSubmit={canSubmit} onSave={submit} />
        {save.isError && <p role="alert">No se guardó la solicitud. Vuelva a verificar el alcance.</p>}
        {save.isSuccess && <>
          <p role="status">Solicitud guardada, pendiente de aprobación. No se crearon tareas ni avisos.</p>
          {onOpenRequests && <button type="button" className="secundario" onClick={onOpenRequests}>Ir a mis solicitudes</button>}
        </>}
      </div>}
    </section>}
  </section>;
}
