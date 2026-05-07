import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BaseDeDatos, Cliente, Dominio, Frecuencia } from "../types";
import { Alerta, EtiquetaEstado, Modal, DialogoConfirmar } from "../components/Comunes";
import { DIAS_SEMANA, ETIQUETAS_FRECUENCIA, ETIQUETAS_ROLES } from "../types";
import { SelectorBuscable } from "../components/SelectorBuscable";

const DIAS_LISTA = Object.keys(DIAS_SEMANA);

export default function FrecuenciasPage() {
  const qc = useQueryClient();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: dominios = [] } = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });
  const { data: bds = [] } = useQuery({ queryKey: ["bases-de-datos"], queryFn: () => api.get<BaseDeDatos[]>("/databases") });
  const { data: frecuencias = [], isLoading } = useQuery({ queryKey: ["frecuencias"], queryFn: () => api.get<Frecuencia[]>("/schedules") });

  const crear = useMutation({
    mutationFn: (body: any) => api.post<Frecuencia>("/schedules", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["frecuencias"] }); setModalAbierto(false); setExito("Frecuencia creada correctamente."); },
    onError: (e: any) => setError(e?.message ?? "Error al crear la frecuencia."),
  });
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/schedules/${id}/deactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["frecuencias"] }) });
  const reactivar = useMutation({ mutationFn: (id: string) => api.post(`/schedules/${id}/reactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["frecuencias"] }) });
  const eliminar = useMutation({
    mutationFn: (id: string) => api.del(`/schedules/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["frecuencias"] }); setExito("Frecuencia eliminada."); setConfirmarEliminar(null); },
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar."),
  });
  const [confirmarEliminar, setConfirmarEliminar] = useState<Frecuencia | null>(null);

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Frecuencias de actualización</h2>
        <button className="primario" onClick={() => setModalAbierto(true)}>Nueva frecuencia</button>
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      {isLoading ? <div className="cargando">Cargando...</div> : (
        <table>
          <thead><tr>
            <th>Cliente</th><th>Tipo</th><th>Objetivos</th><th>Frecuencia</th><th>Inicio</th><th>Rol asignado</th><th>Estado</th><th>Acciones</th>
          </tr></thead>
          <tbody>
            {frecuencias.length === 0 ? (<tr><td colSpan={8} className="vacio">Aún no hay frecuencias configuradas.</td></tr>) :
            frecuencias.map((f) => (
              <tr key={f.id}>
                <td>{f.clientName}</td>
                <td>{f.targetType === "database" ? "Base de datos" : "Dominio"}</td>
                <td>{f.targetIds.length}</td>
                <td>{ETIQUETAS_FRECUENCIA[f.frequencyType]}</td>
                <td>{f.startDate}</td>
                <td>{ETIQUETAS_ROLES[f.assignedRole] ?? f.assignedRole}</td>
                <td><EtiquetaEstado estado={f.active ? "active" : "inactive"} /></td>
                <td className="acciones-tabla">
                  {f.active
                    ? <button className="advertencia" onClick={() => desactivar.mutate(f.id)}>Desactivar</button>
                    : <button className="exito" onClick={() => reactivar.mutate(f.id)}>Reactivar</button>}
                  <button className="peligro" onClick={() => setConfirmarEliminar(f)}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal titulo="Nueva frecuencia" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioFrecuencia clientes={clientes} dominios={dominios} bds={bds} cargando={crear.isPending} onSubmit={(v) => crear.mutate(v)} />
      </Modal>

      <DialogoConfirmar
        abierto={!!confirmarEliminar}
        titulo="Eliminar frecuencia"
        mensaje={confirmarEliminar
          ? `¿Eliminar la frecuencia para ${confirmarEliminar.clientName}? Esta acción no se puede deshacer.`
          : ""}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => confirmarEliminar && eliminar.mutate(confirmarEliminar.id)}
        onCancelar={() => setConfirmarEliminar(null)}
      />
    </>
  );
}

function FormularioFrecuencia({ clientes, dominios, bds, onSubmit, cargando }: { clientes: Cliente[]; dominios: Dominio[]; bds: BaseDeDatos[]; onSubmit: (v: any) => void; cargando: boolean }) {
  const [clientId, setClientId] = useState("");
  const [targetType, setTargetType] = useState<"domain" | "database">("database");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [frequencyType, setFrequencyType] = useState<"weekly" | "interval" | "monthly" | "manual">("weekly");
  const [everyNWeeks, setEveryNWeeks] = useState(1);
  const [weekdays, setWeekdays] = useState<string[]>(["FRIDAY"]);
  const [intervalDays, setIntervalDays] = useState(15);
  const [dayOfMonth, setDayOfMonth] = useState(15);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [assignedRole, setAssignedRole] = useState("database_updater");
  const [err, setErr] = useState<string | null>(null);

  const objetivos = useMemo(() => {
    if (targetType === "database") return bds.filter((b) => b.clientId === clientId && b.status === "active");
    return dominios.filter((d) => d.clientId === clientId && d.status === "active");
  }, [targetType, clientId, bds, dominios]);

  function alternarDia(d: string) {
    setWeekdays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]));
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!clientId) return setErr("Seleccione el cliente.");
      if (targetIds.length === 0) return setErr("Seleccione al menos un objetivo.");
      onSubmit({
        clientId, targetType, targetIds, frequencyType,
        everyNWeeks: frequencyType === "weekly" ? everyNWeeks : undefined,
        weekdays: frequencyType === "weekly" ? weekdays : undefined,
        intervalDays: frequencyType === "interval" ? intervalDays : undefined,
        dayOfMonth: frequencyType === "monthly" ? dayOfMonth : undefined,
        startDate, timezone: "America/Bogota",
        assignedRole, assignedUserIds: [], active: true,
      });
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      <div className="fila-formulario"><label>Cliente *</label>
        <SelectorBuscable
          opciones={clientes.filter((c) => c.status === "active").map((c) => ({ id: c.id, etiqueta: c.name }))}
          valor={clientId}
          onChange={(id) => { setClientId(id); setTargetIds([]); }}
          placeholder="Buscar cliente..."
        /></div>
      <div className="fila-formulario"><label>Tipo de objetivo *</label>
        <select value={targetType} onChange={(e) => { setTargetType(e.target.value as any); setTargetIds([]); setAssignedRole(e.target.value === "database" ? "database_updater" : "domain_updater"); }}>
          <option value="database">Base de datos</option>
          <option value="domain">Dominio</option>
        </select></div>
      <div className="fila-formulario"><label>Objetivos *</label>
        <select multiple value={targetIds} onChange={(e) => setTargetIds(Array.from(e.target.selectedOptions).map((o) => o.value))} style={{ height: 120 }}>
          {objetivos.map((o: any) => <option key={o.id} value={o.id}>{o.companyName ? `${o.companyName} / ${o.dbAccess?.initialCatalog}` : o.domainName}</option>)}
        </select></div>
      <div className="fila-formulario"><label>Tipo de frecuencia *</label>
        <select value={frequencyType} onChange={(e) => setFrequencyType(e.target.value as any)}>
          {Object.entries(ETIQUETAS_FRECUENCIA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></div>
      {frequencyType === "weekly" && (
        <>
          <div className="fila-formulario"><label>Cada cuántas semanas</label>
            <input type="number" min={1} value={everyNWeeks} onChange={(e) => setEveryNWeeks(Number(e.target.value))} /></div>
          <div className="fila-formulario"><label>Días de la semana</label>
            {DIAS_LISTA.map((d) => (
              <label key={d} style={{ display: "inline-flex", alignItems: "center", marginRight: 12, fontWeight: 400 }}>
                <input type="checkbox" style={{ width: "auto", marginRight: 4 }} checked={weekdays.includes(d)} onChange={() => alternarDia(d)} />
                {DIAS_SEMANA[d]}
              </label>
            ))}
          </div>
        </>
      )}
      {frequencyType === "interval" && (
        <div className="fila-formulario"><label>Intervalo en días *</label>
          <input type="number" min={1} value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value))} /></div>
      )}
      {frequencyType === "monthly" && (
        <div className="fila-formulario"><label>Día del mes (1-31) *</label>
          <input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} /></div>
      )}
      <div className="fila-formulario"><label>Fecha de inicio *</label>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
      <div className="fila-formulario"><label>Rol asignado *</label>
        <select value={assignedRole} onChange={(e) => setAssignedRole(e.target.value)}>
          {Object.entries(ETIQUETAS_ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></div>
      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
      </div>
    </form>
  );
}
