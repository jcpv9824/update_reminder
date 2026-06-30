import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageSchedules } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, created, forbidden, noContent, notFound, ok, serverError } from "../lib/http";
import { getPagination, paginateArray } from "../lib/pagination";
import { matchesScheduleSearch } from "../lib/listSearch";
import { generateGenericScheduleName, inferScheduleRole, normalizeFrequencyResponsibility, validateFrequency } from "../lib/scheduleService";
import { filterSchedulesByOrigin } from "../lib/scheduleFilters";
import { previewLicensingScope } from "../lib/licensingScope";
import { markTaskCancelledForOneTimeReschedule, shouldCancelTaskForOneTimeReschedule } from "../lib/scheduleReschedule";
import { rootScheduleId } from "../lib/taskGenerator";
import { runTaskGeneration } from "./generateDailyUpdateTasks";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseModuleRecord, LicensingScope, UpdateSchedule, UpdateTask } from "../types/models";

function bogotaTodayIso(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  return new Date(utcMs - 5 * 3600_000).toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Genera/actualiza tareas inmediatamente tras guardar una actualización
// programada, reutilizando la misma lógica del timer diario (idempotente).
// Una falla aquí NO debe romper el guardado de la programación.
async function regenerarTareasTrasGuardar(): Promise<void> {
  try {
    await runTaskGeneration(bogotaTodayIso(), () => {});
  } catch {/* la generación no debe interrumpir el guardado */}
}

// Cancela (marca obsoletas) todas las tareas abiertas de una programación al
// desactivarla o eliminarla. Incluye vencidas antiguas para que no queden
// tareas huérfanas visibles cuando ya no existe actualización programada.
// Considera el rootScheduleId nuevo y los scheduleId sintéticos heredados de
// versiones anteriores.
async function cancelarTareasAbiertasDeProgramacion(
  schedule: UpdateSchedule,
  user: { id: string; email: string }
): Promise<number> {
  const { resources } = await getContainer("updateTasks").items.query<UpdateTask>({
    query: "SELECT * FROM c WHERE (c.rootScheduleId = @rid OR c.scheduleId = @rid OR STARTSWITH(c.scheduleId, @pref)) AND c.status IN ('pending','in_progress','blocked','reopened','failed')",
    parameters: [
      { name: "@rid", value: schedule.id },
      { name: "@pref", value: `${schedule.id}__` },
    ],
  }).fetchAll();
  const now = new Date().toISOString();
  let cancelled = 0;
  for (const task of resources) {
    const beforeTask = { ...task };
    task.status = "cancelled";
    task.result = "obsolete";
    task.notes = task.notes
      ? `${task.notes}\nTarea cancelada porque su actualización programada fue desactivada o eliminada.`
      : "Tarea cancelada porque su actualización programada fue desactivada o eliminada.";
    task.updatedAt = now;
    task.updatedBy = user.id;
    try {
      await getContainer("updateTasks").item(task.id, task.taskBucket).replace(task);
    } catch (e: any) {
      // La tarea pudo ser eliminada/movida por otra operación concurrente.
      // No es un fallo: simplemente se omite.
      if (e?.code === 404) continue;
      throw e;
    }
    cancelled++;
    await writeAuditLog({
      entityType: "task", entityId: task.id, clientId: task.clientId, clientName: task.clientName,
      domainId: task.domainId, domainName: task.domainName, action: "task_obsoleted",
      performedBy: user.id, performedByEmail: user.email,
      metadata: { reason: "schedule_deactivated_or_deleted", scheduleId: schedule.id },
      before: beforeTask, after: { status: task.status, result: task.result },
    });
  }
  return cancelled;
}

export type ScheduleSummary = {
  proximas: number;
  vencidas: number;
  conError: number;
  completadas: number;
  requiereAtencion: boolean;
};

// Construye, con UNA sola consulta windowed, el resumen de tareas por
// programación (agrupado por rootScheduleId). El estado de vida de la
// programación (Activa/Inactiva/Completada) NO se deriva de aquí.
async function buildScheduleSummaries(today: string): Promise<Map<string, ScheduleSummary>> {
  const windowStart = addDaysIso(today, -30);
  const windowEnd = addDaysIso(today, 30);
  const { resources } = await getContainer("updateTasks").items.query<UpdateTask>({
    query: "SELECT * FROM c WHERE c.taskDate >= @s AND c.taskDate <= @e",
    parameters: [{ name: "@s", value: windowStart }, { name: "@e", value: windowEnd }],
  }).fetchAll().catch(() => ({ resources: [] as UpdateTask[] }));
  const map = new Map<string, ScheduleSummary>();
  for (const t of resources) {
    const rid = rootScheduleId(t);
    if (!rid) continue;
    const s = map.get(rid) ?? { proximas: 0, vencidas: 0, conError: 0, completadas: 0, requiereAtencion: false };
    if (t.status === "completed") s.completadas++;
    else if (t.status === "cancelled") { /* fuera del resumen operativo */ }
    else if (t.status === "failed" || t.status === "blocked") s.conError++;
    else if (t.taskDate < today) s.vencidas++;
    else s.proximas++;
    map.set(rid, s);
  }
  for (const s of map.values()) s.requiereAtencion = s.vencidas > 0 || s.conError > 0;
  return map;
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
  const [{ resources: clients }, { resources: domains }, { resources: databases }, modulesResult] = await Promise.all([
    getContainer("clients").items.readAll<ClientRecord>().fetchAll(),
    getContainer("domains").items.readAll<DomainRecord>().fetchAll(),
    getContainer("databases").items.readAll<DatabaseRecord>().fetchAll(),
    getContainer("licenseModules").items.readAll<LicenseModuleRecord>().fetchAll().catch(() => ({ resources: [] as LicenseModuleRecord[] })),
  ]);
  return { clients, domains, databases, licenseModules: modulesResult.resources };
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

async function cancelOpenTasksForOneTimeReschedule(args: {
  before: UpdateSchedule;
  after: UpdateSchedule;
  user: { id: string; email: string };
}): Promise<number> {
  if (args.before.frequencyType !== "once" || args.after.frequencyType !== "once") return 0;
  if (args.before.startDate === args.after.startDate) return 0;
  if (!args.before.active || args.before.completedAt || args.before.completedReason) return 0;
  const { resources } = await getContainer("updateTasks")
    .items.query<UpdateTask>({
      query: "SELECT * FROM c WHERE c.taskDate = @date",
      parameters: [{ name: "@date", value: args.before.startDate }],
    })
    .fetchAll();
  const now = new Date().toISOString();
  let cancelled = 0;
  for (const task of resources.filter((task) => shouldCancelTaskForOneTimeReschedule(task, args.before, args.after))) {
    const beforeTask = { ...task };
    const cancelledTask = markTaskCancelledForOneTimeReschedule(task, args.before, args.after, args.user.id, now);
    await getContainer("updateTasks").item(cancelledTask.id, cancelledTask.taskBucket).replace(cancelledTask);
    cancelled++;
    await writeAuditLog({
      entityType: "task",
      entityId: cancelledTask.id,
      clientId: cancelledTask.clientId,
      clientName: cancelledTask.clientName,
      domainId: cancelledTask.domainId,
      domainName: cancelledTask.domainName,
      action: "task_obsoleted",
      performedBy: args.user.id,
      performedByEmail: args.user.email,
      metadata: {
        reason: "one_time_schedule_rescheduled",
        scheduleId: args.before.id,
        oldDate: args.before.startDate,
        newDate: args.after.startDate,
      },
      before: beforeTask,
      after: { status: cancelledTask.status, result: cancelledTask.result, taskDate: cancelledTask.taskDate },
    });
  }
  return cancelled;
}

app.http("schedulesList", {
  route: "schedules",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
      const clientId = req.query.get("clientId");
      const origin = req.query.get("origin");
      const search = req.query.get("search");
      const querySpec = clientId
        ? { query: "SELECT * FROM c WHERE c.clientId = @c", parameters: [{ name: "@c", value: clientId }] }
        : { query: "SELECT * FROM c" };
      const { resources } = await getContainer("updateSchedules").items.query<UpdateSchedule>(querySpec).fetchAll();
      let modulesById = new Map<string, LicenseModuleRecord>();
      if (search) {
        const { resources: modules } = await getContainer("licenseModules").items.readAll<LicenseModuleRecord>().fetchAll().catch(() => ({ resources: [] as LicenseModuleRecord[] }));
        modulesById = new Map(modules.map((module) => [module.id, module]));
      }
      const filtered = filterSchedulesByOrigin(resources, origin).filter((schedule) => matchesScheduleSearch(schedule, search, modulesById));
      // Adjuntar resumen derivado de tareas (1 sola consulta windowed).
      const summaries = await buildScheduleSummaries(bogotaTodayIso());
      const vacio: ScheduleSummary = { proximas: 0, vencidas: 0, conError: 0, completadas: 0, requiereAtencion: false };
      const items = filtered.map((s) => ({ ...s, summary: summaries.get(s.id) ?? vacio }));
      const pagination = getPagination(req);
      if (pagination.enabled) return ok(paginateArray(items, pagination.page, pagination.pageSize));
      return ok(items);
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
      if (!canManageSchedules(user)) return forbidden();
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
      try {
        validateFrequency(normalized as any);
      } catch (e: any) {
        return badRequest(e?.message ?? "Frecuencia inválida.");
      }
      const { resource: client } = await getContainer("clients").item(parsed.data.clientId, parsed.data.clientId).read<ClientRecord>();
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
      await getContainer("updateSchedules").items.create(record);
      await writeAuditLog({
        entityType: "schedule",
        entityId: record.id,
        clientId: client.id,
        clientName: client.name,
        action: "schedule_created",
        performedBy: user.id,
        performedByEmail: user.email,
        after: record,
      });
      // Generar tareas inmediatamente sin esperar al timer diario.
      await regenerarTareasTrasGuardar();
      return created(record);
    } catch (e) {
      return serverError(e);
    }
  },
});

async function findSchedule(id: string): Promise<UpdateSchedule | null> {
  const { resources } = await getContainer("updateSchedules")
    .items.query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  return resources[0] ?? null;
}

app.http("schedulesGet", {
  route: "schedules/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
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
      if (!canManageSchedules(user)) return forbidden();
      const existing = await findSchedule(req.params.id);
      if (!existing) return notFound();
      const body = await req.json() as any;
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
      try {
        validateFrequency(normalized as any);
      } catch (e: any) {
        return badRequest(e?.message ?? "Frecuencia inválida.");
      }
      const before = { ...existing };
      const targetType = body.targetType === "domain" || body.targetType === "database" ? body.targetType : existing.targetType;
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
      await getContainer("updateSchedules").item(existing.id, existing.clientId).replace(merged);
      const cancelledTasks = await cancelOpenTasksForOneTimeReschedule({ before: existing, after: merged, user });
      await writeAuditLog({
        entityType: "schedule",
        entityId: existing.id,
        clientId: existing.clientId,
        clientName: existing.clientName,
        action: "schedule_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: merged,
        metadata: cancelledTasks > 0 ? {
          oneTimeScheduleRescheduled: true,
          oldDate: existing.startDate,
          newDate: merged.startDate,
          cancelledOpenTasks: cancelledTasks,
        } : undefined,
      });
      // Regenerar tareas: crea las nuevas que correspondan y marca obsoletas
      // las futuras que ya no apliquen al nuevo alcance/frecuencia.
      await regenerarTareasTrasGuardar();
      return ok(merged);
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
      if (!canManageSchedules(user)) return forbidden();
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
  if (!canManageSchedules(user)) return forbidden();
  const s = await findSchedule(req.params.id);
  if (!s) return notFound();
  s.active = active;
  // Al reactivar, limpiar la marca de completada (caso 'once' o desactivada).
  if (active) { s.completedAt = null; s.completedReason = null; }
  s.updatedAt = new Date().toISOString();
  s.updatedBy = user.id;
  await getContainer("updateSchedules").item(s.id, s.clientId).replace(s);
  await writeAuditLog({ entityType: "schedule", entityId: s.id, clientId: s.clientId, clientName: s.clientName, action, performedBy: user.id, performedByEmail: user.email, after: { active } });
  if (active) {
    // Reactivar → regenerar tareas (las obsoletas se reactivan en la generación).
    await regenerarTareasTrasGuardar();
  } else {
    // Desactivar → cancelar tareas futuras/pendientes de esta programación.
    await cancelarTareasAbiertasDeProgramacion(s, user);
  }
  return ok(s);
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
      if (!canManageSchedules(user)) return forbidden();
      const s = await findSchedule(req.params.id);
      if (!s) return notFound();
      // Cancelar tareas abiertas antes de eliminar la programación.
      const cancelled = await cancelarTareasAbiertasDeProgramacion(s, user);
      try {
        await getContainer("updateSchedules").item(s.id, s.clientId).delete();
      } catch (e: any) {
        // Eliminación idempotente: si el documento ya no existe (p. ej. una
        // segunda petición por doble clic o por una lectura previa
        // eventualmente consistente), se considera ya eliminado y NO se
        // propaga el error 404 crudo de Cosmos al usuario.
        if (e?.code !== 404) throw e;
      }
      await writeAuditLog({ entityType: "schedule", entityId: s.id, clientId: s.clientId, clientName: s.clientName, action: "schedule_deleted", performedBy: user.id, performedByEmail: user.email, metadata: { cancelledOpenTasks: cancelled } });
      // Regenerar: si una tarea era compartida por otra programación activa
      // (p. ej. una copia con el mismo alcance), vuelve a vincularse de
      // inmediato en lugar de quedar cancelada hasta el próximo timer.
      await regenerarTareasTrasGuardar();
      return noContent();
    } catch (e) { return serverError(e); }
  },
});
