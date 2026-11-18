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
  const environment = process.env.PORTAL_SAG_ENVIRONMENT?.trim().toLowerCase() || "production";
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
      const result = await saveSqlCatalogSourceDraft({
        profileId: id.data, environment: configuredCatalogEnvironment(), ...draft.data,
      }, actor);
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
