import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { Tarea, Usuario } from "../types";
import { ETIQUETAS_ROLES } from "../types";
import { Alerta, EtiquetaEstado, Modal } from "../components/Comunes";
import { hoyEnBogotaIso, sumarDiasIso, clasificarTareaPorFecha, type ClasificacionTarea } from "../utils/fechas";
import { formatDomainForPublishing } from "../utils/dominio";

// La ventana de visualización se calcula en zona Bogotá. Las comparaciones
// "hoy / próximas / vencidas" usan ese mismo `HOY` para evitar drift por UTC.
const HOY = hoyEnBogotaIso();
const VENTANA_TAREAS = {
  desde: sumarDiasIso(HOY, -7),
  hasta: sumarDiasIso(HOY, 7),
};

type AccionTarea = "start" | "complete" | "fail" | "reopen";
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
  tareas: Tarea[];
  total: number;
  completadasOk: number;
  completadasConProblemas: number;
  pendientes: number;
  estadoAgregado: "completed" | "with_problems" | "in_progress" | "pending" | "overdue";
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
  if (accion === "start") return "in_progress";
  if (accion === "complete") return "completed";
  if (accion === "fail") return "failed";
  return "reopened";
}

async function copiarTexto(texto: string): Promise<void> {
  if (!texto) return;
  await navigator.clipboard?.writeText(texto);
}

function claveResponsable(t: Tarea): string {
  return t.assignedUserIds.length ? t.assignedUserIds.slice().sort().join("|") : `rol:${t.assignedRole}`;
}

function etiquetaResponsableDeGrupo(items: Tarea[], usuariosMap: Map<string, string>, usuario: Usuario | null): { etiqueta: string; esRolFallback: boolean } {
  const ids = items[0].assignedUserIds ?? [];
  if (ids.length === 0) {
    return { etiqueta: ETIQUETAS_ROLES[items[0].assignedRole] ?? items[0].assignedRole, esRolFallback: true };
  }
  // Caso especial: el único responsable es el usuario actual.
  if (ids.length === 1 && usuario?.id === ids[0]) {
    return { etiqueta: "Tú", esRolFallback: false };
  }
  if (ids.length <= 2) {
    return { etiqueta: ids.map((id) => nombreUsuarioPorId(id, usuariosMap)).join(", "), esRolFallback: false };
  }
  return { etiqueta: `${ids.length} responsables`, esRolFallback: false };
}

export default function TareasPage() {
  const qc = useQueryClient();
  const auth = useAuth();
  const usuario = auth.cargando || !auth.usuario ? null : auth.usuario;
  const roles = usuario?.roles ?? [];
  const puedeGenerar = roles.includes("admin") || roles.includes("client_manager");
  const verDominios = puedeGenerar || roles.includes("domain_updater") || roles.includes("viewer");
  const verBd = puedeGenerar || roles.includes("database_updater") || roles.includes("viewer");

  const [mensaje, setMensaje] = useState<string | null>(null);
  const [errorGeneracion, setErrorGeneracion] = useState<string | null>(null);

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

  const generarTareas = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number; windowStart?: string; windowEnd?: string; message: string }>("/tasks/generate", {}),
    onSuccess: (r) => {
      setMensaje(`${r.message ?? "Tareas generadas correctamente."} Creadas: ${r.created ?? 0}. Omitidas: ${r.skipped ?? 0}.`);
      setErrorGeneracion(null);
      qc.invalidateQueries({ queryKey: ["tareas"] });
    },
    onError: (e: any) => {
      setMensaje(null);
      setErrorGeneracion(e?.message ?? "No se pudieron generar las tareas.");
    },
  });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Tareas</h2>
        {puedeGenerar && (
          <button className="primario" onClick={() => generarTareas.mutate()} disabled={generarTareas.isPending}>
            {generarTareas.isPending ? "Generando..." : "Generar tareas ahora"}
          </button>
        )}
      </div>
      {mensaje && <Alerta tipo="exito">{mensaje}</Alerta>}
      {errorGeneracion && <Alerta tipo="error">{errorGeneracion}</Alerta>}
      <Alerta tipo="info">Mostrando grupos de trabajo desde {VENTANA_TAREAS.desde} hasta {VENTANA_TAREAS.hasta} (zona América/Bogotá).</Alerta>
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
    queryFn: () => api.get<Tarea[]>(`/tasks?targetType=${targetType}&dateFrom=${VENTANA_TAREAS.desde}&dateTo=${VENTANA_TAREAS.hasta}`),
  });

  const cambiarEstado = useMutation({
    mutationFn: ({ id, accion, body }: { id: string; accion: AccionTarea; body?: any }) => api.post(`/tasks/${id}/${accion}`, body ?? {}),
    onMutate: ({ id, accion, body }) => {
      setGuardado((m) => ({ ...m, [id]: { estado: "guardando", reintento: { accion, body } } }));
      setError(null);
    },
    onSuccess: (_r, variables) => {
      const nuevoEstado = estadoDespuesDeAccion(variables.accion);
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

  const grupos = useMemo(() => agruparTareas(tareas, targetType, usuario, usuariosMap), [tareas, targetType, usuario, usuariosMap]);

  // Clasificación por zona Bogotá: hoy / próximas / vencidas / completadas.
  const seccionado = useMemo(() => {
    const out: Record<ClasificacionTarea, GrupoResumen[]> = { vencidas: [], hoy: [], proximas: [], completadas: [], fueraVentana: [] };
    for (const g of grupos) {
      const cls = clasificarTareaPorFecha(g.fecha, g.estadoAgregado === "completed" ? "completed" : "pending", HOY);
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

function agruparTareas(tareas: Tarea[], targetType: "domain" | "database", usuario: Usuario | null, usuariosMap: Map<string, string>): GrupoResumen[] {
  const mapa = new Map<string, Tarea[]>();
  for (const tarea of tareas) {
    const responsable = claveResponsable(tarea);
    const key = `${tarea.taskDate}|${responsable}|${targetType}`;
    mapa.set(key, [...(mapa.get(key) ?? []), tarea]);
  }

  return Array.from(mapa.entries()).map(([key, items]) => {
    const [fecha, responsableClave] = key.split("|");
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
      tareas: items.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.targetName.localeCompare(b.targetName)),
      total: items.length,
      completadasOk,
      completadasConProblemas,
      pendientes,
      estadoAgregado: calcularEstadoGrupo(items, fecha),
    };
  }).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.responsableEtiqueta.localeCompare(b.responsableEtiqueta));
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

  return (
    <>
      <p>
        <strong>Fecha:</strong> {grupo.fecha} ·{" "}
        <strong>Responsables:</strong> {grupo.responsableEtiqueta}
      </p>
      <p>
        <strong>Total:</strong> {grupo.total} · <strong>Completadas:</strong> {grupo.completadasOk} / {grupo.total} · <strong>Con problemas:</strong> {grupo.completadasConProblemas}
      </p>
      {grupo.targetType === "domain" ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="primario"
            onClick={() => copiarTexto(pendientes.map((t) => formatDomainForPublishing(t.domainName)).filter(Boolean).join("\n"))}
          >
            Copiar todos los dominios pendientes (formato publicable)
          </button>
          <button
            type="button"
            onClick={() => copiarTexto(pendientes.map((t) => t.domainName).filter(Boolean).join("\n"))}
          >
            Copiar URLs completas
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
            <th>Dominio registrado</th>
            <th>Dominio para publicar</th>
            {grupo.targetType === "database" && <th>Base</th>}
            <th>Estado</th>
            <th>Nota</th>
            <th>Guardado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {grupo.tareas.map((tarea) => {
            const estado = guardado[tarea.id];
            const puedeCambiar = puedeCambiarTarea(usuario, tarea);
            const notaMostrada = tarea.completedWithProblems
              ? `⚠ ${tarea.problemNote || "Reportó problema"}`
              : (tarea.completionNote || tarea.notes || "-");
            const dominioPublicable = formatDomainForPublishing(tarea.domainName);
            return (
              <tr key={tarea.id}>
                <td>{tarea.clientName}</td>
                <td style={{ fontSize: 12, color: "#6b7280" }}>{tarea.domainName}</td>
                <td style={{ fontFamily: "monospace" }}>{dominioPublicable}</td>
                {grupo.targetType === "database" && <td>{tarea.targetName}</td>}
                <td><EtiquetaEstado estado={tarea.completedWithProblems ? "blocked" : tarea.status} /></td>
                <td style={{ maxWidth: 240, fontSize: 12 }}>{notaMostrada}</td>
                <td>
                  {estado?.estado === "guardando" && "Guardando..."}
                  {estado?.estado === "guardado" && "Guardado"}
                  {estado?.estado === "error" && (
                    <>
                      Error
                      <button type="button" onClick={() => estado.reintento && onAccion(tarea.id, estado.reintento.accion, estado.reintento.body)}>
                        Reintentar
                      </button>
                    </>
                  )}
                </td>
                <td className="acciones-tabla">
                  {grupo.targetType === "domain" ? (
                    <>
                      <button type="button" className="primario" onClick={() => copiarTexto(dominioPublicable)}>
                        Copiar dominio para publicar
                      </button>
                      <button type="button" onClick={() => copiarTexto(tarea.domainName)}>
                        Copiar URL completa
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => copiarTexto(tarea.targetName)}>Copiar base</button>
                      <button type="button" onClick={() => copiarTexto(dominioPublicable)}>Copiar dominio para publicar</button>
                    </>
                  )}
                  {puedeCambiar && tarea.status === "pending" && <button type="button" onClick={() => onAccion(tarea.id, "start")}>Iniciar</button>}
                  {puedeCambiar && tarea.status !== "completed" && <button type="button" className="exito" onClick={() => onSolicitarCompletar(tarea)}>Completar</button>}
                  {puedeCambiar && tarea.status !== "completed" && <button type="button" className="peligro" onClick={() => {
                    const nota = window.prompt("Describe el problema encontrado");
                    if (!nota?.trim()) return;
                    onAccion(tarea.id, "fail", { notes: nota.trim(), result: "failure" });
                  }}>Reportar problema</button>}
                  {puedeCambiar && tarea.status === "completed" && <button type="button" onClick={() => onAccion(tarea.id, "reopen")}>Reabrir</button>}
                  {!puedeCambiar && <span className="texto-ayuda">Sin permiso</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
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
  return (
    <Modal titulo="Confirmar actualización" abierto={abierto} onCerrar={onCerrar}>
      <p>Confirma que completaste esta actualización.</p>
      <p style={{ fontSize: 12, color: "#6b7280" }}>
        {tarea.targetType === "domain"
          ? `Dominio: ${tarea.domainName}`
          : `${tarea.targetName} (dominio ${tarea.domainName})`}
      </p>

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

      {tuvoProblemas && (
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
        <label htmlFor="completion-note">Nota de actualización (opcional)</label>
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
          disabled={tuvoProblemas && !problema.trim()}
          onClick={() => onConfirmar({
            withProblems: tuvoProblemas,
            problemNote: tuvoProblemas ? problema.trim() : undefined,
            completionNote: nota.trim() || undefined,
            notes: nota.trim() || undefined,
            result: tuvoProblemas ? "completed_with_problems" : "success",
          })}
        >
          Confirmar actualización
        </button>
      </div>
    </Modal>
  );
}
