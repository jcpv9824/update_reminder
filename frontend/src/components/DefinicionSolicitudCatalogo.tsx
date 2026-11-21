import { useId, useState } from "react";
import { eligibleRolesForTaskAssignment } from "../permissionAccess";
import type { RoleDefinition } from "../permissionModel";
import { DIAS_SEMANA, type Usuario } from "../types";

type Kind = "domain" | "database";
type Cadence = "once" | "weekly" | "interval" | "monthly" | "manual";
export type DraftDefinitionSelection = {
  calendar: { frequencyType: Cadence; everyNWeeks?: number; weekdays?: string[]; intervalDays?: number;
    preferredWeekdays?: string[]; dayOfMonth?: number; endDate?: string };
  assignment: { mode: "role"; domainRole?: string; databaseRole?: string }
    | { mode: "users"; domainUsers?: string[]; databaseUsers?: string[] };
};

export default function DefinicionSolicitudCatalogo({
  kinds, roles, usuarios, startDate, disabled, canSubmit, onSave,
}: { kinds: readonly Kind[]; roles: RoleDefinition[]; usuarios: Usuario[]; startDate: string; disabled: boolean; canSubmit: boolean;
  onSave: (selection: DraftDefinitionSelection) => void }) {
  const id = useId();
  const [frequencyType, setFrequency] = useState<Cadence>("once");
  const [number, setNumber] = useState("1");
  const [picked, setPicked] = useState<string[]>([]);
  const [endDate, setEndDate] = useState("");
  const [mode, setMode] = useState<"role" | "users">("role");
  const [roleChoice, setRoleChoice] = useState<Partial<Record<Kind, string>>>({});
  const [userChoice, setUserChoice] = useState<Partial<Record<Kind, string[]>>>({});
  const available = { domain: eligibleRolesForTaskAssignment(roles, "domain"), database: eligibleRolesForTaskAssignment(roles, "database") };
  const activeUsers = usuarios.filter(user => user.active !== false);
  const selectedRole = (kind: Kind) => {
    const desired = roleChoice[kind] ?? `${kind}_updater`;
    return available[kind].some(role => role.id === desired) ? desired : "";
  };
  const selectedUsers = (kind: Kind) => (userChoice[kind] ?? []).filter(id => activeUsers.some(user => user.id === id));
  const inputNumber = Number(number);
  const numbered = frequencyType === "weekly" || frequencyType === "interval" || frequencyType === "monthly";
  const valid = kinds.length > 0 && kinds.every(kind => mode === "role" ? selectedRole(kind) !== "" : selectedUsers(kind).length > 0)
    && (!numbered || Number.isInteger(inputNumber) && inputNumber >= 1 && inputNumber <= (frequencyType === "monthly" ? 31 : 32767))
    && (frequencyType !== "weekly" || picked.length > 0) && (frequencyType === "once" || !endDate || endDate >= startDate);
  function save() {
    if (!valid || !canSubmit || disabled) return;
    const calendar = { frequencyType, ...(frequencyType !== "once" && endDate && { endDate }),
      ...(frequencyType === "weekly" && { everyNWeeks: inputNumber, weekdays: picked }),
      ...(frequencyType === "interval" && { intervalDays: inputNumber, ...(picked.length && { preferredWeekdays: picked }) }),
      ...(frequencyType === "monthly" && { dayOfMonth: inputNumber }) };
    const assignment: DraftDefinitionSelection["assignment"] = mode === "role"
      ? { mode, ...(kinds.includes("domain") && { domainRole: selectedRole("domain") }),
        ...(kinds.includes("database") && { databaseRole: selectedRole("database") }) }
      : { mode, ...(kinds.includes("domain") && { domainUsers: selectedUsers("domain") }),
        ...(kinds.includes("database") && { databaseUsers: selectedUsers("database") }) };
    onSave({ calendar, assignment });
  }
  return <fieldset disabled={disabled}>
    <legend>Frecuencia y responsables</legend>
    <div className="campo">
      <label htmlFor={`${id}-frequency`}>Frecuencia de la programación</label>
      <select id={`${id}-frequency`} value={frequencyType} onChange={event => {
        setFrequency(event.target.value as Cadence); setNumber("1"); setPicked([]);
      }}>
        <option value="once">Una sola vez</option><option value="weekly">Semanal</option>
        <option value="interval">Por intervalo de días</option><option value="monthly">Mensual</option>
        <option value="manual">Solo ejecución manual</option>
      </select>
    </div>
    {numbered && <div className="campo">
      <label htmlFor={`${id}-interval`}>{frequencyType === "weekly" ? "Cada cuántas semanas" : frequencyType === "interval" ? "Cada cuántos días" : "Día del mes"}</label>
      <input id={`${id}-interval`} type="number" min={1} max={frequencyType === "monthly" ? 31 : 32767}
        value={number} onChange={event => setNumber(event.target.value)} />
    </div>}
    {(frequencyType === "weekly" || frequencyType === "interval") && <fieldset>
      <legend>{frequencyType === "weekly" ? "Días de la semana" : "Días preferidos (opcional)"}</legend>
      {Object.entries(DIAS_SEMANA).map(([key, label]) => <label key={key} className="fila-seleccion">
        <input type="checkbox" checked={picked.includes(key)}
          onChange={event => setPicked(event.target.checked ? [...picked, key] : picked.filter(value => value !== key))} />{label}
      </label>)}
    </fieldset>}
    {frequencyType !== "once" && <div className="campo">
      <label htmlFor={`${id}-end`}>Fecha de fin (opcional)</label>
      <input id={`${id}-end`} type="date" min={startDate} value={endDate} onChange={event => setEndDate(event.target.value)} />
    </div>}
    <div className="campo">
      <label htmlFor={`${id}-mode`}>Modo de asignación</label>
      <select id={`${id}-mode`} value={mode} onChange={event => setMode(event.target.value === "role" ? "role" : "users")}>
        <option value="role">Por rol</option><option value="users">Usuarios específicos</option>
      </select>
    </div>
    {kinds.map(kind => <div className="campo" key={kind}>
      <label htmlFor={`${id}-${kind}`}>{mode === "role" ? "Rol" : "Usuarios"} para {kind === "domain" ? "dominios" : "bases de datos"}</label>
      {mode === "role"
        ? <select id={`${id}-${kind}`} value={selectedRole(kind)} onChange={event => setRoleChoice({ ...roleChoice, [kind]: event.target.value })}>
          <option value="">Seleccione un rol</option>
          {available[kind].map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
        : <select id={`${id}-${kind}`} multiple value={selectedUsers(kind)}
          onChange={event => setUserChoice({ ...userChoice, [kind]: Array.from(event.target.selectedOptions, option => option.value) })}>
          {activeUsers.map(user => <option key={user.id} value={user.id}>{user.displayName || user.email}</option>)}
        </select>}
    </div>)}
    <button type="button" disabled={!valid || !canSubmit || disabled} onClick={save}>Guardar solicitud de programación</button>
  </fieldset>;
}
