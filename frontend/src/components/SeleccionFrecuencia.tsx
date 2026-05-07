import { useState } from "react";
import { DIAS_SEMANA, ETIQUETAS_FRECUENCIA, ETIQUETAS_ROLES } from "../types";

const DIAS_LISTA = Object.keys(DIAS_SEMANA);

export type ValoresFrecuencia = {
  frequencyType: "weekly" | "interval" | "monthly" | "manual";
  everyNWeeks?: number;
  weekdays?: string[];
  intervalDays?: number;
  dayOfMonth?: number;
  startDate: string;
  timezone: string;
  assignedRole: string;
  assignedUserIds: string[];
  active: boolean;
};

export function valoresFrecuenciaPorDefecto(rolPorDefecto: string): ValoresFrecuencia {
  return {
    frequencyType: "weekly",
    everyNWeeks: 1,
    weekdays: ["FRIDAY"],
    intervalDays: 15,
    dayOfMonth: 15,
    startDate: new Date().toISOString().slice(0, 10),
    timezone: "America/Bogota",
    assignedRole: rolPorDefecto,
    assignedUserIds: [],
    active: true,
  };
}

// Limpia el objeto antes de enviarlo al backend, omitiendo campos que no aplican
// al tipo de frecuencia seleccionada.
export function depurarFrecuenciaParaEnvio(v: ValoresFrecuencia) {
  const base: any = {
    frequencyType: v.frequencyType,
    startDate: v.startDate,
    timezone: v.timezone,
    assignedRole: v.assignedRole,
    assignedUserIds: v.assignedUserIds,
    active: v.active,
  };
  if (v.frequencyType === "weekly") {
    base.everyNWeeks = v.everyNWeeks;
    base.weekdays = v.weekdays;
  }
  if (v.frequencyType === "interval") {
    base.intervalDays = v.intervalDays;
  }
  if (v.frequencyType === "monthly") {
    base.dayOfMonth = v.dayOfMonth;
  }
  return base;
}

// Roles aplicables al objetivo: dominio → domain_updater; base → database_updater.
type Props = {
  valor: ValoresFrecuencia;
  onChange: (v: ValoresFrecuencia) => void;
  rolesPermitidos?: string[];
};

export function SeleccionFrecuencia({ valor, onChange, rolesPermitidos }: Props) {
  const [v, setV] = useState(valor);
  const set = (patch: Partial<ValoresFrecuencia>) => {
    const nuevo = { ...v, ...patch };
    setV(nuevo);
    onChange(nuevo);
  };

  function alternarDia(d: string) {
    const lista = v.weekdays ?? [];
    set({ weekdays: lista.includes(d) ? lista.filter((x) => x !== d) : [...lista, d] });
  }

  const rolesUI = rolesPermitidos ?? Object.keys(ETIQUETAS_ROLES);

  return (
    <div>
      <div className="fila-formulario">
        <label>Tipo de frecuencia *</label>
        <select value={v.frequencyType} onChange={(e) => set({ frequencyType: e.target.value as any })}>
          {Object.entries(ETIQUETAS_FRECUENCIA).map(([k, val]) => <option key={k} value={k}>{val}</option>)}
        </select>
      </div>

      {v.frequencyType === "weekly" && (
        <>
          <div className="fila-formulario">
            <label>Cada cuántas semanas *</label>
            <input type="number" min={1} value={v.everyNWeeks ?? 1} onChange={(e) => set({ everyNWeeks: Number(e.target.value) })} />
          </div>
          <div className="fila-formulario">
            <label>Días de la semana *</label>
            {DIAS_LISTA.map((d) => (
              <label key={d} style={{ display: "inline-flex", alignItems: "center", marginRight: 12, fontWeight: 400 }}>
                <input type="checkbox" style={{ width: "auto", marginRight: 4 }} checked={(v.weekdays ?? []).includes(d)} onChange={() => alternarDia(d)} />
                {DIAS_SEMANA[d]}
              </label>
            ))}
          </div>
        </>
      )}

      {v.frequencyType === "interval" && (
        <div className="fila-formulario">
          <label>Intervalo en días *</label>
          <input type="number" min={1} value={v.intervalDays ?? 15} onChange={(e) => set({ intervalDays: Number(e.target.value) })} />
        </div>
      )}

      {v.frequencyType === "monthly" && (
        <div className="fila-formulario">
          <label>Día del mes (1-31) *</label>
          <input type="number" min={1} max={31} value={v.dayOfMonth ?? 15} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })} />
        </div>
      )}

      <div className="fila-formulario">
        <label>Fecha de inicio *</label>
        <input type="date" value={v.startDate} onChange={(e) => set({ startDate: e.target.value })} />
      </div>

      <div className="fila-formulario">
        <label>Zona horaria</label>
        <input value={v.timezone} onChange={(e) => set({ timezone: e.target.value })} />
      </div>

      <div className="fila-formulario">
        <label>Rol responsable *</label>
        <select value={v.assignedRole} onChange={(e) => set({ assignedRole: e.target.value })}>
          {rolesUI.map((r) => <option key={r} value={r}>{ETIQUETAS_ROLES[r] ?? r}</option>)}
        </select>
      </div>

      <div className="fila-formulario">
        <label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={v.active} onChange={(e) => set({ active: e.target.checked })} />
          Frecuencia activa
        </label>
      </div>
    </div>
  );
}
