import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageClients, canRevealDatabaseSecret, canEditDatabaseLimited, canAccessDatabaseTaskConnection } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { cancelPendingTasksForDatabase } from "../lib/taskCleanup";
import * as keyVault from "../lib/keyVault";
import { buildDatabaseRecordFromInput } from "../lib/databaseService";
import { buildDatabaseAccessInfo } from "../lib/databaseAccessInfo";
import { parseDbAccessString } from "../lib/dbAccessParser";
import { buildScheduleRecord, validateFrequency, type FrequencyInput } from "../lib/scheduleService";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import { getPagination, paginateArray } from "../lib/pagination";
import { matchesDatabaseSearch } from "../lib/listSearch";
import { hasDuplicateDatabaseConnection } from "../lib/duplicateValidation";
import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

const DbCreateSchema = z.object({
  clientId: z.string().min(1),
  domainId: z.string().min(1),
  companyName: z.string().min(1, "El nombre de la empresa es obligatorio."),
  environment: z.string().min(1),
  rawDbAccess: z.string().min(1, "La cadena de acceso es obligatoria."),
  assignedUpdaterIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
  currentDbVersion: z.string().optional(),
  frequency: z.any().optional(),
});

app.http("databasesList", {
  route: "databases",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
      const container = getContainer("databases");
      const clientId = req.query.get("clientId");
      const domainId = req.query.get("domainId");
      const querySpec = clientId
        ? { query: "SELECT * FROM c WHERE c.clientId = @c", parameters: [{ name: "@c", value: clientId }] }
        : { query: "SELECT * FROM c" };
      const { resources } = await container.items.query<DatabaseRecord>(querySpec).fetchAll();
      const status = req.query.get("status");
      const env = req.query.get("environment");
      const search = req.query.get("search");
      const includeDeleted = req.query.get("includeDeleted") === "true";
      let items = resources;
      if (!includeDeleted && !status) items = items.filter((d) => d.status !== "deleted");
      if (domainId) items = items.filter((d) => d.domainId === domainId);
      if (status) items = items.filter((d) => d.status === status);
      if (env) items = items.filter((d) => d.environment === env);
      if (search) items = items.filter((d) => matchesDatabaseSearch(d, search));
      const pagination = getPagination(req);
      if (pagination.enabled) return ok(paginateArray(items, pagination.page, pagination.pageSize));
      return ok(items);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("databasesCreate", {
  route: "databases",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canManageClients(user)) return forbidden();
      const body = await req.json();
      const parsed = DbCreateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);

      const { resource: client } = await getContainer("clients").item(parsed.data.clientId, parsed.data.clientId).read<ClientRecord>();
      if (!client) return badRequest("Cliente no encontrado.");
      const { resources: domains } = await getContainer("domains")
        .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: parsed.data.domainId }] })
        .fetchAll();
      if (!domains.length) return badRequest("Dominio no encontrado.");
      const domain = domains[0];

      try {
        parseDbAccessString(parsed.data.rawDbAccess);
      } catch (e: any) {
        return badRequest(e.message ?? "Cadena de acceso inválida.");
      }
      const { resources: existingDatabases } = await getContainer("databases").items.readAll<DatabaseRecord>().fetchAll();
      if (hasDuplicateDatabaseConnection(existingDatabases, parsed.data.rawDbAccess)) return conflict("Ya existe una base de datos con esta cadena de conexión.");

      const { record, passwordToStore } = buildDatabaseRecordFromInput({
        clientId: client.id,
        clientName: client.name,
        domainId: domain.id,
        domainName: domain.domainName,
        companyName: parsed.data.companyName.trim(),
        environment: parsed.data.environment,
        rawDbAccess: parsed.data.rawDbAccess.trim(),
        assignedUpdaterIds: parsed.data.assignedUpdaterIds,
        notes: parsed.data.notes?.trim(),
        currentUser: user,
      });
      record.currentDbVersion = parsed.data.currentDbVersion;

      await keyVault.setSecret(record.dbAccess.passwordSecretName, passwordToStore);
      await getContainer("databases").items.create(record);
      await writeAuditLog({
        entityType: "database",
        entityId: record.id,
        clientId: client.id,
        clientName: client.name,
        domainId: domain.id,
        domainName: domain.domainName,
        companyName: record.companyName,
        action: "database_created",
        performedBy: user.id,
        performedByEmail: user.email,
        after: {
          companyName: record.companyName,
          serverHostPort: record.dbAccess.serverHostPort,
          initialCatalog: record.dbAccess.initialCatalog,
          userId: record.dbAccess.userId,
          environment: record.environment,
        },
      });

      // Crear la frecuencia asociada en la misma operación, si vino en el cuerpo.
      if (parsed.data.frequency) {
        try {
          const freq = parsed.data.frequency as FrequencyInput;
          validateFrequency(freq);
          const schedule = buildScheduleRecord({
            input: freq,
            clientId: client.id,
            clientName: client.name,
            domainId: domain.id,
            domainName: domain.domainName,
            targetType: "database",
            targetIds: [record.id],
            currentUser: user,
          });
          await getContainer("updateSchedules").items.create(schedule);
          await writeAuditLog({
            entityType: "schedule",
            entityId: schedule.id,
            clientId: client.id,
            clientName: client.name,
            domainId: domain.id,
            domainName: domain.domainName,
            companyName: record.companyName,
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

async function findDatabase(id: string): Promise<DatabaseRecord | null> {
  const { resources } = await getContainer("databases")
    .items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  return resources[0] ?? null;
}

async function findTask(id: string): Promise<UpdateTask | null> {
  const { resources } = await getContainer("updateTasks")
    .items.query<UpdateTask>({
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

app.http("databasesAccessInfo", {
  route: "databases/{id}/access-info",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");

      const taskId = req.query.get("taskId")?.trim();
      if (taskId) {
        const task = await findTask(taskId);
        if (!task || task.targetType !== "database" || task.targetId !== db.id) {
          return forbidden("No tienes permiso para ver esta conexión.");
        }
        if (!canAccessDatabaseTaskConnection(user, task)) {
          return forbidden("No tienes permiso para ver esta conexión.");
        }
        return ok(buildDatabaseAccessInfo(db));
      }

      if (!canRevealDatabaseSecret(user, db) && !canEditDatabaseLimited(user, db)) {
        return forbidden("No tienes permiso para ver esta conexión.");
      }
      return ok(buildDatabaseAccessInfo(db));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("databasesGet", {
  route: "databases/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      return ok(db);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("databasesUpdate", {
  route: "databases/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      if (!canEditDatabaseLimited(user, db)) return forbidden();
      const body = await req.json() as any;
      if (typeof body.rawDbAccess === "string" && body.rawDbAccess.trim() && canManageClients(user)) {
        const { resources: existingDatabases } = await getContainer("databases").items.readAll<DatabaseRecord>().fetchAll();
        if (hasDuplicateDatabaseConnection(existingDatabases, body.rawDbAccess, db.id)) return conflict("Ya existe una base de datos con esta cadena de conexión.");
      }
      const before = { ...db };
      const updated: DatabaseRecord = {
        ...db,
        ...(typeof body.companyName === "string" ? { companyName: body.companyName.trim() } : {}),
        ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
        ...(typeof body.currentDbVersion === "string" ? { currentDbVersion: body.currentDbVersion.trim() } : {}),
        ...(Array.isArray(body.assignedUpdaterIds) ? { assignedUpdaterIds: body.assignedUpdaterIds } : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes.trim() } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      if (typeof body.rawDbAccess === "string" && body.rawDbAccess.trim() && canManageClients(user)) {
        const parsed = parseDbAccessString(body.rawDbAccess);
        updated.dbAccess = { ...updated.dbAccess, serverHostPort: parsed.serverHostPort, initialCatalog: parsed.initialCatalog, userId: parsed.userId };
        await keyVault.setSecret(updated.dbAccess.passwordSecretName, parsed.password);
      }
      await getContainer("databases").item(db.id, db.clientId).replace(updated);
      await writeAuditLog({
        entityType: "database",
        entityId: db.id,
        clientId: db.clientId,
        clientName: db.clientName,
        domainId: db.domainId,
        domainName: db.domainName,
        companyName: updated.companyName,
        action: "database_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before: { ...before, dbAccess: { ...before.dbAccess, passwordSecretName: undefined } },
        after: { ...updated, dbAccess: { ...updated.dbAccess, passwordSecretName: undefined } },
      });
      return ok(updated);
    } catch (e) {
      return serverError(e);
    }
  },
});

async function setDbStatus(req: HttpRequest, action: "database_deactivated" | "database_reactivated", status: "inactive" | "active"): Promise<HttpResponseInit> {
  const user = await getUserOrFail(req);
  if (!canManageClients(user)) return forbidden();
  const db = await findDatabase(req.params.id);
  if (!db) return notFound("Base de datos no encontrada.");
  db.status = status;
  db.updatedAt = new Date().toISOString();
  db.updatedBy = user.id;
  await getContainer("databases").item(db.id, db.clientId).replace(db);
  const obsoletedTasks = status === "inactive"
    ? await cancelPendingTasksForDatabase(db.id, user, "target_database_inactive")
    : 0;
  await writeAuditLog({
    entityType: "database", entityId: db.id, clientId: db.clientId, clientName: db.clientName,
    domainId: db.domainId, domainName: db.domainName, companyName: db.companyName,
    action, performedBy: user.id, performedByEmail: user.email, metadata: { obsoletedTasks }, after: { status: db.status },
  });
  return ok(db);
}

app.http("databasesDeactivate", { route: "databases/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setDbStatus(req, "database_deactivated", "inactive").catch(serverError) });
app.http("databasesReactivate", { route: "databases/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setDbStatus(req, "database_reactivated", "active").catch(serverError) });

// Eliminación física con verificación de integridad: si tiene frecuencias
// asociadas (targetIds), no se puede eliminar.
app.http("databasesDelete", {
  route: "databases/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canManageClients(user)) return forbidden();
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      const cascade = req.query.get("cascade") === "true";
      const { resources: schedulesAsociadas } = await getContainer("updateSchedules").items
        .query<UpdateSchedule>({
          query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.targetIds, @t)",
          parameters: [{ name: "@t", value: db.id }],
        })
        .fetchAll();
      const { resources: tasks } = await getContainer("updateTasks").items
        .query<UpdateTask>({
          query: "SELECT * FROM c WHERE c.targetType = 'database' AND c.targetId = @t AND c.status NOT IN ('completed', 'cancelled')",
          parameters: [{ name: "@t", value: db.id }],
        })
        .fetchAll();
      const dependencies = { schedules: schedulesAsociadas.length, pendingTasks: tasks.length };
      if (!cascade && (dependencies.schedules > 0 || dependencies.pendingTasks > 0)) {
        return conflict("La base de datos tiene dependencias. Confirme eliminación en cascada.", { dependencies });
      }

      const schedContainer = getContainer("updateSchedules");
      let cascadaSchedules = 0;
      for (const s of schedulesAsociadas) {
        try {
          await schedContainer.item(s.id, s.clientId).delete();
          cascadaSchedules++;
          await writeAuditLog({
            entityType: "schedule", entityId: s.id, clientId: s.clientId, clientName: s.clientName,
            domainId: db.domainId, domainName: db.domainName,
            action: "schedule_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
            metadata: { cascadeFromDatabase: db.id }, before: s,
          });
        } catch {/* seguimos con las demás */}
      }
      const now = new Date().toISOString();
      const before = { ...db };
      const deleted = { ...db, status: "deleted" as const, deletedAt: now, deletedBy: user.id, updatedAt: now, updatedBy: user.id };
      await getContainer("databases").item(db.id, db.clientId).replace(deleted);
      const obsoletedTasks = await cancelPendingTasksForDatabase(db.id, user, "target_database_deleted");
      await writeAuditLog({
        entityType: "database", entityId: db.id, clientId: db.clientId, clientName: db.clientName,
        domainId: db.domainId, domainName: db.domainName, companyName: db.companyName,
        action: "database_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
        metadata: { ...dependencies, cascadeSchedules: cascadaSchedules, obsoletedTasks },
        before: { ...before, dbAccess: { ...before.dbAccess, passwordSecretName: undefined } },
        after: { status: "deleted" },
      });
      return ok({ ok: true, deleted: { ...dependencies, obsoletedTasks } });
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("databasesCopyAccessPart", {
  route: "databases/{id}/copy-access-part",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      const body = await req.json() as any;
      const part = String(body.part ?? "");
      const allowed = ["serverHostPort", "initialCatalog", "userId", "password"];
      if (!allowed.includes(part)) return badRequest("Parte no permitida.");

      if (part === "password") {
        if (!canRevealDatabaseSecret(user, db)) return forbidden("No tiene permisos para acceder a la contraseña.");
        const value = await keyVault.getSecret(db.dbAccess.passwordSecretName);
        await writeAuditLog({
          entityType: "database",
          entityId: db.id,
          clientId: db.clientId,
          clientName: db.clientName,
          domainId: db.domainId,
          domainName: db.domainName,
          companyName: db.companyName,
          action: "database_password_copied",
          performedBy: user.id,
          performedByEmail: user.email,
        });
        return ok({ part, value });
      }

      const value = (db.dbAccess as any)[part] as string;
      await writeAuditLog({
        entityType: "database",
        entityId: db.id,
        clientId: db.clientId,
        clientName: db.clientName,
        domainId: db.domainId,
        domainName: db.domainName,
        companyName: db.companyName,
        action: "database_access_part_copied",
        performedBy: user.id,
        performedByEmail: user.email,
        metadata: { part },
      });
      return ok({ part, value });
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("databasesRevealPassword", {
  route: "databases/{id}/reveal-password",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      const body = (await req.json().catch(() => ({}))) as any;
      let authorizedByTask = false;
      let taskId: string | undefined;
      if (typeof body.taskId === "string" && body.taskId.trim()) {
        const requestedTaskId = body.taskId.trim();
        taskId = requestedTaskId;
        const task = await findTask(requestedTaskId);
        authorizedByTask = !!task && task.targetType === "database" && task.targetId === db.id && canAccessDatabaseTaskConnection(user, task);
      }
      if (!authorizedByTask && !canRevealDatabaseSecret(user, db)) return forbidden("No tiene permisos para acceder a la contraseña.");
      const value = await keyVault.getSecret(db.dbAccess.passwordSecretName);
      const metadata: Record<string, string> = { databaseId: db.id, reason: typeof body.reason === "string" ? body.reason : "manual" };
      if (taskId) metadata.taskId = taskId;
      await writeAuditLog({
        entityType: "database",
        entityId: db.id,
        clientId: db.clientId,
        clientName: db.clientName,
        domainId: db.domainId,
        domainName: db.domainName,
        companyName: db.companyName,
        action: "database_password_revealed",
        performedBy: user.id,
        performedByEmail: user.email,
        metadata,
      });
      return ok({ password: value });
    } catch (e) {
      return serverError(e);
    }
  },
});
