import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { loadUserProfile, requireUser } from "../lib/auth";
import { badRequest, conflict, forbidden, notFound, ok, unauthorized } from "../lib/http";
import { canManageIntegration, type IntegrationAction } from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import {
  CATALOG_ERP_ISSUER_SCOPE,
  readSqlCatalogSourceBindings,
  saveSqlCatalogSourceDraft,
  type SqlCatalogSourceBinding,
} from "../lib/catalogSourceBindingsSqlRepository";
import type { CatalogEnvironment } from "../lib/catalogSourceConfiguration";
import { certifySavedCatalogSource } from "../lib/catalogSourceCertification";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { publishSavedCatalogSource, readCatalogRefreshConfiguration } from "../lib/catalogSourcePublication";
import { catalogSourceIdSchema } from "../lib/catalogSourceId";

const PROFILE_ID = z.string().min(1).max(150).refine(value => value.trim() === value && !/\p{Cc}/u.test(value));
const DRAFT = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("erp-customers"),
    issuerScope: z.string().trim().toUpperCase().regex(CATALOG_ERP_ISSUER_SCOPE),
  }).strict(),
  z.object({ role: z.literal("sag-admin") }).strict(),
]);

function catalogAdminEnabled(): boolean {
  return process.env.PORTAL_CATALOG_ADMIN_ENABLED?.trim().toLowerCase() === "true";
}

function configuredCatalogEnvironment(): CatalogEnvironment {
  // Mirrors the existing runtime SQL environment selection; never read request data.
  const environment = process.env.PORTAL_SAG_ENVIRONMENT?.trim().toLowerCase();
  if (environment !== "qa" && environment !== "production") throw new Error("Ambiente de catálogo inválido.");
  return environment;
}

async function profileFor(req: HttpRequest, action: IntegrationAction) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile || !canManageIntegration(profile, action, await loadRoleDefinitions())) return null;
  return profile;
}

function presentBinding(binding: SqlCatalogSourceBinding) {
  return {
    id: binding.id,
    profileId: binding.profileId,
    label: binding.label,
    role: binding.role,
    state: binding.state,
    ...(binding.role === "erp-customers" && binding.issuerScope ? { issuerScope: binding.issuerScope } : {}),
    canReadCurrentProfile: binding.canReadCurrentProfile,
  };
}

function responseForError(error: unknown): HttpResponseInit {
  if (error && typeof error === "object" && "status" in error && error.status === 401) return unauthorized();
  // Never include driver errors, request bodies, database addresses or credential references.
  return { status: 500, jsonBody: { error: "No se pudo consultar o guardar la fuente del catálogo." } };
}

app.http("catalogSourcesList", {
  route: "settings/integrations/catalog-sources",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    if (!catalogAdminEnabled()) return notFound();
    try {
      if (!await profileFor(req, "view")) return forbidden();
      const items = await readSqlCatalogSourceBindings(configuredCatalogEnvironment());
      return ok({ items: items.map(presentBinding) });
    } catch (error) {
      return responseForError(error);
    }
  },
});

function sourceCertification(action: "verify" | "activate") {
  return async (req: HttpRequest): Promise<HttpResponseInit> => {
    if (!catalogAdminEnabled()) return notFound();
    try {
      const auth = await requireUser(req);
      const actor = await loadUserProfile(auth);
      if (!actor) return forbidden();
      const roles = await loadRoleDefinitions();
      if (!canManageIntegration(actor, "test_database", roles)
        || (action === "activate" && !canManageIntegration(actor, "edit_database", roles))) return forbidden();
      const sourceId = catalogSourceIdSchema.safeParse(req.params.sourceId);
      if (!sourceId.success) return badRequest("La fuente de catálogo no es válida.");
      let body: unknown;
      try { body = await req.json(); } catch { return badRequest("El cuerpo JSON no es válido."); }
      if (!z.object({}).strict().safeParse(body).success) return badRequest("La solicitud no admite parámetros.");
      const environment = configuredCatalogEnvironment();
      const limited = await enforceRequestRateLimit(req, "integration_connection_test", actor.id, RATE_LIMIT_POLICIES.integrationTest);
      if (limited) return limited;
      const status = await certifySavedCatalogSource({ environment, sourceId: sourceId.data, action, actor,
        ...(action === "activate" && { authorizeActivation: async () => {
          if (!catalogAdminEnabled() || configuredCatalogEnvironment() !== environment) return false;
          const current = await loadUserProfile(await requireUser(req));
          if (!current || current.id !== actor.id) return false;
          const currentRoles = await loadRoleDefinitions();
          return canManageIntegration(current, "test_database", currentRoles) &&
            canManageIntegration(current, "edit_database", currentRoles);
        } }),
      });
      if (status === "verified" || status === "activated") return ok({ status });
      if (status === "missing") return notFound("No se encontró la fuente del catálogo.");
      if (status === "forbidden") return forbidden();
      if (status === "not_read_only") return conflict("La cuenta configurada no cumple los permisos de solo lectura.");
      if (status === "unavailable") return { status: 503, jsonBody: { error: "No se pudo verificar la conexión o su contrato de lectura." } };
      if (status === "superseded") return conflict("El perfil o la fuente cambiaron. Recargue y vuelva a verificar.");
      return conflict("La fuente no se puede activar o verificar con su configuración actual.");
    } catch (error) {
      return responseForError(error);
    }
  };
}

app.http("catalogSourceVerify", {
  route: "settings/integrations/catalog-sources/{sourceId}/verify", methods: ["POST"], authLevel: "anonymous",
  handler: sourceCertification("verify"),
});

app.http("catalogSourceActivate", {
  route: "settings/integrations/catalog-sources/{sourceId}/activate", methods: ["POST"], authLevel: "anonymous",
  handler: sourceCertification("activate"),
});

app.http("catalogSourceRefresh", {
  route: "settings/integrations/catalog-sources/{sourceId}/refresh", methods: ["POST"], authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    if (!catalogAdminEnabled() || process.env.PORTAL_CATALOG_SOURCE_REFRESH_ENABLED?.trim() !== "true") return notFound();
    try {
      const actor = await loadUserProfile(await requireUser(req));
      if (!actor || !actor.roles.includes("super_admin")) return forbidden();
      const roles = (await loadRoleDefinitions()).filter(role => role.active !== false);
      if (!(["view", "test_database", "edit_database"] as const).every(action => canManageIntegration(actor, action, roles))) return forbidden();
      const sourceId = catalogSourceIdSchema.safeParse(req.params.sourceId);
      if (!sourceId.success) return badRequest("La fuente de catálogo no es válida.");
      if (!z.object({}).strict().safeParse(await req.json().catch(() => null)).success) return badRequest("La solicitud no admite parámetros.");
      const environment = configuredCatalogEnvironment();
      const limited = await enforceRequestRateLimit(req, "catalog_source_refresh", actor.id,
        { maxAttempts: 2, windowSeconds: 120, blockSeconds: 120 });
      if (limited) return limited;
      const status = await publishSavedCatalogSource({ environment, sourceId: sourceId.data, actorId: actor.id });
      if (status === "published") return ok({ status });
      if (status === "missing") return notFound("No se encontró la fuente del catálogo.");
      if (status === "superseded" || status === "ineligible") return conflict("La fuente no admite la actualización con su versión actual.");
      return { status: 503, jsonBody: { error: "No se pudo actualizar la fuente. Se conserva la última revisión disponible." } };
    } catch (error) { return responseForError(error); }
  },
});

app.http("catalogSourceDraftSave", {
  route: "settings/integrations/catalog-sources/profile/{profileId}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    if (!catalogAdminEnabled()) return notFound();
    try {
      const actor = await profileFor(req, "edit_database");
      if (!actor) return forbidden();
      const id = PROFILE_ID.safeParse(req.params.profileId);
      if (!id.success) return badRequest("El perfil de base de datos no es válido.");
      let body: unknown;
      try { body = await req.json(); }
      catch { return badRequest("El cuerpo JSON no es válido."); }
      const draft = DRAFT.safeParse(body);
      if (!draft.success) return badRequest("Use un rol de catálogo y, para ERP, un emisor con formato CO:NIT.");
      const environment = configuredCatalogEnvironment();
      const config = readCatalogRefreshConfiguration();
      const input = { profileId: id.data, environment, ...draft.data };
      const result = draft.data.role === "sag-admin" && config?.environment === environment && config.includeSagV2
        ? await saveSqlCatalogSourceDraft(input, actor, "sag_admin_v2") : await saveSqlCatalogSourceDraft(input, actor);
      if (result.status === "saved") return ok(presentBinding(result.binding));
      if (result.status === "profile-not-found") return notFound("No se encontró el perfil de base de datos.");
      if (result.status === "unsupported-profile") {
        return conflict("El perfil de base de datos no está disponible para un borrador de catálogo.");
      }
      return conflict("La vinculación existente no se puede sustituir desde un borrador.");
    } catch (error) {
      return responseForError(error);
    }
  },
});
