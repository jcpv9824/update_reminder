import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { appendSqlAuditLog } from "../lib/auditSqlWriter";
import { getContainer } from "../lib/cosmos";
import { getDataBackend } from "../lib/dataBackend";
import { cancelPendingTasksForDatabase } from "../lib/taskCleanup";
import * as keyVault from "../lib/keyVault";
import { buildDatabaseRecordFromInput } from "../lib/databaseService";
import { buildDatabaseAccessInfo } from "../lib/databaseAccessInfo";
import { parseDbAccessString } from "../lib/dbAccessParser";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canCopyDatabaseConnectionPart,
  canCreateDatabase,
  canDeactivateDatabase,
  canDeleteDatabase,
  canEditDatabase,
  canReactivateDatabase,
  canRevealDatabasePassword,
  canViewDatabaseConnection,
  canViewDatabases,
} from "../lib/managementAccess";
import { getPagination, paginateArray, type PageResult } from "../lib/pagination";
import { matchesDatabaseSearch } from "../lib/listSearch";
import { hasDuplicateDatabaseConnection } from "../lib/duplicateValidation";
import { isAllowedEnvironment } from "../lib/environments";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { canPerformTaskActionWithRoleDefinitions } from "../lib/taskAccess";
import { toPublicDatabase } from "../lib/publicDtos";
import { readSqlPublicDatabases, readSqlRestrictedDatabase, type DatabaseFilters, type PublicDatabaseDto } from "../lib/coreMastersSqlRepository";
import { createSqlDatabaseWithSecret, updateSqlDatabaseWithSecret } from "../lib/databasesSqlService";
import { setSqlDatabaseStatus } from "../lib/databasesSqlWriteRepository";
import { readSqlWorkflowTasks } from "../lib/workflowTasksSqlRepository";
import { deleteSqlCoreCascade } from "../lib/coreCascadeSqlRepository";
import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

function resultCount<T>(result: T[] | PageResult<T>): number {
  return Array.isArray(result) ? result.length : result.total;
}

const DbCreateSchema = z.object({
  clientId: z.string().min(1),
  domainId: z.string().min(1),
  companyName: z.string().min(1, "El nombre de la empresa es obligatorio."),
  environment: z.string().refine(isAllowedEnvironment, "El ambiente debe ser Producción, Pruebas o Demo."),
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
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewDatabases(user, roleDefinitions)) return forbidden();
      const clientId = req.query.get("clientId");
      const domainId = req.query.get("domainId");
      const status = req.query.get("status");
      const env = req.query.get("environment");
      const search = req.query.get("search");
      const includeDeleted = req.query.get("includeDeleted") === "true";
      const canReadDeleted = canDeleteDatabase(user, roleDefinitions) || canReactivateDatabase(user, roleDefinitions);
      const pagination = getPagination(req);
      const sqlFilters: DatabaseFilters = {
        clientId: clientId ?? undefined,
        domainId: domainId ?? undefined,
        status: status ?? undefined,
        environment: env ?? undefined,
        search: search?.trim().toLowerCase() || undefined,
        visibility: !canReadDeleted || (!includeDeleted && !status) ? "not-deleted" : "all",
      };
      const backend = getDataBackend();
      if (backend === "sql") return ok(await readSqlPublicDatabases(sqlFilters, pagination));
      const container = getContainer("databases");
      const querySpec = clientId
        ? { query: "SELECT * FROM c WHERE c.clientId = @c", parameters: [{ name: "@c", value: clientId }] }
        : { query: "SELECT * FROM c" };
      const { resources } = await container.items.query<DatabaseRecord>(querySpec).fetchAll();
      let items = resources;
      if (!canReadDeleted) items = items.filter((d) => d.status !== "deleted");
      if (!includeDeleted && !status) items = items.filter((d) => d.status !== "deleted");
      if (domainId) items = items.filter((d) => d.domainId === domainId);
      if (status) items = items.filter((d) => d.status === status);
      if (env) items = items.filter((d) => d.environment === env);
      if (search) items = items.filter((d) => matchesDatabaseSearch(d, search));
      const publicItems = items.map(toPublicDatabase);
      const primary: PublicDatabaseDto[] | PageResult<PublicDatabaseDto> = pagination.enabled
        ? paginateArray(publicItems, pagination.page, pagination.pageSize)
        : publicItems;
      if (backend === "dual-read") {
        const shadow = await readSqlPublicDatabases(sqlFilters, pagination);
        if (resultCount(primary) !== resultCount(shadow)) console.warn("Databases dual-read parity mismatch.");
      }
      return ok(primary);
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
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateDatabase(user, roleDefinitions)) return forbidden();
      const body = await req.json();
      const parsed = DbCreateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (!isAllowedEnvironment(parsed.data.environment)) return badRequest("El ambiente debe ser Producción, Pruebas o Demo.");

      try {
        parseDbAccessString(parsed.data.rawDbAccess);
      } catch (e: any) {
        return badRequest(e.message ?? "Cadena de acceso inválida.");
      }
      if (getDataBackend() === "sql") {
        const record = await createSqlDatabaseWithSecret({
          clientId: parsed.data.clientId,
          clientName: "",
          domainId: parsed.data.domainId,
          domainName: "",
          companyName: parsed.data.companyName.trim(),
          environment: parsed.data.environment,
          rawDbAccess: parsed.data.rawDbAccess.trim(),
          assignedUpdaterIds: parsed.data.assignedUpdaterIds,
          notes: parsed.data.notes?.trim(),
          currentDbVersion: parsed.data.currentDbVersion,
          currentUser: user,
        }, { id: user.id, email: user.email });
        return created(toPublicDatabase(record));
      }
      const { resource: client } = await getContainer("clients").item(parsed.data.clientId, parsed.data.clientId).read<ClientRecord>();
      if (!client) return badRequest("Cliente no encontrado.");
      const { resources: domains } = await getContainer("domains")
        .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: parsed.data.domainId }] })
        .fetchAll();
      if (!domains.length) return badRequest("Dominio no encontrado.");
      const domain = domains[0];
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

      // Las bases ya no crean frecuencias embebidas. Las tareas de bases se
      // programan desde "Actualizaciones programadas" con alcance explícito.
      return created(toPublicDatabase(record));
    } catch (e) {
      return serverError(e);
    }
  },
});

async function findDatabase(id: string): Promise<DatabaseRecord | null> {
  const backend = getDataBackend();
  if (backend === "sql") return readSqlRestrictedDatabase(id);
  const { resources } = await getContainer("databases")
    .items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  if (backend === "dual-read") {
    const shadow = await readSqlRestrictedDatabase(id);
    if (Boolean(resources[0]) !== Boolean(shadow)) console.warn("Database detail dual-read parity mismatch.");
  }
  return resources[0] ?? null;
}

async function findTask(id: string): Promise<UpdateTask | null> {
  if (getDataBackend() === "sql") {
    const today = new Date().toISOString().slice(0, 10);
    return (await readSqlWorkflowTasks({ sourceId: id, today, operationalOnly: false }))[0] ?? null;
  }
  const { resources } = await getContainer("updateTasks")
    .items.query<UpdateTask>({
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

function canUseDatabaseTaskAction(
  user: Awaited<ReturnType<typeof getUserOrFail>>,
  db: DatabaseRecord,
  task: UpdateTask | null,
  actionId: "view_database_connection" | "copy_database_connection_part" | "reveal_database_password",
  roleDefinitions: Parameters<typeof canPerformTaskActionWithRoleDefinitions>[3]
): boolean {
  return !!task
    && task.targetType === "database"
    && task.targetId === db.id
    && canPerformTaskActionWithRoleDefinitions(user, task, actionId, roleDefinitions);
}

app.http("databasesAccessInfo", {
  route: "databases/{id}/access-info",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");

      const taskId = req.query.get("taskId")?.trim();
      let task: UpdateTask | null = null;
      if (taskId) {
        task = await findTask(taskId);
      }
      if (!canViewDatabaseConnection(user, roleDefinitions) && !canUseDatabaseTaskAction(user, db, task, "view_database_connection", roleDefinitions)) {
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
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewDatabases(user, roleDefinitions)) return forbidden();
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      if (db.status === "deleted" && !canDeleteDatabase(user, roleDefinitions) && !canReactivateDatabase(user, roleDefinitions)) return forbidden("No tiene permisos para consultar esta base de datos.");
      return ok(toPublicDatabase(db));
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
      const roleDefinitions = await loadRoleDefinitions();
      if (!canEditDatabase(user, roleDefinitions)) return forbidden();
      const body = await req.json() as any;
      if (typeof body.environment === "string" && !isAllowedEnvironment(body.environment)) return badRequest("El ambiente debe ser Producción, Pruebas o Demo.");
      if (typeof body.rawDbAccess === "string" && body.rawDbAccess.trim()) {
        try {
          parseDbAccessString(body.rawDbAccess);
        } catch (e: any) {
          return badRequest(e.message ?? "Cadena de acceso inválida.");
        }
      }
      if (getDataBackend() === "sql") {
        const updated = await updateSqlDatabaseWithSecret(req.params.id, {
          ...(typeof body.companyName === "string" ? { companyName: body.companyName } : {}),
          ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
          ...(typeof body.currentDbVersion === "string" ? { currentDbVersion: body.currentDbVersion } : {}),
          ...(Array.isArray(body.assignedUpdaterIds) ? { assignedUpdaterIds: body.assignedUpdaterIds } : {}),
          ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
          ...(typeof body.rawDbAccess === "string" && body.rawDbAccess.trim() ? { rawDbAccess: body.rawDbAccess } : {}),
        }, { id: user.id, email: user.email });
        return updated ? ok(toPublicDatabase(updated)) : notFound("Base de datos no encontrada.");
      }
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      if (typeof body.rawDbAccess === "string" && body.rawDbAccess.trim()) {
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
      if (typeof body.rawDbAccess === "string" && body.rawDbAccess.trim()) {
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
      return ok(toPublicDatabase(updated));
    } catch (e) {
      return serverError(e);
    }
  },
});

async function setDbStatus(req: HttpRequest, action: "database_deactivated" | "database_reactivated", status: "inactive" | "active"): Promise<HttpResponseInit> {
  const user = await getUserOrFail(req);
  const roleDefinitions = await loadRoleDefinitions();
  const allowed = status === "active" ? canReactivateDatabase(user, roleDefinitions) : canDeactivateDatabase(user, roleDefinitions);
  if (!allowed) return forbidden();
  if (getDataBackend() === "sql") {
    const result = await setSqlDatabaseStatus(
      req.params.id,
      status,
      action,
      { id: user.id, email: user.email },
      status === "inactive" ? "target_database_inactive" : undefined,
    );
    return result ? ok(toPublicDatabase(result.record)) : notFound("Base de datos no encontrada.");
  }
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
  return ok(toPublicDatabase(db));
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
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeleteDatabase(user, roleDefinitions)) return forbidden();
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      const cascade = req.query.get("cascade") === "true";
      if (getDataBackend() === "sql") {
        const result = await deleteSqlCoreCascade("database", db.id, cascade, { id: user.id, email: user.email });
        if (!result.found) return notFound("Base de datos no encontrada.");
        if (result.requiresCascade) return conflict("La base de datos tiene dependencias. Confirme eliminación en cascada.", { dependencies: result.dependencies });
        return ok({ ok: true, deleted: { ...result.dependencies, obsoletedTasks: result.obsoletedTasks, cascadeSchedules: result.cascadeSchedules } });
      }
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
      const roleDefinitions = await loadRoleDefinitions();
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      const body = await req.json() as any;
      const part = String(body.part ?? "");
      const allowed = ["serverHostPort", "initialCatalog", "userId", "password"];
      if (!allowed.includes(part)) return badRequest("Parte no permitida.");

      const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
      const task = taskId ? await findTask(taskId) : null;
      const canCopyFromTask = canUseDatabaseTaskAction(user, db, task, "copy_database_connection_part", roleDefinitions);
      const canRevealFromTask = canUseDatabaseTaskAction(user, db, task, "reveal_database_password", roleDefinitions);

      if (part === "password") {
        if (!canRevealDatabasePassword(user, roleDefinitions) && !canRevealFromTask) return forbidden("No tiene permisos para acceder a la contraseña.");
        const value = await keyVault.getSecret(db.dbAccess.passwordSecretName);
        const audit = {
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
        } as const;
        if (getDataBackend() === "sql") await appendSqlAuditLog(audit);
        else await writeAuditLog(audit);
        return ok({ part, value });
      }
      if (!canCopyDatabaseConnectionPart(user, roleDefinitions) && !canCopyFromTask) return forbidden("No tiene permisos para acceder a esta conexión.");

      const value = (db.dbAccess as any)[part] as string;
      const audit = {
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
      } as const;
      if (getDataBackend() === "sql") await appendSqlAuditLog(audit);
      else await writeAuditLog(audit);
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
      const roleDefinitions = await loadRoleDefinitions();
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      const body = (await req.json().catch(() => ({}))) as any;
      let task: UpdateTask | null = null;
      let taskId: string | undefined;
      if (typeof body.taskId === "string" && body.taskId.trim()) {
        const requestedTaskId = body.taskId.trim();
        taskId = requestedTaskId;
        task = await findTask(requestedTaskId);
      }
      if (!canRevealDatabasePassword(user, roleDefinitions) && !canUseDatabaseTaskAction(user, db, task, "reveal_database_password", roleDefinitions)) return forbidden("No tiene permisos para acceder a la contraseña.");
      const value = await keyVault.getSecret(db.dbAccess.passwordSecretName);
      const metadata: Record<string, string> = { databaseId: db.id, reason: typeof body.reason === "string" ? body.reason : "manual" };
      if (taskId) metadata.taskId = taskId;
      const audit = {
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
      } as const;
      if (getDataBackend() === "sql") await appendSqlAuditLog(audit);
      else await writeAuditLog(audit);
      return ok({ password: value });
    } catch (e) {
      return serverError(e);
    }
  },
});
