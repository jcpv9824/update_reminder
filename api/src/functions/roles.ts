import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
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
import { roleUsageMessage } from "../lib/roleLifecycle";
import {
  createSqlRole,
  deleteSqlRole,
  getSqlRoleUsage,
  updateSqlRole,
} from "../lib/securityManagementSqlWriteRepository";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

function defaultRoleById(id: string) {
  return DEFAULT_ROLE_DEFINITIONS.find((role) => role.id === id);
}

async function getRoleUsage(roleId: string) {
  return getSqlRoleUsage(roleId);
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

      try {
        return created(await createSqlRole(record, { id: user.id, email: user.email }));
      } catch (error: any) {
        if (error?.status === 409) return conflict(error.message);
        if (error?.status === 400) return badRequest(error.message);
        throw error;
      }
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
      const existing = roleDefinitions.find((role) => role.id === id);
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

      try {
        const result = await updateSqlRole(updated, { id: user.id, email: user.email });
        return result ? ok(result) : notFound("Rol no encontrado.");
      } catch (error: any) {
        if (error?.status === 400) return badRequest(error.message);
        throw error;
      }
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

      const existing = roleDefinitions.find((role) => role.id === id);
      if (!existing) return notFound("Rol no encontrado.");

      const usage = await getRoleUsage(id);
      if (usage.hasReferences) return conflict(roleUsageMessage(usage), usage);

      try {
        const deleted = await deleteSqlRole(id, { id: user.id, email: user.email });
        return deleted ? noContent() : notFound("Rol no encontrado.");
      } catch (error: any) {
        if (error?.status === 409) return conflict(roleUsageMessage(error.usage), error.usage);
        if (error?.status === 400) return badRequest(error.message);
        throw error;
      }
    } catch (e) {
      return serverError(e);
    }
  },
});
