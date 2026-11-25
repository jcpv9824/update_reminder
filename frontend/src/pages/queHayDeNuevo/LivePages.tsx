import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Link, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ConstructorRutas } from "./componentes/ConstructorRuta";
import { Dialogo, EtiquetaEstadoQhdn, EtiquetaSistema, EtiquetaTipo } from "./componentes/Comunes";
import { EditorEnriquecido, VisorEnriquecido } from "./componentes/EditorEnriquecido";
import { ErpClientCombobox } from "./componentes/ErpClientCombobox";
import { docVacio, ETIQUETAS_ESTADO_QHDN, ETIQUETAS_TIPO_CORTAS, rutaTexto, rutaVacia } from "./logica";
import { createDraftSaveSession, draftFromForm, errorMessage, formFromEntry, mutationOptions, richLayoutVersion, safeDisplayDoc, storagePending, whatsNewApi, type Advisors, type ConfigDto, type EntryDto, type EntrySummary, type ErpClientLookup, type Me, type Page, type ReportInput, type ReportPreview, type RoundDto, type RoundProgress, type SavedReport } from "./contrato";
import { aceptaDocumentoPrivado, BotonDescargaPrivada, subirArchivoPrivado, tiposVideoPrivado, validarArchivoPrivado, type DestinoArchivoPrivado, type TipoArchivoPrivado } from "./componentes/archivosPrivados";
import type { Adjunto, DatosFormulario, DocEnriquecido, Sistema, TipoEntrada } from "./tipos";
import "./queHayDeNuevo.css";

const base = "/actualizaciones/que-hay-de-nuevo";
const types: TipoEntrada[] = ["nuevo", "mejora", "regla_negocio", "sp_critico", "rediseno"];
const key = ["whats-new"];
const Scope = createContext<string[]>(key);
function PrivateScope({ children }: { children: ReactNode }) {
  const auth = useAuth(); const qc = useQueryClient();
  const user = !auth.cargando ? auth.usuario : null;
  const identity = user ? `${user.id}:${[...user.roles].sort().join(",")}` : "anonymous";
  const scope = useMemo(() => [...key, "private", identity], [identity]);
  useEffect(() => () => { qc.removeQueries({ queryKey: scope }); }, [qc, scope]);
  if (!user) return <p role="alert">Debes iniciar sesión para continuar.</p>;
  return <Scope.Provider value={scope}><div key={identity}>{children}</div></Scope.Provider>;
}
const can = (me: Me, permission: string) => me.permissions.includes(permission);
function Feedback({ error }: { error: unknown }) { return error ? <div className="alerta-error" role="alert">{errorMessage(error)}</div> : null; }
function Loading() { return <p role="status">Cargando...</p>; }
function ReadDoc({ value, publicProfile = false, privateMedia = false }: { value: DocEnriquecido | null; publicProfile?: boolean; privateMedia?: boolean }) {
  const doc = useMemo(() => safeDisplayDoc(value, publicProfile, privateMedia), [value, publicProfile, privateMedia]);
  return <VisorEnriquecido valor={doc} archivosPrivados={privateMedia && !publicProfile} />;
}
function PageControl({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (n: number) => void }) {
  return <div className="qhdn-fila" aria-label="Paginación"><button disabled={page <= 1} onClick={() => onChange(page - 1)}>Anterior</button><span role="status">Página {page} · {total} resultados</span><button disabled={page * size >= total} onClick={() => onChange(page + 1)}>Siguiente</button></div>;
}
function RemoveButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="peligro qhdn-icono-eliminar" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Trash2 size={16} aria-hidden="true" /></button>;
}
function RemovalDialog({ title, children, remove, onRemoved, onClose }: { title: string; children: ReactNode; remove: () => Promise<void>; onRemoved: () => void; onClose: () => void }) {
  const lock = useRef(false);
  const operation = useMutation({ mutationFn: remove, onSuccess: onRemoved });
  return <Dialogo titulo={title} abierto onCerrar={() => { if (!lock.current) onClose(); }}>
    {children}
    <Feedback error={operation.error} />
    {operation.isPending && <p role="status">Eliminando…</p>}
    <div className="acciones-formulario">
      <button type="button" data-autofoco disabled={operation.isPending} onClick={onClose}>Cancelar</button>
      <button type="button" className="peligro" disabled={operation.isPending} onClick={() => {
        if (lock.current) return;
        lock.current = true;
        void operation.mutateAsync().catch(() => {}).finally(() => { lock.current = false; });
      }}>Confirmar eliminación</button>
    </div>
  </Dialogo>;
}
function RemoveEntryDialog({ entry, onClose, unsaved = false, returnTo = base }: { entry: EntryDto; onClose: () => void; unsaved?: boolean; returnTo?: string }) {
  const key = useContext(Scope);
  const qc = useQueryClient();
  const navigate = useNavigate();
  return <RemovalDialog title="Eliminar entrada" remove={() => whatsNewApi.deleteEntry(entry.id, entry.etag)} onClose={onClose} onRemoved={() => {
    // Mark the active detail stale without refetching it before leaving. Lists
    // and the queue refetch when mounted, immediately dropping the entry.
    for (const kind of ["entry", "entries", "queue"]) void qc.invalidateQueries({ queryKey: kind === "entry" ? [...key, kind, entry.id] : [...key, kind], refetchType: "none" });
    navigate(returnTo, { replace: true });
  }}>
    <p>Se retirará la entrada {entry.number} de las listas y de la publicación pública, si estaba visible. Se conserva el historial y no se enviarán correos.</p>
    {unsaved && <p>Los cambios locales sin guardar no formarán parte del historial.</p>}
  </RemovalDialog>;
}
function useOperation() {
  const key = useContext(Scope);
  const qc = useQueryClient();
  const mutation = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: async () => { await qc.invalidateQueries({ queryKey: key }); }, onError: async (error: Error & { status?: number }) => { if (error.status === 401 || error.status === 403) await qc.resetQueries({ queryKey: key }); } });
  return { ...mutation, run: (fn: () => Promise<unknown>) => mutation.mutate(fn) };
}
function useMe() { const key = useContext(Scope); return useQuery({ queryKey: [...key, "me"], queryFn: whatsNewApi.me, staleTime: 0, refetchOnMount: "always" }); }

const leaveWithChanges = () => window.confirm("Hay cambios sin guardar. ¿Quieres salir y descartarlos?");
// BrowserRouter does not support useBlocker. Intercept normal same-origin links,
// and restore the position of a cancelled same-document back/forward traversal.
// Non-SPA navigation/reloads use the native beforeunload prompt.
function useUnsavedNavigation(dirty: boolean) {
  const current = useLocation();
  useEffect(() => {
    if (!dirty) return;
    const idx: unknown = window.history.state?.idx;
    let restoring = false;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const dest = new URL(link.href, window.location.href);
      if (dest.origin !== window.location.origin || (dest.pathname === current.pathname && dest.search === current.search)) return;
      if (!leaveWithChanges()) { event.preventDefault(); event.stopPropagation(); }
    };
    const pop = (event: PopStateEvent) => {
      if (restoring) { restoring = false; return; }
      const next: unknown = event.state?.idx;
      if (typeof idx === "number" && typeof next === "number" && idx !== next && !leaveWithChanges()) {
        restoring = true;
        event.stopImmediatePropagation();
        window.history.go(idx - next);
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", pop, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", pop, true);
    };
  }, [dirty, current.pathname, current.search]);
}

export function LiveWhatsNewPage() {
  return <PrivateScope><PrivateWhatsNew /></PrivateScope>;
}
function PrivateWhatsNew() {
  const me = useMe();
  const [chosen, setChosen] = useState<string | null>(null);
  const [workDirty, setWorkDirty] = useState(false);
  if (me.isPending) return <Loading />;
  if (me.error) return <><Feedback error={me.error} /><button onClick={() => me.refetch()}>Reintentar</button></>;
  const actor = me.data;
  const dev = actor.areas.includes("desarrollo") && can(actor, "updates.whats_new.author");
  const test = actor.areas.includes("soporte") && can(actor, "updates.whats_new.test");
  const read = actor.views.includes("lectura");
  const browseEntries = dev || actor.superAdmin === true;
  const view = chosen && ((chosen === "desarrollador" && browseEntries) || (chosen === "asesor" && test))
    ? chosen : dev ? "desarrollador" : test ? "asesor" : browseEntries ? "desarrollador" : read ? "lectura" : null;
  if (!can(actor, "updates.whats_new.view") || !view) return <div className="alerta-error" role="alert">No tienes un área y permisos habilitados para esta opción. Solicita acceso al administrador.</div>;
  const choose = (next: string) => { if (view !== next && (!workDirty || leaveWithChanges())) setChosen(next); };
  return <div className="qhdn-pagina">{browseEntries && test && <div className="qhdn-visiones"><div className="qhdn-selector-vision" role="group" aria-label="Visión"><button aria-pressed={view === "desarrollador"} onClick={() => choose("desarrollador")}>{dev ? "Desarrollador" : "Entradas del equipo"}</button><button aria-pressed={view === "asesor"} onClick={() => choose("asesor")}>Asesor</button></div></div>}
    <Routes>
      <Route path="nueva" element={dev ? <LiveForm me={actor} /> : <p role="alert">No tienes permiso para crear entradas.</p>} />
      <Route path=":id/editar" element={dev ? <LoadForm me={actor} /> : <p role="alert">No tienes permiso para editar entradas.</p>} />
      <Route path=":id/corregir" element={dev || can(actor, "configuration.whats_new.manage") ? <LoadForm me={actor} correction /> : <p role="alert">No tienes permiso para corregir entradas.</p>} />
      <Route path="reportes" element={actor.canUseSavedReports ? <SavedReports /> : <p role="alert">No tienes permiso para ver los reportes guardados.</p>} />
      <Route path=":id" element={<LiveEntry me={actor} developerView={view === "desarrollador"} onDirtyChange={setWorkDirty} />} />
      <Route index element={view === "desarrollador" ? <DeveloperList me={actor} canCreate={dev} /> : <LiveList me={actor} onDirtyChange={setWorkDirty} />} />
    </Routes>
  </div>;
}

const developerTabs = [["todas", "Todas"], ["borradores", "Borradores"], ["publicadas", "Publicadas"]] as const;
type DeveloperTab = typeof developerTabs[number][0];
type DeveloperPage = Page<EntrySummary> & { tabCounts?: Record<DeveloperTab, number> };
const localDate = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Bogota" });
function prettyDate(date: string) { const value = new Date(date); return Number.isNaN(value.valueOf()) ? "—" : localDate.format(value); }
function statusDetail(row: EntrySummary) {
  if (row.status === "borrador" && (!row.type || !row.system || !row.primaryRoute || !row.summary)) return "Faltan campos";
  if (row.status === "en_pruebas" && row.holder) return `${row.holder.displayName} · ${row.checklistDone} de ${row.checklistTotal}`;
  if (row.openFindings > 0) return `${row.openFindings} ${row.openFindings === 1 ? "hallazgo vigente" : "hallazgos vigentes"}`;
  return null;
}
function DeveloperList({ me, canCreate }: { me: Me; canCreate: boolean }) {
  const key = useContext(Scope);
  const tabsId = useId();
  const [tab, setTab] = useState<DeveloperTab>("todas");
  const [scope, setScope] = useState(me.superAdmin && !canCreate ? "all" : "mine");
  const [type, setType] = useState(""); const [system, setSystem] = useState(""); const [status, setStatus] = useState("");
  const [q, setQ] = useState(""); const [page, setPage] = useState(1);
  const mayListTeam = me.superAdmin === true || can(me, "updates.whats_new.view_all") || can(me, "configuration.whats_new.manage");
  const showAuthor = mayListTeam && scope === "all";
  const filters = { tab, scope: showAuthor ? "all" : "mine", type, system, status, q, page, pageSize: 20 };
  const entries = useQuery({ queryKey: [...key, "entries", filters], queryFn: async (): Promise<DeveloperPage> => whatsNewApi.list(filters) });
  const useTab = (value: DeveloperTab) => { setTab(value); setPage(1); };
  const change = (set: (v: string) => void, value: string) => { set(value); setPage(1); };
  return <>
    <header className="qhdn-encabezado">
      <h1>Qué hay de nuevo · {canCreate ? "Mis entradas" : "Entradas del equipo"}</h1>
      <div className="qhdn-fila">
        {me.canUseSavedReports && <Link className="qhdn-enlace-reportes" to={`${base}/reportes`}>Reportes guardados</Link>}
        {canCreate && <Link className="qhdn-boton-primario-enlace" to={`${base}/nueva`}><Plus size={16} aria-hidden="true" /> Nueva entrada</Link>}
      </div>
    </header>
    <p className="alerta alerta-info qhdn-aviso-desarrollador">Las entradas publicadas se consultan en solo lectura. El detalle muestra el avance de las pruebas y sus hallazgos; puedes corregir una entrada propia cuando el estado lo permite.</p>
    <div className="qhdn-filtros-desarrollador" role="search" aria-label="Filtrar mis entradas">
      {mayListTeam && <label>Ver<select value={scope} onChange={e => change(setScope, e.target.value)}><option value="mine">Mis entradas</option><option value="all">Todo el equipo</option></select></label>}
      <label>Tipo<select value={type} onChange={e => change(setType, e.target.value)}><option value="">Todos</option>{types.map(t => <option key={t} value={t}>{ETIQUETAS_TIPO_CORTAS[t]}</option>)}</select></label>
      <label>Sistema<select value={system} onChange={e => change(setSystem, e.target.value)}><option value="">Todos</option><option value="sag_web">SAG Web</option><option value="sag_clasico">SAG Clásico</option></select></label>
      <label>Estado<select value={status} onChange={e => change(setStatus, e.target.value)}><option value="">Todos</option>{Object.entries(ETIQUETAS_ESTADO_QHDN).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="qhdn-filtro-busqueda">Buscar por ruta o texto<input type="search" value={q} maxLength={100} placeholder="Ruta o texto" onChange={e => change(setQ, e.target.value)} /></label>
    </div>
    <div className="qhdn-pestanas qhdn-pestanas-desarrollador" role="tablist" aria-label="Entradas por publicación">
      {developerTabs.map(([value,label], index) => <button key={value} type="button" role="tab" id={`${tabsId}-${value}`} aria-selected={tab === value} aria-controls={`${tabsId}-panel`} tabIndex={tab === value ? 0 : -1} onClick={() => useTab(value)} onKeyDown={event => {
        const next = event.key === "Home" ? 0 : event.key === "End" ? developerTabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % developerTabs.length : event.key === "ArrowLeft" ? (index + developerTabs.length - 1) % developerTabs.length : null;
        if (next !== null) { event.preventDefault(); const target = developerTabs[next][0]; useTab(target); document.getElementById(`${tabsId}-${target}`)?.focus(); }
      }}>{label}{entries.data?.tabCounts?.[value] !== undefined && !entries.error && <span className="qhdn-conteo">{entries.data.tabCounts[value]}</span>}</button>)}
    </div>
    <section id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} tabIndex={0}>
      {entries.isPending ? <Loading /> : entries.error ? <><Feedback error={entries.error} /><button type="button" onClick={() => entries.refetch()}>Reintentar</button></> : <>
        {entries.data.items.length === 0 ? <div className="tarjeta">No hay entradas con estos filtros.</div> : <div className="qhdn-tabla-contenedor qhdn-tabla-desarrollador"><table>
          <caption className="sr-only">{showAuthor ? "Entradas de todo el equipo" : "Mis entradas"}</caption>
          <thead><tr><th scope="col">Tipo</th><th scope="col">Ruta</th><th scope="col">Qué cambió</th><th scope="col">Sistema</th>{showAuthor && <th scope="col">Desarrollador</th>}<th scope="col">Estado</th><th scope="col">Creada</th><th scope="col">Acción</th></tr></thead>
          <tbody>{entries.data.items.map(e => {
            const detail = statusDetail(e);
            const continueDraft = canCreate && e.status === "borrador" && e.developer.id === me.user.id;
            return <tr key={e.id}><td><EtiquetaTipo tipo={e.type} /></td><td className="qhdn-celda-ruta">{e.primaryRoute || "—"}<small className="qhdn-detalle-estado">{e.number}</small></td>
              <td className="qhdn-celda-resumen">{e.summary || <span className="texto-ayuda">Sin descripción</span>}</td><td><EtiquetaSistema sistema={e.system} /></td>{showAuthor && <td>{e.developer.displayName}</td>}
              <td><EtiquetaEstadoQhdn estado={e.status} />{detail && <small className="qhdn-detalle-estado">{detail}</small>}</td><td><time dateTime={e.createdAt}>{prettyDate(e.createdAt)}</time></td>
              <td><div className="acciones-tabla"><Link className="qhdn-accion-fila" to={`${base}/${e.id}${continueDraft ? "/editar" : ""}`} aria-label={`${continueDraft ? "Continuar" : "Ver detalle de"} ${e.number}`}>{continueDraft ? "Continuar" : "Ver detalle"}</Link></div></td></tr>;
          })}</tbody>
        </table></div>}
        <PageControl page={page} total={entries.data.total} size={entries.data.pageSize} onChange={setPage} />
      </>}
    </section>
  </>;
}

const advisorTabs = [["sin_probar", "Sin probar"], ["en_pruebas", "En pruebas"], ["aprobadas", "Aprobadas"], ["fallidas", "Fallidas"]] as const;
type AdvisorTab = typeof advisorTabs[number][0];
function previousBogotaMonth() {
  const date = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = Number(date.find(part => part.type === "year")?.value);
  const month = Number(date.find(part => part.type === "month")?.value);
  return `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}`;
}
function LiveList({ me, onDirtyChange }: { me: Me; onDirtyChange: (value: boolean) => void }) {
  const key = useContext(Scope);
  const navigate = useNavigate();
  const tabsId = useId();
  const [params, setParams] = useSearchParams();
  const [defaultMonth] = useState(previousBogotaMonth);
  const [report, setReport] = useState(false);
  const [notice, setNotice] = useState("");
  const dirty = useRef(false);
  const reportDirty = useCallback((value: boolean) => { dirty.current = value; onDirtyChange(value); }, [onDirtyChange]);
  const reportOnly = !can(me, "updates.whats_new.test") && !can(me, "updates.whats_new.view_all") && !can(me, "configuration.whats_new.manage") && can(me, "updates.whats_new.report");
  const tabs = reportOnly ? advisorTabs.slice(2) : advisorTabs;
  const tab = tabs.find(([value]) => value === params.get("tab"))?.[0] ?? tabs[0][0];
  const done = tab === "aprobadas" || tab === "fallidas";
  const result = tab === "aprobadas" ? "sin_errores" : tab === "fallidas" ? "fallidas" : undefined;
  const type = types.find(value => value === params.get("type")) ?? "";
  const requestedSystem = params.get("system");
  const system = requestedSystem === "sag_web" || requestedSystem === "sag_clasico" ? requestedSystem : "";
  const rawMonth = params.get("createdMonth") ?? "";
  const createdMonth = rawMonth === "all" ? "" : /^\d{4}-(?:0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : defaultMonth;
  const q = (params.get("q") ?? "").slice(0, 100);
  const rawPage = params.get("page") ?? "";
  const page = /^[1-9]\d{0,3}$/.test(rawPage) ? Number(rawPage) : 1;
  const assignedToMe = tab === "sin_probar" && params.get("assignedToMe") === "true" ? "true" : undefined;
  const testingByMe = tab === "en_pruebas" && params.get("testingByMe") === "true" ? "true" : undefined;
  const selected = params.get("entry");
  const filters = { tab: done ? "probadas" : tab, result, type, system, createdMonth, q, page, pageSize: 20, assignedToMe, testingByMe };
  const entries = useQuery({ queryKey: [...key, "queue", filters], queryFn: () => whatsNewApi.list(filters, true), refetchOnWindowFocus: true, refetchInterval: 60 * 60 * 1000 });
  const active = entries.data?.items.find(row => row.id === selected);
  const unselected = new URLSearchParams(params);
  unselected.delete("entry");
  const returnTo = `${base}${unselected.size ? `?${unselected}` : ""}`;
  useEffect(() => {
    if (!selected || !entries.isSuccess || active) return;
    // Do not unmount an editor with unsaved data because a background refetch
    // changed membership. The explicit navigation guard remains in force.
    if (dirty.current) return;
    setNotice("La entrada ya no está disponible con estos filtros.");
    setParams(current => { const clean = new URLSearchParams(current); clean.delete("entry"); return clean; }, { replace: true });
  }, [selected, active, entries.isSuccess, setParams]);
  function change(field: string, value: string, keepPage = false, replace = false) {
    if (dirty.current && !leaveWithChanges()) return false;
    setNotice("");
    setParams(current => {
      const next = new URLSearchParams(current);
      next.delete("entry");
      if (!keepPage) next.delete("page");
      if (value) next.set(field, value);
      else next.delete(field);
      return next;
    }, { replace, preventScrollReset: true });
    return true;
  }
  const selectEntry = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("entry", id);
    return `${base}?${next}`;
  };
  return <>
    <header className="qhdn-encabezado qhdn-asesor-encabezado">
      <div><h1>Qué hay de nuevo · Bandeja de pruebas</h1></div>
      <div className="qhdn-fila"><button type="button" disabled={entries.isFetching} onClick={() => void entries.refetch()}>Actualizar bandeja</button>
        {me.canUseSavedReports && <Link className="qhdn-enlace-reportes" to={`${base}/reportes`}>Reportes guardados</Link>}
        {done && can(me, "updates.whats_new.report") && <button className="primario" type="button" onClick={() => { if (!dirty.current) setReport(true); }} disabled={dirty.current}>{me.canUseSavedReports ? "Preparar reporte privado" : "Vista previa del reporte"}</button>}</div>
    </header>
    <div className="qhdn-pestanas qhdn-asesor-pestanas" role="tablist" aria-label="Pruebas">
      {tabs.map(([value, label], index) => <button key={value} type="button" role="tab" id={`${tabsId}-${value}`} aria-selected={tab === value} aria-controls={`${tabsId}-panel`} tabIndex={tab === value ? 0 : -1}
        onClick={() => change("tab", value)} onKeyDown={event => {
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
            event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
          if (next !== null) { event.preventDefault(); const target = tabs[next][0]; if (change("tab", target)) document.getElementById(`${tabsId}-${target}`)?.focus(); }
        }}>{label}{tab === value && entries.data && !entries.error && <span className="qhdn-conteo" aria-hidden="true">{entries.data.total}</span>}</button>)}
    </div>
    <div className="qhdn-asesor-filtros" role="search" aria-label="Filtrar bandeja de pruebas">
      <label>Tipo<select value={type} onChange={e => change("type", e.target.value)}><option value="">Todos</option>{types.map(t => <option key={t} value={t}>{ETIQUETAS_TIPO_CORTAS[t]}</option>)}</select></label>
      <label>Sistema<select value={system} onChange={e => change("system", e.target.value)}><option value="">Todos</option><option value="sag_web">SAG Web</option><option value="sag_clasico">SAG Clásico</option></select></label>
      <label>Mes de creación<input type="month" value={createdMonth} onChange={e => change("createdMonth", e.target.value || "all")} /></label>
      <label>Buscar<input type="search" value={q} maxLength={100} placeholder="Ruta o texto" onChange={e => change("q", e.target.value, false, true)} /></label>
      {tab === "sin_probar" && <label className="qhdn-check"><input type="checkbox" checked={!!assignedToMe} onChange={e => change("assignedToMe", e.target.checked ? "true" : "")} />Asignadas a mí inicialmente</label>}
      {tab === "en_pruebas" && <label className="qhdn-check"><input type="checkbox" checked={!!testingByMe} onChange={e => change("testingByMe", e.target.checked ? "true" : "")} />Probando yo</label>}
    </div>
    {notice && <p role="status">{notice}</p>}
    <div className={selected ? "qhdn-asesor-workspace tiene-detalle" : "qhdn-asesor-workspace"}>
      <section id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
        {entries.isPending ? <Loading /> : entries.error ? <><Feedback error={entries.error} /><button type="button" onClick={() => void entries.refetch()}>Reintentar</button></> :
          <>{entries.data.items.length ? <ul className="qhdn-asesor-lista" aria-label="Entradas de la bandeja">{entries.data.items.map(e => {
            const person = tab === "sin_probar" ? e.initialAssigneeName : tab === "en_pruebas" ? e.holder?.displayName : e.lastTesterName;
            const personLabel = tab === "sin_probar" ? "Asesor asignado" : tab === "en_pruebas" ? "En pruebas por" : "Última persona que probó";
            return <li key={e.id} className={selected === e.id ? "qhdn-asesor-fila seleccionada" : "qhdn-asesor-fila"}>
              <div className="qhdn-etiquetas"><strong>{e.number}</strong><EtiquetaTipo tipo={e.type} /><EtiquetaSistema sistema={e.system} />{tab === "aprobadas" && typeof e.showToClients === "boolean" && <span className="qhdn-detalle-estado">{visibilityLabel(e.showToClients, me.publicEnabled)}</span>}</div>
              <p>{e.summary || "Sin descripción"}{e.primaryRoute && <small className="qhdn-detalle-estado">{e.primaryRoute}</small>}</p>
              <div className="qhdn-asesor-fila-meta"><span>{personLabel}: <strong>{person || "—"}</strong></span><time dateTime={e.createdAt}>{prettyDate(e.createdAt)}</time>
                <Link className="qhdn-accion-fila" to={selectEntry(e.id)} preventScrollReset aria-current={selected === e.id ? "location" : undefined} aria-label={`Ver detalle de ${e.number}`}>Ver detalle</Link></div>
            </li>;
          })}</ul> : <p className="tarjeta">No hay entradas con estos filtros.</p>}
          <PageControl page={page} total={entries.data.total} size={entries.data.pageSize} onChange={value => change("page", String(value), true)} /></>}
      </section>
      {selected && (active || dirty.current) && <section className="qhdn-asesor-detalle" aria-label="Entrada seleccionada">
        <LiveEntry key={selected} entryId={selected} me={me} developerView={false} returnTo={returnTo}
          onDirtyChange={reportDirty} />
      </section>}
    </div>
    {report && <ReportDialog filters={{ type, system, createdMonth, q }} result={result} onClose={() => setReport(false)} onSaved={me.canUseSavedReports ? id => navigate(`${base}/reportes/${encodeURIComponent(id)}`) : undefined} />}
  </>;
}

const emptyForm = (): DatosFormulario => ({ tipo: null, sistema: null, rutas: [rutaVacia()], queCambio: null, acciones: [], cliente: "", asesorInicialId: "", reglasNegocio: [], videos: [] });
type LiveDraftForm = DatosFormulario & { clientSelection?: ErpClientLookup | null };
function ReferenceFields({ group, value, onChange, onUpload }: { group: "reglasNegocio" | "videos"; value: Adjunto[]; onChange: (items: Adjunto[]) => void; onUpload?: () => void }) {
  const fieldId = useId();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [link, setLink] = useState({ label: "", url: "" });
  const [error, setError] = useState("");
  const video = group === "videos";
  const title = video ? "Video de entrega" : "Reglas de negocio";
  function add() {
    try {
      const url = new URL(link.url);
      if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2000) throw new Error();
      onChange([...value, { id: crypto.randomUUID(), clase: "enlace", nombre: link.label.trim(), url: url.href }]);
      setLink({ label: "", url: "" }); setError(""); setAddMode(false);
    } catch { setError("Usa un enlace HTTPS válido, sin credenciales."); }
  }
  return <section className="qhdn-referencia-desarrollador" aria-labelledby={`${fieldId}-title`}>
    <h3 id={`${fieldId}-title`}>{video ? "9." : "8."} {title}</h3>
    <div className="qhdn-referencia-barra"><div className="qhdn-referencia-valores">
      {value.length === 0 ? <p className="texto-ayuda">Sin referencias añadidas.</p> : <ul aria-label={video ? "Videos de entrega" : "Referencias de reglas de negocio"}>{value.map(item => <li key={item.id}><span>{item.clase === "archivo" ? <BotonDescargaPrivada id={item.id} name={item.nombre} /> : item.nombre || item.url}<small>{item.clase === "archivo" ? "Archivo" : "Enlace"}</small></span><RemoveButton label={`Quitar ${item.nombre || item.url || "archivo adjunto"}`} onClick={() => onChange(value.filter(other => other.id !== item.id))} /></li>)}</ul>}
    </div><button type="button" className="qhdn-referencia-mas" aria-label={`Agregar referencia a ${title}`} aria-expanded={actionsOpen} aria-controls={actionsOpen ? `${fieldId}-actions` : undefined} onClick={() => setActionsOpen(!actionsOpen)}><Plus size={15} aria-hidden="true" /></button></div>
    {actionsOpen && <div className="qhdn-fila qhdn-referencia-opciones" id={`${fieldId}-actions`}>
      <button type="button" onClick={() => { setAddMode(true); setActionsOpen(false); setError(""); }}>Añadir enlace</button>
      <button type="button" disabled={!onUpload} aria-describedby={!onUpload ? "storage-form" : undefined} onClick={() => { setActionsOpen(false); onUpload?.(); }}>Adjuntar archivo</button>
    </div>}
    {addMode && <div className="qhdn-referencia-enlace"><label>Nombre del enlace (opcional)<input value={link.label} maxLength={200} onChange={e => setLink({ ...link, label: e.target.value })} /></label><label>URL HTTPS<input type="url" value={link.url} maxLength={2000} onChange={e => { setLink({ ...link, url: e.target.value }); setError(""); }} /></label>
      {error && <p className="qhdn-error-campo" role="alert">{error}</p>}<div className="qhdn-fila"><button type="button" disabled={!link.url.trim()} onClick={add}>Agregar enlace</button><button type="button" onClick={() => { setAddMode(false); setError(""); }}>Cancelar</button></div></div>}
  </section>;
}

function fieldRequirements(form: LiveDraftForm, clientLabel: string | null) {
  const missing: string[] = [];
  if (!form.tipo) missing.push("tipo");
  if (!form.sistema) missing.push("sistema");
  if (!form.rutas.length || form.rutas.some(r => r.niveles.some(n => !n.valor.trim()))) missing.push("rutas");
  if (docVacio(form.queCambio)) missing.push("qué cambió");
  if (!form.acciones.length) missing.push("acción requerida");
  else if (form.acciones.some(a => docVacio(a.texto))) missing.push("detalle de las acciones");
  if (form.tipo === "nuevo" && !clientLabel) missing.push("cliente del ERP");
  if (form.tipo === "nuevo" && !form.asesorInicialId) missing.push("asesor inicial");
  return missing;
}
function LoadForm({ me, correction = false }: { me: Me; correction?: boolean }) {
  const key = useContext(Scope);
  const { id = "" } = useParams();
  const entry = useQuery({ queryKey: [...key, "entry", id], queryFn: () => whatsNewApi.detail(id) });
  if (entry.isPending) return <Loading />;
  if (entry.error) return <Feedback error={entry.error} />;
  if ((!correction && (entry.data.status !== "borrador" || entry.data.developer.id !== me.user.id)) || (correction && !["sin_probar", "fallida"].includes(entry.data.status))) return <p role="alert">Esta entrada no se puede editar en su estado actual. <Link to={`${base}/${id}`}>Ver detalle</Link></p>;
  return <LiveForm me={me} entry={entry.data} correction={correction} key={id} />;
}
function LiveForm({ me, entry, correction = false }: { me: Me; entry?: EntryDto; correction?: boolean }) {
  const key = useContext(Scope);
  const saveDraft = useMemo(() => createDraftSaveSession(), []);
  const [form, setForm] = useState<LiveDraftForm>(() => entry ? formFromEntry(entry) : emptyForm());
  const [saved, setSaved] = useState<EntryDto | undefined>(entry); const [note, setNote] = useState<DocEnriquecido | null>(null); const [message, setMessage] = useState("");
  const [editRevision, setEditRevision] = useState(0);
  const [committedRevision, setCommittedRevision] = useState(0);
  const [draftPending, setDraftPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [draftError, setDraftError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadBusy = useRef(false);
  const publishing = useRef(false);
  const inFlightDraft = useRef<Promise<EntryDto>>();
  const fileKeys = useRef(new Map<string, string>());
  const rulesInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState(""); const navigate = useNavigate();
  const missingId = useId();
  const actions = useQuery({ queryKey: [...key, "required-actions"], queryFn: () => whatsNewApi.lookup<{ code: string; label: string; isOther: boolean }>("required-actions") });
  const support = useQuery({ queryKey: [...key, "support-users"], queryFn: () => whatsNewApi.lookup("support-users") });
  const op = useOperation();
  const [submitting, setSubmitting] = useState(false);
  const latest = useRef({ form, saved, revision: 0, conflicted: false });
  function update(patch: Partial<LiveDraftForm>) {
    const state = latest.current;
    state.form = { ...state.form, ...patch };
    state.revision++;
    setEditRevision(state.revision);
    if (!state.conflicted) setDraftError(null);
    setForm(state.form);
  }
  const clientLabel = form.clientSelection === undefined ? saved?.clientName ?? null : form.clientSelection?.label ?? null;
  function persistDraft() {
    if (inFlightDraft.current) return inFlightDraft.current;
    const state = latest.current;
    const submitted = state.form;
    const revision = state.revision;
    const selection = submitted.clientSelection;
    if (state.conflicted) return Promise.reject(new Error("El borrador tiene una versión más reciente."));
    setDraftPending(true);
    setDraftError(null);
    const write = saveDraft(draftFromForm(submitted, selection === null ? null : selection?.id), state.saved)
      .then(result => {
        state.saved = result;
        setSaved(result);
        setCommittedRevision(revision);
        if (selection !== undefined && state.form.clientSelection === selection) {
          state.form = { ...state.form, clientSelection: undefined };
          setForm(state.form);
        }
        return result;
      }).catch((error: unknown) => {
        const response = error as { status?: number; data?: { code?: unknown } };
        if (response.status === 409 && (!response.data?.code || response.data.code === "version_desactualizada")) {
          state.conflicted = true;
          setConflict(true);
        }
        setDraftError(error);
        throw error;
      }).finally(() => {
        if (inFlightDraft.current === write) inFlightDraft.current = undefined;
        setDraftPending(false);
      });
    inFlightDraft.current = write;
    return write;
  }
  async function save(publish = false) {
    const state = latest.current;
    if (removing || inFlightDraft.current || publishing.current || uploadBusy.current || state.conflicted || correction) return;
    if (publish) { publishing.current = true; setSubmitting(true); }
    setLocalError("");
    try {
      const result = await persistDraft();
      if (publish) { await op.mutateAsync(() => whatsNewApi.command(result.id, "publish", result.etag)); navigate(`${base}/${result.id}`); }
      else setMessage("Borrador guardado.");
    } catch { /* draft and publish errors are displayed without replacing local edits */ }
    finally { if (publish) { publishing.current = false; setSubmitting(false); } }
  }
  async function upload(file: File, kind: TipoArchivoPrivado, target: DestinoArchivoPrivado) {
    if (!me.storageAvailable || uploadBusy.current || publishing.current) throw new Error("No se puede iniciar otra carga en este momento.");
    validarArchivoPrivado(file, kind);
    uploadBusy.current = true; setUploading(true); setLocalError("");
    try {
      const current = latest.current.saved;
      if (!current || (target !== "que_cambio" && current.type !== "nuevo")) {
        if (correction) throw new Error("La entrada no admite esta referencia.");
        throw new Error("Guarda el borrador antes de adjuntar archivos o pegar imágenes.");
      }
      const fingerprint = JSON.stringify([kind, target, file.name, file.size, file.lastModified, file.type]);
      const key = fileKeys.current.get(fingerprint) ?? crypto.randomUUID();
      fileKeys.current.set(fingerprint, key);
      const result = await subirArchivoPrivado(current.id, file, kind, target, key);
      fileKeys.current.delete(fingerprint);
      return result;
    } finally { uploadBusy.current = false; setUploading(false); }
  }
  async function addReferenceFile(group: "reglasNegocio" | "videos", file?: File) {
    if (!file) return;
    try {
      const media = await upload(file, group === "videos" ? "video" : "documento", group === "videos" ? "video" : "reglas_negocio");
      const current = latest.current.form;
      if (current.tipo === "nuevo") update({ [group]: [...current[group], { id: media.fileId, clase: "archivo", nombre: media.name, url: "" }] });
    } catch (error) { setLocalError(errorMessage(error)); }
  }
  const dirty = editRevision !== committedRevision;
  useUnsavedNavigation(dirty || uploading || draftPending || submitting);
  const formLocked = submitting || op.isPending;
  const mayRemove = !correction && saved?.status === "borrador" && (saved.canDelete ?? entry?.canDelete) === true;
  const missing = fieldRequirements(form, clientLabel);
  const title = correction ? "Corregir y volver a publicar" : saved ? "Editar borrador" : "Nueva entrada";
  return <>
    <header className="qhdn-formulario-cabecera">
      <Link to={base}>← Volver a mis entradas</Link>
      <h1>{title} · Qué hay de nuevo</h1>
      <div className="qhdn-etiquetas"><EtiquetaEstadoQhdn estado={saved?.status ?? "borrador"} />{saved?.number && <span className="qhdn-detalle-identificador">{saved.number}</span>}</div>
    </header>
    <Feedback error={op.error || draftError} />{localError && <p role="alert" className="alerta-error">{localError}</p>}
    <div className="qhdn-formulario-grid qhdn-desarrollador-grid">
      <form className="tarjeta qhdn-formulario qhdn-formulario-desarrollador" onSubmit={e => { e.preventDefault(); void save(); }}>
        <h2>Datos del cambio</h2>
        <fieldset disabled={correction || formLocked || uploading} className="qhdn-fieldset"><legend>1. Tipo *</legend><div className="qhdn-radios qhdn-chips">{types.map(t => <label key={t} className={`qhdn-radio qhdn-chip qhdn-tipo-${t}`}><input type="radio" name="tipo" checked={form.tipo === t} onChange={() => update({ tipo: t, ...(t !== "nuevo" ? { clientSelection: null, asesorInicialId: "", reglasNegocio: [], videos: [] } : {}) })} />{ETIQUETAS_TIPO_CORTAS[t]}</label>)}</div></fieldset>
        <fieldset disabled={correction || formLocked} className="qhdn-fieldset"><legend>2. Sistema *</legend><div className="qhdn-radios qhdn-chips">{[["sag_web", "SAG Web"], ["sag_clasico", "SAG Clásico"]].map(([v,l]) => <label className="qhdn-radio qhdn-chip" key={v}><input type="radio" name="sistema" checked={form.sistema === v} onChange={() => update({ sistema: v as Sistema })} />{l}</label>)}</div></fieldset>
        <p className="qhdn-autor"><strong>Desarrollador:</strong> {entry?.developer.displayName ?? me.user.displayName} <small>Es quien creó la entrada y no se puede cambiar.</small></p>
        <fieldset disabled={correction || formLocked} className="qhdn-fieldset"><legend>3. Rutas *</legend><ConstructorRutas rutas={form.rutas} onChange={rutas => update({ rutas })} /></fieldset>
        <section className="qhdn-formulario-seccion"><h3 id="live-what">4. Qué cambió *</h3>
          <p className="texto-ayuda">Explica qué cambió y en qué caso se nota. No incluyas claves ni otros datos sensibles.</p>
          <EditorEnriquecido valor={form.queCambio} onChange={queCambio => update({ queCambio })} etiquetaId="live-what" perfil="medio" soloLectura={formLocked} archivosPrivados cargarArchivo={me.storageAvailable ? (file, kind) => upload(file, kind, "que_cambio") : undefined} />
        </section>
        <fieldset className="qhdn-fieldset" disabled={formLocked}><legend>5. Acción requerida *</legend>
          <p className="texto-ayuda">Marca las acciones y describe en cada una lo que debe hacer Soporte.</p>
          {actions.isPending && <Loading />}<Feedback error={actions.error} />
          {actions.data?.map(a => <div key={a.code} className="qhdn-accion-desarrollador"><label className="qhdn-check"><input type="checkbox" checked={form.acciones.some(v => v.accionId === a.code)} onChange={e => update({ acciones: e.target.checked ? [...form.acciones, { accionId: a.code, nombre: a.label, texto: null }] : form.acciones.filter(v => v.accionId !== a.code) })} />{a.label}</label>
            {form.acciones.some(v => v.accionId === a.code) && <EditorEnriquecido valor={form.acciones.find(v => v.accionId === a.code)!.texto} onChange={texto => update({ acciones: form.acciones.map(v => v.accionId === a.code ? { ...v, texto } : v) })} tamano="compacto" ariaLabel={`Detalle de ${a.label}`} perfil="compacto" soloLectura={formLocked} />}</div>)}
        </fieldset>
        {form.tipo === "nuevo" && <fieldset className="qhdn-fieldset qhdn-nuevo-desarrollador" disabled={correction || formLocked}><legend>Solo para desarrollos nuevos</legend>
          <div className="qhdn-pares-desarrollador">
            <ErpClientCombobox name={clientLabel} readOnly={correction} scope={key} lookup={whatsNewApi.lookupErpClients} onSelect={clientSelection => update({ clientSelection })} />
            <div><label><span aria-hidden="true">7. </span>Asesor a cargo de las pruebas iniciales *<select value={form.asesorInicialId} onChange={e => update({ asesorInicialId: e.target.value })}><option value="">Seleccione un asesor</option>{support.data?.filter(u => u.id !== me.user.id && u.active !== false).map(u => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></label><Feedback error={support.error} /></div>
            <ReferenceFields group="reglasNegocio" value={form.reglasNegocio} onChange={reglasNegocio => update({ reglasNegocio })} onUpload={me.storageAvailable && !uploading ? () => rulesInput.current?.click() : undefined} />
            <ReferenceFields group="videos" value={form.videos} onChange={videos => update({ videos })} onUpload={me.storageAvailable && !uploading ? () => videoInput.current?.click() : undefined} />
          </div>
          <input ref={rulesInput} type="file" aria-label="Documento de reglas de negocio" accept={aceptaDocumentoPrivado} hidden onChange={e => { void addReferenceFile("reglasNegocio", e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
          <input ref={videoInput} type="file" aria-label="Archivo de video de entrega" accept={tiposVideoPrivado.join(",")} hidden onChange={e => { void addReferenceFile("videos", e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
        </fieldset>}
        {correction && <section className="qhdn-formulario-seccion"><h3 id="live-correction">Nota de corrección</h3><EditorEnriquecido valor={note} onChange={value => { setNote(value); update({}); }} perfil="medio" etiquetaId="live-correction" soloLectura={formLocked} /></section>}
        {me.storageAvailable && !saved && <p className="texto-ayuda">Guarda el borrador antes de adjuntar archivos o pegar imágenes.</p>}
        {!me.storageAvailable && <p className="texto-ayuda" id="storage-form">{storagePending}</p>}
        {uploading && <p className="texto-ayuda" id="storage-form" role="status">Subiendo archivo a almacenamiento privado…</p>}
        <div className="qhdn-pie-formulario">
          <p role="status" className="texto-ayuda">{draftPending ? "Guardando borrador…" : dirty ? "Cambios sin guardar." : message}</p>
          <div className="acciones-formulario">
            {mayRemove && <RemoveButton label="Eliminar entrada" disabled={formLocked || draftPending || uploading} onClick={() => {
              if (!inFlightDraft.current && !uploadBusy.current && !publishing.current) setRemoving(true);
            }} />}
            {correction ? <button type="button" className="primario" disabled={formLocked || uploading} onClick={() => op.mutateAsync(() => whatsNewApi.command(entry!.id, "correct", entry!.etag, { whatChanged: form.queCambio, requiredActions: draftFromForm(form).requiredActions, correctionNote: note, ...richLayoutVersion(entry!.whatChanged) })).then(() => navigate(`${base}/${entry!.id}`)).catch(() => {})}>Corregir y volver a publicar</button> : <>
              <button type="submit" disabled={formLocked || draftPending || uploading || conflict}>Guardar borrador</button>
              <button type="button" className="primario" disabled={formLocked || draftPending || uploading || conflict || missing.length > 0} aria-describedby={missing.length ? missingId : undefined} onClick={() => void save(true)}>Publicar a Soporte</button>
            </>}
          </div>
          {!correction && missing.length > 0 && <p id={missingId} className="texto-ayuda qhdn-campos-faltantes">Para publicar, completa: {missing.join(", ")}.</p>}
        </div>
      </form>
      <aside className="qhdn-panel-lateral qhdn-lateral-desarrollador">
        <section className="tarjeta qhdn-guia-desarrollador"><h2>¿Qué registrar?</h2><ul><li><strong>Nuevo:</strong> una opción o funcionalidad nueva.</li><li><strong>Mejora:</strong> un cambio a una función existente.</li><li><strong>Regla de negocio:</strong> un cambio de comportamiento.</li><li><strong>SP crítico:</strong> un ajuste técnico urgente.</li><li><strong>Rediseño:</strong> un cambio de estructura o experiencia.</li></ul><p>Indica dónde encontrar el cambio y qué debe validar Soporte.</p></section>
        <section className="tarjeta qhdn-previa-desarrollador"><h2>Vista previa para Soporte</h2><div className="qhdn-etiquetas"><EtiquetaTipo tipo={form.tipo} /><EtiquetaSistema sistema={form.sistema} /></div><p className="texto-ayuda">{form.rutas[0] ? rutaTexto(form.rutas[0]) || "Sin ruta" : "Sin ruta"}</p><ReadDoc value={form.queCambio} privateMedia /></section>
      </aside>
    </div>
    {removing && saved && <RemoveEntryDialog entry={saved} unsaved={dirty} onClose={() => setRemoving(false)} />}
  </>;
}

function LiveEntry({ me, developerView, entryId, returnTo = base, onDirtyChange }: { me: Me; developerView: boolean; entryId?: string; returnTo?: string; onDirtyChange?: (dirty: boolean) => void }) {
  const key = useContext(Scope);
  const params = useParams();
  const id = entryId ?? params.id ?? "";
  const detail = useQuery({ queryKey: [...key, "entry", id], queryFn: () => whatsNewApi.detail(id) });
  if (detail.isPending) return <Loading />;
  const status = (detail.error as { status?: number } | null)?.status;
  if (!detail.data || status === 401 || status === 403 || status === 404) return <><Feedback error={detail.error} /><button type="button" onClick={() => detail.refetch()}>Recargar</button></>;
  return <><Feedback error={detail.error} /><EntryContent key={id} me={me} entry={detail.data} developerView={developerView} returnTo={returnTo} onDirtyChange={onDirtyChange} /></>;
}

type RoundState = { id: string | null; etag: string | null; current: RoundProgress; saved: RoundProgress; stale: boolean };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const visibilityLabel = (show: boolean, global: boolean) => !show ? "Privada" : global ? "Visible a clientes" : "Preparada · publicación general desactivada";
function fromRound(round?: RoundDto): RoundState {
  const progress = { items: round?.checklist.map(({ itemNo, checked }) => ({ itemNo, checked })) ?? [], body: round?.noteDraft ?? null };
  return { id: round?.id ?? null, etag: round?.etag ?? null, saved: progress, current: progress, stale: false };
}
function useStableActionKey() {
  const last = useRef<{ intent: string; key: string }>();
  return (intent: unknown) => {
    const payload = JSON.stringify(intent);
    if (last.current?.intent !== payload) last.current = { intent: payload, key: crypto.randomUUID() };
    return last.current.key;
  };
}
function EntryContent({ me, entry: e, developerView, returnTo, onDirtyChange }: { me: Me; entry: EntryDto & Advisors; developerView: boolean; returnTo: string; onDirtyChange?: (dirty: boolean) => void }) {
  const key = useContext(Scope); const qc = useQueryClient();
  const op = useOperation();
  const [confirm, setConfirm] = useState<string | null>(null); const [reason, setReason] = useState("");
  const [approving, setApproving] = useState(false); const [publishChoice, setPublishChoice] = useState<boolean | null>(null);
  const [removing, setRemoving] = useState(false); const [annul, setAnnul] = useState<string | null>(null);
  const [note, setNote] = useState<DocEnriquecido | null>(null);
  const [finding, setFinding] = useState<DocEnriquecido | null>(null);
  const [clientDirty, setClientDirty] = useState(false);
  const [clientEditorVersion, setClientEditorVersion] = useState(0);
  const [feedback, setFeedback] = useState("");
  const persistentKey = useStableActionKey();
  const round = e.rounds.find(r => r.status === "tomada"); const mine = round?.holderId === me.user.id;
  const [progress, setProgress] = useState(() => fromRound(round));
  const progressDirty = !same(progress.current, progress.saved);
  const unsaved = progressDirty || !docVacio(note) || !docVacio(finding) || clientDirty;
  useUnsavedNavigation(unsaved);
  useEffect(() => { onDirtyChange?.(unsaved); }, [onDirtyChange, unsaved]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const tester = me.areas.includes("soporte") && can(me, "updates.whats_new.test");
  const manage = can(me, "configuration.whats_new.manage"); const author = e.developer.id === me.user.id && can(me, "updates.whats_new.author") && me.areas.includes("desarrollo");
  const contributors = [e.developer.id, ...e.log.filter(l => ["editar_borrador", "publicar", "corregir", "corregir_en_nombre"].includes(l.action)).map(l => l.byId)];
  const removed = e.status === "eliminada";
  const mayTest = !removed && !developerView && tester && !contributors.includes(me.user.id);
  const hasPublishingPermission = !removed && !developerView && me.areas.includes("soporte") &&
    can(me, "updates.whats_new.publish_client") && e.type !== "sp_critico";
  const mayApprovePublic = hasPublishingPermission && mayTest && mine;
  const mayToggle = hasPublishingPermission && e.status === "probado";
  const mayEditClientText = e.type !== "sp_critico" && (mayTest && mine || mayToggle);
  const hasClientText = Boolean(e.clientText?.title?.trim()) && !docVacio(safeDisplayDoc(e.clientText?.body ?? null, true));
  useEffect(() => {
    setProgress(current => {
      if ((round?.id ?? null) === current.id && (round?.etag ?? null) === current.etag) return current;
      return !same(current.current, current.saved) ? { ...current, stale: true } : fromRound(round);
    });
  }, [round?.id, round?.etag]);
  const progressWrite = useMutation({
    mutationFn: (submission: { id: string; etag: string; payload: RoundProgress }) => whatsNewApi.progress(submission.id, submission.etag, submission.payload),
    onSuccess: async (result, written) => {
      const committed = result.rounds.find(item => item.id === written.id && item.status === "tomada");
      if (!committed) return;
      await qc.cancelQueries({ queryKey: [...key, "entry", e.id], exact: true });
      setProgress(current => current.id === written.id
        ? { ...current, etag: committed.etag, saved: written.payload, stale: false } : current);
      setFeedback("Avance guardado.");
      // Apply the version returned by the explicit operation without replacing
      // the editor or its locally typed changes after the request started.
      qc.setQueryData([...key, "entry", e.id], result);
      void qc.invalidateQueries({ queryKey: [...key, "queue"] });
      void qc.invalidateQueries({ queryKey: [...key, "entries"] });
    },
  });
  const savingProgress = useRef(false);
  function saveProgress() {
    if (!mine || !mayTest || !progressDirty || !round || !progress.etag || progress.stale || progress.id !== round.id || savingProgress.current || op.isPending) return;
    savingProgress.current = true;
    setFeedback("");
    void progressWrite.mutateAsync({ id: round.id, etag: progress.etag, payload: progress.current }).catch(() => {}).finally(() => { savingProgress.current = false; });
  }
  function editProgress(update: (before: RoundProgress) => RoundProgress) {
    setFeedback("");
    setProgress(current => ({ ...current, current: update(current.current) }));
  }
  const blocking = op.isPending || progressWrite.isPending;
  const canClose = mine && mayTest && !blocking && !unsaved && !progress.stale;
  function command(action: string, data: unknown = {}) { op.run(() => whatsNewApi.command(e.id, action, e.etag, data, persistentKey([e.id, action, data]))); }
  function record(kind: "notes" | "findings", body: DocEnriquecido | null) {
    if (!round || !mine || !mayTest || blocking || docVacio(body)) return;
    const write = { body };
    const url = `/whats-new/rounds/${encodeURIComponent(round.id)}/${kind}`;
    void op.mutateAsync(() => api.post(url, write, mutationOptions(round.etag, true, persistentKey([url, round.etag, write])))).then(() => {
      const setBody = kind === "notes" ? setNote : setFinding;
      setBody(current => same(current, body) ? null : current);
    }).catch(() => {});
  }
  function approve() {
    if (!canClose || publishChoice === null || (publishChoice && (!mayApprovePublic || !hasClientText))) return;
    const data = { publishToClients: publishChoice };
    void op.mutateAsync(() => whatsNewApi.command(e.id, "mark-tested", e.etag, data, persistentKey([e.id, "mark-tested", data])))
      .then(() => { setApproving(false); setPublishChoice(null); }).catch(() => {});
  }
  const findings = <><h3>Hallazgos {developerView && <span className="qhdn-conteo">{e.findings.length}</span>}</h3>{e.findings.length === 0 && <p>Sin hallazgos registrados.</p>}{e.findings.map(f => <article className={developerView ? "qhdn-hallazgo-detalle" : "qhdn-evento"} key={f.id}><h4>Hallazgo {f.number} · Ronda {f.roundNo}</h4><ReadDoc value={f.body} />{f.annulled ? <p>Anulado: {f.annulled.reason}</p> : mine && mayTest && f.roundNo === round.roundNo && <button type="button" disabled={blocking || progressDirty} onClick={() => { setAnnul(f.id); setConfirm("annul"); }}>Anular hallazgo</button>}</article>)}</>;
  const persistedNotes = e.rounds.flatMap(item => item.notes.map(n => ({ ...n, roundNo: item.roundNo })));
  return <><Link className={developerView ? "qhdn-volver-desarrollador" : undefined} to={returnTo}>{developerView ? "← Volver a mis entradas" : "← Volver a la bandeja"}</Link>
    <header className="qhdn-encabezado qhdn-cabecera-detalle">
      <div><h1>{developerView ? "Detalle de la entrada" : e.number}</h1><div className="qhdn-etiquetas">{developerView && <span className="qhdn-detalle-identificador">{e.number}</span>}<EtiquetaTipo tipo={e.type} /><EtiquetaSistema sistema={e.system} /><EtiquetaEstadoQhdn estado={e.status} /></div></div>
      {developerView && author && e.status === "borrador" && <Link className="qhdn-boton-primario-enlace" to={`${base}/${e.id}/editar`}>Continuar edición</Link>}
    </header>
    {developerView && (e.status !== "borrador" || !author) && <p className="alerta alerta-info qhdn-aviso-desarrollador"><strong>Solo lectura.</strong> {(author || manage) && ["sin_probar", "fallida"].includes(e.status) ? "Usa la acción de corrección para modificar el cambio y devolverlo a Soporte." : "En este estado no puedes editar la entrada."}</p>}
    {!approving && <Feedback error={op.error} />}
    <div className="qhdn-fila qhdn-comandos-detalle">
      {author && e.status === "borrador" && <>{!developerView && <Link to={`${base}/${e.id}/editar`}>Editar borrador</Link>}<button type="button" disabled={blocking} onClick={() => command("publish")}>Publicar a Soporte</button></>}
      {!removed && e.canDelete === true && <RemoveButton label="Eliminar entrada" disabled={blocking} onClick={() => setRemoving(true)} />}
      {(author || manage) && ["sin_probar", "fallida"].includes(e.status) && <Link to={`${base}/${e.id}/corregir`}>Corregir y volver a publicar</Link>}
      {!developerView && e.status === "sin_probar" && <button className="primario" type="button" disabled={!mayTest || blocking} onClick={() => command("take")}>Tomar para probar</button>}
      {mine && mayTest && <>
        <button type="button" onClick={() => setConfirm("release")} disabled={blocking}>Soltar</button>
        <button type="button" className="peligro" disabled={!canClose || !e.findings.some(f => f.roundNo === round.roundNo && !f.annulled)} onClick={() => command("mark-failed")}>Marcar fallida</button>
        <button type="button" className="primario" disabled={!canClose || round.checklist.some(c => !c.checked)} onClick={() => { op.reset(); setPublishChoice(null); setApproving(true); }}>Aprobar</button>
      </>}
      {!removed && !developerView && manage && round && !mine && <button type="button" disabled={blocking} onClick={() => setConfirm("force-release")}>Forzar Soltar</button>}
      {!developerView && manage && e.status === "probado" && <button type="button" disabled={blocking} onClick={() => setConfirm("archive")}>Archivar</button>}
    </div>
    {!developerView && e.status === "sin_probar" && !mayTest && <p>Probar exige área Soporte y permiso de pruebas; quien creó o corrigió la entrada no puede probarla.</p>}
    {round && !mine && <p>En pruebas por {round.holderName}. Solo lectura.</p>}
    <div className={developerView ? "qhdn-detalle-grid qhdn-desarrollador-grid" : "qhdn-asesor-detalle-grid"}><section className="tarjeta">
      <h2>Datos del cambio</h2>
      <dl className="qhdn-datos"><dt>Desarrollador</dt><dd>{e.developer.displayName}</dd>
        {developerView ? <><dt>Asesores que han probado</dt><dd>{e.participants.filter(p => p.role === "asesor").map(p => p.displayName).join(", ") || "Ninguno todavía"}</dd></> :
          <><dt>Asesor asignado</dt><dd>{e.initialAssigneeName || "—"}</dd><dt>En pruebas por</dt><dd>{round?.holderName || "—"}</dd><dt>Última persona que probó</dt><dd>{e.lastTesterName || "—"}</dd></>}
        {e.clientName && <><dt>Cliente</dt><dd>{e.clientName}</dd></>}<dt>Creada</dt><dd><time dateTime={e.createdAt}>{prettyDate(e.createdAt)}</time></dd>
      </dl>
      <h3>Dónde se encuentra</h3><ul>{e.routes.map((r,i) => <li key={i}>{[r.via === "barra_lateral" ? "Barra lateral" : "Barra de navegación", ...r.submenus, r.option].join(" › ")}</li>)}</ul><h3>Qué cambió</h3><ReadDoc value={e.whatChanged} privateMedia />
      <h3>Acción requerida</h3>{e.requiredActions.map(a => <section key={a.code}><h4>{a.label}</h4><ReadDoc value={a.detail} /></section>)}
      {e.attachments.length > 0 && <section><h3>Referencias internas</h3><ul>{e.attachments.map((a,i) => <li key={i}>{a.group === "video" ? "Video" : "Reglas de negocio"}: {a.kind === "archivo" ? <BotonDescargaPrivada id={a.fileId} name={a.name || "Archivo adjunto"} /> : /^https:\/\//i.test(a.url) ? <a href={a.url} target="_blank" rel="noopener noreferrer">{a.label || a.url}</a> : "Enlace no disponible"}</li>)}</ul></section>}
    </section><aside className="qhdn-panel-lateral">
      {!developerView && (round || progress.stale) && <section className="tarjeta qhdn-asesor-progreso"><h3>Avance de pruebas</h3>
        <progress max={progress.current.items.length || 1} value={progress.current.items.filter(item => item.checked).length} aria-label="Avance del checklist" />
        {round?.checklist.map(item => <label className="qhdn-check" key={item.itemNo}><input type="checkbox" checked={progress.current.items.find(value => value.itemNo === item.itemNo)?.checked ?? item.checked} disabled={!mine || !mayTest || progress.stale || op.isPending} onChange={event => {
          const checked = event.target.checked;
          editProgress(current => ({ ...current, items: current.items.map(value => value.itemNo === item.itemNo ? { ...value, checked } : value) }));
        }} />{item.label}</label>)}
        {(mine && mayTest || progress.stale) && <>
          <EditorEnriquecido valor={progress.current.body} onChange={body => editProgress(current => ({ ...current, body: docVacio(body) ? null : body }))} perfil="medio" tamano="compacto" ariaLabel="Borrador de avance" soloLectura={progress.stale || op.isPending} />
          <Feedback error={progressWrite.error} />
          {progress.stale && <p role="alert">La ronda cambió en otra sesión. El avance local se conserva; copia lo necesario antes de recargar.</p>}
          <p role="status" className="texto-ayuda">{progressWrite.isPending ? "Guardando avance…" : progressDirty ? "Avance sin guardar." : feedback}</p>
          <button type="button" className="primario" disabled={!mine || !mayTest || !progressDirty || progress.stale || blocking} onClick={saveProgress}>Guardar avance</button>
          <p className="texto-ayuda">Completa y guarda el checklist para aprobar. Guarda o limpia los borradores antes de cerrar la prueba.</p>
        </>}
      </section>}
      {!developerView && <ClientText key={clientEditorVersion} entry={e} editable={mayEditClientText} mayToggle={mayToggle} globalPublic={me.publicEnabled} onDirtyChange={setClientDirty} busy={blocking} />}
      <section className="tarjeta"><h3>Notas de prueba</h3>{!persistedNotes.length && <p>Sin notas registradas.</p>}
        {persistedNotes.map(n => <article className="qhdn-evento" key={n.id}><p>Ronda {n.roundNo} · <time dateTime={n.createdAt}>{prettyDate(n.createdAt)}</time></p><ReadDoc value={n.body} /></article>)}
        {mine && mayTest && <details><summary>Agregar una nota</summary><EditorEnriquecido valor={note} onChange={setNote} perfil="medio" ariaLabel="Nota de prueba" tamano="compacto" />
          <button type="button" disabled={docVacio(note) || blocking || progressDirty} onClick={() => record("notes", note)}>Guardar nota</button></details>}
      </section>
      <section className="tarjeta">{findings}
        {mine && mayTest && <details><summary>Agregar un hallazgo</summary><EditorEnriquecido valor={finding} onChange={setFinding} perfil="medio" ariaLabel="Nuevo hallazgo" tamano="compacto" />
          <button type="button" disabled={docVacio(finding) || blocking || progressDirty} onClick={() => record("findings", finding)}>Registrar hallazgo</button><p className="texto-ayuda">Registrar un hallazgo no envía correo.</p></details>}
      </section>
      <div className="tarjeta"><h3>Historial y rondas de prueba</h3>{e.rounds.map(r => <details key={r.id}><summary>Ronda {r.roundNo} · {r.holderName} · {r.status}</summary><ul>{r.checklist.map(c => <li key={c.itemNo}>{c.checked ? "✓" : "○"} {c.label}</li>)}</ul></details>)}<ol>{e.log.map((l,i) => <li key={i}><time>{new Date(l.at).toLocaleString("es-CO", { timeZone: "America/Bogota" })}</time> · {l.byId}: {l.action.replaceAll("_", " ")}{l.reason && ` · ${l.reason}`}</li>)}</ol></div>
    </aside></div>
    <Dialogo titulo="Aprobar entrada" abierto={approving} onCerrar={() => { if (!blocking) { setApproving(false); setPublishChoice(null); } }}>
      <p>Elige si esta novedad aprobada podrá mostrarse a los clientes. Esta acción no envía correos.</p>
      <fieldset disabled={blocking}><legend>¿Mostrar a clientes?</legend>
        <label className="qhdn-radio"><input type="radio" name="qhdn-publicar-decision" checked={publishChoice === true} disabled={!mayApprovePublic || !hasClientText} onChange={() => setPublishChoice(true)} />Sí, mostrar a clientes</label>
        <label className="qhdn-radio"><input type="radio" name="qhdn-publicar-decision" checked={publishChoice === false} onChange={() => setPublishChoice(false)} />No, mantener privada</label>
      </fieldset>
      {(!mayApprovePublic || !hasClientText) && <p className="texto-ayuda">{e.type === "sp_critico" ? "Los SP críticos no se muestran a clientes." : !mayApprovePublic ? "Tu cuenta puede aprobar, pero no publicar a clientes." : "Guarda primero un título y texto para clientes distintos del contenido interno."}</p>}
      {publishChoice === true && !me.publicEnabled && <p className="texto-ayuda">La publicación general está desactivada. Esta entrada quedará preparada, pero no se mostrará todavía.</p>}
      <Feedback error={approving ? op.error : null} />
      <div className="acciones-formulario"><button type="button" data-autofoco disabled={blocking} onClick={() => { setApproving(false); setPublishChoice(null); }}>Cancelar</button><button type="button" className="primario" disabled={!canClose || publishChoice === null || (publishChoice && (!mayApprovePublic || !hasClientText))} onClick={approve}>Confirmar aprobación</button></div>
    </Dialogo>
    <Dialogo titulo={confirm === "release" ? "Soltar y reiniciar la prueba" : "Confirmar acción"} abierto={!!confirm} onCerrar={() => { setConfirm(null); setReason(""); }}>
      {confirm === "release" ? <><p>La entrada volverá a Sin probar y la próxima prueba empezará vacía. Se conserva la historia de esta ronda. No se enviará ningún correo.</p>{unsaved && <p>Esta acción descarta los cambios locales sin guardar.</p>}</> : <label>Motivo (10 a 500 caracteres)<textarea value={reason} minLength={10} maxLength={500} onChange={ev => setReason(ev.target.value)} /></label>}
      <button type="button" className="primario" disabled={blocking || (confirm !== "release" && reason.trim().length < 10)} onClick={() => {
        const action = confirm!;
        if (action === "annul") { const path = `/whats-new/findings/${encodeURIComponent(annul!)}/annul`; op.run(() => api.post(path, { reason }, mutationOptions(round?.etag ?? e.etag, true, persistentKey([path, reason])))); }
        else if (action === "release") {
          void op.mutateAsync(() => whatsNewApi.command(e.id, "release", e.etag, {}, persistentKey([e.id, "release"]))).then(() => {
            setProgress(fromRound()); setNote(null); setFinding(null); setClientEditorVersion(version => version + 1);
          }).catch(() => {});
        } else command(action, { reason });
        setConfirm(null); setReason("");
      }}>Confirmar</button>
    </Dialogo>
    {removing && <RemoveEntryDialog entry={e} returnTo={returnTo} onClose={() => setRemoving(false)} unsaved={unsaved} />}
  </>;
}

function ClientText({ entry, editable, mayToggle, globalPublic, onDirtyChange, busy }: { entry: EntryDto; editable: boolean; mayToggle: boolean; globalPublic: boolean; onDirtyChange: (dirty: boolean) => void; busy: boolean }) {
  const key = useContext(Scope); const qc = useQueryClient();
  const source = () => ({ title: entry.clientText?.title ?? "", body: entry.clientText?.body ?? null, etag: entry.clientText?.etag ?? entry.etag });
  const [saved, setSaved] = useState(source);
  const [title, setTitle] = useState(saved.title);
  const [body, setBody] = useState<DocEnriquecido | null>(saved.body);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState("");
  const op = useOperation(); const persistentKey = useStableActionKey();
  const dirty = title !== saved.title || !same(body, saved.body);
  const safeBody = useMemo(() => safeDisplayDoc(body, true), [body]);
  useEffect(() => { onDirtyChange(dirty); }, [onDirtyChange, dirty]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    const current = source();
    if (current.etag === saved.etag) return;
    if (dirty) { setStale(true); return; }
    setSaved(current); setTitle(current.title); setBody(current.body); setStale(false);
  }, [entry.etag, entry.clientText?.etag]);
  const shown = entry.clientText?.showToClients === true;
  const mayShow = Boolean(entry.clientText?.title?.trim()) && !docVacio(safeDisplayDoc(entry.clientText?.body ?? null, true));
  function save() {
    if (!editable || !dirty || stale || busy || op.isPending) return;
    const written = { title: title.trim() || null, body: safeBody };
    const path = `/whats-new/entries/${encodeURIComponent(entry.id)}/client-text`;
    setMessage("");
    void op.mutateAsync(async () => {
      const result = await api.put<EntryDto>(path, written, mutationOptions(saved.etag));
      if (result.clientText) {
        setSaved({ title, body, etag: result.clientText.etag });
        qc.setQueryData([...key, "entry", entry.id], result);
      }
      setMessage("Texto para clientes guardado.");
    }).catch(() => {});
  }
  function toggleVisibility() {
    if (!mayToggle || busy || op.isPending || dirty || (!shown && !mayShow)) return;
    const body = { showToClients: !shown };
    void op.mutateAsync(() => whatsNewApi.command(entry.id, "set-client-visibility", entry.etag, body, persistentKey([entry.id, "visibility", body]))).catch(() => {});
  }
  return <section className="tarjeta"><h3>Para clientes</h3>
    <p className="qhdn-detalle-estado">Estado: <strong>{visibilityLabel(shown && entry.status === "probado" && entry.type !== "sp_critico", globalPublic)}</strong></p>
    <p>Redacta un texto público independiente. El contenido interno no se publica.</p>
    {entry.type === "sp_critico" && <p>Los SP críticos nunca se publican.</p>}
    <label>Título para clientes<input value={title} maxLength={120} disabled={!editable || busy || stale} onChange={e => { setMessage(""); setTitle(e.target.value); }} /></label>
    <EditorEnriquecido valor={safeBody} onChange={value => { setMessage(""); setBody(docVacio(value) ? null : value); }} perfil="cliente" ariaLabel="Texto para clientes" tamano="compacto" soloLectura={!editable || busy || stale} />
    <Feedback error={op.error} />{stale && <p role="alert">El texto se actualizó en otra sesión. Tus cambios locales se conservan; copia lo necesario antes de recargar.</p>}
    <p role="status" className="texto-ayuda">{op.isPending ? "Guardando…" : dirty ? "Texto para clientes sin guardar." : message}</p>
    {(editable || mayToggle) && <div className="qhdn-fila">
      {editable && <button type="button" disabled={!dirty || stale || busy || op.isPending} onClick={save}>Guardar texto para clientes</button>}
      {mayToggle && <button type="button" disabled={stale || dirty || busy || op.isPending || (!shown && !mayShow)} onClick={toggleVisibility}>{shown ? "Ocultar a clientes" : "Mostrar a clientes"}</button>}
    </div>}
  </section>;
}
function ReportFrame({ html, title }: { html: string; title: string }) { return <iframe className="qhdn-reporte-frame" title={title} srcDoc={html} sandbox="" referrerPolicy="no-referrer" />; }
export function ReportDialog({ filters, onClose, onSaved, result }: { filters: Record<string, string>; onClose: () => void; onSaved?: (id: string) => void; result?: string }) {
  const [include, setInclude] = useState<ReportInput["include"]>(result === "sin_errores" ? "aprobadas" : result === "fallidas" ? "fallidas" : "todas");
  const monthField = filters.createdMonth !== undefined ? "createdMonth" : "month";
  const [month, setMonth] = useState(filters[monthField] ?? "");
  const [preview, setPreview] = useState<{ result: ReportPreview; input: ReportInput } | null>(null);
  const key = useRef<{ payload: string; value: string }>();
  const inFlight = useRef(false);
  const input: ReportInput = { include, filters: Object.fromEntries(Object.entries({ ...filters, [monthField]: month }).filter(([, value]) => value.trim() !== "")) };
  const previewOp = useMutation({ mutationFn: whatsNewApi.preview, onSuccess: (result, input) => setPreview({ result, input }) });
  const saveOp = useMutation({ mutationFn: (body: ReportInput & { previewSha256: string }) => {
    const payload = JSON.stringify(body);
    if (key.current?.payload !== payload) key.current = { payload, value: crypto.randomUUID() };
    return whatsNewApi.saveReport(body, key.current.value);
  }, onSuccess: ({ id }) => onSaved?.(id), onError: (error: Error & { status?: number }) => { if (error.status === 409) setPreview(null); } });
  const busy = previewOp.isPending || saveOp.isPending;
  const staleReport = saveOp.error?.status === 409;
  const approvedPreview = preview && same(preview.input, input) && /^[a-f0-9]{64}$/.test(preview.result.snapshotSha256) && preview.result.entryCount > 0 ? preview : null;
  function run(kind: "preview" | "save") {
    if (inFlight.current || (kind === "save" && (!approvedPreview || !onSaved))) return;
    inFlight.current = true;
    if (kind === "preview") { setPreview(null); saveOp.reset(); }
    const request = kind === "preview" ? previewOp.mutateAsync(input) : saveOp.mutateAsync({ ...approvedPreview!.input, previewSha256: approvedPreview!.result.snapshotSha256 });
    void request.catch(() => {}).finally(() => { inFlight.current = false; });
  }
  return <Dialogo titulo={onSaved ? "Preparar reporte privado" : "Vista previa del reporte"} abierto onCerrar={() => { if (!inFlight.current) onClose(); }} className="qhdn-dialogo-reporte">
    <fieldset disabled={busy}><legend>Qué incluir</legend>{([["todas", "Todas"], ["aprobadas", "Solo aprobadas"], ["fallidas", "Solo fallidas"]] as const).map(([value, label]) => <label className="qhdn-radio" key={value}><input type="radio" name="include" value={value} checked={include === value} onChange={() => { setInclude(value); setPreview(null); }} />{label}</label>)}</fieldset>
    <label>{monthField === "createdMonth" ? "Mes de creación del reporte (opcional)" : "Mes del reporte (opcional)"}<input type="month" value={month} disabled={busy} onChange={event => { setMonth(event.target.value); setPreview(null); }} /></label>
    <p className="texto-ayuda">{onSaved ? "El reporte se guarda en el Portal de forma privada. No se envían correos." : "La vista previa no guarda un reporte ni envía correos."}</p>
    {staleReport ? <p role="alert">Los datos del reporte cambiaron. Genera una nueva vista previa antes de guardar.</p> : <Feedback error={previewOp.error || saveOp.error} />}
    {busy && <p role="status">{saveOp.isPending ? "Guardando reporte…" : "Preparando vista previa…"}</p>}
    <div className="qhdn-fila">
      <button type="button" disabled={busy} onClick={() => run("preview")}>Ver vista previa</button>
      {onSaved && <button type="button" className="primario" disabled={busy || !approvedPreview} onClick={() => run("save")}>Guardar reporte privado</button>}
    </div>
    {preview && <><p>{preview.result.entryCount} entradas · {preview.result.approvedCount} aprobadas · {preview.result.failedCount} fallidas</p><ReportFrame html={preview.result.html} title="Vista previa del reporte" /></>}
  </Dialogo>;
}
function SavedReports() {
  const key = useContext(Scope);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [preparing, setPreparing] = useState(false);
  const [removing, setRemoving] = useState<SavedReport | null>(null);
  const [feedback, setFeedback] = useState("");
  const reports = useQuery({ queryKey: [...key, "saved-reports", page], queryFn: () => whatsNewApi.savedReports(page) });
  return <>
    <Link to={base}>← Volver a Qué hay de nuevo</Link>
    <header className="qhdn-encabezado"><h1>Reportes guardados</h1><button className="primario" type="button" onClick={() => setPreparing(true)}>Preparar reporte privado</button></header>
    <p className="texto-ayuda">Los reportes son privados. Guardar o eliminar un reporte no envía correos.</p>
    {feedback && <p role="status">{feedback}</p>}
    {reports.isPending ? <Loading /> : reports.error ? <><Feedback error={reports.error} /><button type="button" onClick={() => void reports.refetch()}>Reintentar</button></> : <>
      {reports.data.items.length === 0 ? <p className="tarjeta">No hay reportes guardados.</p> :
        <div className="qhdn-tabla-contenedor"><table><caption className="sr-only">Reportes privados guardados</caption>
          <thead><tr><th scope="col">Fecha</th><th scope="col">Autor</th><th scope="col">Entradas</th><th scope="col">Acciones</th></tr></thead>
          <tbody>{reports.data.items.map(report => <tr key={report.id}>
            <td><time dateTime={report.generatedAt}>{prettyDate(report.generatedAt)}</time></td>
            <td>{report.generatedBy.displayName}</td>
            <td>{report.entryCount} · {report.approvedCount} aprobadas · {report.failedCount} fallidas</td>
            <td><div className="acciones-tabla">
              <Link className="qhdn-enlace-reportes" to={`${base}/reportes/${encodeURIComponent(report.id)}`}>Abrir reporte</Link>
              {report.canDelete && <RemoveButton label="Eliminar reporte" onClick={() => { setFeedback(""); setRemoving(report); }} />}
            </div></td>
          </tr>)}</tbody>
        </table></div>}
      <PageControl page={page} total={reports.data.total} size={reports.data.pageSize} onChange={setPage} />
    </>}
    {preparing && <ReportDialog filters={{}} onClose={() => setPreparing(false)} onSaved={id => {
      void qc.invalidateQueries({ queryKey: [...key, "saved-reports"] });
      navigate(`${base}/reportes/${encodeURIComponent(id)}`);
    }} />}
    {removing && <RemovalDialog title="Eliminar reporte" onClose={() => setRemoving(null)} remove={() => whatsNewApi.deleteReport(removing.id)} onRemoved={() => {
      qc.removeQueries({ queryKey: [...key, "report", removing.id], exact: true });
      if (reports.data?.items.length === 1 && page > 1) setPage(page - 1);
      void qc.invalidateQueries({ queryKey: [...key, "saved-reports"] });
      setRemoving(null);
      setFeedback("Reporte eliminado.");
    }}><p>El reporte guardado por {removing.generatedBy.displayName} el {prettyDate(removing.generatedAt)} dejará de aparecer y su enlace ya no abrirá. Se conserva el historial; no se enviarán correos.</p></RemovalDialog>}
  </>;
}
export function LiveReportPage() {
  return <PrivateScope><PrivateReport /></PrivateScope>;
}
function PrivateReport() {
  const key = useContext(Scope);
  const { id = "" } = useParams(); const report = useQuery({ queryKey: [...key, "report", id], queryFn: () => api.getText(`/whats-new/reports/${encodeURIComponent(id)}`, { credentials: "include" }), retry: false });
  return <main className="qhdn-pagina qhdn-reporte-completo"><Link to={`${base}/reportes`}>← Volver a reportes guardados</Link><h1>Reporte de pruebas</h1>{report.isPending ? <Loading /> : report.error ? <Feedback error={report.error} /> : <ReportFrame html={report.data} title="Reporte completo" />}</main>;
}

export function LiveConfigPage() {
  return <PrivateScope><PrivateConfig /></PrivateScope>;
}
function PrivateConfig() {
  const key = useContext(Scope);
  const me = useMe(); const config = useQuery({ queryKey: [...key, "config"], queryFn: () => api.get<ConfigDto>("/whats-new/config") }); const op = useOperation(); const [newLabel, setNewLabel] = useState(""); const [copied, setCopied] = useState(false);
  if (me.isPending || config.isPending) return <Loading />;
  if (me.error || config.error) return <Feedback error={me.error || config.error} />;
  const editable = can(me.data, "configuration.whats_new.manage"); const c = config.data;
  return <div className="qhdn-pagina"><h1>Configuración de Qué hay de nuevo</h1><Feedback error={op.error} /><section className="tarjeta"><h2>Acciones requeridas predefinidas</h2>{!editable && <p>Solo lectura: necesitas el permiso de gestión para modificar la configuración.</p>}{c.actions.map(a => <ConfigAction key={`${a.id}-${a.etag}`} action={a} disabled={!editable || op.isPending} save={(body) => op.run(() => api.put(`/whats-new/config/actions/${a.id}`, body, mutationOptions(a.etag)))} />)}<label>Nueva acción<input value={newLabel} maxLength={120} disabled={!editable || op.isPending} onChange={e => setNewLabel(e.target.value)} /></label><button disabled={!editable || !newLabel.trim() || op.isPending} onClick={() => op.mutateAsync(() => api.post("/whats-new/config/actions", { label: newLabel.trim() }, mutationOptions(undefined, true))).then(() => setNewLabel("")).catch(() => {})}>Agregar acción</button></section><section className="tarjeta"><h2>Enlace para clientes</h2><p><a href="/novedades">{window.location.origin}/novedades</a></p><button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/novedades`).then(() => setCopied(true)).catch(() => setCopied(false))}>Copiar enlace</button><a href="/novedades">Abrir página del cliente</a>{copied && <p role="status">Enlace copiado.</p>}<label className="qhdn-check"><input type="checkbox" role="switch" checked={c.settings.publicEnabled} disabled={!editable || op.isPending} onChange={e => op.run(() => api.put("/whats-new/config/settings", { publicEnabled: e.target.checked }, mutationOptions(c.settings.etag)))} />Publicación activa</label></section></div>;
}
function ConfigAction({ action, disabled, save }: { action: ConfigDto["actions"][number]; disabled: boolean; save: (body: { label: string; active: boolean; sortOrder: number }) => void }) {
  const [label, setLabel] = useState(action.label); const [active, setActive] = useState(action.active); const [order, setOrder] = useState(action.sortOrder);
  return <fieldset disabled={disabled} className="qhdn-fila"><legend>{action.label}</legend><label>Nombre<input value={label} maxLength={120} onChange={e => setLabel(e.target.value)} /></label><label className="qhdn-check"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Activa</label><label>Orden<input type="number" min={1} max={999} value={order} onChange={e => setOrder(Number(e.target.value))} /></label><button disabled={disabled || !label.trim() || order < 1 || order > 999} onClick={() => save({ label, active, sortOrder: order })}>Guardar acción</button></fieldset>;
}
