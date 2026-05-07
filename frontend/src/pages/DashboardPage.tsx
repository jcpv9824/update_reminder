import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Cliente, Dominio, BaseDeDatos, Tarea } from "../types";

function Tarjeta({ titulo, valor }: { titulo: string; valor: number | string }) {
  return (
    <div className="dashboard-tarjeta">
      <div className="numero">{valor}</div>
      <div className="etiqueta">{titulo}</div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: tareas = [] } = useQuery({ queryKey: ["tareas"], queryFn: () => api.get<Tarea[]>("/tasks") });
  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: dominios = [] } = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });
  const { data: bds = [] } = useQuery({ queryKey: ["bases-de-datos"], queryFn: () => api.get<BaseDeDatos[]>("/databases") });

  const hoy = new Date().toISOString().slice(0, 10);
  const haceSieteDias = new Date(Date.now() - 7 * 24 * 3600_000).toISOString().slice(0, 10);

  const pendientesHoy = tareas.filter((t) => t.taskDate === hoy && (t.status === "pending" || t.status === "in_progress")).length;
  const vencidas = tareas.filter((t) => t.taskDate < hoy && (t.status === "pending" || t.status === "in_progress" || t.status === "reopened")).length;
  const completadasHoy = tareas.filter((t) => t.taskDate === hoy && t.status === "completed").length;
  const fallidasOBloqueadas = tareas.filter((t) => t.status === "failed" || t.status === "blocked").length;

  const clientesActivos = clientes.filter((c) => c.status === "active").length;
  const dominiosActivos = dominios.filter((d) => d.status === "active").length;
  const bdActivas = bds.filter((b) => b.status === "active").length;

  const fallidasUltimos7 = tareas.filter((t) => t.status === "failed" && t.taskDate >= haceSieteDias).length;
  const clientesConVencidas = new Set(tareas.filter((t) => t.taskDate < hoy && t.status !== "completed").map((t) => t.clientId)).size;

  return (
    <>
      <div className="encabezado-pagina"><h2>Tablero</h2></div>
      <div className="dashboard-grid">
        <Tarjeta titulo="Tareas pendientes hoy" valor={pendientesHoy} />
        <Tarjeta titulo="Tareas vencidas" valor={vencidas} />
        <Tarjeta titulo="Tareas completadas hoy" valor={completadasHoy} />
        <Tarjeta titulo="Tareas fallidas o bloqueadas" valor={fallidasOBloqueadas} />
      </div>
      <h3>Resumen general</h3>
      <div className="dashboard-grid">
        <Tarjeta titulo="Clientes activos" valor={clientesActivos} />
        <Tarjeta titulo="Dominios activos" valor={dominiosActivos} />
        <Tarjeta titulo="Bases de datos activas" valor={bdActivas} />
        <Tarjeta titulo="Clientes con tareas vencidas" valor={clientesConVencidas} />
        <Tarjeta titulo="Tareas fallidas últimos 7 días" valor={fallidasUltimos7} />
      </div>
    </>
  );
}
