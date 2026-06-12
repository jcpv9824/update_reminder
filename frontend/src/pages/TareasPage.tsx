import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { Frecuencia, Tarea, Usuario } from "../types";
import { ETIQUETAS_ROLES } from "../types";
import { Alerta, EtiquetaEstado, Modal } from "../components/Comunes";
import { hoyEnBogotaIso, sumarDiasIso, clasificarTareaPorFecha, type ClasificacionTarea } from "../utils/fechas";
import { formatDomainForPublishing } from "../utils/dominio";

// La ventana de visualización se calcula en zona Bogotá. Las comparaciones
// "hoy / próximas / vencidas" usan ese mismo `HOY` para evitar drift por UTC.
const HOY = hoyEnBogotaIso();
const VENTANA_TAREAS = {
  hasta: sumarDiasIso(HOY, 4),
};

type AccionTarea = "complete" | "block" | "reopen" | "resolve-block";
type EstadoGuardado = "guardando" | "guardado" | "error";

type GrupoResumen = {
  id: string;
  fecha: string;
  responsableClave: string;
  responsableEtiqueta: string;
  responsableEsRolFallback: boolean;
  asignadoAlActual: boolean;
  rolHabilitaActual: boolean;
  targetType: "domain" | "database";
  rootScheduleId?: string;
  scheduleName?: string;
  tareas: Tarea[];
  total: number;
  completadasOk: number;
  completadasConProblemas: number;
  pendientes: number;
  estadoAgregado: "completed" | "with_problems" | "in_progress" | "pending" | "overdue";
};

type ConexionInfo = {
  server: string;
  databaseName: string;
  user: string;
  hasPassword: boolean;
};

function etiquetaTipo(targetType: "domain" | "database", plural = false): string {
  if (targetType === "domain") return plural ? "dominios" : "Dominio";
  return plural ? "bases de datos" : "Base de datos";
}

function nombreUsuarioPorId(id: string, mapa: Map<string, string>): string {
  return mapa.get(id) ?? id;
}

function calcularEstadoGrupo(tareas: Tarea[], fecha: string): GrupoResumen["estadoAgregado"] {
  const conProblemas = tareas.some((t) => t.completedWithProblems || t.status === "failed");
  if (conProblemas) return "with_problems";
  if (tareas.every((t) => t.status === "completed")) return "completed";
  if (fecha < HOY && tareas.some((t) => t.status !== "completed" && t.status !== "cancelled")) return "overdue";
  if (tareas.some((t) => t.status === "in_progress" || t.status === "completed" || t.status === "reopened")) return "in_progress";
  return "pending";
}

function etiquetaEstadoGrupo(estado: GrupoResumen["estadoAgregado"]): string {
  return ({
    completed: "Completado",
    with_problems: "Con problemas",
    in_progress: "En progreso",
    pending: "Pendiente",
    overdue: "Vencido",
  } as const)[estado];
}

export function puedeCambiarTarea(usuario: Usuario | null, tarea: Tarea): boolean {
  const roles = usuario?.roles ?? [];
  if (roles.includes("admin")) return true;
  const rolNecesario = tarea.targetType === "domain" ? "domain_updater" : "database_updater";
  if (!roles.includes(rolNecesario)) return false;
  if (tarea.assignedUserIds.length === 0) return true;
  return !!usuario && tarea.assignedUserIds.includes(usuario.id);
}

function estadoDespuesDeAccion(accion: AccionTarea): Tarea["status"] {
  if (accion === "complete") return "completed";
  if (accion === "block") return "blocked";
  return "pending";
}

// Copia robusta al portapapeles. El Clipboard API moderno exige "activación
// transitoria" del usuario; si la copia ocurre DESPUÉS de un await de red
// (p. ej. revelar la contraseña), esa activación ya expiró y writeText falla.
// Por eso intentamos primero el API moderno y, si falla, usamos el método
// clásico textarea + execCommand, que es más tolerante en ese escenario.
async function copiarTexto(texto: string): Promise<boolean> {
  if (!texto) return false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {/* intentar el método de respaldo */}
  try {
    const ta = document.createElement("textarea");
    ta.value = texto;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function claveResponsable(t: Tarea): string {
  return t.assignedUserIds.length ? t.assignedUserIds.slice().sort().join("|") : `rol:${t.assignedRole}`;
}

function etiquetaResponsableDeGrupo(items: Tarea[], usuariosMap: Map<string, string>, usuario: Usuario | null): { etiqueta: string; esRolFallback: boolean } {
  const ids = items[0].assignedUserIds ?? [];
  if (ids.length === 0) {
    return { etiqueta: ETIQUETAS_ROLES[items[0].assignedRole] ?? items[0].assignedRole, esRolFallback: true };
  }
  if (ids.length === 1 && usuario?.id === ids[0]) {
    return { etiqueta: usuario.displayName || usuario.email || "Tú", esRolFallback: false };
  }
  if (ids.length <= 2) {
    return { etiqueta: ids.map((id) => nombreUsuarioPorId(id, usuariosMap)).join(", "), esRolFallback: false };
  }
  return { etiqueta: `${ids.length} responsables`, esRolFallback: false };
}

export default function TareasPage() {
  const auth = useAuth();
  const usuario = auth.cargando || !auth.usuario ? null : auth.usuario;
  const roles = usuario?.roles ?? [];
  const puedeGenerar = roles.includes("admin") || roles.includes("client_manager");
  const verDominios = puedeGenerar || roles.includes("domain_updater") || roles.includes("viewer");
  const verBd = puedeGenerar || roles.includes("database_updater") || roles.includes("viewer");

  // Cargar nombres de los usuarios cuando el actual puede gestionar (admin / client_manager).
  const { data: usuarios = [] } = useQuery({
    queryKey: ["usuarios-tareas"],
    queryFn: () => api.get<Array<{ id: string; displayName: string; email: string }>>("/users"),
    enabled: puedeGenerar,
  });
  const usuariosMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of usuarios) m.set(u.id, u.displayName || u.email);
    return m;
  }, [usuarios]);

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Tareas</h2>
      </div>
      <Alerta tipo="info">Vista operativa: vencidas abiertas, hoy, próximas 4 días y completadas recientes.</Alerta>
      <div className="tareas-grid">
        {verDominios && <ColumnaTareas titulo="Tareas de dominios" targetType="domain" usuario={usuario} usuariosMap={usuariosMap} />}
        {verBd && <ColumnaTareas titulo="Tareas de bases de datos" targetType="database" usuario={usuario} usuariosMap={usuariosMap} />}
        {!verDominios && !verBd && <Alerta tipo="info">No tienes tareas asignadas.</Alerta>}
      </div>
    </>
  );
}

function ColumnaTareas({ titulo, targetType, usuario, usuariosMap }: { titulo: string; targetType: "domain" | "database"; usuario: Usuario | null; usuariosMap: Map<string, string> }) {
  const qc = useQueryClient();
  const [grupoActivo, setGrupoActivo] = useState<GrupoResumen | null>(null);
  const [confirmando, setConfirmando] = useState<{ tarea: Tarea } | null>(null);
  const [guardado, setGuardado] = useState<Record<string, { estado: EstadoGuardado; mensaje?: string; reintento?: { accion: AccionTarea; body?: any } }>>({});
  const [error, setError] = useState<string | null>(null);

  const { data: tareas = [], isLoading } = useQuery({
    queryKey: ["tareas", targetType],
    queryFn: () => api.get<Tarea[]>(`/tasks?targetType=${targetType}&dateTo=${VENTANA_TAREAS.hasta}`),
  });

  const { data: actualizaciones = [] } = useQuery({
    queryKey: ["frecuencias-tareas"],
    queryFn: () => api.get<Frecuencia[]>("/schedules"),
  });
  const nombresProgramacion = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of actualizaciones) m.set(f.id, f.name || f.clientName || "Actualización programada");
    return m;
  }, [actualizaciones]);

  const cambiarEstado = useMutation({
    mutationFn: ({ id, accion, body }: { id: string; accion: AccionTarea; body?: any }) => api.post(`/tasks/${id}/${accion}`, body ?? {}),
    onMutate: ({ id, accion, body }) => {
      setGuardado((m) => ({ ...m, [id]: { estado: "guardando", reintento: { accion, body } } }));
      setError(null);
    },
    onSuccess: (_r, variables) => {
      const nuevoEstado = variables.accion === "resolve-block"
        ? (variables.body?.newStatus ?? "pending")
        : estadoDespuesDeAccion(variables.accion);
      qc.setQueryData<Tarea[]>(["tareas", targetType], (actuales = []) =>
        actuales.map((t) => t.id === variables.id ? {
          ...t,
          status: nuevoEstado,
          notes: variables.body?.notes ?? t.notes,
          completedWithProblems: nuevoEstado === "completed" ? !!variables.body?.withProblems : t.completedWithProblems,
          problemNote: variables.body?.problemNote ?? t.problemNote,
          completionNote: variables.body?.completionNote ?? t.completionNote,
          completedAt: nuevoEstado === "completed" ? new Date().toISOString() : t.completedAt,
        } : t)
      );
      setGuardado((m) => ({ ...m, [variables.id]: { estado: "guardado" } }));
    },
    onError: (e: any, variables) => {
      const mensaje = e?.message ?? "No se pudo guardar el cambio.";
      setError(mensaje);
      setGuardado((m) => ({ ...m, [variables.id]: { estado: "error", mensaje, reintento: { accion: variables.accion, body: variables.body } } }));
    },
  });

  const tareasVisibles = useMemo(() => tareas.filter((t) => t.status !== "cancelled"), [tareas]);
  const grupos = useMemo(() => agruparTareas(tareasVisibles, targetType, usuario, usuariosMap, nombresProgramacion), [tareasVisibles, targetType, usuario, usuariosMap, nombresProgramacion]);

  // Clasificación por zona Bogotá: hoy / próximas / vencidas / completadas.
  const seccionado = useMemo(() => {
    const out: Record<ClasificacionTarea, GrupoResumen[]> = { vencidas: [], hoy: [], proximas: [], completadas: [], fueraVentana: [] };
    for (const g of grupos) {
      const todasCompletadas = g.tareas.every((t) => t.status === "completed");
      const completedAt = todasCompletadas
        ? g.tareas.map((t) => t.completedAt?.slice(0, 10)).filter(Boolean).sort().at(-1) ?? null
        : null;
      const cls = clasificarTareaPorFecha(g.fecha, todasCompletadas ? "completed" : "pending", HOY, completedAt);
      out[cls].push(g);
    }
    return out;
  }, [grupos]);

  function accionar(id: string, accion: AccionTarea, body?: any) {
    cambiarEstado.mutate({ id, accion, body });
  }

  return (
    <div className="columna-tareas">
      <h3>{titulo}</h3>
      {error && <Alerta tipo="error">{error}</Alerta>}
      {isLoading ? <div className="cargando">Cargando...</div> : (
        <>
          <GrupoResumenSeccion titulo="Vencidas" grupos={seccionado.vencidas} onAbrir={setGrupoActivo} />
          <GrupoResumenSeccion titulo="Hoy" grupos={seccionado.hoy} onAbrir={setGrupoActivo} />
          <GrupoResumenSeccion titulo="Próximas" grupos={seccionado.proximas} onAbrir={setGrupoActivo} />
          <GrupoResumenSeccion titulo="Completadas" grupos={seccionado.completadas} onAbrir={setGrupoActivo} />
        </>
      )}

      <Modal
        titulo={grupoActivo ? `${grupoActivo.responsableEtiqueta} — ${etiquetaTipo(grupoActivo.targetType, true)} por actualizar` : ""}
        abierto={!!grupoActivo}
        onCerrar={() => setGrupoActivo(null)}
        className="modal-detalle-tareas"
      >
        {grupoActivo && (
          <DetalleGrupo
            grupo={grupos.find((g) => g.id === grupoActivo.id) ?? grupoActivo}
            usuario={usuario}
            guardado={guardado}
            onSolicitarCompletar={(tarea) => setConfirmando({ tarea })}
            onAccion={accionar}
          />
        )}
      </Modal>

      <ModalConfirmarCompletar
        abierto={!!confirmando}
        tarea={confirmando?.tarea ?? null}
        onCerrar={() => setConfirmando(null)}
        onConfirmar={(payload) => {
          if (!confirmando) return;
          const t = confirmando.tarea;
          accionar(t.id, "complete", payload);
          setConfirmando(null);
        }}
      />
    </div>
  );
}

function rootScheduleIdTarea(tarea: Tarea): string {
  if (tarea.rootScheduleId) return tarea.rootScheduleId;
  return tarea.scheduleId.split("__")[0] || tarea.scheduleId;
}

function agruparTareas(tareas: Tarea[], targetType: "domain" | "database", usuario: Usuario | null, usuariosMap: Map<string, string>, nombresProgramacion: Map<string, string>): GrupoResumen[] {
  const sep = "\u001f";
  const mapa = new Map<string, Tarea[]>();
  for (const tarea of tareas) {
    const responsable = claveResponsable(tarea);
    const rootId = rootScheduleIdTarea(tarea);
    const key = [tarea.taskDate, responsable, targetType, rootId].join(sep);
    mapa.set(key, [...(mapa.get(key) ?? []), tarea]);
  }

  return Array.from(mapa.entries()).map(([key, items]) => {
    const [fecha, responsableClave, , rootScheduleId] = key.split(sep);
    const completadasOk = items.filter((t) => t.status === "completed" && !t.completedWithProblems).length;
    const completadasConProblemas = items.filter((t) => (t.status === "completed" && t.completedWithProblems) || t.status === "failed").length;
    const pendientes = items.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
    const { etiqueta, esRolFallback } = etiquetaResponsableDeGrupo(items, usuariosMap, usuario);
    const ids = items[0].assignedUserIds ?? [];
    const asignadoAlActual = !!usuario && ids.includes(usuario.id);
    const rolNecesario = items[0].targetType === "domain" ? "domain_updater" : "database_updater";
    const rolHabilitaActual = !!usuario && (usuario.roles ?? []).includes(rolNecesario) && ids.length === 0;
    return {
      id: key,
      fecha,
      responsableClave,
      responsableEtiqueta: etiqueta,
      responsableEsRolFallback: esRolFallback,
      asignadoAlActual,
      rolHabilitaActual,
      targetType,
      rootScheduleId,
      scheduleName: nombresProgramacion.get(rootScheduleId),
      tareas: items.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.targetName.localeCompare(b.targetName)),
      total: items.length,
      completadasOk,
      completadasConProblemas,
      pendientes,
      estadoAgregado: calcularEstadoGrupo(items, fecha),
    };
  }).sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.scheduleName ?? "").localeCompare(b.scheduleName ?? "") || a.responsableEtiqueta.localeCompare(b.responsableEtiqueta));
}

function GrupoResumenSeccion({ titulo, grupos, onAbrir }: { titulo: string; grupos: GrupoResumen[]; onAbrir: (g: GrupoResumen) => void }) {
  return (
    <div className="grupo-tareas">
      <div className="grupo-tareas-titulo">{titulo} <span style={{ color: "#9ca3af", fontWeight: 400 }}>({grupos.length})</span></div>
      {grupos.length === 0 ? <div className="vacio" style={{ padding: 8, fontSize: 12 }}>Sin grupos.</div> : (
        <ul className="lista-tareas">
          {grupos.map((g) => {
            const clases = ["item-tarea"];
            if (g.asignadoAlActual) clases.push("item-tarea-asignada");
            else if (g.rolHabilitaActual) clases.push("item-tarea-rol-actual");
            return (
              <li key={g.id} className={clases.join(" ")}>
                <div className="item-tarea-datos">
                  <div className="item-tarea-fila">
                    <strong>{g.responsableEtiqueta} — {g.targetType === "domain" ? "Dominios" : "Bases de datos"} por actualizar</strong>
                    {g.asignadoAlActual && <span className="badge-asignado">Asignado a ti</span>}
                    {!g.asignadoAlActual && g.rolHabilitaActual && <span className="badge-rol">Tu rol puede atender esta tarea</span>}
                    <EtiquetaEstado estado={g.estadoAgregado === "overdue" ? "failed" : g.estadoAgregado === "with_problems" ? "blocked" : g.estadoAgregado} />
                  </div>
                  <div className="item-tarea-fila item-tarea-detalle">
                    <span>Fecha: {g.fecha}</span>
                    <span>Total: {g.total} {etiquetaTipo(g.targetType, true)}</span>
                  </div>
                  {g.scheduleName && (
                    <div className="item-tarea-fila item-tarea-detalle">
                      <span>Actualización: {g.scheduleName}</span>
                    </div>
                  )}
                  <div className="item-tarea-fila item-tarea-detalle">
                    <span>Completadas: {g.completadasOk} / {g.total}</span>
                    <span>Pendientes: {g.pendientes}</span>
                    <span>Con problemas: {g.completadasConProblemas}</span>
                  </div>
                  <div className="item-tarea-fila item-tarea-detalle">
                    <span>Estado: {etiquetaEstadoGrupo(g.estadoAgregado)}</span>
                    {!g.responsableEsRolFallback && <span>Responsable: {g.responsableEtiqueta}</span>}
                  </div>
                </div>
                <div className="acciones-tabla">
                  <button onClick={() => onAbrir(g)}>Ver detalle</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DetalleGrupo({ grupo, usuario, guardado, onSolicitarCompletar, onAccion }: {
  grupo: GrupoResumen;
  usuario: Usuario | null;
  guardado: Record<string, { estado: EstadoGuardado; mensaje?: string; reintento?: { accion: AccionTarea; body?: any } }>;
  onSolicitarCompletar: (t: Tarea) => void;
  onAccion: (id: string, accion: AccionTarea, body?: any) => void;
}) {
  const pendientes = grupo.tareas.filter((t) => t.status !== "completed" && t.status !== "cancelled");
  const [bloqueo, setBloqueo] = useState<Tarea | null>(null);
  const [resolver, setResolver] = useState<Tarea | null>(null);
  const [reabrir, setReabrir] = useState<Tarea | null>(null);
  return (
    <>
      <p>
        <strong>Fecha:</strong> {grupo.fecha} ·{" "}
        <strong>Responsables:</strong> {grupo.responsableEtiqueta}
      </p>
      <p>
        <strong>Total:</strong> {grupo.total} · <strong>Completadas:</strong> {grupo.completadasOk} / {grupo.total} · <strong>Con problemas:</strong> {grupo.completadasConProblemas}
      </p>
      {grupo.scheduleName && <p><strong>Actualización programada:</strong> {grupo.scheduleName}</p>}
      {grupo.targetType === "domain" ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="primario"
            onClick={() => copiarTexto(pendientes.map((t) => formatDomainForPublishing(t.domainName)).filter(Boolean).join("\n"))}
          >
            Copiar todos los dominios pendientes (formato publicable)
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => copiarTexto(pendientes.map((t) => t.targetName).filter(Boolean).join("\n"))}
        >
          Copiar todas las bases pendientes
        </button>
      )}

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Cliente</th>
            {grupo.targetType === "domain" ? (
              <>
                <th>Dominio registrado</th>
                <th>Dominio para publicar</th>
              </>
            ) : (
              <>
                <th>Dominio para publicar</th>
                <th>Base / conexión</th>
              </>
            )}
            <th>Estado</th>
            <th>Nota</th>
            <th className="columna-acciones">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {grupo.tareas.map((tarea) => {
            const estado = guardado[tarea.id];
            const puedeCambiar = puedeCambiarTarea(usuario, tarea);
            const notaMostrada = tarea.completedWithProblems
              ? `Con problemas: ${tarea.problemNote || "Reportó problema"}`
              : (tarea.completionNote || tarea.notes || "-");
            const dominioPublicable = formatDomainForPublishing(tarea.domainName);
            return (
              <tr key={tarea.id}>
                <td>{tarea.clientName}</td>
                {grupo.targetType === "domain" ? (
                  <>
                    <td style={{ fontSize: 12, color: "#6b7280" }}>{tarea.domainName}</td>
                    <td style={{ fontFamily: "monospace" }}>{dominioPublicable}</td>
                  </>
                ) : (
                  <>
                    <td style={{ fontFamily: "monospace" }}>{dominioPublicable}</td>
                    <td>
                      <ConexionBaseCelda tarea={tarea} usuario={usuario} />
                    </td>
                  </>
                )}
                <td><EtiquetaEstado estado={tarea.completedWithProblems ? "blocked" : tarea.status} /></td>
                <td style={{ maxWidth: 260, fontSize: 12 }}>
                  <div>{notaMostrada}</div>
                  {estado?.estado && (
                    <div className={`estado-guardado estado-guardado-${estado.estado}`}>
                      {estado.estado === "guardando" && "Guardando..."}
                      {estado.estado === "guardado" && "Guardado"}
                      {estado.estado === "error" && (
                        <>
                          Error
                          <button type="button" onClick={() => estado.reintento && onAccion(tarea.id, estado.reintento.accion, estado.reintento.body)}>
                            Reintentar
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </td>
                <td className="acciones-tabla acciones-fila-tarea celda-acciones" data-testid={`acciones-tarea-${tarea.id}`}>
                  {grupo.targetType === "domain" ? (
                    <button type="button" className="primario" onClick={() => copiarTexto(dominioPublicable)}>
                      Copiar dominio para publicar
                    </button>
                  ) : (
                    null
                  )}
                  {puedeCambiar && tarea.status !== "completed" && tarea.status !== "cancelled" && (
                    <button type="button" className="exito" onClick={() => onSolicitarCompletar(tarea)}>Completar</button>
                  )}
                  {puedeCambiar && tarea.status !== "completed" && tarea.status !== "cancelled" && tarea.status !== "blocked" && (
                    <button type="button" className="advertencia" onClick={() => setBloqueo(tarea)}>Bloquear</button>
                  )}
                  {puedeCambiar && tarea.status === "blocked" && (
                    <button type="button" className="primario" onClick={() => setResolver(tarea)}>Resolver bloqueo</button>
                  )}
                  {puedeCambiar && tarea.status === "completed" && (
                    <button type="button" onClick={() => setReabrir(tarea)}>Reabrir</button>
                  )}
                  {!puedeCambiar && <span className="texto-ayuda">Sin permiso</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ModalBloquearTarea
        tarea={bloqueo}
        onCerrar={() => setBloqueo(null)}
        onConfirmar={(motivo) => {
          if (!bloqueo) return;
          onAccion(bloqueo.id, "block", { blockReason: motivo, notes: motivo });
          setBloqueo(null);
        }}
      />
      <ModalResolverBloqueo
        tarea={resolver}
        onCerrar={() => setResolver(null)}
        onConfirmar={(payload) => {
          if (!resolver) return;
          onAccion(resolver.id, "resolve-block", payload);
          setResolver(null);
        }}
      />
      <ModalReabrirTarea
        tarea={reabrir}
        onCerrar={() => setReabrir(null)}
        onConfirmar={(reopenReason) => {
          if (!reabrir) return;
          onAccion(reabrir.id, "reopen", { reopenReason });
          setReabrir(null);
        }}
      />
    </>
  );
}

function ModalBloquearTarea({ tarea, onCerrar, onConfirmar }: {
  tarea: Tarea | null;
  onCerrar: () => void;
  onConfirmar: (motivo: string) => void;
}) {
  const [motivo, setMotivo] = useState("");
  useEffect(() => { if (tarea) setMotivo(""); }, [tarea?.id]);
  return (
    <Modal titulo="Bloquear tarea" abierto={!!tarea} onCerrar={onCerrar}>
      <p>Indique el motivo por el cual esta tarea queda bloqueada.</p>
      <div className="fila-formulario">
        <label htmlFor="motivo-bloqueo">Motivo del bloqueo *</label>
        <textarea id="motivo-bloqueo" rows={3} maxLength={4000} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </div>
      <div className="acciones-formulario">
        <button type="button" onClick={onCerrar}>Cancelar</button>
        <button type="button" className="advertencia" disabled={!motivo.trim()} onClick={() => onConfirmar(motivo.trim())}>Bloquear tarea</button>
      </div>
    </Modal>
  );
}

function ModalResolverBloqueo({ tarea, onCerrar, onConfirmar }: {
  tarea: Tarea | null;
  onCerrar: () => void;
  onConfirmar: (payload: { resolutionComment?: string; newStatus: "pending" | "in_progress" | "completed" }) => void;
}) {
  const [comentario, setComentario] = useState("");
  const [newStatus, setNewStatus] = useState<"pending" | "in_progress" | "completed">("pending");
  useEffect(() => { if (tarea) { setComentario(""); setNewStatus("pending"); } }, [tarea?.id]);
  return (
    <Modal titulo="Resolver bloqueo" abierto={!!tarea} onCerrar={onCerrar}>
      <p>Esta tarea está bloqueada por un problema reportado. Indique cómo desea continuar.</p>
      <div className="fila-formulario">
        <label htmlFor="comentario-resolucion">Comentario de resolución (opcional)</label>
        <textarea id="comentario-resolucion" rows={3} maxLength={4000} value={comentario} onChange={(e) => setComentario(e.target.value)} />
      </div>
      <div className="fila-formulario">
        <label htmlFor="nuevo-estado-bloqueo">Nuevo estado *</label>
        <select id="nuevo-estado-bloqueo" value={newStatus} onChange={(e) => setNewStatus(e.target.value as any)}>
          <option value="pending">Pendiente</option>
          <option value="in_progress">En progreso</option>
          <option value="completed">Completada</option>
        </select>
      </div>
      <div className="acciones-formulario">
        <button type="button" onClick={onCerrar}>Cancelar</button>
        <button type="button" className="primario" onClick={() => onConfirmar({ resolutionComment: comentario.trim() || undefined, newStatus })}>Guardar resolución</button>
      </div>
    </Modal>
  );
}

function ModalReabrirTarea({ tarea, onCerrar, onConfirmar }: {
  tarea: Tarea | null;
  onCerrar: () => void;
  onConfirmar: (motivo?: string) => void;
}) {
  const [motivo, setMotivo] = useState("");
  useEffect(() => { if (tarea) setMotivo(""); }, [tarea?.id]);
  return (
    <Modal titulo="Reabrir tarea completada" abierto={!!tarea} onCerrar={onCerrar}>
      <p>Esta tarea ya fue marcada como completada. Si la reabre, volverá a quedar pendiente y podrá completarse nuevamente.</p>
      <div className="fila-formulario">
        <label htmlFor="motivo-reapertura">Motivo de reapertura (opcional)</label>
        <textarea id="motivo-reapertura" rows={3} maxLength={4000} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </div>
      <div className="acciones-formulario">
        <button type="button" onClick={onCerrar}>Cancelar</button>
        <button type="button" className="primario" onClick={() => onConfirmar(motivo.trim() || undefined)}>Reabrir tarea</button>
      </div>
    </Modal>
  );
}

function ConexionBaseCelda({ tarea, usuario }: { tarea: Tarea; usuario: Usuario | null }) {
  const [passwordVisible, setPasswordVisible] = useState<string | null>(null);
  const [cargandoPwd, setCargandoPwd] = useState(false);
  const [errorPwd, setErrorPwd] = useState<string | null>(null);
  const [mensajePwd, setMensajePwd] = useState<string | null>(null);
  const ocultarTimer = useRef<number | null>(null);
  const puedeVerPassword = puedeCambiarTarea(usuario, tarea);
  const conexion = useQuery({
    queryKey: ["conexion-db-tarea", tarea.targetId, tarea.id],
    queryFn: () => api.get<ConexionInfo>(`/databases/${tarea.targetId}/access-info?taskId=${encodeURIComponent(tarea.id)}`),
    enabled: tarea.targetType === "database" && !!tarea.targetId && !!tarea.id,
    retry: false,
  });

  function ocultarPassword() {
    if (ocultarTimer.current) { window.clearTimeout(ocultarTimer.current); ocultarTimer.current = null; }
    setPasswordVisible(null);
  }

  // "Ver" alterna: si ya está visible, la oculta; si no, la revela (con
  // auto-ocultado a los 30s). Limpia el temporizador previo para no reocultar
  // antes de tiempo al re-revelar.
  async function alternarVer() {
    if (passwordVisible) { ocultarPassword(); return; }
    if (!conexion.data || !puedeVerPassword) return;
    setCargandoPwd(true);
    setErrorPwd(null);
    setMensajePwd(null);
    try {
      const r = await api.post<{ password: string }>(`/databases/${tarea.targetId}/reveal-password`, { taskId: tarea.id, reason: "task_detail" });
      setPasswordVisible(r.password);
      if (ocultarTimer.current) window.clearTimeout(ocultarTimer.current);
      ocultarTimer.current = window.setTimeout(() => { setPasswordVisible(null); ocultarTimer.current = null; }, 30000);
    } catch (e: any) {
      setErrorPwd(e?.message ?? "No se pudo revelar la contraseña.");
    } finally {
      setCargandoPwd(false);
    }
  }

  async function copiarPassword() {
    if (!conexion.data || !puedeVerPassword) return;
    setCargandoPwd(true);
    setErrorPwd(null);
    setMensajePwd(null);
    try {
      const r = await api.post<{ password: string }>(`/databases/${tarea.targetId}/reveal-password`, { taskId: tarea.id, reason: "task_detail_copy" });
      const ok = await copiarTexto(r.password);
      if (ok) {
        setMensajePwd("Contraseña copiada al portapapeles.");
      } else {
        // Si el navegador bloqueó el portapapeles, mostramos la contraseña
        // para que el usuario pueda copiarla manualmente.
        setPasswordVisible(r.password);
        setErrorPwd("No se pudo copiar automáticamente. La contraseña se muestra para copiarla manualmente.");
      }
    } catch (e: any) {
      setErrorPwd(e?.message ?? "No se pudo copiar la contraseña.");
    } finally {
      setCargandoPwd(false);
    }
  }

  if (conexion.isLoading || conexion.isFetching) return <span className="texto-ayuda">Cargando conexión...</span>;
  if (conexion.isError) {
    const error = conexion.error as Error & { status?: number };
    const esPermiso = error.status === 403 || /permiso/i.test(error.message);
    return (
      <div className="conexion-celda">
        <span className="texto-ayuda" style={{ color: esPermiso ? "#92400e" : "#991b1b" }}>
          {esPermiso ? "No tienes permiso para ver esta conexión." : "No se pudo cargar la conexión."}
        </span>
        {!esPermiso && <button type="button" onClick={() => conexion.refetch()}>Reintentar</button>}
      </div>
    );
  }
  const info = conexion.data;
  if (!info) return <span className="texto-ayuda">No se pudo cargar la conexión.</span>;
  return (
    <div className="conexion-celda">
      <ConexionLinea etiqueta="Servidor" valor={info.server} />
      <ConexionLinea etiqueta="Base" valor={info.databaseName} />
      <ConexionLinea etiqueta="Usuario" valor={info.user} />
      <div className="conexion-linea">
        <strong>Contraseña:</strong>
        <span className="conexion-valor">{info.hasPassword ? (passwordVisible ?? "••••••••••••") : "No configurada"}</span>
        <span className="acciones-tabla">
          {puedeVerPassword && info.hasPassword ? (
            <>
              <button type="button" disabled={cargandoPwd} onClick={alternarVer}>{passwordVisible ? "Ocultar" : "Ver"}</button>
              <button type="button" disabled={cargandoPwd} onClick={copiarPassword}>Copiar</button>
            </>
          ) : (
            <button type="button" disabled title="No tienes permiso para ver esta contraseña.">Sin permiso</button>
          )}
        </span>
      </div>
      {mensajePwd && <span className="texto-ayuda" style={{ color: "#047857" }}>{mensajePwd}</span>}
      {errorPwd && <span className="texto-ayuda" style={{ color: "#991b1b" }}>{errorPwd}</span>}
    </div>
  );
}

function ConexionLinea({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="conexion-linea">
      <strong>{etiqueta}:</strong>
      <span className="conexion-valor">{valor}</span>
      <button type="button" onClick={() => copiarTexto(valor)}>Copiar</button>
    </div>
  );
}

function ModalConfirmarCompletar({ abierto, tarea, onCerrar, onConfirmar }: {
  abierto: boolean;
  tarea: Tarea | null;
  onCerrar: () => void;
  onConfirmar: (payload: { withProblems: boolean; problemNote?: string; completionNote?: string; notes?: string; result?: string }) => void;
}) {
  const [tuvoProblemas, setTuvoProblemas] = useState(false);
  const [problema, setProblema] = useState("");
  const [nota, setNota] = useState("");

  // Reset cuando se abre/cambia la tarea.
  useEffect(() => {
    if (abierto) { setTuvoProblemas(false); setProblema(""); setNota(""); }
  }, [abierto, tarea?.id]);

  if (!tarea) return null;
  const esBloqueada = tarea.status === "blocked";
  return (
    <Modal titulo={esBloqueada ? "Completar tarea bloqueada" : "Confirmar actualización"} abierto={abierto} onCerrar={onCerrar}>
      <p>
        {esBloqueada
          ? "Esta tarea estaba bloqueada por un problema reportado. Si ya fue corregido y la actualización se completó correctamente, puede marcarla como completada."
          : "Confirma que completaste esta actualización."}
      </p>
      <p style={{ fontSize: 12, color: "#6b7280" }}>
        {tarea.targetType === "domain"
          ? `Dominio: ${tarea.domainName}`
          : `${tarea.targetName} (dominio ${tarea.domainName})`}
      </p>

      {!esBloqueada && (
        <div className="fila-formulario">
          <label>
            <input
              type="checkbox"
              style={{ width: "auto", marginRight: 6 }}
              checked={tuvoProblemas}
              onChange={(e) => setTuvoProblemas(e.target.checked)}
            />
            ¿Tuviste algún problema durante la actualización?
          </label>
        </div>
      )}

      {!esBloqueada && tuvoProblemas && (
        <div className="fila-formulario">
          <label htmlFor="problema-note">Describe el problema encontrado</label>
          <textarea
            id="problema-note"
            rows={3}
            maxLength={4000}
            value={problema}
            onChange={(e) => setProblema(e.target.value)}
            placeholder="¿Qué pasó? Esta nota se enviará a los administradores."
          />
        </div>
      )}

      <div className="fila-formulario">
        <label htmlFor="completion-note">{esBloqueada ? "Comentario de cierre (opcional)" : "Nota de actualización (opcional)"}</label>
        <textarea
          id="completion-note"
          rows={2}
          maxLength={4000}
          value={nota}
          onChange={(e) => setNota(e.target.value)}
        />
      </div>

      <div className="acciones-formulario">
        <button type="button" onClick={onCerrar}>Cancelar</button>
        <button
          type="button"
          className="primario"
          disabled={!esBloqueada && tuvoProblemas && !problema.trim()}
          onClick={() => onConfirmar({
            withProblems: esBloqueada ? false : tuvoProblemas,
            problemNote: !esBloqueada && tuvoProblemas ? problema.trim() : undefined,
            completionNote: nota.trim() || undefined,
            notes: nota.trim() || undefined,
            result: !esBloqueada && tuvoProblemas ? "completed_with_problems" : "success",
          })}
        >
          {esBloqueada ? "Marcar como completada" : "Confirmar actualización"}
        </button>
      </div>
    </Modal>
  );
}
