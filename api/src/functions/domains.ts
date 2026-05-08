import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageClients, canEditDomainLimited } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, created, forbidden, noContent, notFound, ok, serverError } from "../lib/http";
import { buildScheduleRecord, validateFrequency, type FrequencyInput } from "../lib/scheduleService";
import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

const DomainSchema = z.object({
  clientId: z.string().min(1, "El cliente es obligatorio."),
  domainName: z.string().min(1, "El dominio es obligatorio."),
  environment: z.string().min(1, "El ambiente es obligatorio."),
  currentWebVersion: z.string().optional(),
  assignedUpdaterIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
  frequency: z.any().optional(),
});

app.http("domainsList", {
  route: "domains",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
      const container = getContainer("domains");
      const clientId = req.query.get("clientId");
      const status = req.query.get("status");
      const environment = req.query.get("environment");
      const search = req.query.get("search")?.toLowerCase();
      const responsable = req.query.get("responsable");
      const querySpec = clientId
        ? { query: "SELECT * FROM c WHERE c.clientId = @c", parameters: [{ name: "@c", value: clientId }] }
        : { query: "SELECT * FROM c" };
      const { resources } = await container.items.query<DomainRecord>(querySpec).fetchAll();
      const includeDeleted = req.query.get("includeDeleted") === "true";
      let items = resources;
      if (!includeDeleted && !status) items = items.filter((d) => d.status !== "deleted");
      if (status) items = items.filter((d) => d.status === status);
      if (environment) items = items.filter((d) => d.environment === environment);
      if (search) items = items.filter((d) => d.domainName.toLowerCase().includes(search) || d.clientName.toLowerCase().includes(search));
      if (responsable) items = items.filter((d) => d.assignedUpdaterIds.includes(responsable));
      return ok(items);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("domainsCreate", {
  route: "domains",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canManageClients(user)) return forbidden();
      const body = await req.json();
      const parsed = DomainSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const { resource: client } = await getContainer("clients").item(parsed.data.clientId, parsed.data.clientId).read<ClientRecord>();
      if (!client) return badRequest("Cliente no encontrado.");
      const now = new Date().toISOString();
      const record: DomainRecord = {
        id: `domain_${uuid()}`,
        clientId: client.id,
        clientName: client.name,
        domainName: parsed.data.domainName.trim(),
        environment: parsed.data.environment,
        currentWebVersion: parsed.data.currentWebVersion,
        assignedUpdaterIds: parsed.data.assignedUpdaterIds,
        status: "active",
        notes: parsed.data.notes,
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
        lastUpdatedAt: null,
        lastUpdatedBy: null,
      };
      await getContainer("domains").items.create(record);
      await writeAuditLog({
        entityType: "domain",
        entityId: record.id,
        clientId: client.id,
        clientName: client.name,
        domainId: record.id,
        domainName: record.domainName,
        action: "domain_created",
        performedBy: user.id,
        performedByEmail: user.email,
        after: record,
      });

      // Crear la frecuencia asociada en la misma operación, si vino en el cuerpo.
      if (parsed.data.frequency) {
        try {
          const freq = { ...(parsed.data.frequency as FrequencyInput), origin: "domain_default" };
          validateFrequency(freq);
          const schedule = buildScheduleRecord({
            input: freq,
            clientId: client.id,
            clientName: client.name,
            domainId: record.id,
            domainName: record.domainName,
            targetType: "domain",
            targetIds: [record.id],
            currentUser: user,
          });
          await getContainer("updateSchedules").items.create(schedule);
          await writeAuditLog({
            entityType: "schedule",
            entityId: schedule.id,
            clientId: client.id,
            clientName: client.name,
            domainId: record.id,
            domainName: record.domainName,
            action: "schedule_created",
            performedBy: user.id,
            performedByEmail: user.email,
            after: schedule,
          });
        } catch (e: any) {
          return badRequest(e?.message ?? "Frecuencia inválida.");
        }
      }
      return created(record);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("domainsGet", {
  route: "domains/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
      const id = req.params.id;
      const { resources } = await getContainer("domains")
        .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
        .fetchAll();
      if (!resources.length) return notFound("Dominio no encontrado.");
      return ok(resources[0]);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("domainsUpdate", {
  route: "domains/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const id = req.params.id;
      const container = getContainer("domains");
      const { resources } = await container
        .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
        .fetchAll();
      if (!resources.length) return notFound("Dominio no encontrado.");
      const existing = resources[0];
      if (!canEditDomainLimited(user, existing)) return forbidden();
      const body = await req.json() as any;

      // Validar la frecuencia ANTES de tocar el dominio para no dejar
      // estado inconsistente si la frecuencia es inválida.
      if (body.frequency) {
        try {
          validateFrequency(body.frequency as FrequencyInput);
        } catch (e: any) {
          return badRequest(e?.message ?? "Frecuencia inválida.");
        }
      }

      const before = { ...existing };
      const updated: DomainRecord = {
        ...existing,
        ...(typeof body.domainName === "string" ? { domainName: body.domainName.trim() } : {}),
        ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
        ...(typeof body.currentWebVersion === "string" ? { currentWebVersion: body.currentWebVersion } : {}),
        ...(Array.isArray(body.assignedUpdaterIds) ? { assignedUpdaterIds: body.assignedUpdaterIds } : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await container.item(id, existing.clientId).replace(updated);
      await writeAuditLog({
        entityType: "domain",
        entityId: id,
        clientId: existing.clientId,
        clientName: existing.clientName,
        domainId: id,
        domainName: updated.domainName,
        action: "domain_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: updated,
      });
      if (body.frequency) {
        try {
          const freq = body.frequency as FrequencyInput;
          validateFrequency(freq);
          const scheduleContainer = getContainer("updateSchedules");
          const { resources: schedules } = await scheduleContainer.items
            .query<UpdateSchedule>({
              query: "SELECT * FROM c WHERE c.targetType = 'domain' AND (c.domainId = @d OR ARRAY_CONTAINS(c.targetIds, @d))",
              parameters: [{ name: "@d", value: id }],
            })
            .fetchAll();
          const existingSchedule = schedules[0];
          if (existingSchedule) {
            const beforeSchedule = { ...existingSchedule };
            const merged: UpdateSchedule = {
              ...existingSchedule,
              frequencyType: freq.frequencyType,
              everyNWeeks: freq.everyNWeeks,
              weekdays: freq.weekdays,
              intervalDays: freq.intervalDays,
              preferredWeekdays: freq.preferredWeekdays,
              dayOfMonth: freq.dayOfMonth,
              startDate: freq.startDate,
              endDate: freq.endDate ?? null,
              timezone: freq.timezone ?? "America/Bogota",
              assignedRole: "domain_updater",
              assignedUserIds: freq.assignedUserIds ?? existing.assignedUpdaterIds ?? [],
              databaseAssignedUserIds: freq.databaseAssignedUserIds ?? existingSchedule.databaseAssignedUserIds ?? [],
              databaseReminderRecipientsMode:
                freq.databaseReminderRecipientsMode ?? ((freq.databaseAssignedUserIds ?? existingSchedule.databaseAssignedUserIds ?? []).length > 0 ? "assignedUsers" : "roleUsers"),
              origin: "domain_default",
              active: freq.active ?? true,
              reminders: freq.reminders,
              domainName: updated.domainName,
              targetIds: [id],
              updatedAt: new Date().toISOString(),
              updatedBy: user.id,
            };
            await scheduleContainer.item(existingSchedule.id, existingSchedule.clientId).replace(merged);
            await writeAuditLog({
              entityType: "schedule",
              entityId: merged.id,
              clientId: existing.clientId,
              clientName: existing.clientName,
              domainId: id,
              domainName: updated.domainName,
              action: "schedule_updated",
              performedBy: user.id,
              performedByEmail: user.email,
              before: beforeSchedule,
              after: merged,
            });
          } else {
            const schedule = buildScheduleRecord({
              input: { ...freq, origin: "domain_default" },
              clientId: existing.clientId,
              clientName: existing.clientName,
              domainId: id,
              domainName: updated.domainName,
              targetType: "domain",
              targetIds: [id],
              currentUser: user,
            });
            await scheduleContainer.items.create(schedule);
            await writeAuditLog({
              entityType: "schedule",
              entityId: schedule.id,
              clientId: existing.clientId,
              clientName: existing.clientName,
              domainId: id,
              domainName: updated.domainName,
              action: "schedule_created",
              performedBy: user.id,
              performedByEmail: user.email,
              after: schedule,
            });
          }
        } catch (e: any) {
          return badRequest(e?.message ?? "Frecuencia inválida.");
        }
      }
      return ok(updated);
    } catch (e) {
      return serverError(e);
    }
  },
});

async function setDomainStatus(req: HttpRequest, action: "domain_deactivated" | "domain_reactivated", status: "inactive" | "active"): Promise<HttpResponseInit> {
  const user = await getUserOrFail(req);
  if (!canManageClients(user)) return forbidden();
  const id = req.params.id;
  const container = getContainer("domains");
  const { resources } = await container
    .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  if (!resources.length) return notFound("Dominio no encontrado.");
  const existing = resources[0];
  existing.status = status;
  existing.updatedAt = new Date().toISOString();
  existing.updatedBy = user.id;
  await container.item(id, existing.clientId).replace(existing);
  await writeAuditLog({
    entityType: "domain", entityId: id, clientId: existing.clientId, clientName: existing.clientName,
    domainId: id, domainName: existing.domainName,
    action, performedBy: user.id, performedByEmail: user.email, after: existing,
  });
  return ok(existing);
}

app.http("domainsDeactivate", { route: "domains/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setDomainStatus(req, "domain_deactivated", "inactive").catch(serverError) });
app.http("domainsReactivate", { route: "domains/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setDomainStatus(req, "domain_reactivated", "active").catch(serverError) });

// Eliminación física con verificación de integridad.
app.http("domainsDelete", {
  route: "domains/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canManageClients(user)) return forbidden();
      const id = req.params.id;
      const container = getContainer("domains");
      const { resources } = await container
        .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
        .fetchAll();
      if (!resources.length) return notFound("Dominio no encontrado.");
      const dom = resources[0];

      // Verificación de integridad: bloquear solo si hay bases de datos
      // asociadas al dominio (datos importantes). Las frecuencias asociadas
      // se eliminan en cascada porque son configuración del dominio.
      const dbsQ = await getContainer("databases")
        .items.query<DatabaseRecord>({
          query: "SELECT * FROM c WHERE c.domainId = @d AND c.status != 'deleted'",
          parameters: [{ name: "@d", value: id }],
        })
        .fetchAll();
      const bdsCount = dbsQ.resources.length;
      if (bdsCount > 0) {
        return badRequest(`No se puede eliminar el dominio porque tiene ${bdsCount} base(s) de datos asociada(s). Elimine o desactive esas bases de datos primero.`);
      }

      // Cascada: eliminar las frecuencias asociadas a este dominio.
      const schedContainer = getContainer("updateSchedules");
      const { resources: schedulesAsociadas } = await schedContainer.items
        .query<UpdateSchedule>({
          query: "SELECT * FROM c WHERE c.domainId = @d OR ARRAY_CONTAINS(c.targetIds, @d)",
          parameters: [{ name: "@d", value: id }],
        })
        .fetchAll();
      let cascadaSchedules = 0;
      for (const s of schedulesAsociadas) {
        try {
          await schedContainer.item(s.id, s.clientId).delete();
          cascadaSchedules++;
          await writeAuditLog({
            entityType: "schedule", entityId: s.id, clientId: s.clientId, clientName: s.clientName,
            domainId: id, domainName: dom.domainName,
            action: "schedule_deleted", performedBy: user.id, performedByEmail: user.email,
            metadata: { cascadeFromDomain: id }, before: s,
          });
        } catch {/* si falla una, seguimos con las demás */}
      }

      await container.item(id, dom.clientId).delete();
      await writeAuditLog({
        entityType: "domain", entityId: id, clientId: dom.clientId, clientName: dom.clientName,
        domainId: id, domainName: dom.domainName,
        action: "domain_deleted", performedBy: user.id, performedByEmail: user.email,
        metadata: { cascadeSchedules: cascadaSchedules },
        before: dom,
      });
      return noContent();
    } catch (e) {
      return serverError(e);
    }
  },
});
