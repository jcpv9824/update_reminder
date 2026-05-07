import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { BaseDeDatos, Tarea } from "../types";
import { Alerta, EtiquetaEstado, Modal } from "../components/Comunes";
import { PanelAccesoBd } from "../components/PanelAccesoBd";

// Vista unificada de tareas. Muestra dos columnas (dominios y bases de datos).
// La visibilidad y los botones de acción dependen del rol del usuario.
export default function TareasPage() {
  const auth = useAuth();
  const usuario = auth.cargando || !auth.usuario ? null : auth.usuario;
  const roles = usuario?.roles ?? [];
  const esAdmin = roles.includes("admin") || roles.includes("client_manager");
  const verDominios = esAdmin || roles.includes("domain_updater");
  const verBd = esAdmin || roles.includes("database_updater");
  const soloLectura = !esAdmin && !roles.includes("domain_updater") && !roles.includes("database_updater");

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Tareas</h2>
      </div>
      <div className="tareas-grid">
        {verDominios && <ColumnaTareas titulo="Tareas de dominios" targetType="domain" soloLectura={soloLectura} />}
        {verBd && <ColumnaTareas titulo="Tareas de bases de datos" targetType="database" soloLectura={soloLectura} />}
        {!verDominios && !verBd && <Alerta tipo="info">No tienes tareas asignadas.</Alerta>}
      </div>
    </>
  );
}

function ColumnaTareas({ titulo, targetType, soloLectura }: { titulo: string; targetType: "domain" | "database"; soloLectura: boolean }) {
  const qc = useQueryClient();
  const [tareaActiva, setTareaActiva] = useState<Tarea | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: tareas = [], isLoading } = useQuery({
    queryKey: ["tareas", targetType],
    queryFn: () => api.get<Tarea[]>(`/tasks?targetType=${targetType}`),
  });

  const cambiarEstado = useMutation({
    mutationFn: ({ id, accion, body }: { id: string; accion: string; body?: any }) => api.post(`/tasks/${id}/${accion}`, body ?? {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tareas"] }); setTareaActiva(null); },
    onError: (e: any) => setError(e?.message ?? "No se pudo actualizar la tarea."),
  });

  const hoy = new Date().toISOString().slice(0, 10);
  const activas = (t: Tarea) => t.status !== "completed" && t.status !== "cancelled";
  const vencidas = tareas.filter((t) => t.taskDate < hoy && activas(t));
  const deHoy = tareas.filter((t) => t.taskDate === hoy && activas(t));
  const proximas = tareas.filter((t) => t.taskDate > hoy && activas(t));
  const completadas = tareas.filter((t) => t.status === "completed");

  return (
    <div className="columna-tareas">
      <h3>{titulo}</h3>
      {error && <Alerta tipo="error">{error}</Alerta>}
      {isLoading ? <div className="cargando">Cargando...</div> : (
        <>
          <Grupo titulo="Vencidas" tareas={vencidas} targetType={targetType} soloLectura={soloLectura}
            onAbrir={setTareaActiva} onAccion={(id, accion, body) => cambiarEstado.mutate({ id, accion, body })} />
          <Grupo titulo="Hoy" tareas={deHoy} targetType={targetType} soloLectura={soloLectura}
            onAbrir={setTareaActiva} onAccion={(id, accion, body) => cambiarEstado.mutate({ id, accion, body })} />
          <Grupo titulo="Próximas" tareas={proximas} targetType={targetType} soloLectura={soloLectura}
            onAbrir={setTareaActiva} onAccion={(id, accion, body) => cambiarEstado.mutate({ id, accion, body })} />
          <Grupo titulo="Completadas" tareas={completadas} targetType={targetType} soloLectura={soloLectura}
            onAbrir={setTareaActiva} onAccion={(id, accion, body) => cambiarEstado.mutate({ id, accion, body })} />
        </>
      )}

      <Modal titulo={tareaActiva ? `Tarea: ${tareaActiva.targetName}` : ""} abierto={!!tareaActiva} onCerrar={() => setTareaActiva(null)}>
        {tareaActiva && (
          <DetalleTarea
            tarea={tareaActiva}
            soloLectura={soloLectura}
            onAccion={(id, accion, body) => cambiarEstado.mutate({ id, accion, body })}
          />
        )}
      </Modal>
    </div>
  );
}

function Grupo({ titulo, tareas, targetType, soloLectura, onAbrir, onAccion }: {
  titulo: string;
  tareas: Tarea[];
  targetType: "domain" | "database";
  soloLectura: boolean;
  onAbrir: (t: Tarea) => void;
  onAccion: (id: string, accion: string, body?: any) => void;
}) {
  return (
    <div className="grupo-tareas">
      <div className="grupo-tareas-titulo">{titulo} <span style={{ color: "#9ca3af", fontWeight: 400 }}>({tareas.length})</span></div>
      {tareas.length === 0 ? <div className="vacio" style={{ padding: 8, fontSize: 12 }}>Sin tareas.</div> : (
        <ul className="lista-tareas">
          {tareas.map((t) => (
            <li key={t.id} className="item-tarea">
              <div className="item-tarea-datos">
                <div className="item-tarea-fila">
                  <strong>{t.clientName}</strong>
                  <EtiquetaEstado estado={t.status} />
                </div>
                <div className="item-tarea-fila item-tarea-detalle">
                  <span>{t.domainName}</span>
                  {targetType === "database" && <span>· {t.targetName}</span>}
                </div>
                <div className="item-tarea-fila item-tarea-detalle">
                  <span>📅 {t.taskDate}</span>
                  {t.assignedUserIds.length > 0 && <span>👤 {t.assignedUserIds[0]}</span>}
                </div>
              </div>
              <div className="acciones-tabla">
                <button onClick={() => onAbrir(t)}>Abrir</button>
                {!soloLectura && t.status === "pending" && <button onClick={() => onAccion(t.id, "start")}>Iniciar</button>}
                {!soloLectura && t.status !== "completed" && <button className="exito" onClick={() => onAccion(t.id, "complete", { result: "success" })}>Completar</button>}
                {!soloLectura && t.status !== "completed" && <button className="advertencia" onClick={() => onAccion(t.id, "block")}>Bloquear</button>}
                {!soloLectura && t.status !== "completed" && <button className="peligro" onClick={() => onAccion(t.id, "fail", { result: "failure" })}>Fallida</button>}
                {!soloLectura && t.status === "completed" && <button onClick={() => onAccion(t.id, "reopen")}>Reabrir</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetalleTarea({ tarea, soloLectura, onAccion }: { tarea: Tarea; soloLectura: boolean; onAccion: (id: string, accion: string, body?: any) => void }) {
  const [notas, setNotas] = useState(tarea.notes ?? "");
  const { data: bd } = useQuery({
    queryKey: ["bd-tarea", tarea.targetId],
    queryFn: () => api.get<BaseDeDatos>(`/databases/${tarea.targetId}`),
    enabled: tarea.targetType === "database",
  });

  return (
    <>
      <p><strong>Cliente:</strong> {tarea.clientName}</p>
      <p><strong>Dominio:</strong> {tarea.domainName}</p>
      <p><strong>Fecha programada:</strong> {tarea.taskDate}</p>
      <p><strong>Estado:</strong> <EtiquetaEstado estado={tarea.status} /></p>
      {tarea.targetType === "database" && bd && (
        <>
          <h4>Acceso a la base de datos</h4>
          <PanelAccesoBd bd={bd} />
        </>
      )}
      <div className="fila-formulario">
        <label>Notas</label>
        <textarea rows={3} value={notas} onChange={(e) => setNotas(e.target.value)} disabled={soloLectura} />
      </div>
      {!soloLectura && (
        <div className="acciones-formulario">
          {tarea.status === "pending" && <button onClick={() => onAccion(tarea.id, "start", { notes: notas })}>Iniciar</button>}
          {tarea.status !== "completed" && <button className="exito" onClick={() => onAccion(tarea.id, "complete", { notes: notas, result: "success" })}>Completada</button>}
          {tarea.status !== "completed" && <button className="advertencia" onClick={() => onAccion(tarea.id, "block", { notes: notas })}>Bloqueada</button>}
          {tarea.status !== "completed" && <button className="peligro" onClick={() => onAccion(tarea.id, "fail", { notes: notas, result: "failure" })}>Fallida</button>}
          {tarea.status === "completed" && <button onClick={() => onAccion(tarea.id, "reopen", { notes: notas })}>Reabrir</button>}
        </div>
      )}
    </>
  );
}
