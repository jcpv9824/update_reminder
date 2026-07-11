import { randomUUID } from "node:crypto";
import type { CurrentUser, RemindersConfig, UpdateSchedule, Weekday } from "../types/models";
import { eligibleRolesForTaskAssignment, type RoleDefinition } from "./permissionModel";

// Entrada parcial de frecuencia que pueden enviar las pantallas de
// "Nuevo dominio" o "Nueva base de datos" para crear la frecuencia
// asociada en la misma operación.
export type FrequencyInput = {
  name?: string;
  frequencyType: "once" | "weekly" | "interval" | "monthly" | "manual";
  everyNWeeks?: number;
  weekdays?: Weekday[];
  intervalDays?: number;
  preferredWeekdays?: Weekday[];
  dayOfMonth?: number;
  startDate: string;
  endDate?: string | null;
  timezone?: string;
  assignedRole?: string;
  assignedUserIds?: string[];
  databaseAssignedUserIds?: string[];
  databaseReminderRecipientsMode?: "assignedUsers" | "roleUsers";
  scopeGroups?: import("../types/models").ScheduleScopeGroup[];
  selectionMode?: import("../types/models").ScheduleSelectionMode;
  manualTargetTypes?: import("../types/models").ManualTargetTypes;
  licensingScope?: import("../types/models").LicensingScope;
  assignmentMode?: import("../types/models").ScheduleAssignmentMode;
  domainAssignedRole?: string;
  databaseAssignedRole?: string;
  origin?: "domain_default" | "special" | "database_inherited" | string;
  active?: boolean;
  reminders?: RemindersConfig;
};

export function validateFrequency(input: FrequencyInput): void {
  if (!input || !input.frequencyType) {
    throw new Error("La frecuencia es obligatoria.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate ?? "")) {
    throw new Error("La fecha de inicio de la frecuencia debe estar en formato YYYY-MM-DD.");
  }
  if (input.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    throw new Error("La fecha de fin de la frecuencia debe estar en formato YYYY-MM-DD.");
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw new Error("La fecha de fin no puede ser anterior a la fecha de inicio.");
  }
  if (input.frequencyType === "weekly") {
    if (!input.weekdays || input.weekdays.length === 0) {
      throw new Error("Seleccione al menos un día de la semana para la frecuencia.");
    }
    if ((input.everyNWeeks ?? 1) < 1) {
      throw new Error("El intervalo de semanas debe ser mayor o igual a 1.");
    }
  }
  if (input.frequencyType === "once" && input.endDate && input.endDate !== input.startDate) {
    throw new Error("La programación única no debe tener una fecha de fin distinta a la fecha de actualización.");
  }
  if (input.frequencyType === "interval") {
    if (!input.intervalDays || input.intervalDays < 1) {
      throw new Error("El intervalo en días debe ser mayor o igual a 1.");
    }
  }
  if (input.frequencyType === "monthly") {
    const d = input.dayOfMonth ?? 0;
    if (d < 1 || d > 31) {
      throw new Error("El día del mes debe estar entre 1 y 31.");
    }
  }
  if (input.reminders?.remindersEnabled) {
    if (!input.reminders.reminderDaysBefore || input.reminders.reminderDaysBefore.length === 0) {
      throw new Error("Seleccione al menos un recordatorio.");
    }
    if (!/^\d{2}:\d{2}$/.test(input.reminders.reminderTime ?? "")) {
      throw new Error("La hora del recordatorio debe estar en formato HH:mm.");
    }
  }
}

export function inferScheduleRole(targetType: "domain" | "database"): string {
  return targetType === "domain" ? "domain_updater" : "database_updater";
}

export function validateScheduleRoleAssignments(
  input: Pick<FrequencyInput, "assignmentMode" | "assignedRole" | "domainAssignedRole" | "databaseAssignedRole" | "selectionMode" | "manualTargetTypes" | "licensingScope"> & { targetType?: "domain" | "database" },
  roleDefinitions: RoleDefinition[]
): string | null {
  if (input.assignmentMode === "users") return null;

  const scopeTargetTypes = input.selectionMode === "licensing"
    ? input.licensingScope?.targetTypes
    : input.manualTargetTypes;
  const targetTypes: Array<"domain" | "database"> = scopeTargetTypes === "domains_only"
    ? ["domain"]
    : scopeTargetTypes === "databases_only"
      ? ["database"]
      : scopeTargetTypes === "domains_and_databases"
        ? ["domain", "database"]
        : [input.targetType ?? "domain"];

  for (const targetType of targetTypes) {
    const roleId = targetType === "domain"
      ? input.domainAssignedRole ?? input.assignedRole ?? inferScheduleRole("domain")
      : input.databaseAssignedRole ?? inferScheduleRole("database");
    const eligible = eligibleRolesForTaskAssignment(roleDefinitions, targetType);
    if (!eligible.some((role) => role.id === roleId)) {
      const label = targetType === "domain" ? "dominios" : "bases de datos";
      return `El rol seleccionado para tareas de ${label} debe estar activo, tener acceso a Tareas y visibilidad para ese tipo de tarea.`;
    }
  }

  return null;
}

const ETIQUETA_FRECUENCIA: Record<string, string> = {
  once: "única",
  weekly: "semanal",
  interval: "por intervalo",
  monthly: "mensual",
  manual: "manual",
};

// Genera un nombre genérico descriptivo cuando el usuario no escribe uno.
// Ej.: "Actualización semanal — Cliente ABC — 2026-05-07" o, para alcance
// por licenciamiento multi-cliente, "Actualización por licenciamiento — 2026-05-07".
export function generateGenericScheduleName(args: {
  name?: string;
  selectionMode?: string;
  frequencyType: string;
  clientName?: string;
  startDate: string;
}): string {
  const provided = (args.name ?? "").trim();
  if (provided) return provided.slice(0, 200);
  const etiqueta = ETIQUETA_FRECUENCIA[args.frequencyType] ?? args.frequencyType;
  if (args.selectionMode === "licensing") {
    return `Actualización por licenciamiento — ${etiqueta} — ${args.startDate}`.slice(0, 200);
  }
  const cliente = (args.clientName ?? "").trim();
  return (cliente
    ? `Actualización ${etiqueta} — ${cliente} — ${args.startDate}`
    : `Actualización ${etiqueta} — ${args.startDate}`).slice(0, 200);
}

export function normalizeFrequencyResponsibility(input: FrequencyInput): FrequencyInput {
  const assignedUserIds = input.assignedUserIds ?? [];
  const databaseAssignedUserIds = input.databaseAssignedUserIds ?? [];
  return {
    ...input,
    assignedUserIds,
    databaseAssignedUserIds,
    databaseReminderRecipientsMode: databaseAssignedUserIds.length > 0 ? "assignedUsers" : "roleUsers",
    reminders: input.reminders
      ? {
          ...input.reminders,
          reminderRecipientsMode: assignedUserIds.length > 0 ? "assignedUsers" : "roleUsers",
          customReminderEmails: [],
        }
      : input.reminders,
  };
}

export function buildScheduleRecord(args: {
  input: FrequencyInput;
  clientId: string;
  clientName: string;
  domainId?: string;
  domainName?: string;
  targetType: "domain" | "database";
  targetIds: string[];
  currentUser: CurrentUser;
}): UpdateSchedule {
  const now = new Date().toISOString();
  const normalized = normalizeFrequencyResponsibility(args.input);
  return {
    id: `schedule_${randomUUID()}`,
    name: generateGenericScheduleName({
      name: normalized.name,
      selectionMode: normalized.selectionMode,
      frequencyType: normalized.frequencyType,
      clientName: args.clientName,
      startDate: normalized.startDate,
    }),
    clientId: args.clientId,
    clientName: args.clientName,
    domainId: args.domainId,
    domainName: args.domainName,
    targetType: args.targetType,
    targetIds: args.targetIds,
    frequencyType: normalized.frequencyType,
    everyNWeeks: normalized.everyNWeeks,
    weekdays: normalized.weekdays,
    intervalDays: normalized.intervalDays,
    preferredWeekdays: normalized.preferredWeekdays,
    dayOfMonth: normalized.dayOfMonth,
    startDate: normalized.startDate,
    endDate: normalized.endDate ?? null,
    timezone: normalized.timezone ?? "America/Bogota",
    assignedRole: normalized.assignedRole ?? inferScheduleRole(args.targetType),
    assignedUserIds: normalized.assignedUserIds ?? [],
    databaseAssignedUserIds: normalized.databaseAssignedUserIds ?? [],
    databaseReminderRecipientsMode: normalized.databaseReminderRecipientsMode,
    scopeGroups: normalized.scopeGroups,
    selectionMode: normalized.selectionMode,
    manualTargetTypes: normalized.manualTargetTypes,
    licensingScope: normalized.licensingScope,
    assignmentMode: normalized.assignmentMode,
    domainAssignedRole: normalized.domainAssignedRole,
    databaseAssignedRole: normalized.databaseAssignedRole,
    origin: normalized.origin,
    active: normalized.active ?? true,
    reminders: normalized.reminders,
    createdAt: now,
    createdBy: args.currentUser.id,
    updatedAt: now,
    updatedBy: args.currentUser.id,
  };
}

export function isDomainDefaultScheduleForDomain(schedule: UpdateSchedule, domainId: string): boolean {
  return schedule.origin === "domain_default" &&
    schedule.targetType === "domain" &&
    (schedule.domainId === domainId || (schedule.targetIds ?? []).includes(domainId));
}

export function deactivateDomainDefaultSchedule(schedule: UpdateSchedule, userId: string, nowIso: string): UpdateSchedule {
  return {
    ...schedule,
    active: false,
    updatedAt: nowIso,
    updatedBy: userId,
  };
}
