import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { summarizeLicenseDeleteDependencies } from "../lib/licenseDeletion";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canManageLicenseAssignments,
  canManageLicenseModules,
  canViewLicensing,
  buildUniqueLicenseCode,
  generateLicenseCodeFromName,
  hasDuplicateLicenseCode,
  normalizeLicenseCode,
  validateLicenseAssignmentRequirements,
} from "../lib/licenseRules";
import type {
  ClientRecord,
  CurrentUser,
  DatabaseRecord,
  DomainRecord,
  LicenseAssignmentRecord,
  LicenseModuleRecord,
} from "../types/models";

const ModuleSchema = z.object({
  name: z.string().min(1, "El nombre del módulo es obligatorio.").max(200),
  code: z.string().max(80).optional().default(""),
  description: z.string().max(2000).optional().default(""),
  status: z.enum(["active", "inactive", "deleted"]).optional().default("active"),
});

const AssignmentSchema = z.object({
  moduleId: z.string().min(1, "Seleccione un módulo."),
  targetType: z.enum(["client", "domain", "database"]),
  clientId: z.string().min(1, "Seleccione un cliente."),
  domainId: z.string().optional(),
  databaseId: z.string().optional(),
  environment: z.string().optional().default("all"),
  status: z.enum(["active", "inactive", "deleted"]).optional().default("active"),
});

async function getUserOrFail(req: HttpRequest): Promise<CurrentUser> {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

async function getLicensingViewer(req: HttpRequest): Promise<CurrentUser> {
  const user = await getUserOrFail(req);
  if (!canViewLicensing(user)) throw Object.assign(new Error("No tiene permisos para ver licenciamiento."), { status: 403 });
  return user;
}

async function getAssignmentManager(req: HttpRequest): Promise<CurrentUser> {
  const user = await getLicensingViewer(req);
  if (!canManageLicenseAssignments(user)) throw Object.assign(new Error("No tiene permisos para administrar asignaciones."), { status: 403 });
  return user;
}

async function getModuleManager(req: HttpRequest): Promise<CurrentUser> {
  const user = await getUserOrFail(req);
  if (!canManageLicenseModules(user)) throw Object.assign(new Error("Solo administradores pueden administrar módulos de licencia."), { status: 403 });
  return user;
}

async function nextModuleCode(name: string, code?: string, excludeId?: string): Promise<string | HttpResponseInit> {
  const { resources } = await getContainer("licenseModules").items.readAll<LicenseModuleRecord>().fetchAll();
  if (code?.trim()) {
    const normalized = normalizeLicenseCode(code);
    if (hasDuplicateLicenseCode(resources, normalized, excludeId)) return conflict("Ya existe un módulo con ese código.");
    return normalized;
  }
  return buildUniqueLicenseCode(resources, generateLicenseCodeFromName(name), excludeId);
}

async function findModule(id: string): Promise<LicenseModuleRecord | null> {
  const { resource } = await getContainer("licenseModules").item(id, id).read<LicenseModuleRecord>();
  return resource ?? null;
}

function isHttpResponse(value: LicenseAssignmentRecord | HttpResponseInit): value is HttpResponseInit {
  return typeof (value as HttpResponseInit).status === "number";
}

async function findAssignment(id: string): Promise<LicenseAssignmentRecord | null> {
  const { resources } = await getContainer("licenseAssignments").items.query<LicenseAssignmentRecord>({
    query: "SELECT * FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: id }],
  }).fetchAll();
  return resources[0] ?? null;
}

async function buildAssignment(input: z.infer<typeof AssignmentSchema>): Promise<LicenseAssignmentRecord | HttpResponseInit> {
  const missing = validateLicenseAssignmentRequirements(input);
  if (missing) return badRequest(missing);

  const module = await findModule(input.moduleId);
  if (!module || module.status !== "active" || module.active === false || module.deletedAt) return badRequest("El módulo seleccionado no está activo.");

  const { resource: client } = await getContainer("clients").item(input.clientId, input.clientId).read<ClientRecord>();
  if (!client || client.status !== "active") return badRequest("El cliente seleccionado no está activo.");

  let domain: DomainRecord | null = null;
  let database: DatabaseRecord | null = null;
  if (input.targetType === "domain" || input.targetType === "database") {
    if (!input.domainId) return badRequest("Seleccione un dominio.");
    const { resources } = await getContainer("domains").items.query<DomainRecord>({
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: input.domainId }],
    }).fetchAll();
    domain = resources[0] ?? null;
    if (!domain || domain.status !== "active" || domain.clientId !== client.id) return badRequest("El dominio seleccionado no pertenece al cliente o no está activo.");
  }
  if (input.targetType === "database") {
    if (!input.databaseId) return badRequest("Seleccione una base de datos.");
    const { resources } = await getContainer("databases").items.query<DatabaseRecord>({
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: input.databaseId }],
    }).fetchAll();
    database = resources[0] ?? null;
    if (!database || database.status !== "active" || database.clientId !== client.id || database.domainId !== domain?.id) {
      return badRequest("La base de datos seleccionada no pertenece al cliente/dominio o no está activa.");
    }
  }

  return {
    id: `license_assignment_${uuid()}`,
    moduleId: module.id,
    moduleName: module.name,
    moduleCode: module.code,
    targetType: input.targetType,
    targetId: input.targetType === "client" ? client.id : input.targetType === "domain" ? domain!.id : database!.id,
    clientId: client.id,
    clientName: client.name,
    domainId: domain?.id,
    domainName: domain?.domainName,
    databaseId: database?.id,
    databaseName: database?.dbAccess.initialCatalog,
    environment: input.environment || "all",
    status: input.status,
    active: input.status === "active",
    createdAt: "",
    createdBy: "",
    updatedAt: "",
    updatedBy: "",
  };
}

app.http("licenseModulesList", {
  route: "license-modules",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getLicensingViewer(req);
      const includeDeleted = req.query.get("includeDeleted") === "true";
      const { resources } = await getContainer("licenseModules").items.readAll<LicenseModuleRecord>().fetchAll();
      const items = includeDeleted ? resources : resources.filter((module) => module.status !== "deleted" && !module.deletedAt);
      return ok(items.sort((a, b) => a.name.localeCompare(b.name, "es")));
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
      const user = await getModuleManager(req);
      const parsed = ModuleSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const code = await nextModuleCode(parsed.data.name, parsed.data.code);
      if (typeof code !== "string") return code;
      const now = new Date().toISOString();
      const record: LicenseModuleRecord = {
        id: `license_module_${uuid()}`,
        name: parsed.data.name.trim(),
        code,
        description: parsed.data.description?.trim(),
        status: parsed.data.status,
        active: parsed.data.status === "active",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      await getContainer("licenseModules").items.create(record);
      await writeAuditLog({ entityType: "licenseModule", entityId: record.id, action: "license_module_created", performedBy: user.id, performedByEmail: user.email, after: record });
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
      const user = await getModuleManager(req);
      const id = req.params.id;
      const current = await findModule(id);
      if (!current || current.status === "deleted" || current.deletedAt) return notFound("Licencia o módulo no encontrado.");
      const parsed = ModuleSchema.partial().safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const nextCode = parsed.data.code !== undefined
        ? await nextModuleCode(parsed.data.name ?? current.name, parsed.data.code, id)
        : current.code ?? await nextModuleCode(parsed.data.name ?? current.name, undefined, id);
      if (typeof nextCode !== "string") return nextCode;
      const before = { ...current };
      const updated: LicenseModuleRecord = {
        ...current,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.code !== undefined ? { code: nextCode } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description.trim() } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status, active: parsed.data.status === "active" } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await getContainer("licenseModules").item(id, id).replace(updated);
      await writeAuditLog({ entityType: "licenseModule", entityId: id, action: "license_module_updated", performedBy: user.id, performedByEmail: user.email, before, after: updated });
      return ok(updated);
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
      const user = await getModuleManager(req);
      const id = req.params.id;
      const moduleContainer = getContainer("licenseModules");
      const resource = await findModule(id);
      if (!resource || resource.status === "deleted" || resource.deletedAt) return notFound("Licencia o módulo no encontrado.");

      const [{ resources: assignments }, { resources: clients }, { resources: domains }, { resources: databases }] = await Promise.all([
        getContainer("licenseAssignments").items.query<LicenseAssignmentRecord>({
          query: "SELECT * FROM c WHERE c.moduleId = @moduleId",
          parameters: [{ name: "@moduleId", value: id }],
        }).fetchAll(),
        getContainer("clients").items.readAll<ClientRecord>().fetchAll(),
        getContainer("domains").items.readAll<DomainRecord>().fetchAll(),
        getContainer("databases").items.readAll<DatabaseRecord>().fetchAll(),
      ]);
      const clientsUsingLicense = summarizeLicenseDeleteDependencies({ moduleId: id, assignments, clients, domains, databases });

      if (clientsUsingLicense.length > 0) {
        return conflict("No se puede eliminar esta licencia porque tiene asignaciones activas.", {
          dependencies: {
            assignments: clientsUsingLicense.reduce((sum, client) => sum + client.assignments, 0),
            clients: clientsUsingLicense,
          },
          detail: "Quite primero las asignaciones activas de estos clientes y luego intente eliminar la licencia nuevamente.",
        });
      }

      const now = new Date().toISOString();
      const before = { ...resource };
      const deleted: LicenseModuleRecord = {
        ...resource,
        status: "deleted",
        active: false,
        deletedAt: now,
        deletedBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      await moduleContainer.item(id, id).replace(deleted);
      await writeAuditLog({ entityType: "licenseModule", entityId: id, action: "license_module_deleted", performedBy: user.id, performedByEmail: user.email, before, after: { status: "deleted" } });
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
      await getLicensingViewer(req);
      const includeDeleted = req.query.get("includeDeleted") === "true";
      const { resources } = await getContainer("licenseAssignments").items.readAll<LicenseAssignmentRecord>().fetchAll();
      const items = includeDeleted ? resources : resources.filter((assignment) => assignment.status !== "deleted" && !assignment.deletedAt);
      return ok(items.sort((a, b) => (a.clientName ?? "").localeCompare(b.clientName ?? "", "es")));
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
      const user = await getAssignmentManager(req);
      const parsed = AssignmentSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const built = await buildAssignment(parsed.data);
      if (isHttpResponse(built)) return built;
      const now = new Date().toISOString();
      const record = { ...built, createdAt: now, createdBy: user.id, updatedAt: now, updatedBy: user.id } as LicenseAssignmentRecord;
      await getContainer("licenseAssignments").items.create(record);
      await writeAuditLog({ entityType: "licenseAssignment", entityId: record.id, clientId: record.clientId, clientName: record.clientName, action: "license_assignment_created", performedBy: user.id, performedByEmail: user.email, after: record });
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
      const user = await getAssignmentManager(req);
      const id = req.params.id;
      const current = await findAssignment(id);
      if (!current || current.status === "deleted" || current.deletedAt) return notFound("Asignación no encontrada.");
      const parsed = AssignmentSchema.partial().safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const merged = {
        moduleId: parsed.data.moduleId ?? current.moduleId,
        targetType: parsed.data.targetType ?? current.targetType ?? "client",
        clientId: parsed.data.clientId ?? current.clientId,
        domainId: parsed.data.domainId ?? current.domainId,
        databaseId: parsed.data.databaseId ?? current.databaseId,
        environment: parsed.data.environment ?? current.environment ?? "all",
        status: parsed.data.status ?? current.status ?? "active",
      };
      const built = await buildAssignment(merged as z.infer<typeof AssignmentSchema>);
      if (isHttpResponse(built)) return built;
      const before = { ...current };
      const updated: LicenseAssignmentRecord = {
        ...current,
        ...built,
        id: current.id,
        createdAt: current.createdAt,
        createdBy: current.createdBy,
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      if (current.clientId && updated.clientId !== current.clientId) {
        await getContainer("licenseAssignments").item(current.id, current.clientId).delete();
        await getContainer("licenseAssignments").items.create(updated);
      } else {
        await getContainer("licenseAssignments").item(current.id, current.clientId || updated.clientId || current.id).replace(updated);
      }
      await writeAuditLog({ entityType: "licenseAssignment", entityId: id, clientId: updated.clientId, clientName: updated.clientName, action: "license_assignment_updated", performedBy: user.id, performedByEmail: user.email, before, after: updated });
      return ok(updated);
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
      const user = await getAssignmentManager(req);
      const current = await findAssignment(req.params.id);
      if (!current || current.status === "deleted" || current.deletedAt) return notFound("Asignación no encontrada.");
      const before = { ...current };
      const deleted: LicenseAssignmentRecord = {
        ...current,
        status: "deleted",
        active: false,
        deletedAt: new Date().toISOString(),
        deletedBy: user.id,
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await getContainer("licenseAssignments").item(current.id, current.clientId || current.id).replace(deleted);
      await writeAuditLog({ entityType: "licenseAssignment", entityId: current.id, clientId: current.clientId, clientName: current.clientName, action: "license_assignment_deleted", performedBy: user.id, performedByEmail: user.email, before, after: { status: "deleted" } });
      return ok({ ok: true, deleted: true });
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});
