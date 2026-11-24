import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ConstructorRutas } from "./componentes/ConstructorRuta";
import { Dialogo, EtiquetaEstadoQhdn, EtiquetaSistema, EtiquetaTipo } from "./componentes/Comunes";
import { EditorEnriquecido, VisorEnriquecido } from "./componentes/EditorEnriquecido";
import { ErpClientCombobox } from "./componentes/ErpClientCombobox";
import { docVacio, ETIQUETAS_ESTADO_QHDN, ETIQUETAS_TIPO_CORTAS, rutaTexto, rutaVacia } from "./logica";
import { createDraftSaveSession, draftFromForm, errorMessage, formFromEntry, mutationOptions, safeDisplayDoc, storagePending, whatsNewApi, type ConfigDto, type EntryDto, type EntrySummary, type ErpClientLookup, type Me, type Page, type ReportInput, type ReportPreview } from "./contrato";
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
function useOperation() {
  const key = useContext(Scope);
  const qc = useQueryClient();
  const mutation = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: async () => { await qc.invalidateQueries({ queryKey: key }); }, onError: async (error: Error & { status?: number }) => { if (error.status === 401 || error.status === 403) await qc.resetQueries({ queryKey: key }); } });
  return { ...mutation, run: (fn: () => Promise<unknown>) => mutation.mutate(fn) };
}
function useMe() { const key = useContext(Scope); return useQuery({ queryKey: [...key, "me"], queryFn: whatsNewApi.me, staleTime: 0, refetchOnMount: "always" }); }

export function LiveWhatsNewPage() {
  return <PrivateScope><PrivateWhatsNew /></PrivateScope>;
}
function PrivateWhatsNew() {
  const me = useMe();
  const [chosen, setChosen] = useState<string | null>(null);
  if (me.isPending) return <Loading />;
  if (me.error) return <><Feedback error={me.error} /><button onClick={() => me.refetch()}>Reintentar</button></>;
  const actor = me.data;
  const dev = actor.areas.includes("desarrollo") && can(actor, "updates.whats_new.author");
  const test = actor.areas.includes("soporte") && can(actor, "updates.whats_new.test");
  const read = actor.views.includes("lectura");
  const view = chosen && ((chosen === "desarrollador" && dev) || (chosen === "asesor" && test)) ? chosen : dev ? "desarrollador" : test ? "asesor" : read ? "lectura" : null;
  if (!can(actor, "updates.whats_new.view") || (!dev && !test && !read)) return <div className="alerta-error" role="alert">No tienes un área y permisos habilitados para esta opción. Solicita acceso al administrador.</div>;
  return <div className="qhdn-pagina">{dev && test && <div className="qhdn-visiones"><div className="qhdn-selector-vision" role="group" aria-label="Visión"><button aria-pressed={view === "desarrollador"} onClick={() => setChosen("desarrollador")}>Desarrollador</button><button aria-pressed={view === "asesor"} onClick={() => setChosen("asesor")}>Asesor</button></div></div>}
    <Routes>
      <Route path="nueva" element={dev ? <LiveForm me={actor} /> : <p role="alert">No tienes permiso para crear entradas.</p>} />
      <Route path=":id/editar" element={dev ? <LoadForm me={actor} /> : <p role="alert">No tienes permiso para editar entradas.</p>} />
      <Route path=":id/corregir" element={dev || can(actor, "configuration.whats_new.manage") ? <LoadForm me={actor} correction /> : <p role="alert">No tienes permiso para corregir entradas.</p>} />
      <Route path=":id" element={<LiveEntry me={actor} developerView={view === "desarrollador"} />} />
      <Route index element={view === "desarrollador" ? <DeveloperList me={actor} /> : <LiveList me={actor} support />} />
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
function DeveloperList({ me }: { me: Me }) {
  const key = useContext(Scope);
  const tabsId = useId();
  const [tab, setTab] = useState<DeveloperTab>("todas");
  const [scope, setScope] = useState("mine");
  const [type, setType] = useState(""); const [system, setSystem] = useState(""); const [status, setStatus] = useState("");
  const [q, setQ] = useState(""); const [page, setPage] = useState(1);
  const mayListTeam = can(me, "updates.whats_new.view_all") || can(me, "configuration.whats_new.manage");
  const showAuthor = mayListTeam && scope === "all";
  const filters = { tab, scope: showAuthor ? "all" : "mine", type, system, status, q, page, pageSize: 20 };
  const entries = useQuery({ queryKey: [...key, "entries", filters], queryFn: async (): Promise<DeveloperPage> => whatsNewApi.list(filters) });
  const useTab = (value: DeveloperTab) => { setTab(value); setPage(1); };
  const change = (set: (v: string) => void, value: string) => { set(value); setPage(1); };
  return <>
    <header className="qhdn-encabezado">
      <h1>Qué hay de nuevo · Mis entradas</h1>
      <Link className="qhdn-boton-primario-enlace" to={`${base}/nueva`}><Plus size={16} aria-hidden="true" /> Nueva entrada</Link>
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
            const continueDraft = e.status === "borrador" && e.developer.id === me.user.id;
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

function LiveList({ me, support }: { me: Me; support: boolean }) {
  const key = useContext(Scope);
  const reportOnly = !can(me, "updates.whats_new.test") && !can(me, "updates.whats_new.view_all") && !can(me, "configuration.whats_new.manage") && can(me, "updates.whats_new.report");
  const [tab, setTab] = useState(reportOnly ? "probadas" : "sin_probar");
  const [result, setResult] = useState("ambas");
  const [scope, setScope] = useState("mine");
  const [type, setType] = useState(""); const [system, setSystem] = useState(""); const [status, setStatus] = useState("");
  const [month, setMonth] = useState(""); const [q, setQ] = useState(""); const [page, setPage] = useState(1); const [report, setReport] = useState(false);
  const filters = support ? { tab, result: tab === "probadas" ? result : undefined, type, system, month, q, page, pageSize: 20 } : { scope, type, system, status, q, page, pageSize: 20 };
  const entries = useQuery({ queryKey: [...key, support ? "queue" : "entries", filters], queryFn: () => whatsNewApi.list(filters, support) });
  function change(fn: () => void) { fn(); setPage(1); }
  return <><div className="pagina-encabezado"><div><h1>Qué hay de nuevo</h1><p>{support ? "Bandeja de pruebas" : "Mis entradas"}</p></div>{!support && <Link className="qhdn-boton-primario-enlace" to={`${base}/nueva`}>Nueva entrada</Link>}</div>
    {support && <div className="qhdn-pestanas" role="tablist" aria-label="Pruebas">{[["sin_probar", "Sin probar"], ["en_pruebas", "En pruebas"], ["probadas", "Probadas"]].map(([value,label]) => <button role="tab" aria-selected={tab === value} key={value} disabled={reportOnly && value !== "probadas"} onClick={() => change(() => setTab(value))}>{label}</button>)}</div>}
    <div className="tarjeta qhdn-fila">
      {!support && <label>Ver<select value={scope} onChange={e => change(() => setScope(e.target.value))}><option value="mine">Mis entradas</option>{can(me, "updates.whats_new.view_all") && <option value="all">Todo el equipo</option>}</select></label>}
      <label>Tipo<select value={type} onChange={e => change(() => setType(e.target.value))}><option value="">Todos</option>{types.map(t => <option key={t} value={t}>{ETIQUETAS_TIPO_CORTAS[t]}</option>)}</select></label>
      <label>Sistema<select value={system} onChange={e => change(() => setSystem(e.target.value))}><option value="">Todos</option><option value="sag_web">SAG Web</option><option value="sag_clasico">SAG Clásico</option></select></label>
      {!support && <label>Estado<select value={status} onChange={e => change(() => setStatus(e.target.value))}><option value="">Todos</option>{["borrador", "sin_probar", "en_pruebas", "probado", "fallida", "archivada"].map(s => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}</select></label>}
      {support && <label>Mes<input type="month" value={month} onChange={e => change(() => setMonth(e.target.value))} /></label>}
      {support && tab === "probadas" && <label>Resultado<select value={result} onChange={e => change(() => setResult(e.target.value))}><option value="ambas">Ambas</option><option value="sin_errores">Sin errores</option><option value="fallidas">Fallidas</option></select></label>}
      <label>Buscar<input type="search" value={q} maxLength={100} onChange={e => change(() => setQ(e.target.value))} /></label>
    </div>
    {support && tab === "probadas" && can(me, "updates.whats_new.report") && <button className="primario" onClick={() => setReport(true)}>Enviar reporte</button>}
    {entries.isPending ? <Loading /> : entries.error ? <><Feedback error={entries.error} /><button onClick={() => entries.refetch()}>Reintentar</button></> : <><div className="qhdn-tabla-contenedor"><table aria-label={support ? "Bandeja de pruebas" : "Mis entradas"}><thead><tr><th>Entrada</th><th>Tipo / Sistema</th><th>Qué cambió</th><th>Desarrollador</th><th>Estado</th></tr></thead><tbody>{entries.data.items.map(e => <tr key={e.id}><td><Link to={`${base}/${e.id}`}>{e.number}</Link></td><td><EtiquetaTipo tipo={e.type} /> <EtiquetaSistema sistema={e.system} /></td><td>{e.summary || "Borrador sin contenido"}<small className="qhdn-detalle-estado">{e.primaryRoute}</small></td><td>{e.developer?.displayName}</td><td><EtiquetaEstadoQhdn estado={e.status} /></td></tr>)}</tbody></table></div>{entries.data.items.length === 0 && <p>No hay entradas con estos filtros.</p>}<PageControl page={page} total={entries.data.total} size={20} onChange={setPage} /></>}
    {report && <ReportDialog filters={{ type, system, month, q }} onClose={() => setReport(false)} />}
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
      {value.length === 0 ? <p className="texto-ayuda">Sin referencias añadidas.</p> : <ul aria-label={video ? "Videos de entrega" : "Referencias de reglas de negocio"}>{value.map(item => <li key={item.id}><span>{item.clase === "archivo" ? <BotonDescargaPrivada id={item.id} name={item.nombre} /> : item.nombre || item.url}<small>{item.clase === "archivo" ? "Archivo" : "Enlace"}</small></span><button type="button" aria-label={`Quitar ${item.nombre || item.url || "archivo adjunto"}`} onClick={() => onChange(value.filter(other => other.id !== item.id))}>Quitar</button></li>)}</ul>}
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
  const [draftError, setDraftError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const failedRevision = useRef<number>();
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
  const latest = useRef({ form, saved, revision: 0, committed: 0, conflicted: false });
  function update(patch: Partial<LiveDraftForm>) {
    const state = latest.current;
    state.form = { ...state.form, ...patch };
    if (!correction) {
      state.revision++;
      setEditRevision(state.revision);
      if (!state.conflicted) setDraftError(null);
    }
    setForm(state.form);
  }
  const clientLabel = form.clientSelection === undefined ? saved?.clientName ?? null : form.clientSelection?.label ?? null;
  const saveRef = useRef<() => void>(() => {});
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
        state.committed = revision;
        failedRevision.current = undefined;
        setSaved(result);
        setCommittedRevision(revision);
        if (selection !== undefined && state.form.clientSelection === selection) {
          state.form = { ...state.form, clientSelection: undefined };
          setForm(state.form);
        }
        return result;
      }).catch((error: unknown) => {
        failedRevision.current = state.revision;
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
  async function save(publish = false, auto = false) {
    const state = latest.current;
    if (inFlightDraft.current || publishing.current || uploadBusy.current || state.conflicted || correction
      || (auto && (state.revision === state.committed || failedRevision.current === state.revision))) return;
    if (publish) { publishing.current = true; setSubmitting(true); }
    if (!auto) setLocalError("");
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
      let current = inFlightDraft.current ? await inFlightDraft.current : latest.current.saved;
      if (!current || (target !== "que_cambio" && current.type !== "nuevo")) {
        if (correction) throw new Error("La entrada no admite esta referencia.");
        current = await persistDraft();
        setMessage("Borrador creado para recibir archivos. No se ha publicado.");
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
  saveRef.current = () => { void save(false, true); };
  const dirty = editRevision !== committedRevision;
  useEffect(() => {
    if (!dirty || correction || draftPending || uploading || submitting || conflict || failedRevision.current === editRevision) return;
    const timer = window.setTimeout(() => saveRef.current(), 3_000);
    return () => window.clearTimeout(timer);
  }, [dirty, editRevision, correction, draftPending, uploading, submitting, conflict]);
  useEffect(() => {
    if (!dirty) return;
    // The debounce leaves a brief unsaved window; never discard it on a reload silently.
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    // BrowserRouter's in-app links don't fire beforeunload (including the sidebar).
    const warnLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const destination = new URL(link.href, location.href);
      if (destination.origin !== location.origin || destination.pathname === location.pathname) return;
      if (!window.confirm("Hay cambios sin guardar. ¿Quieres salir del borrador?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", warnLink, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", warnLink, true);
    };
  }, [dirty]);
  const formLocked = submitting || op.isPending;
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
        {correction && <section className="qhdn-formulario-seccion"><h3 id="live-correction">Nota de corrección</h3><EditorEnriquecido valor={note} onChange={setNote} perfil="medio" etiquetaId="live-correction" soloLectura={formLocked} /></section>}
        {!me.storageAvailable && <p className="texto-ayuda" id="storage-form">{storagePending}</p>}
        {uploading && <p className="texto-ayuda" id="storage-form" role="status">Subiendo archivo a almacenamiento privado…</p>}
        <div className="qhdn-pie-formulario">
          <p role="status" className="texto-ayuda">{draftPending ? "Guardando borrador…" : dirty ? "Cambios sin guardar." : message}</p>
          <div className="acciones-formulario">{correction ? <button type="button" className="primario" disabled={formLocked || uploading} onClick={() => op.mutateAsync(() => whatsNewApi.command(entry!.id, "correct", entry!.etag, { whatChanged: form.queCambio, requiredActions: draftFromForm(form).requiredActions, correctionNote: note })).then(() => navigate(`${base}/${entry!.id}`)).catch(() => {})}>Corregir y volver a publicar</button> : <><button type="submit" disabled={formLocked || draftPending || uploading || conflict}>Guardar borrador</button><button type="button" className="primario" disabled={formLocked || draftPending || uploading || conflict || missing.length > 0} aria-describedby={missing.length ? missingId : undefined} onClick={() => void save(true)}>Publicar a Soporte</button></>}</div>
          {!correction && missing.length > 0 && <p id={missingId} className="texto-ayuda qhdn-campos-faltantes">Para publicar, completa: {missing.join(", ")}.</p>}
        </div>
      </form>
      <aside className="qhdn-panel-lateral qhdn-lateral-desarrollador">
        <section className="tarjeta qhdn-guia-desarrollador"><h2>¿Qué registrar?</h2><ul><li><strong>Nuevo:</strong> una opción o funcionalidad nueva.</li><li><strong>Mejora:</strong> un cambio a una función existente.</li><li><strong>Regla de negocio:</strong> un cambio de comportamiento.</li><li><strong>SP crítico:</strong> un ajuste técnico urgente.</li><li><strong>Rediseño:</strong> un cambio de estructura o experiencia.</li></ul><p>Indica dónde encontrar el cambio y qué debe validar Soporte.</p></section>
        <section className="tarjeta qhdn-previa-desarrollador"><h2>Vista previa para Soporte</h2><div className="qhdn-etiquetas"><EtiquetaTipo tipo={form.tipo} /><EtiquetaSistema sistema={form.sistema} /></div><p className="texto-ayuda">{form.rutas[0] ? rutaTexto(form.rutas[0]) || "Sin ruta" : "Sin ruta"}</p><ReadDoc value={form.queCambio} privateMedia /></section>
      </aside>
    </div>
  </>;
}

function LiveEntry({ me, developerView }: { me: Me; developerView: boolean }) {
  const key = useContext(Scope);
  const { id = "" } = useParams(); const detail = useQuery({ queryKey: [...key, "entry", id], queryFn: () => whatsNewApi.detail(id) });
  if (detail.isPending) return <Loading />;
  if (detail.error) return <><Feedback error={detail.error} /><button onClick={() => detail.refetch()}>Recargar</button></>;
  return <EntryContent me={me} entry={detail.data} developerView={developerView} />;
}
function EntryContent({ me, entry: e, developerView }: { me: Me; entry: EntryDto; developerView: boolean }) {
  const key = useContext(Scope); const qc = useQueryClient(); const [noteSaved, setNoteSaved] = useState("");
  const op = useOperation(); const navigate = useNavigate(); const [confirm, setConfirm] = useState<string | null>(null); const [reason, setReason] = useState("");
  const [body, setBody] = useState<DocEnriquecido | null>(null); const [annul, setAnnul] = useState<string | null>(null);
  const round = e.rounds.find(r => r.status === "tomada"); const mine = round?.holderId === me.user.id;
  const tester = me.areas.includes("soporte") && can(me, "updates.whats_new.test");
  const manage = can(me, "configuration.whats_new.manage"); const author = e.developer.id === me.user.id && can(me, "updates.whats_new.author") && me.areas.includes("desarrollo");
  const contributors = [e.developer.id, ...e.log.filter(l => ["editar_borrador", "publicar", "corregir", "corregir_en_nombre"].includes(l.action)).map(l => l.byId)];
  const mayTest = !developerView && tester && !contributors.includes(me.user.id);
  const noteDraft = useMutation({ mutationFn: (data: { roundId: string; etag: string; body: DocEnriquecido | null }) => api.put(`/whats-new/rounds/${data.roundId}/note-draft`, { body: data.body }, mutationOptions(data.etag)), onSuccess: async () => { setNoteSaved("Avance guardado automáticamente."); await qc.invalidateQueries({ queryKey: [...key, "entry", e.id] }); } });
  useEffect(() => { setBody(round?.noteDraft ?? null); setNoteSaved(""); }, [round?.id]);
  useEffect(() => {
    if (!round || !mine || !mayTest || noteDraft.isPending || noteDraft.error || op.isPending || JSON.stringify(body) === JSON.stringify(round.noteDraft)) return;
    const timer = setTimeout(() => noteDraft.mutate({ roundId: round.id, etag: round.etag, body }), 1500);
    return () => clearTimeout(timer);
  }, [body, round?.etag, mine, mayTest, op.isPending, noteDraft.isPending]);
  function command(action: string, data: unknown = {}) { op.run(() => whatsNewApi.command(e.id, action, e.etag, data)); }
  const findings = <><h3>Hallazgos {developerView && <span className="qhdn-conteo">{e.findings.length}</span>}</h3>{e.findings.length === 0 && <p>Sin hallazgos registrados.</p>}{e.findings.map(f => <article className={developerView ? "qhdn-hallazgo-detalle" : "tarjeta"} key={f.id}><h4>Hallazgo {f.number} · Ronda {f.roundNo}</h4><ReadDoc value={f.body} />{f.annulled ? <p>Anulado: {f.annulled.reason}</p> : mine && mayTest && f.roundNo === round.roundNo && <button onClick={() => { setAnnul(f.id); setConfirm("annul"); }}>Anular hallazgo</button>}</article>)}</>;
  return <><Link className={developerView ? "qhdn-volver-desarrollador" : undefined} to={base}>{developerView ? "← Volver a mis entradas" : "← Volver a la bandeja"}</Link>
    <header className={developerView ? "qhdn-encabezado qhdn-cabecera-detalle" : "pagina-encabezado"}>
      <div><h1>{developerView ? "Detalle de la entrada" : e.number}</h1><div className="qhdn-etiquetas">{developerView && <span className="qhdn-detalle-identificador">{e.number}</span>}<EtiquetaTipo tipo={e.type} /><EtiquetaSistema sistema={e.system} /><EtiquetaEstadoQhdn estado={e.status} /></div></div>
      {developerView && author && e.status === "borrador" && <Link className="qhdn-boton-primario-enlace" to={`${base}/${e.id}/editar`}>Continuar edición</Link>}
    </header>
    {developerView && (e.status !== "borrador" || !author) && <p className="alerta alerta-info qhdn-aviso-desarrollador"><strong>Solo lectura.</strong> {(author || manage) && ["sin_probar", "fallida"].includes(e.status) ? "Usa la acción de corrección para modificar el cambio y devolverlo a Soporte." : "En este estado no puedes editar la entrada."}</p>}
    <Feedback error={op.error} /><div className="qhdn-fila qhdn-comandos-detalle">
    {author && e.status === "borrador" && <>{!developerView && <Link to={`${base}/${e.id}/editar`}>Editar borrador</Link>}<button disabled={op.isPending} onClick={() => command("publish")}>Publicar a Soporte</button><button className="peligro" onClick={() => setConfirm("delete")}>Eliminar borrador</button></>}
    {(author || manage) && ["sin_probar", "fallida"].includes(e.status) && <Link to={`${base}/${e.id}/corregir`}>Corregir y volver a publicar</Link>}
    {!developerView && e.status === "sin_probar" && <button className="primario" disabled={!mayTest || op.isPending} onClick={() => command("take")}>Tomar para probar</button>}
    {!developerView && mine && <><button onClick={() => setConfirm("release")} disabled={op.isPending}>Soltar</button><button className="peligro" disabled={op.isPending || !e.findings.some(f => f.roundNo === round.roundNo && !f.annulled)} onClick={() => command("mark-failed")}>Marcar fallida</button><button className="primario" disabled={op.isPending || round.checklist.some(c => !c.checked)} onClick={() => command("mark-tested")}>Marcar probado</button></>}
    {!developerView && manage && round && !mine && <button onClick={() => setConfirm("force-release")}>Forzar Soltar</button>}{!developerView && manage && e.status === "probado" && <button onClick={() => setConfirm("archive")}>Archivar</button>}
  </div>{!developerView && e.status === "sin_probar" && !mayTest && <p>Probar exige área Soporte y permiso de pruebas; quien creó o corrigió la entrada no puede probarla.</p>}{round && !mine && <p>En pruebas por {round.holderName}. Solo lectura.</p>}
    <Feedback error={noteDraft.error} />{!developerView && <p role="status">{noteSaved}</p>}<div className={developerView ? "qhdn-detalle-grid qhdn-desarrollador-grid" : "qhdn-formulario-grid"}><section className="tarjeta">
      {developerView ? <><h2>Datos del cambio</h2><dl className="qhdn-datos">
        <dt>Desarrollador</dt><dd>{e.developer.displayName}</dd><dt>Asesores que han probado</dt><dd>{e.participants.filter(p => p.role === "asesor").map(p => p.displayName).join(", ") || "Ninguno todavía"}</dd>
        {e.clientName && <><dt>Cliente</dt><dd>{e.clientName}</dd></>}<dt>Creada</dt><dd><time dateTime={e.createdAt}>{prettyDate(e.createdAt)}</time></dd>
      </dl></> : <><p><strong>Desarrollador:</strong> {e.developer.displayName}</p><p><strong>Asesores que han probado:</strong> {e.participants.filter(p => p.role === "asesor").map(p => p.displayName).join(", ") || "Ninguno todavía"}</p>{e.clientName && <p><strong>Cliente:</strong> {e.clientName}</p>}</>}
      <h3>Dónde se encuentra</h3><ul>{e.routes.map((r,i) => <li key={i}>{[r.via === "barra_lateral" ? "Barra lateral" : "Barra de navegación", ...r.submenus, r.option].join(" › ")}</li>)}</ul><h3>Qué cambió</h3><ReadDoc value={e.whatChanged} privateMedia />
      <h3>Acción requerida</h3>{e.requiredActions.map(a => <section key={a.code}><h4>{a.label}</h4><ReadDoc value={a.detail} /></section>)}
      {e.attachments.length > 0 && <section><h3>Referencias internas</h3><ul>{e.attachments.map((a,i) => <li key={i}>{a.group === "video" ? "Video" : "Reglas de negocio"}: {a.kind === "archivo" ? <BotonDescargaPrivada id={a.fileId} name={a.name || "Archivo adjunto"} /> : /^https:\/\//i.test(a.url) ? <a href={a.url} target="_blank" rel="noopener noreferrer">{a.label || a.url}</a> : "Enlace no disponible"}</li>)}</ul></section>}
      {!developerView && round && <section><h3>Mi checklist</h3><progress max={round.checklist.length || 1} value={round.checklist.filter(c => c.checked).length} aria-label="Avance del checklist" />{round.checklist.map(item => <label className="qhdn-check" key={item.itemNo}><input type="checkbox" checked={item.checked} disabled={!mine || !mayTest || op.isPending} onChange={() => op.run(() => api.patch(`/whats-new/rounds/${round.id}/checklist`, { items: [{ itemNo: item.itemNo, checked: !item.checked }] }, mutationOptions(round.etag)))} />{item.label}</label>)}<p>Para aprobar, completa el checklist. Para marcar fallida, registra al menos un hallazgo vigente de esta ronda.</p></section>}
      {mine && mayTest && <section><h3 id="live-note">Notas y hallazgos</h3><EditorEnriquecido valor={body} onChange={setBody} perfil="medio" etiquetaId="live-note" /><div className="qhdn-fila"><button disabled={!body || op.isPending} onClick={() => op.mutateAsync(() => api.post(`/whats-new/rounds/${round.id}/notes`, { body }, mutationOptions(round.etag, true))).then(() => setBody(null)).catch(() => {})}>Guardar como nota</button><button disabled={!body || op.isPending} onClick={() => op.mutateAsync(() => api.post(`/whats-new/rounds/${round.id}/findings`, { body }, mutationOptions(round.etag, true))).then(() => setBody(null)).catch(() => {})}>Registrar hallazgo</button></div><p className="texto-ayuda">Registrar un hallazgo no envía correo.</p></section>}
      {!developerView && findings}
    </section><aside className="qhdn-panel-lateral">{developerView ? <section className="tarjeta">{findings}</section> : <ClientText me={me} entry={e} editable={can(me, "updates.whats_new.publish_client") && me.areas.includes("soporte") && !contributors.includes(me.user.id) && (mine || e.status === "probado")} />}<div className="tarjeta"><h3>Historial y rondas de prueba</h3>{e.rounds.map(r => <details key={r.id}><summary>Ronda {r.roundNo} · {r.holderName} · {r.status}</summary><ul>{r.checklist.map(c => <li key={c.itemNo}>{c.checked ? "✓" : "○"} {c.label}</li>)}</ul>{r.notes.map(n => <ReadDoc key={n.id} value={n.body} />)}</details>)}<ol>{e.log.map((l,i) => <li key={i}><time>{new Date(l.at).toLocaleString("es-CO", { timeZone: "America/Bogota" })}</time> · {l.byId}: {l.action.replaceAll("_", " ")}{l.reason && ` · ${l.reason}`}</li>)}</ol></div></aside></div>
    <Dialogo titulo={confirm === "release" ? "Soltar y reiniciar la prueba" : "Confirmar acción"} abierto={!!confirm} onCerrar={() => { setConfirm(null); setReason(""); }}>{confirm === "release" ? <p>La entrada volverá a Sin probar y la próxima prueba empezará vacía. Se conserva la historia de esta ronda. No se enviará ningún correo.</p> : confirm === "delete" ? <p>Se eliminará este borrador. Esta acción no se puede deshacer.</p> : <label>Motivo (10 a 500 caracteres)<textarea value={reason} minLength={10} maxLength={500} onChange={ev => setReason(ev.target.value)} /></label>}<button className="primario" disabled={op.isPending || (!["release", "delete"].includes(confirm ?? "") && reason.trim().length < 10)} onClick={() => { const action = confirm!; if (action === "delete") op.mutateAsync(() => api.del(`/whats-new/entries/${e.id}`, mutationOptions(e.etag))).then(() => navigate(base)).catch(() => {}); else if (action === "annul") op.run(() => api.post(`/whats-new/findings/${annul}/annul`, { reason }, mutationOptions(round?.etag ?? e.etag, true))); else command(action, action === "release" ? {} : { reason }); setConfirm(null); setReason(""); }}>Confirmar</button></Dialogo>
  </>;
}

function ClientText({ entry: source, editable }: { me: Me; entry: EntryDto; editable: boolean }) {
  const entry = { ...source, etag: source.clientText?.etag ?? source.etag };
  const [show, setShow] = useState(entry.clientText?.showToClients ?? false); const [title, setTitle] = useState(entry.clientText?.title ?? ""); const [body, setBody] = useState<DocEnriquecido | null>(entry.clientText?.body ?? null); const op = useOperation();
  useEffect(() => { setShow(entry.clientText?.showToClients ?? false); setTitle(entry.clientText?.title ?? ""); setBody(entry.clientText?.body ?? null); }, [entry.clientText?.etag]);
  return <section className="tarjeta"><h3>Para clientes</h3><p>Mostrar significa mostrar a todos los clientes. Redacta un texto público independiente: nunca se copia contenido interno.</p><label className="qhdn-check"><input type="checkbox" role="switch" checked={show} disabled={!editable || entry.type === "sp_critico" || op.isPending} onChange={e => setShow(e.target.checked)} />Mostrar esta novedad a los clientes</label>{entry.type === "sp_critico" && <p>Los SP críticos nunca se publican.</p>}{!editable && <p>No tienes permiso para modificar la publicación de esta entrada.</p>}<label>Título para clientes<input value={title} maxLength={120} disabled={!editable || op.isPending} onChange={e => setTitle(e.target.value)} /></label><EditorEnriquecido valor={safeDisplayDoc(body, true)} onChange={setBody} perfil="cliente" ariaLabel="Texto para clientes" tamano="compacto" soloLectura={!editable} /><Feedback error={op.error} />{editable && <button disabled={op.isPending} onClick={() => op.run(() => api.put(`/whats-new/entries/${entry.id}/client-text`, { showToClients: show, title: title || null, body: safeDisplayDoc(body, true) }, mutationOptions(entry.etag)))}>Guardar texto para clientes</button>}</section>;
}

function ReportFrame({ html, title }: { html: string; title: string }) { return <iframe className="qhdn-reporte-frame" title={title} srcDoc={html} sandbox="" referrerPolicy="no-referrer" />; }
export function ReportDialog({ filters, onClose }: { filters: Record<string, string>; onClose: () => void }) {
  const key = useContext(Scope);
  const [include, setInclude] = useState<ReportInput["include"]>("todas"); const [selected, setSelected] = useState<string[]>([]); const [search, setSearch] = useState(""); const [preview, setPreview] = useState<ReportPreview | null>(null);
  const recipients = useQuery({ queryKey: [...key, "recipients", search], queryFn: () => whatsNewApi.lookup("recipients", search) });
  const op = useMutation<ReportPreview | { id: string }, Error, "preview" | "send">({ mutationFn: (action) => action === "preview" ? whatsNewApi.preview({ include, filters }) : whatsNewApi.send({ include, filters, recipientIds: selected }), onSuccess: (result, action) => { if (action === "preview") setPreview(result as ReportPreview); } });
  return <Dialogo titulo="Enviar reporte de Probadas" abierto onCerrar={onClose} className="qhdn-dialogo-reporte"><fieldset><legend>Qué incluir</legend>{[["todas", "Todas"], ["aprobadas", "Solo aprobadas"], ["fallidas", "Solo fallidas"]].map(([v,l]) => <label className="qhdn-radio" key={v}><input type="radio" name="include" value={v} checked={include === v} onChange={() => { setInclude(v as ReportInput["include"]); setPreview(null); }} />{l}</label>)}</fieldset><label>Buscar destinatarios<input type="search" value={search} maxLength={100} onChange={e => setSearch(e.target.value)} /></label><fieldset><legend>Usuarios activos del portal</legend>{recipients.isPending ? <Loading /> : recipients.data?.filter(u => u.active !== false).map(u => <label className="qhdn-check" key={u.id}><input type="checkbox" checked={selected.includes(u.id)} disabled={!selected.includes(u.id) && selected.length >= 30} onChange={e => setSelected(ids => e.target.checked ? [...ids, u.id] : ids.filter(id => id !== u.id))} />{u.displayName} {u.email && `· ${u.email}`}</label>)}</fieldset><p role="status">{selected.length} de 30 destinatarios seleccionados. Elige al menos uno.</p><p className="texto-ayuda">El reporte completo requiere iniciar sesión; cualquier usuario activo del portal puede abrirlo.</p><Feedback error={recipients.error || op.error} /><p className="alerta-info">El envío todavía no está disponible: el almacenamiento de archivos no está conectado. La vista previa HTML sí está disponible.</p><div className="qhdn-fila"><button disabled={op.isPending} onClick={() => op.mutate("preview")}>Ver reporte</button><button disabled={op.isPending || selected.length === 0 || selected.length > 30} onClick={() => op.mutate("send")}>Enviar a {selected.length} personas</button></div>{preview && <><p>{preview.entryCount} entradas · {preview.approvedCount} aprobadas · {preview.failedCount} fallidas</p><ReportFrame html={preview.html} title="Vista previa del reporte" /></>}</Dialogo>;
}
export function LiveReportPage() {
  return <PrivateScope><PrivateReport /></PrivateScope>;
}
function PrivateReport() {
  const key = useContext(Scope);
  const { id = "" } = useParams(); const report = useQuery({ queryKey: [...key, "report", id], queryFn: () => api.getText(`/whats-new/reports/${encodeURIComponent(id)}`, { credentials: "include" }), retry: false });
  return <main className="qhdn-pagina qhdn-reporte-completo"><h1>Reporte de pruebas</h1>{report.isPending ? <Loading /> : report.error ? <Feedback error={report.error} /> : <ReportFrame html={report.data} title="Reporte completo" />}</main>;
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

export function LivePublicPage() {
  const [params, setParams] = useSearchParams(); const detailId = params.get("detalle"); const [category, setCategory] = useState("todo"); const [period, setPeriod] = useState("todo"); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [page, setPage] = useState(1);
  const validRange = period !== "rango" || (!!from && !!to && from <= to); const filters = { categoria: category, periodo: period, ...(period === "rango" ? { desde: from, hasta: to } : {}), page };
  const list = useQuery({ queryKey: [...key, "public", filters], queryFn: () => whatsNewApi.publicList(filters), enabled: validRange });
  const detail = useQuery({ queryKey: [...key, "public-detail", detailId], queryFn: () => whatsNewApi.publicDetail(detailId!), enabled: !!detailId });
  function change(fn: () => void) { fn(); setPage(1); }
  const month = (value: string) => { const [y,m] = value.split("-").map(Number); return Number.isFinite(y) && Number.isFinite(m) ? new Date(Date.UTC(y,m - 1,15)).toLocaleDateString("es-CO", { month: "long", year: "numeric", timeZone: "America/Bogota" }) : value; };
  return <main className="qhdn-novedades"><header className="qhdn-novedades-cabecera"><img src="/brand/sag-two-tone-icon.png" alt="SAG" /><h1>Novedades de SAG Web</h1><p>Conoce las opciones nuevas y las mejoras que tenemos para ti.</p></header><section className="qhdn-novedades-filtros"><label>Tipo<select value={category} onChange={e => change(() => setCategory(e.target.value))}><option value="todo">Todo</option><option value="nuevas">Opciones nuevas</option><option value="mejoras">Mejoras</option></select></label><label>Fecha de liberación<select value={period} onChange={e => change(() => setPeriod(e.target.value))}><option value="mes_actual">Mes actual</option><option value="ultimos_3_meses">Últimos 3 meses</option><option value="ultimo_ano">Último año</option><option value="todo">Todo</option><option value="rango">Rango de fechas</option></select></label>{period === "rango" && <><label>Desde<input type="date" value={from} onChange={e => change(() => setFrom(e.target.value))} /></label><label>Hasta<input type="date" value={to} min={from} onChange={e => change(() => setTo(e.target.value))} /></label></>}</section>
    {!validRange ? <p role="alert">Selecciona un rango válido de fechas.</p> : list.isPending ? <Loading /> : list.error ? <><p role="alert">No pudimos cargar las novedades. Inténtalo de nuevo.</p><button onClick={() => list.refetch()}>Reintentar</button></> : !list.data.enabled || list.data.items.length === 0 ? <p>Sin novedades por ahora.</p> : <><section className="qhdn-novedades-grid">{list.data.items.map(item => <article key={item.publicId} className="tarjeta qhdn-novedad"><span className="qhdn-tipo">{item.category === "nuevo" || item.category === "nueva" ? "Opción nueva" : "Mejora"}</span><time>{month(item.releaseMonth)}</time><h2>{item.title}</h2><p>{item.summary}</p><h3>Dónde lo encuentras</h3><p>{item.whereToFind}</p><button onClick={() => setParams({ detalle: item.publicId })}>Ver detalle</button></article>)}</section><PageControl page={page} total={list.data.total} size={list.data.pageSize} onChange={setPage} /></>}
    <Dialogo titulo={detail.data?.title ?? "Detalle de la novedad"} abierto={!!detailId} onCerrar={() => setParams({})}>{detail.isPending ? <Loading /> : detail.error ? <p role="alert">No pudimos cargar esta novedad.</p> : detail.data && <><p>{month(detail.data.releaseMonth)}</p><ReadDoc value={detail.data.body} publicProfile /><h4>Dónde lo encuentras</h4><p>{detail.data.whereToFind}</p></>}</Dialogo>
  </main>;
}
