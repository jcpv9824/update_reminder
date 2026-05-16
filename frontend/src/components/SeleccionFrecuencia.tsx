import { useState } from "react";
import { DIAS_SEMANA, ETIQUETAS_FRECUENCIA, ETIQUETAS_ROLES, type Usuario } from "../types";

const DIAS_LISTA = Object.keys(DIAS_SEMANA);

export type ConfiguracionRecordatorios = {
  remindersEnabled: boolean;
  reminderDaysBefore: number[];
  reminderTime: string;
  reminderRecipientsMode: "assignedUsers" | "roleUsers" | "customEmails";
  customReminderEmails?: string[];
};

export type ValoresFrecuencia = {
  frequencyType: "weekly" | "interval" | "monthly" | "manual";
  everyNWeeks?: number;
  weekdays?: string[];
  intervalDays?: number;
  dayOfMonth?: number;
  startDate: string;
  hasEndDate?: boolean;
  endDate?: string | null;
  timezone: string;
  assignedRole: string;
  assignedUserIds: string[];
  databaseAssignedUserIds?: string[];
  databaseReminderRecipientsMode?: "assignedUsers" | "roleUsers";
  active: boolean;
  reminders: ConfiguracionRecordatorios;
};

export function valoresFrecuenciaPorDefecto(rolPorDefecto: string): ValoresFrecuencia {
  return {
    frequencyType: "weekly",
    everyNWeeks: 1,
    weekdays: ["FRIDAY"],
    intervalDays: 15,
    dayOfMonth: 15,
    startDate: new Date().toISOString().slice(0, 10),
    hasEndDate: false,
    endDate: null,
    timezone: "America/Bogota",
    assignedRole: rolPorDefecto,
    assignedUserIds: [],
    databaseAssignedUserIds: [],
    databaseReminderRecipientsMode: "roleUsers",
    active: true,
    reminders: {
      // Por defecto los recordatorios quedan activados cuando se crea una
      // frecuencia automática. El admin puede desactivarlos si lo desea.
      remindersEnabled: true,
      // Avisar el día antes y el mismo día por defecto.
      reminderDaysBefore: [1, 0],
      reminderTime: "08:00",
      // Los recordatorios se envían automáticamente a los usuarios con el rol
      // responsable (Actualizador de dominios / Actualizador de bases de datos).
      reminderRecipientsMode: "roleUsers",
      customReminderEmails: [],
    },
  };
}

// Limpia el objeto antes de enviarlo al backend, omitiendo campos que no aplican
// al tipo de frecuencia seleccionada.
export function depurarFrecuenciaParaEnvio(v: ValoresFrecuencia) {
  const base: any = {
    frequencyType: v.frequencyType,
    startDate: v.startDate,
    endDate: v.hasEndDate ? v.endDate || null : null,
    timezone: v.timezone,
    assignedRole: v.assignedRole,
    assignedUserIds: v.assignedUserIds,
    databaseAssignedUserIds: v.databaseAssignedUserIds ?? [],
    databaseReminderRecipientsMode: (v.databaseAssignedUserIds ?? []).length > 0 ? "assignedUsers" : "roleUsers",
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
  base.reminders = {
    remindersEnabled: v.reminders.remindersEnabled,
    reminderDaysBefore: v.reminders.reminderDaysBefore,
    reminderTime: v.reminders.reminderTime,
    reminderRecipientsMode: v.assignedUserIds.length > 0 ? "assignedUsers" : "roleUsers",
    customReminderEmails: [],
  };
  return base;
}

// Roles aplicables al objetivo: dominio → domain_updater; base → database_updater.
type Props = {
  valor: ValoresFrecuencia;
  onChange: (v: ValoresFrecuencia) => void;
  rolesPermitidos?: string[];
  mostrarRol?: boolean;
  usuarios?: Usuario[];
  tipoObjetivo?: "domain" | "database";
};

export function SeleccionFrecuencia({ valor, onChange, rolesPermitidos, mostrarRol = false, usuarios = [], tipoObjetivo = "domain" }: Props) {
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
  const usuariosActivos = usuarios.filter((u) => u.active !== false);
  const responsableManual = v.reminders.reminderRecipientsMode === "assignedUsers" || v.assignedUserIds.length > 0;
  const responsableBasesManual = v.databaseReminderRecipientsMode === "assignedUsers" || (v.databaseAssignedUserIds ?? []).length > 0;

  function etiquetaUsuario(u: Usuario, rolSugerido?: string) {
    const rol = rolSugerido && u.roles.includes(rolSugerido) ? " - rol recomendado" : "";
    return `${u.displayName || u.email} (${u.email})${rol}`;
  }

  function seleccionarResponsable(ids: string[]) {
    set({
      assignedUserIds: ids,
      reminders: {
        ...v.reminders,
        reminderRecipientsMode: ids.length > 0 ? "assignedUsers" : "roleUsers",
        customReminderEmails: [],
      },
    });
  }

  function seleccionarResponsableBases(ids: string[]) {
    set({
      databaseAssignedUserIds: ids,
      databaseReminderRecipientsMode: ids.length > 0 ? "assignedUsers" : "roleUsers",
    });
  }

  return (
    <div>
      <div className="fila-formulario">
        <label>Tipo de frecuencia *</label>
        <select value={v.frequencyType} onChange={(e) => set({ frequencyType: e.target.value as any })}>
          {Object.entries(ETIQUETAS_FRECUENCIA).filter(([k]) => k !== "once").map(([k, val]) => <option key={k} value={k}>{val}</option>)}
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
        <label>
          <input
            type="checkbox"
            style={{ width: "auto", marginRight: 6 }}
            checked={!!v.hasEndDate}
            onChange={(e) => set({ hasEndDate: e.target.checked, endDate: e.target.checked ? v.endDate ?? v.startDate : null })}
          />
          Tiene fecha de fin
        </label>
      </div>

      {v.hasEndDate && (
        <div className="fila-formulario">
          <label>Fecha de fin</label>
          <input type="date" value={v.endDate ?? ""} onChange={(e) => set({ endDate: e.target.value || null })} />
        </div>
      )}

      <div className="fila-formulario">
        <label>Zona horaria</label>
        <input value={v.timezone} onChange={(e) => set({ timezone: e.target.value })} />
      </div>

      {mostrarRol && (
        <div className="fila-formulario">
          <label>Rol responsable *</label>
          <select value={v.assignedRole} onChange={(e) => set({ assignedRole: e.target.value })}>
            {rolesUI.map((r) => <option key={r} value={r}>{ETIQUETAS_ROLES[r] ?? r}</option>)}
          </select>
        </div>
      )}

      <h5 style={{ margin: "12px 0 6px" }}>Responsable de actualización</h5>
      <div className="fila-formulario">
        <label style={{ fontWeight: 400 }}>
          <input
            type="radio"
            name="modoResponsableActualizacion"
            style={{ width: "auto", marginRight: 6 }}
            checked={!responsableManual}
            onChange={() => seleccionarResponsable([])}
          />
          Usar rol predeterminado
        </label>
        <label style={{ fontWeight: 400 }}>
          <input
            type="radio"
            name="modoResponsableActualizacion"
            style={{ width: "auto", marginRight: 6 }}
            checked={responsableManual}
            onChange={() => set({ reminders: { ...v.reminders, reminderRecipientsMode: "assignedUsers", customReminderEmails: [] } })}
          />
          Asignar responsable específico
        </label>
        {!responsableManual ? (
          <p className="texto-ayuda">
            Las tareas y recordatorios se asignarán automáticamente a las personas con el rol {ETIQUETAS_ROLES[v.assignedRole] ?? v.assignedRole}.
          </p>
        ) : null}
      </div>

      {responsableManual && (
        <div className="fila-formulario">
          <label>Responsable específico</label>
          <select
            multiple
            aria-label="Responsable específico"
            value={v.assignedUserIds}
            onChange={(e) => seleccionarResponsable(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))}
          >
            {usuariosActivos.map((u) => (
              <option key={u.id} value={u.id}>{etiquetaUsuario(u, v.assignedRole)}</option>
            ))}
          </select>
          <p className="texto-ayuda">Puedes seleccionar una o varias personas activas. Si vuelves al rol predeterminado, se limpiará esta selección.</p>
        </div>
      )}

      {tipoObjetivo === "domain" && (
        <>
          <h5 style={{ margin: "12px 0 6px" }}>Responsable de bases de datos asociadas</h5>
          <div className="fila-formulario">
            <label style={{ fontWeight: 400 }}>
              <input
                type="radio"
                name="modoResponsableBases"
                style={{ width: "auto", marginRight: 6 }}
                checked={!responsableBasesManual}
                onChange={() => seleccionarResponsableBases([])}
              />
              Usar rol predeterminado
            </label>
            <label style={{ fontWeight: 400 }}>
              <input
                type="radio"
                name="modoResponsableBases"
                style={{ width: "auto", marginRight: 6 }}
                checked={responsableBasesManual}
                onChange={() => set({ databaseReminderRecipientsMode: "assignedUsers" })}
              />
              Asignar responsable específico
            </label>
            {!responsableBasesManual ? (
              <p className="texto-ayuda">
                Las tareas de bases de datos heredadas de este dominio se asignarán automáticamente a las personas con el rol Actualizador de bases de datos.
              </p>
            ) : null}
          </div>
          {responsableBasesManual && (
            <div className="fila-formulario">
              <label>Responsables específicos de bases de datos</label>
              <select
                multiple
                aria-label="Responsables específicos de bases de datos"
                value={v.databaseAssignedUserIds ?? []}
                onChange={(e) => seleccionarResponsableBases(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))}
              >
                {usuariosActivos.map((u) => (
                  <option key={u.id} value={u.id}>{etiquetaUsuario(u, "database_updater")}</option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      <div className="fila-formulario">
        <label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={v.active} onChange={(e) => set({ active: e.target.checked })} />
          Frecuencia activa
        </label>
      </div>

      <h5 style={{ margin: "12px 0 6px" }}>Recordatorios por correo</h5>
      <div className="fila-formulario">
        <label>
          <input
            type="checkbox"
            style={{ width: "auto", marginRight: 6 }}
            checked={v.reminders.remindersEnabled}
            onChange={(e) => set({ reminders: { ...v.reminders, remindersEnabled: e.target.checked } })}
          />
          Activar recordatorios automáticos
        </label>
      </div>
      {v.reminders.remindersEnabled && (
        <>
          <div className="fila-formulario">
            <label>Días previos (separados por coma; 0 = el mismo día)</label>
            <input
              value={(v.reminders.reminderDaysBefore ?? []).join(", ")}
              onChange={(e) => {
                const arr = e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
                set({ reminders: { ...v.reminders, reminderDaysBefore: arr } });
              }}
              placeholder="1, 0"
            />
            <p className="texto-ayuda">Por defecto avisa un día antes y el mismo día.</p>
          </div>
          <div className="fila-formulario">
            <label>Hora de envío (HH:mm)</label>
            <input
              value={v.reminders.reminderTime}
              onChange={(e) => set({ reminders: { ...v.reminders, reminderTime: e.target.value } })}
              placeholder="08:00"
            />
          </div>
          <p className="texto-ayuda">
            Los recordatorios se enviarán al responsable seleccionado. Si no seleccionas uno, se enviarán a las personas activas con el rol correspondiente.
          </p>
        </>
      )}
    </div>
  );
}
