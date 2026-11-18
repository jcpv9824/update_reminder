import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { appendSqlAuditLog } from "../lib/auditSqlWriter";
import * as keyVault from "../lib/keyVault";
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
import { getPagination } from "../lib/pagination";
import { isAllowedEnvironment } from "../lib/environments";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { canPerformTaskActionWithRoleDefinitions } from "../lib/taskAccess";
import { toPublicDatabase } from "../lib/publicDtos";
import { readSqlPublicDatabases, readSqlRestrictedDatabase, type DatabaseFilters } from "../lib/coreMastersSqlRepository";
import { createSqlDatabaseWithSecret, updateSqlDatabaseWithSecret } from "../lib/databasesSqlService";
import { setSqlDatabaseStatus } from "../lib/databasesSqlWriteRepository";
import { readSqlWorkflowTasks } from "../lib/workflowTasksSqlRepository";
import { deleteSqlCoreCascade } from "../lib/coreCascadeSqlRepository";
import type { DatabaseRecord, UpdateTask } from "../types/models";
import { readAuditedTaskDatabaseConnection } from "../lib/catalogTaskDatabaseConnection";
import { catalogMasterReadOnly, catalogOwnsOperationalMasters } from "../lib/catalogMasterOwnership";

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
      return ok(await readSqlPublicDatabases(sqlFilters, pagination));
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
      if (catalogOwnsOperationalMasters()) return catalogMasterReadOnly("bases de datos");
      const body = await req.json();
      const parsed = DbCreateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (!isAllowedEnvironment(parsed.data.environment)) return badRequest("El ambiente debe ser Producción, Pruebas o Demo.");

      try {
        parseDbAccessString(parsed.data.rawDbAccess);
      } catch (e: any) {
        return badRequest(e.message ?? "Cadena de acceso inválida.");
      }
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
    } catch (e) {
      return serverError(e);
    }
  },
});

async function findDatabase(id: string): Promise<DatabaseRecord | null> {
  return readSqlRestrictedDatabase(id);
}

async function findTask(id: string): Promise<UpdateTask | null> {
  const today = new Date().toISOString().slice(0, 10);
  // Historical or shared catalog tasks are not grants via this legacy lookup.
  return (await readSqlWorkflowTasks({ sourceId: id, today, operationalOnly: false, legacyOnly: true }))[0] ?? null;
}

const catalogTaskAccessOn = (): boolean => process.env.PORTAL_CATALOG_READ_ENABLED?.trim() === "true";
const confidentialHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const privateResponse = (response: HttpResponseInit): HttpResponseInit => ({ ...response, headers: confidentialHeaders });
const taskIdSchema = z.string().min(1).max(260).refine(value => value === value.trim() && !/\p{C}/u.test(value));
const databaseIdSchema = taskIdSchema.refine(value => value.length <= 150);
const copyPartSchema = z.enum(["serverHostPort", "initialCatalog", "userId", "password"]);
type TaskConnectionAction = Parameters<typeof readAuditedTaskDatabaseConnection>[0]["action"];

async function catalogTaskConnection(req: HttpRequest, actor: Awaited<ReturnType<typeof getUserOrFail>>, rawTask: unknown,
  action: TaskConnectionAction): Promise<HttpResponseInit> {
  const task = taskIdSchema.safeParse(rawTask);
  const database = databaseIdSchema.safeParse(req.params.id);
  if (!task.success || !database.success) return privateResponse(forbidden("Se requiere una tarea activa asignada para consultar esta conexión."));
  const environment = process.env.PORTAL_SAG_ENVIRONMENT?.trim();
  if (environment !== "qa" && environment !== "production") return catalogTaskConnectionError();
  const value = await readAuditedTaskDatabaseConnection({ taskId: task.data, databaseId: database.data, actor, environment, action });
  if (!value) return privateResponse(forbidden("No tienes permiso para consultar esta conexión desde la tarea."));
  if (value.kind === "password") return { status: 200, body: value.value,
    headers: { ...confidentialHeaders, "Content-Type": "text/plain; charset=utf-8" } };
  return privateResponse(ok(value.kind === "info" ? value.info : { part: value.part, value: value.value }));
}

function catalogTaskConnectionError(error?: unknown): HttpResponseInit {
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  return privateResponse({ status: status === 401 || status === 403 ? status : 503,
    jsonBody: { error: "No se pudo consultar la conexión de la tarea." } });
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
      if (catalogTaskAccessOn()) return await catalogTaskConnection(req, user, req.query.get("taskId"), { kind: "view" });
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
      return catalogTaskAccessOn() ? catalogTaskConnectionError(e) : serverError(e);
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
      if (catalogOwnsOperationalMasters()) return catalogMasterReadOnly("bases de datos");
      const body = await req.json() as any;
      if (typeof body.environment === "string" && !isAllowedEnvironment(body.environment)) return badRequest("El ambiente debe ser Producción, Pruebas o Demo.");
      if (typeof body.rawDbAccess === "string" && body.rawDbAccess.trim()) {
        try {
          parseDbAccessString(body.rawDbAccess);
        } catch (e: any) {
          return badRequest(e.message ?? "Cadena de acceso inválida.");
        }
      }
      const updated = await updateSqlDatabaseWithSecret(req.params.id, {
        ...(typeof body.companyName === "string" ? { companyName: body.companyName } : {}),
        ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
        ...(typeof body.currentDbVersion === "string" ? { currentDbVersion: body.currentDbVersion } : {}),
        ...(Array.isArray(body.assignedUpdaterIds) ? { assignedUpdaterIds: body.assignedUpdaterIds } : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        ...(typeof body.rawDbAccess === "string" && body.rawDbAccess.trim() ? { rawDbAccess: body.rawDbAccess } : {}),
      }, { id: user.id, email: user.email });
      return updated ? ok(toPublicDatabase(updated)) : notFound("Base de datos no encontrada.");
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
  if (catalogOwnsOperationalMasters()) return catalogMasterReadOnly("bases de datos");
  const result = await setSqlDatabaseStatus(
    req.params.id,
    status,
    action,
    { id: user.id, email: user.email },
    status === "inactive" ? "target_database_inactive" : undefined,
  );
  return result ? ok(toPublicDatabase(result.record)) : notFound("Base de datos no encontrada.");
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
      if (catalogOwnsOperationalMasters()) return catalogMasterReadOnly("bases de datos");
      const db = await findDatabase(req.params.id);
      if (!db) return notFound("Base de datos no encontrada.");
      const cascade = req.query.get("cascade") === "true";
      const result = await deleteSqlCoreCascade("database", db.id, cascade, { id: user.id, email: user.email });
      if (!result.found) return notFound("Base de datos no encontrada.");
      if (result.requiresCascade) return conflict("La base de datos tiene dependencias. Confirme eliminación en cascada.", { dependencies: result.dependencies });
      return ok({ ok: true, deleted: { ...result.dependencies, obsoletedTasks: result.obsoletedTasks, cascadeSchedules: result.cascadeSchedules } });
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
      if (catalogTaskAccessOn()) {
        const parsed = z.object({ taskId: taskIdSchema, part: copyPartSchema }).strict().safeParse(await req.json().catch(() => null));
        if (!parsed.success) return privateResponse(badRequest("Se requiere una tarea y una parte válida de la conexión."));
        return await catalogTaskConnection(req, user, parsed.data.taskId, { kind: "copy", part: parsed.data.part });
      }
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
        await appendSqlAuditLog(audit);
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
      await appendSqlAuditLog(audit);
      return ok({ part, value });
    } catch (e) {
      return catalogTaskAccessOn() ? catalogTaskConnectionError(e) : serverError(e);
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
      if (catalogTaskAccessOn()) {
        const parsed = z.object({ taskId: taskIdSchema, reason: z.enum(["task_detail", "task_detail_copy"]).optional() }).strict()
          .safeParse(await req.json().catch(() => null));
        if (!parsed.success) return privateResponse(badRequest("Se requiere una tarea válida."));
        return await catalogTaskConnection(req, user, parsed.data.taskId, { kind: "reveal" });
      }
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
      await appendSqlAuditLog(audit);
      return ok({ password: value });
    } catch (e) {
      return catalogTaskAccessOn() ? catalogTaskConnectionError(e) : serverError(e);
    }
  },
});
