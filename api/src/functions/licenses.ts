import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { summarizeLicenseDeleteDependencies } from "../lib/licenseDeletion";
import { canManageClients } from "../lib/permissions";
import { conflict, forbidden, notFound, ok, serverError } from "../lib/http";
import type {
  ClientRecord,
  DatabaseRecord,
  DomainRecord,
  LicenseAssignmentRecord,
  LicenseModuleRecord,
} from "../types/models";

async function getManagerOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  if (!canManageClients(profile)) throw Object.assign(new Error("No tiene permisos para administrar licencias."), { status: 403 });
  return profile;
}

app.http("licenseModulesList", {
  route: "license-modules",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getManagerOrFail(req);
      const includeDeleted = req.query.get("includeDeleted") === "true";
      const { resources } = await getContainer("licenseModules").items.readAll<LicenseModuleRecord>().fetchAll();
      const items = includeDeleted ? resources : resources.filter((module) => module.status !== "deleted" && !module.deletedAt);
      return ok(items);
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
      const user = await getManagerOrFail(req);
      const id = req.params.id;
      const moduleContainer = getContainer("licenseModules");
      const { resource } = await moduleContainer.item(id, id).read<LicenseModuleRecord>();
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
      await writeAuditLog({
        entityType: "licenseModule",
        entityId: id,
        action: "license_module_deleted",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: { status: "deleted" },
      });
      return ok({ ok: true, deleted: true });
    } catch (e: any) {
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});
