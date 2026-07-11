import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, conflict, created, forbidden, noContent, notFound, ok, serverError } from "../lib/http";
import { DEFAULT_ROLE_DEFINITIONS } from "../lib/permissionModel";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import {
  createRoleDefinitionRecord,
  updateRoleDefinitionRecord,
  type RoleDefinitionRecord,
} from "../lib/roleDefinitions";
import { canCreateRoleDefinition, canEditRoleDefinition, canListRoleDefinitions } from "../lib/managementAccess";
import { canDeleteRoleDefinition } from "../lib/managementAccess";
import { roleUsageMessage, roleUsageSummary } from "../lib/roleLifecycle";
import type { UpdateSchedule, UpdateTask, UserRecord } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

async function readStoredRoleRecords(): Promise<RoleDefinitionRecord[]> {
  const { resources } = await getContainer("roles").items.readAll<RoleDefinitionRecord>().fetchAll();
  return resources;
}

function defaultRoleById(id: string) {
  return DEFAULT_ROLE_DEFINITIONS.find((role) => role.id === id);
}

async function getRoleUsage(roleId: string) {
  const [users, schedules, tasks] = await Promise.all([
    getContainer("users").items.readAll<UserRecord>().fetchAll(),
    getContainer("updateSchedules").items.readAll<UpdateSchedule>().fetchAll(),
    getContainer("updateTasks").items.readAll<UpdateTask>().fetchAll(),
  ]);
  return roleUsageSummary(roleId, users.resources, schedules.resources, tasks.resources);
}

app.http("rolesList", {
  route: "roles",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canListRoleDefinitions(user)) return forbidden();
      return ok(await loadRoleDefinitions());
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("rolesCreate", {
  route: "roles",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateRoleDefinition(user, roleDefinitions)) return forbidden();

      let record: RoleDefinitionRecord;
      try {
        record = createRoleDefinitionRecord(await req.json(), user, new Date().toISOString());
      } catch (error: any) {
        return badRequest(error?.message ?? "Rol no válido.");
      }

      const stored = await readStoredRoleRecords();
      if (defaultRoleById(record.id) || stored.some((role) => role.id === record.id)) {
        return badRequest("Ya existe un rol con ese ID.");
      }

      await getContainer("roles").items.create(record);
      await writeAuditLog({
        entityType: "role",
        entityId: record.id,
        action: "role_created",
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

app.http("rolesUpdate", {
  route: "roles/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canEditRoleDefinition(user, roleDefinitions)) return forbidden();

      const id = req.params.id;
      const container = getContainer("roles");
      const stored = await readStoredRoleRecords();
      const existing = stored.find((role) => role.id === id) ?? defaultRoleById(id);
      if (!existing) return notFound("Rol no encontrado.");

      let updated: RoleDefinitionRecord;
      try {
        updated = updateRoleDefinitionRecord(existing, await req.json(), user, new Date().toISOString());
      } catch (error: any) {
        return badRequest(error?.message ?? "Rol no válido.");
      }

      if (existing.active !== false && updated.active === false) {
        const usage = await getRoleUsage(updated.id);
        if (usage.hasReferences) return conflict(roleUsageMessage(usage), usage);
      }

      await container.items.upsert(updated);
      await writeAuditLog({
        entityType: "role",
        entityId: updated.id,
        action: "role_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before: existing,
        after: updated,
      });
      return ok(updated);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("rolesDelete", {
  route: "roles/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeleteRoleDefinition(user, roleDefinitions)) return forbidden();

      const id = req.params.id;
      if (defaultRoleById(id)) return badRequest("Los roles predeterminados no se eliminan; puede editar su configuración o desactivarlos cuando no tengan referencias.");

      const stored = await readStoredRoleRecords();
      const existing = stored.find((role) => role.id === id);
      if (!existing) return notFound("Rol no encontrado.");

      const usage = await getRoleUsage(id);
      if (usage.hasReferences) return conflict(roleUsageMessage(usage), usage);

      await getContainer("roles").item(id, id).delete();
      await writeAuditLog({
        entityType: "role",
        entityId: id,
        action: "role_deleted",
        performedBy: user.id,
        performedByEmail: user.email,
        before: existing,
      });
      return noContent();
    } catch (e) {
      return serverError(e);
    }
  },
});
