import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageSchedules } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, created, forbidden, noContent, notFound, ok, serverError } from "../lib/http";
import { getPagination, paginateArray } from "../lib/pagination";
import { matchesScheduleSearch } from "../lib/listSearch";
import { inferScheduleRole, normalizeFrequencyResponsibility } from "../lib/scheduleService";
import { filterSchedulesByOrigin } from "../lib/scheduleFilters";
import { previewLicensingScope } from "../lib/licensingScope";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseModuleRecord, LicensingScope, UpdateSchedule } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

const Weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;

const ScheduleSchema = z.object({
  clientId: z.string().min(1, "El cliente es obligatorio."),
  domainId: z.string().optional(),
  targetType: z.enum(["domain", "database"]),
  targetIds: z.array(z.string()).default([]),
  frequencyType: z.enum(["weekly", "interval", "monthly", "manual"]),
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
  licensingScope: z.object({
    licenseModuleIds: z.array(z.string()).default([]),
    licenseMatchMode: z.enum(["any", "all"]).default("any"),
    environment: z.string().default("all"),
    targetTypes: z.enum(["domains_and_databases", "domains_only", "databases_only"]).default("domains_and_databases"),
    activeOnly: z.boolean().default(true),
  }).optional(),
  assignmentMode: z.enum(["role", "users"]).optional(),
  domainAssignedRole: z.string().optional(),
  databaseAssignedRole: z.string().optional(),
  origin: z.string().optional(),
  active: z.boolean().default(true),
  notes: z.string().optional(),
});

const LicensingPreviewSchema = z.object({
  licenseModuleIds: z.array(z.string()).default([]),
  licenseMatchMode: z.enum(["any", "all"]).default("any"),
  environment: z.string().default("all"),
  targetTypes: z.enum(["domains_and_databases", "domains_only", "databases_only"]).default("domains_and_databases"),
  activeOnly: z.boolean().default(true),
});

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
      const items = filterSchedulesByOrigin(resources, origin).filter((schedule) => matchesScheduleSearch(schedule, search, modulesById));
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
        const moduleError = await validateActiveLicenseModules(parsed.data.licensingScope!.licenseModuleIds);
        if (moduleError) return badRequest(moduleError);
      }
      const normalized = normalizeFrequencyResponsibility(parsed.data as any);
      const { resource: client } = await getContainer("clients").item(parsed.data.clientId, parsed.data.clientId).read<ClientRecord>();
      if (!client) return badRequest("Cliente no encontrado.");
      const now = new Date().toISOString();
      const record: UpdateSchedule = {
        id: `schedule_${uuid()}`,
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
        const moduleError = await validateActiveLicenseModules(body.licensingScope.licenseModuleIds);
        if (moduleError) return badRequest(moduleError);
      }
      const normalized = normalizeFrequencyResponsibility({ ...body });
      const before = { ...existing };
      const targetType = body.targetType === "domain" || body.targetType === "database" ? body.targetType : existing.targetType;
      const merged: UpdateSchedule = {
        ...existing,
        ...normalized,
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
      });
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
      const missing = validateLicensingScope(parsed.data);
      if (missing) return badRequest(missing);
      const data = await loadLicensingScopeData();
      return ok(previewLicensingScope({ scope: parsed.data, ...data }));
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
  s.updatedAt = new Date().toISOString();
  s.updatedBy = user.id;
  await getContainer("updateSchedules").item(s.id, s.clientId).replace(s);
  await writeAuditLog({ entityType: "schedule", entityId: s.id, clientId: s.clientId, clientName: s.clientName, action, performedBy: user.id, performedByEmail: user.email, after: { active } });
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
      await getContainer("updateSchedules").item(s.id, s.clientId).delete();
      await writeAuditLog({ entityType: "schedule", entityId: s.id, clientId: s.clientId, clientName: s.clientName, action: "schedule_deleted", performedBy: user.id, performedByEmail: user.email });
      return noContent();
    } catch (e) { return serverError(e); }
  },
});
