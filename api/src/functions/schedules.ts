import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageSchedules } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, created, forbidden, noContent, notFound, ok, serverError } from "../lib/http";
import { inferScheduleRole } from "../lib/scheduleService";
import { filterSchedulesByOrigin } from "../lib/scheduleFilters";
import type { ClientRecord, UpdateSchedule } from "../types/models";

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
  origin: z.string().optional(),
  active: z.boolean().default(true),
  notes: z.string().optional(),
});

app.http("schedulesList", {
  route: "schedules",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
      const clientId = req.query.get("clientId");
      const origin = req.query.get("origin");
      const querySpec = clientId
        ? { query: "SELECT * FROM c WHERE c.clientId = @c", parameters: [{ name: "@c", value: clientId }] }
        : { query: "SELECT * FROM c" };
      const { resources } = await getContainer("updateSchedules").items.query<UpdateSchedule>(querySpec).fetchAll();
      return ok(filterSchedulesByOrigin(resources, origin));
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
        frequencyType: parsed.data.frequencyType,
        everyNWeeks: parsed.data.everyNWeeks,
        weekdays: parsed.data.weekdays as any,
        intervalDays: parsed.data.intervalDays,
        preferredWeekdays: parsed.data.preferredWeekdays as any,
        dayOfMonth: parsed.data.dayOfMonth,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate ?? null,
        timezone: parsed.data.timezone,
        assignedRole: parsed.data.assignedRole ?? inferScheduleRole(parsed.data.targetType),
        assignedUserIds: parsed.data.assignedUserIds,
        databaseAssignedUserIds: parsed.data.databaseAssignedUserIds,
        databaseReminderRecipientsMode:
          parsed.data.databaseReminderRecipientsMode ?? (parsed.data.databaseAssignedUserIds.length > 0 ? "assignedUsers" : "roleUsers"),
        origin: parsed.data.origin ?? "special",
        active: parsed.data.active,
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
      const before = { ...existing };
      const targetType = body.targetType === "domain" || body.targetType === "database" ? body.targetType : existing.targetType;
      const merged: UpdateSchedule = {
        ...existing,
        ...body,
        targetType,
        assignedRole: body.assignedRole ?? inferScheduleRole(targetType),
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
