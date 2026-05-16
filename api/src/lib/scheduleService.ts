import { v4 as uuid } from "uuid";
import type { CurrentUser, RemindersConfig, UpdateSchedule, Weekday } from "../types/models";

// Entrada parcial de frecuencia que pueden enviar las pantallas de
// "Nuevo dominio" o "Nueva base de datos" para crear la frecuencia
// asociada en la misma operación.
export type FrequencyInput = {
  frequencyType: "weekly" | "interval" | "monthly" | "manual";
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
}

export function inferScheduleRole(targetType: "domain" | "database"): string {
  return targetType === "domain" ? "domain_updater" : "database_updater";
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
    id: `schedule_${uuid()}`,
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
