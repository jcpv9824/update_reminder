import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { Tarea, Usuario } from "../types";
import { ETIQUETAS_ESTADO, ETIQUETAS_ROLES } from "../types";
import { Alerta, EtiquetaEstado, Modal } from "../components/Comunes";

function sumarDiasIso(dias: number): string {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  hoy.setDate(hoy.getDate() + dias);
  return hoy.toISOString().slice(0, 10);
}

const VENTANA_TAREAS = {
  desde: sumarDiasIso(-7),
  hasta: sumarDiasIso(7),
};

type AccionTarea = "start" | "complete" | "fail" | "block" | "reopen";
type EstadoGuardado = "guardando" | "guardado" | "error";

type GrupoResumen = {
  id: string;
  fecha: string;
  responsableClave: string;
  responsableEtiqueta: string;
  targetType: "domain" | "database";
  tareas: Tarea[];
  completadas: number;
  pendientes: number;
  conProblemas: number;
  estadoAgregado: "completed" | "failed" | "in_progress" | "pending" | "overdue";
};

function etiquetaTipo(targetType: "domain" | "database", plural = false): string {
  if (targetType === "domain") return plural ? "dominios" : "Dominio";
  return plural ? "bases de datos" : "Base de datos";
}

function etiquetaResponsable(t: Tarea, usuario?: Usuario | null): string {
  if (t.assignedUserIds.length === 0) return ETIQUETAS_ROLES[t.assignedRole] ?? t.assignedRole;
  if (t.assignedUserIds.length === 1 && usuario?.id === t.assignedUserIds[0]) return "Tú";
  if (t.assignedUserIds.length === 1) return `Usuario ${t.assignedUserIds[0]}`;
  return `Usuarios ${t.assignedUserIds.join(", ")}`;
}

function claveResponsable(t: Tarea): string {
  return t.assignedUserIds.length ? t.assignedUserIds.slice().sort().join("|") : `rol:${t.assignedRole}`;
}

function calcularEstadoGrupo(tareas: Tarea[], fecha: string): GrupoResumen["estadoAgregado"] {
  const hoy = new Date().toISOString().slice(0, 10);
  if (tareas.every((t) => t.status === "completed")) return "completed";
  if (tareas.some((t) => t.status === "failed" || t.status === "blocked")) return "failed";
  if (fecha < hoy && tareas.some((t) => t.status !== "completed" && t.status !== "cancelled")) return "overdue";
  if (tareas.some((t) => t.status === "in_progress" || t.status === "completed" || t.status === "reopened")) return "in_progress";
  return "pending";
}

function etiquetaEstadoGrupo(estado: GrupoResumen["estadoAgregado"]): string {
  const etiquetas = {
    completed: "Completado",
    failed: "Con problemas",
    in_progress: "En progreso",
    pending: "Pendiente",
    overdue: "Vencido",
  };
  return etiquetas[estado];
}

function puedeCambiarTarea(usuario: Usuario | null, tarea: Tarea): boolean {
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
  if (accion === "block") return "blocked";
  return "reopened";
}

async function copiarTexto(texto: string): Promise<void> {
  if (!texto) return;
  await navigator.clipboard?.writeText(texto);
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
      <Alerta tipo="info">Mostrando grupos de trabajo desde {VENTANA_TAREAS.desde} hasta {VENTANA_TAREAS.hasta}.</Alerta>
      <div className="tareas-grid">
        {verDominios && <ColumnaTareas titulo="Tareas de dominios" targetType="domain" usuario={usuario} />}
        {verBd && <ColumnaTareas titulo="Tareas de bases de datos" targetType="database" usuario={usuario} />}
        {!verDominios && !verBd && <Alerta tipo="info">No tienes tareas asignadas.</Alerta>}
      </div>
    </>
  );
}

function ColumnaTareas({ titulo, targetType, usuario }: { titulo: string; targetType: "domain" | "database"; usuario: Usuario | null }) {
  const qc = useQueryClient();
  const [grupoActivo, setGrupoActivo] = useState<GrupoResumen | null>(null);
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
        actuales.map((t) => t.id === variables.id ? { ...t, status: nuevoEstado, notes: variables.body?.notes ?? t.notes } : t)
      );
      setGuardado((m) => ({ ...m, [variables.id]: { estado: "guardado" } }));
    },
    onError: (e: any, variables) => {
      const mensaje = e?.message ?? "No se pudo guardar el cambio.";
      setError(mensaje);
      setGuardado((m) => ({ ...m, [variables.id]: { estado: "error", mensaje, reintento: { accion: variables.accion, body: variables.body } } }));
    },
  });

  const grupos = useMemo(() => agruparTareas(tareas, targetType, usuario), [tareas, targetType, usuario]);
  const hoy = new Date().toISOString().slice(0, 10);
  const vencidas = grupos.filter((g) => g.estadoAgregado === "overdue");
  const deHoy = grupos.filter((g) => g.fecha === hoy && g.estadoAgregado !== "completed" && g.estadoAgregado !== "overdue");
  const proximas = grupos.filter((g) => g.fecha > hoy && g.estadoAgregado !== "completed");
  const completadas = grupos.filter((g) => g.estadoAgregado === "completed");

  function accionar(id: string, accion: AccionTarea, body?: any) {
    cambiarEstado.mutate({ id, accion, body });
  }

  return (
    <div className="columna-tareas">
      <h3>{titulo}</h3>
      {error && <Alerta tipo="error">{error}</Alerta>}
      {isLoading ? <div className="cargando">Cargando...</div> : (
        <>
          <GrupoResumenSeccion titulo="Vencidas" grupos={vencidas} onAbrir={setGrupoActivo} />
          <GrupoResumenSeccion titulo="Hoy" grupos={deHoy} onAbrir={setGrupoActivo} />
          <GrupoResumenSeccion titulo="Próximas" grupos={proximas} onAbrir={setGrupoActivo} />
          <GrupoResumenSeccion titulo="Completadas" grupos={completadas} onAbrir={setGrupoActivo} />
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
            onAccion={accionar}
          />
        )}
      </Modal>
    </div>
  );
}

function agruparTareas(tareas: Tarea[], targetType: "domain" | "database", usuario: Usuario | null): GrupoResumen[] {
  const mapa = new Map<string, Tarea[]>();
  for (const tarea of tareas) {
    const responsable = claveResponsable(tarea);
    const key = `${tarea.taskDate}|${responsable}|${targetType}`;
    mapa.set(key, [...(mapa.get(key) ?? []), tarea]);
  }

  return Array.from(mapa.entries()).map(([key, items]) => {
    const [fecha, responsableClave] = key.split("|");
    const completadas = items.filter((t) => t.status === "completed").length;
    const conProblemas = items.filter((t) => t.status === "failed" || t.status === "blocked").length;
    return {
      id: key,
      fecha,
      responsableClave,
      responsableEtiqueta: etiquetaResponsable(items[0], usuario),
      targetType,
      tareas: items.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.targetName.localeCompare(b.targetName)),
      completadas,
      pendientes: items.filter((t) => t.status !== "completed" && t.status !== "cancelled").length,
      conProblemas,
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
          {grupos.map((g) => (
            <li key={g.id} className="item-tarea">
              <div className="item-tarea-datos">
                <div className="item-tarea-fila">
                  <strong>{g.responsableEtiqueta} — {g.targetType === "domain" ? "Dominios" : "Bases de datos"} por actualizar</strong>
                  <EtiquetaEstado estado={g.estadoAgregado === "overdue" ? "failed" : g.estadoAgregado} />
                </div>
                <div className="item-tarea-fila item-tarea-detalle">
                  <span>Fecha: {g.fecha}</span>
                  <span>Total: {g.tareas.length} {etiquetaTipo(g.targetType, true)}</span>
                </div>
                <div className="item-tarea-fila item-tarea-detalle">
                  <span>Completadas: {g.completadas} / {g.tareas.length}</span>
                  <span>Pendientes: {g.pendientes}</span>
                  <span>Con problemas: {g.conProblemas}</span>
                </div>
                <div className="item-tarea-fila item-tarea-detalle">
                  <span>Estado: {etiquetaEstadoGrupo(g.estadoAgregado)}</span>
                </div>
              </div>
              <div className="acciones-tabla">
                <button onClick={() => onAbrir(g)}>Ver detalle</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetalleGrupo({ grupo, usuario, guardado, onAccion }: {
  grupo: GrupoResumen;
  usuario: Usuario | null;
  guardado: Record<string, { estado: EstadoGuardado; mensaje?: string; reintento?: { accion: AccionTarea; body?: any } }>;
  onAccion: (id: string, accion: AccionTarea, body?: any) => void;
}) {
  const pendientes = grupo.tareas.filter((t) => t.status !== "completed" && t.status !== "cancelled");

  function pedirNotaYEnviar(tarea: Tarea, accion: AccionTarea) {
    if (!puedeCambiarTarea(usuario, tarea)) return;
    if (accion === "fail" || accion === "block") {
      const nota = window.prompt("Describe el problema encontrado");
      if (!nota?.trim()) return;
      onAccion(tarea.id, accion, { notes: nota.trim(), result: "failure" });
      return;
    }
    if (accion === "complete") {
      const nota = window.prompt("Nota de actualización (opcional)") ?? "";
      onAccion(tarea.id, accion, { notes: nota.trim(), result: "success" });
      return;
    }
    onAccion(tarea.id, accion);
  }

  return (
    <>
      <p><strong>Fecha:</strong> {grupo.fecha}</p>
      <p><strong>Total:</strong> {grupo.tareas.length} | <strong>Completadas:</strong> {grupo.completadas} / {grupo.tareas.length} | <strong>Con problemas:</strong> {grupo.conProblemas}</p>
      <button
        type="button"
        onClick={() => copiarTexto(pendientes.map((t) => grupo.targetType === "domain" ? t.domainName : t.targetName).filter(Boolean).join("\n"))}
      >
        {grupo.targetType === "domain" ? "Copiar todos los dominios pendientes" : "Copiar todas las bases pendientes"}
      </button>

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Dominio</th>
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
            return (
              <tr key={tarea.id}>
                <td>{tarea.clientName}</td>
                <td>{tarea.domainName}</td>
                {grupo.targetType === "database" && <td>{tarea.targetName}</td>}
                <td><EtiquetaEstado estado={tarea.status} /></td>
                <td>{tarea.notes || "-"}</td>
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
                  <button type="button" onClick={() => copiarTexto(grupo.targetType === "domain" ? tarea.domainName : tarea.targetName)}>
                    {grupo.targetType === "domain" ? "Copiar dominio" : "Copiar base"}
                  </button>
                  {grupo.targetType === "database" && <button type="button" onClick={() => copiarTexto(tarea.domainName)}>Copiar dominio</button>}
                  {puedeCambiar && tarea.status === "pending" && <button type="button" onClick={() => pedirNotaYEnviar(tarea, "start")}>Iniciar</button>}
                  {puedeCambiar && tarea.status !== "completed" && <button type="button" className="exito" onClick={() => pedirNotaYEnviar(tarea, "complete")}>Completar</button>}
                  {puedeCambiar && tarea.status !== "completed" && <button type="button" className="peligro" onClick={() => pedirNotaYEnviar(tarea, "fail")}>Problema</button>}
                  {puedeCambiar && tarea.status !== "completed" && <button type="button" className="advertencia" onClick={() => pedirNotaYEnviar(tarea, "block")}>Bloquear</button>}
                  {puedeCambiar && tarea.status === "completed" && <button type="button" onClick={() => pedirNotaYEnviar(tarea, "reopen")}>Reabrir</button>}
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
