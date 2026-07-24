import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canCreateLicense,
  canDeactivateLicense,
  canDeleteLicense,
  canEditLicense,
  canReactivateLicense,
  canViewLicensingOption,
} from "../lib/managementAccess";
import { getPagination } from "../lib/pagination";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { readSqlLicenseAssignments, readSqlLicenseModules } from "../lib/licensingSqlRepository";
import {
  createSqlLicenseAssignment,
  createSqlLicenseModule,
  deleteSqlLicenseAssignment,
  deleteSqlLicenseModule,
  findSqlLicenseAssignment,
  findSqlLicenseModule,
  updateSqlLicenseAssignment,
  updateSqlLicenseModule,
} from "../lib/licensingSqlWriteRepository";
import type { CurrentUser } from "../types/models";

const ModuleSchema = z.object({
  name: z.string().trim().min(1, "El nombre del módulo es obligatorio.").max(200),
  code: z.string().trim().max(80).optional().default(""),
  description: z.string().trim().max(2000).optional().default(""),
  status: z.enum(["active", "inactive", "deleted"]).optional().default("active"),
});

const AssignmentSchema = z.object({
  moduleId: z.string().min(1, "Seleccione un módulo."),
  targetType: z.enum(["client", "domain", "database"]),
  clientId: z.string().min(1, "Seleccione un cliente."),
  domainId: z.string().optional(),
  databaseId: z.string().optional(),
  environment: z.enum(["all", "production", "test", "demo"]).optional().default("all"),
  status: z.enum(["active", "inactive", "deleted"]).optional().default("active"),
});

async function getUserOrFail(req: HttpRequest): Promise<CurrentUser> {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

app.http("licenseModulesList", {
  route: "license-modules",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewLicensingOption(user, roleDefinitions)) return forbidden("No tiene permisos para ver licenciamiento.");
      const includeDeleted = req.query.get("includeDeleted") === "true";
      const search = req.query.get("search");
      const pagination = getPagination(req);
      const sqlFilters = { includeDeleted, search: search?.trim().toLowerCase() || undefined };
      return ok(await readSqlLicenseModules(sqlFilters, pagination));
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});

app.http("licenseModulesCreate", {
  route: "license-modules",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateLicense(user, roleDefinitions)) return forbidden("No tiene permisos para crear licencias.");
      const parsed = ModuleSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const record = await createSqlLicenseModule(`license_module_${randomUUID()}`, parsed.data, {
        id: user.id, email: user.email,
      });
      return created(record);
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});

app.http("licenseModulesUpdate", {
  route: "license-modules/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canEditLicense(user, roleDefinitions)) return forbidden("No tiene permisos para editar licencias.");
      const id = req.params.id;
      const current = await findSqlLicenseModule(id);
      if (!current || current.status === "deleted" || current.deletedAt) return notFound("Licencia o módulo no encontrado.");
      const parsed = ModuleSchema.partial().safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.status === "inactive" && current.status !== "inactive" && !canDeactivateLicense(user, roleDefinitions)) return forbidden("No tiene permisos para desactivar licencias.");
      if (parsed.data.status === "active" && current.status !== "active" && !canReactivateLicense(user, roleDefinitions)) return forbidden("No tiene permisos para reactivar licencias.");
      const updated = await updateSqlLicenseModule(id, parsed.data, { id: user.id, email: user.email });
      return updated ? ok(updated) : notFound("Licencia o módulo no encontrado.");
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});

app.http("licenseModulesDelete", {
  route: "license-modules/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeleteLicense(user, roleDefinitions)) return forbidden("No tiene permisos para eliminar licencias.");
      const id = req.params.id;
      const result = await deleteSqlLicenseModule(id, { id: user.id, email: user.email });
      if (!result.found) return notFound("Licencia o módulo no encontrado.");
      if (!result.deleted) {
        return conflict("No se puede eliminar esta licencia porque tiene asignaciones activas.", {
          dependencies: {
            assignments: result.dependencies.reduce((sum, client) => sum + Number(client.assignments), 0),
            clients: result.dependencies,
          },
          detail: "Quite primero las asignaciones activas de estos clientes y luego intente eliminar la licencia nuevamente.",
        });
      }
      return ok({ ok: true, deleted: true });
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});

app.http("licenseAssignmentsList", {
  route: "license-assignments",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewLicensingOption(user, roleDefinitions)) return forbidden("No tiene permisos para ver licenciamiento.");
      const includeDeleted = req.query.get("includeDeleted") === "true";
      const pagination = getPagination(req);
      return ok(await readSqlLicenseAssignments(includeDeleted, pagination));
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});

app.http("licenseAssignmentsCreate", {
  route: "license-assignments",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateLicense(user, roleDefinitions)) return forbidden("No tiene permisos para crear asignaciones.");
      const parsed = AssignmentSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const record = await createSqlLicenseAssignment(`license_assignment_${randomUUID()}`, parsed.data, {
        id: user.id, email: user.email,
      });
      return created(record);
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});

app.http("licenseAssignmentsUpdate", {
  route: "license-assignments/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canEditLicense(user, roleDefinitions)) return forbidden("No tiene permisos para editar asignaciones.");
      const id = req.params.id;
      const current = await findSqlLicenseAssignment(id);
      if (!current || current.status === "deleted" || current.deletedAt) return notFound("Asignación no encontrada.");
      const parsed = AssignmentSchema.partial().safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.status === "inactive" && current.status !== "inactive" && !canDeactivateLicense(user, roleDefinitions)) return forbidden("No tiene permisos para desactivar asignaciones.");
      if (parsed.data.status === "active" && current.status !== "active" && !canReactivateLicense(user, roleDefinitions)) return forbidden("No tiene permisos para reactivar asignaciones.");
      const updated = await updateSqlLicenseAssignment(id, parsed.data, { id: user.id, email: user.email });
      return updated ? ok(updated) : notFound("Asignación no encontrada.");
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});

app.http("licenseAssignmentsDelete", {
  route: "license-assignments/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeleteLicense(user, roleDefinitions)) return forbidden("No tiene permisos para eliminar asignaciones.");
      const deleted = await deleteSqlLicenseAssignment(req.params.id, { id: user.id, email: user.email });
      return deleted ? ok({ ok: true, deleted: true }) : notFound("Asignación no encontrada.");
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});
