import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Cliente, RegistroAuditoria } from "../types";
import { ETIQUETAS_ACCION_AUDITORIA } from "../types";
import { SelectorBuscable } from "../components/SelectorBuscable";

export default function AuditoriaPage() {
  const [clientId, setClientId] = useState("");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [performedBy, setPerformedBy] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const params = new URLSearchParams();
  if (clientId) params.set("clientId", clientId);
  if (entityType) params.set("entityType", entityType);
  if (action) params.set("action", action);
  if (performedBy) params.set("performedBy", performedBy);
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);

  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["auditoria", params.toString()],
    queryFn: () => api.get<RegistroAuditoria[]>(`/audit-logs?${params.toString()}`),
  });

  return (
    <>
      <div className="encabezado-pagina"><h2>Auditoría</h2></div>
      <div className="barra-filtros">
        <div className="campo"><label>Desde</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value ? new Date(e.target.value).toISOString() : "")} /></div>
        <div className="campo"><label>Hasta</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value ? new Date(e.target.value + "T23:59:59").toISOString() : "")} /></div>
        <div className="campo"><label>Cliente</label>
          <SelectorBuscable
            opciones={clientes.map((c) => ({ id: c.id, etiqueta: c.name }))}
            valor={clientId}
            onChange={setClientId}
            permiteVacio
            textoVacio="Todos los clientes"
            placeholder="Buscar cliente..."
          /></div>
        <div className="campo"><label>Tipo de entidad</label>
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">Todas</option>
            <option value="user">Usuario</option>
            <option value="client">Cliente</option>
            <option value="domain">Dominio</option>
            <option value="database">Base de datos</option>
            <option value="schedule">Frecuencia</option>
            <option value="task">Tarea</option>
          </select></div>
        <div className="campo"><label>Acción</label>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Todas</option>
            {Object.entries(ETIQUETAS_ACCION_AUDITORIA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        <div className="campo"><label>Usuario</label>
          <input value={performedBy} onChange={(e) => setPerformedBy(e.target.value)} placeholder="ID del usuario" /></div>
      </div>

      {isLoading ? <div className="cargando">Cargando...</div> : (
        <table>
          <thead><tr>
            <th>Fecha</th><th>Acción</th><th>Entidad</th><th>Cliente</th><th>Dominio</th><th>Usuario</th>
          </tr></thead>
          <tbody>
            {logs.length === 0 ? (<tr><td colSpan={6} className="vacio">No hay registros para los filtros seleccionados.</td></tr>) :
            logs.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.performedAt).toLocaleString("es-CO")}</td>
                <td>{ETIQUETAS_ACCION_AUDITORIA[l.action] ?? l.action}</td>
                <td>{l.entityType} ({l.entityId.slice(0, 8)}...)</td>
                <td>{l.clientName ?? "-"}</td>
                <td>{l.domainName ?? "-"}</td>
                <td>{l.performedByEmail ?? l.performedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
