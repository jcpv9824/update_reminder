import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, created, forbidden, noContent, notFound, ok, serverError } from "../lib/http";
import {
  canCreateSchedule,
  canDeactivateSchedule,
  canDeleteSchedule,
  canEditSchedule,
  canPreviewScheduleScope,
  canReactivateSchedule,
  canViewSchedules,
} from "../lib/managementAccess";
import { getPagination } from "../lib/pagination";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { generateGenericScheduleName, inferScheduleRole, normalizeFrequencyResponsibility, validateFrequency, validateScheduleRoleAssignments } from "../lib/scheduleService";
import { previewLicensingScope } from "../lib/licensingScope";
import { readSqlSchedules } from "../lib/schedulingSqlRepository";
import {
  createSqlSchedule,
  deleteSqlSchedule,
  setSqlScheduleActive,
  updateSqlSchedule,
} from "../lib/schedulingSqlWriteRepository";
import { readSqlClients } from "../lib/clientsSqlRepository";
import { readSqlDomains, readSqlPublicDatabases } from "../lib/coreMastersSqlRepository";
import { readSqlLicenseModules } from "../lib/licensingSqlRepository";
import { runTaskGeneration } from "./generateDailyUpdateTasks";
import type { ClientRecord, DatabaseRecord, LicensingScope, UpdateSchedule } from "../types/models";

function bogotaTodayIso(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  return new Date(utcMs - 5 * 3600_000).toISOString().slice(0, 10);
}

export async function loadScheduleClient(clientId: string): Promise<ClientRecord | null> {
  return (await readSqlClients(clientId))[0] ?? null;
}

// Genera/actualiza tareas inmediatamente tras guardar una actualización
// programada, reutilizando la misma lógica del timer diario (idempotente).
// Una falla aquí NO debe romper el guardado de la programación.
async function regenerarTareasTrasGuardar(): Promise<void> {
  try {
    await runTaskGeneration(bogotaTodayIso(), () => {});
  } catch {/* la generación no debe interrumpir el guardado */}
}

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

const Weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const FrequencyTypes = ["once", "weekly", "interval", "monthly", "manual"] as const;

const LicensingScopeSchema = z.object({
  licenseModuleIds: z.array(z.string()).default([]),
  licenseMatchMode: z.enum(["any", "all"]).default("any"),
  environment: z.string().default("all"),
  targetTypes: z.enum(["domains_and_databases", "domains_only", "databases_only"]).default("domains_and_databases"),
  activeOnly: z.boolean().default(true),
  excludedDomainIds: z.array(z.string()).default([]).optional(),
  excludedDatabaseIds: z.array(z.string()).default([]).optional(),
});

const RemindersSchema = z.object({
  remindersEnabled: z.boolean().default(true),
  reminderDaysBefore: z.array(z.number().int().min(0).max(30)).default([1, 0]),
  reminderTime: z.string().regex(/^\d{2}:\d{2}$/, "La hora del recordatorio debe estar en formato HH:mm.").default("08:00"),
  reminderRecipientsMode: z.enum(["assignedUsers", "roleUsers", "customEmails"]).default("roleUsers"),
  customReminderEmails: z.array(z.string()).default([]).optional(),
}).optional();

const ScheduleSchema = z.object({
  name: z.string().trim().max(200).optional(),
  clientId: z.string().min(1, "El cliente es obligatorio."),
  domainId: z.string().optional(),
  targetType: z.enum(["domain", "database"]),
  targetIds: z.array(z.string()).default([]),
  frequencyType: z.enum(FrequencyTypes),
  everyNWeeks: z.number().int().positive().optional(),
  weekdays: z.array(z.enum(Weekdays)).optional(),
  intervalDays: z.number().int().positive().optional(),
  preferredWeekdays: z.array(z.enum(Weekdays)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe estar en formato YYYY-MM-DD."),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha de fin debe estar en formato YYYY-MM-DD.").nullable().optional(),
  timezone: z.string().default("America/Bogota"),
  assignedRole: z.string().min(1).optional(),
  assignedUserIds: z.array(z.string()).default([]),
  databaseAssignedUserIds: z.array(z.string()).default([]),
  databaseReminderRecipientsMode: z.enum(["assignedUsers", "roleUsers"]).optional(),
  scopeGroups: z.array(z.object({
    clientId: z.string(),
    includeAllDomains: z.boolean(),
    domains: z.array(z.object({
      domainId: z.string(),
      includeAllDatabases: z.boolean(),
      databaseIds: z.array(z.string()),
    })),
  })).optional(),
  selectionMode: z.enum(["manual", "licensing"]).optional().default("manual"),
  manualTargetTypes: z.enum(["domains_and_databases", "domains_only", "databases_only"]).optional().default("domains_and_databases"),
  licensingScope: LicensingScopeSchema.optional(),
  assignmentMode: z.enum(["role", "users"]).optional(),
  domainAssignedRole: z.string().optional(),
  databaseAssignedRole: z.string().optional(),
  origin: z.string().optional(),
  active: z.boolean().default(true),
  reminders: RemindersSchema,
  notes: z.string().optional(),
});

const LicensingPreviewSchema = z.union([
  LicensingScopeSchema,
  z.object({ licensingScope: LicensingScopeSchema }),
]);

async function loadLicensingScopeData() {
  const pagination = { enabled: false, page: 1, pageSize: 500 };
  const [clients, domainsResult, databasesResult, modulesResult] = await Promise.all([
    readSqlClients(),
    readSqlDomains({ excludeDeleted: true }, pagination),
    readSqlPublicDatabases({ visibility: "not-deleted" }, pagination),
    readSqlLicenseModules({ includeDeleted: false }, pagination),
  ]);
  return {
    clients,
    domains: Array.isArray(domainsResult) ? domainsResult : domainsResult.items,
    databases: (Array.isArray(databasesResult) ? databasesResult : databasesResult.items) as DatabaseRecord[],
    licenseModules: Array.isArray(modulesResult) ? modulesResult : modulesResult.items,
  };
}

function validateLicensingScope(scope?: LicensingScope): string | null {
  if (!scope) return "Configure el alcance por licenciamiento.";
  const ids = Array.from(new Set(scope.licenseModuleIds.map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) return "Seleccione al menos una licencia.";
  return null;
}

function normalizeScopeIds(scope: LicensingScope): LicensingScope {
  return {
    ...scope,
    licenseModuleIds: Array.from(new Set((scope.licenseModuleIds ?? []).map((id) => id.trim()).filter(Boolean))),
    excludedDomainIds: Array.from(new Set((scope.excludedDomainIds ?? []).map((id) => id.trim()).filter(Boolean))),
    excludedDatabaseIds: Array.from(new Set((scope.excludedDatabaseIds ?? []).map((id) => id.trim()).filter(Boolean))),
  };
}

async function validateLicensingScopeExceptions(scope: LicensingScope): Promise<string | null> {
  const data = await loadLicensingScopeData();
  const baseScope = normalizeScopeIds({ ...scope, excludedDomainIds: [], excludedDatabaseIds: [] });
  const preview = previewLicensingScope({ scope: baseScope, ...data });
  const allowedDomainIds = new Set(preview.groups.flatMap((group) => group.domains.map((domain) => domain.id)));
  const allowedDatabaseIds = new Set(preview.groups.flatMap((group) => group.domains.flatMap((domain) => domain.databases.map((db) => db.id))));
  const invalidDomain = (scope.excludedDomainIds ?? []).find((id) => !allowedDomainIds.has(id));
  if (invalidDomain) return "Una excepción de dominio no pertenece al alcance actual.";
  const invalidDatabase = (scope.excludedDatabaseIds ?? []).find((id) => !allowedDatabaseIds.has(id));
  if (invalidDatabase) return "Una excepción de base de datos no pertenece al alcance actual.";
  return null;
}

async function validateActiveLicenseModules(ids: string[]): Promise<string | null> {
  const { licenseModules } = await loadLicensingScopeData();
  const modulesById = new Map(licenseModules.map((module) => [module.id, module]));
  for (const id of ids) {
    const module = modulesById.get(id);
    if (!module || module.status !== "active" || module.active === false || module.deletedAt) return "Seleccione solo licencias activas.";
  }
  return null;
}

app.http("schedulesList", {
  route: "schedules",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewSchedules(user, roleDefinitions)) return forbidden();
      const clientId = req.query.get("clientId");
      const origin = req.query.get("origin");
      const search = req.query.get("search");
      const pagination = getPagination(req);
      const sqlFilters = { clientId, origin, search };
      return ok(await readSqlSchedules(sqlFilters, pagination, bogotaTodayIso()));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("schedulesCreate", {
  route: "schedules",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateSchedule(user, roleDefinitions)) return forbidden();
      const body = await req.json();
      const parsed = ScheduleSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.selectionMode === "licensing") {
        const missing = validateLicensingScope(parsed.data.licensingScope as LicensingScope | undefined);
        if (missing) return badRequest(missing);
        parsed.data.licensingScope = normalizeScopeIds(parsed.data.licensingScope!);
        const moduleError = await validateActiveLicenseModules(parsed.data.licensingScope.licenseModuleIds);
        if (moduleError) return badRequest(moduleError);
        const exceptionError = await validateLicensingScopeExceptions(parsed.data.licensingScope);
        if (exceptionError) return badRequest(exceptionError);
      }
      const normalized = normalizeFrequencyResponsibility(parsed.data as any);
      const roleAssignmentError = validateScheduleRoleAssignments({ ...normalized, targetType: parsed.data.targetType }, roleDefinitions);
      if (roleAssignmentError) return badRequest(roleAssignmentError);
      try {
        validateFrequency(normalized as any);
      } catch (e: any) {
        return badRequest(e?.message ?? "Frecuencia inválida.");
      }
      const client = await loadScheduleClient(parsed.data.clientId);
      if (!client) return badRequest("Cliente no encontrado.");
      const now = new Date().toISOString();
      const record: UpdateSchedule = {
        id: `schedule_${randomUUID()}`,
        name: generateGenericScheduleName({
          name: parsed.data.name,
          selectionMode: normalized.selectionMode ?? parsed.data.selectionMode ?? "manual",
          frequencyType: normalized.frequencyType,
          clientName: client.name,
          startDate: normalized.startDate,
        }),
        clientId: client.id,
        clientName: client.name,
        domainId: parsed.data.domainId,
        domainName: undefined,
        targetType: parsed.data.targetType,
        targetIds: parsed.data.targetIds,
        frequencyType: normalized.frequencyType,
        everyNWeeks: normalized.everyNWeeks,
        weekdays: normalized.weekdays as any,
        intervalDays: normalized.intervalDays,
        preferredWeekdays: normalized.preferredWeekdays as any,
        dayOfMonth: normalized.dayOfMonth,
        startDate: normalized.startDate,
        endDate: normalized.endDate ?? null,
        timezone: normalized.timezone ?? "America/Bogota",
        assignedRole: normalized.assignedRole ?? inferScheduleRole(parsed.data.targetType),
        assignedUserIds: normalized.assignedUserIds ?? [],
        databaseAssignedUserIds: normalized.databaseAssignedUserIds ?? [],
        databaseReminderRecipientsMode: normalized.databaseReminderRecipientsMode,
        scopeGroups: normalized.scopeGroups,
        selectionMode: normalized.selectionMode ?? parsed.data.selectionMode ?? "manual",
        licensingScope: normalized.licensingScope ?? parsed.data.licensingScope,
        assignmentMode: normalized.assignmentMode,
        domainAssignedRole: normalized.domainAssignedRole,
        databaseAssignedRole: normalized.databaseAssignedRole,
        reminders: normalized.reminders,
        origin: normalized.origin ?? "special",
        active: normalized.active ?? true,
        notes: parsed.data.notes,
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      const createdSchedule = await createSqlSchedule(record, { id: user.id, email: user.email });
      await regenerarTareasTrasGuardar();
      return created(createdSchedule);
    } catch (e) {
      return serverError(e);
    }
  },
});

async function findSchedule(id: string): Promise<UpdateSchedule | null> {
  const result = await readSqlSchedules({ sourceId: id }, { enabled: false, page: 1, pageSize: 1 }, bogotaTodayIso());
  return Array.isArray(result) ? result[0] ?? null : result.items[0] ?? null;
}

app.http("schedulesGet", {
  route: "schedules/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewSchedules(user, roleDefinitions)) return forbidden();
      const s = await findSchedule(req.params.id);
      if (!s) return notFound();
      return ok(s);
    } catch (e) { return serverError(e); }
  },
});

app.http("schedulesUpdate", {
  route: "schedules/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canEditSchedule(user, roleDefinitions)) return forbidden();
      const existing = await findSchedule(req.params.id);
      if (!existing) return notFound();
      const body = await req.json() as any;
      if (body.active === false && existing.active !== false && !canDeactivateSchedule(user, roleDefinitions)) return forbidden();
      if (body.active === true && existing.active === false && !canReactivateSchedule(user, roleDefinitions)) return forbidden();
      if (body.selectionMode === "licensing") {
        const missing = validateLicensingScope(body.licensingScope);
        if (missing) return badRequest(missing);
        body.licensingScope = normalizeScopeIds(body.licensingScope);
        const moduleError = await validateActiveLicenseModules(body.licensingScope.licenseModuleIds);
        if (moduleError) return badRequest(moduleError);
        const exceptionError = await validateLicensingScopeExceptions(body.licensingScope);
        if (exceptionError) return badRequest(exceptionError);
      }
      const normalized = normalizeFrequencyResponsibility({ ...body });
      const targetType = body.targetType === "domain" || body.targetType === "database" ? body.targetType : existing.targetType;
      const roleAssignmentError = validateScheduleRoleAssignments({ ...existing, ...normalized, targetType }, roleDefinitions);
      if (roleAssignmentError) return badRequest(roleAssignmentError);
      try {
        validateFrequency(normalized as any);
      } catch (e: any) {
        return badRequest(e?.message ?? "Frecuencia inválida.");
      }
      // Nombre: si el usuario envía uno, se respeta; si lo vacía, se regenera
      // un genérico; si no toca el campo, se conserva el actual.
      const nextName = typeof body.name === "string"
        ? generateGenericScheduleName({
            name: body.name,
            selectionMode: normalized.selectionMode ?? body.selectionMode ?? existing.selectionMode ?? "manual",
            frequencyType: normalized.frequencyType,
            clientName: existing.clientName,
            startDate: normalized.startDate,
          })
        : existing.name;
      const merged: UpdateSchedule = {
        ...existing,
        ...normalized,
        name: nextName,
        targetType,
        assignedRole: normalized.assignedRole ?? inferScheduleRole(targetType),
        assignedUserIds: normalized.assignedUserIds ?? [],
        databaseAssignedUserIds: normalized.databaseAssignedUserIds ?? [],
        databaseReminderRecipientsMode: normalized.databaseReminderRecipientsMode ?? "roleUsers",
        scopeGroups: normalized.scopeGroups,
        selectionMode: normalized.selectionMode ?? body.selectionMode ?? existing.selectionMode ?? "manual",
        licensingScope: normalized.licensingScope ?? body.licensingScope,
        assignmentMode: normalized.assignmentMode,
        domainAssignedRole: normalized.domainAssignedRole,
        databaseAssignedRole: normalized.databaseAssignedRole,
        reminders: normalized.reminders,
        origin: body.origin ?? existing.origin ?? "special",
        targetIds: Array.isArray(body.targetIds) ? body.targetIds : existing.targetIds,
        endDate: body.endDate ?? null,
        id: existing.id,
        clientId: existing.clientId,
        clientName: existing.clientName,
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      const result = await updateSqlSchedule(existing, merged, { id: user.id, email: user.email });
      if (!result) return notFound();
      await regenerarTareasTrasGuardar();
      return ok(result.schedule);
    } catch (e) { return serverError(e); }
  },
});

app.http("previewLicensingScope", {
  route: "special-schedules/preview-licensing-scope",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canPreviewScheduleScope(user, roleDefinitions)) return forbidden();
      const parsed = LicensingPreviewSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const scope = normalizeScopeIds("licensingScope" in parsed.data ? parsed.data.licensingScope : parsed.data);
      const missing = validateLicensingScope(scope);
      if (missing) return badRequest(missing);
      const data = await loadLicensingScopeData();
      return ok(previewLicensingScope({ scope, ...data }));
    } catch (e) {
      return serverError(e);
    }
  },
});

async function setScheduleStatus(req: HttpRequest, action: string, active: boolean): Promise<HttpResponseInit> {
  const user = await getUserOrFail(req);
  const roleDefinitions = await loadRoleDefinitions();
  const allowed = active ? canReactivateSchedule(user, roleDefinitions) : canDeactivateSchedule(user, roleDefinitions);
  if (!allowed) return forbidden();
  const s = await findSchedule(req.params.id);
  if (!s) return notFound();
  s.active = active;
  // Al reactivar, limpiar la marca de completada (caso 'once' o desactivada).
  if (active) { s.completedAt = null; s.completedReason = null; }
  s.updatedAt = new Date().toISOString();
  s.updatedBy = user.id;
  const updated = await setSqlScheduleActive(s, active, { id: user.id, email: user.email }, action);
  if (!updated) return notFound();
  if (active) await regenerarTareasTrasGuardar();
  return ok(updated);
}

app.http("schedulesDeactivate", { route: "schedules/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setScheduleStatus(req, "schedule_deactivated", false).catch(serverError) });
app.http("schedulesReactivate", { route: "schedules/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setScheduleStatus(req, "schedule_reactivated", true).catch(serverError) });

app.http("schedulesDelete", {
  route: "schedules/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeleteSchedule(user, roleDefinitions)) return forbidden();
      const s = await findSchedule(req.params.id);
      if (!s) return notFound();
      const result = await deleteSqlSchedule(s, { id: user.id, email: user.email });
      if (!result.deleted) return notFound();
      await regenerarTareasTrasGuardar();
      return noContent();
    } catch (e) { return serverError(e); }
  },
});
