import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, forbidden, noContent, ok, serverError } from "../lib/http";
import { canManageIntegration, type IntegrationAction } from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import {
  deleteExternalDatabaseConnection,
  readIntegrationConnections,
  saveExternalDatabaseConnection,
  saveSeaweedFSConnection,
  testSavedExternalDatabaseConnection,
  testSavedSeaweedFSConnection,
  testTransientExternalDatabaseConnection,
  testTransientSeaweedFSConnection,
} from "../lib/integrationConnectionsService";

const Etag = z.string().trim().regex(/^[0-9a-f]{16}$/i, "La versión de la configuración no es válida.");
const Secret = z.string().min(1).max(512);
const S3Bucket = z.string().trim().min(3).max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "El bucket S3 no tiene un formato válido.");
const SqlHost = z.string().trim().min(1).max(255).refine(
  (value) => !/[:/\\,;=\s]/.test(value),
  "Ingrese solamente el host o IP de SQL Server, sin protocolo, puerto ni instancia.",
);

const HttpsEndpoint = z.string().trim().max(500).transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "/" && url.pathname !== "")
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Use un endpoint HTTPS raíz, sin credenciales, ruta, consulta ni fragmento." });
      return z.NEVER;
    }
    return url.origin;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "El endpoint SeaweedFS no es una URL HTTPS válida." });
    return z.NEVER;
  }
});

const SeaweedBase = z.object({
  displayName: z.string().trim().min(1).max(160),
  endpoint: HttpsEndpoint,
  region: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/i),
  bucket: S3Bucket,
  forcePathStyle: z.boolean(),
  active: z.boolean(),
}).strict();

const SeaweedSaveSchema = SeaweedBase.extend({
  etag: Etag.optional(),
  accessKey: Secret.optional(),
  secretKey: Secret.optional(),
}).superRefine((value, ctx) => {
  if (Boolean(value.accessKey) !== Boolean(value.secretKey)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Debe enviar la clave de acceso y la clave secreta juntas." });
  }
});

const SeaweedTestSchema = SeaweedBase.omit({ displayName: true, active: true }).extend({
  accessKey: Secret,
  secretKey: Secret,
}).strict();

const ExternalDatabaseBase = z.object({
  displayName: z.string().trim().min(1).max(160),
  purpose: z.string().trim().max(500).optional(),
  serverHost: SqlHost,
  serverPort: z.number().int().min(1).max(65535),
  databaseName: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  active: z.boolean(),
}).strict();

const ExternalDatabaseSaveSchema = ExternalDatabaseBase.extend({
  id: z.string().trim().min(1).max(150).optional(),
  etag: Etag.optional(),
  password: Secret.optional(),
}).strict();

const ExternalDatabaseTestSchema = ExternalDatabaseBase
  .omit({ displayName: true, purpose: true, active: true })
  .extend({ password: Secret })
  .strict();

async function profileFor(req: HttpRequest, action: IntegrationAction) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  if (!canManageIntegration(profile, action, await loadRoleDefinitions())) return null;
  return profile;
}

async function json(req: HttpRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw Object.assign(new Error("El cuerpo JSON no es válido."), { status: 400 });
  }
}

function firstIssue(error: z.ZodError): HttpResponseInit {
  return badRequest(error.issues[0]?.message ?? "Los datos enviados no son válidos.");
}

async function limitTest(req: HttpRequest, userId: string): Promise<HttpResponseInit | null> {
  return enforceRequestRateLimit(
    req,
    "integration_connection_test",
    userId,
    RATE_LIMIT_POLICIES.integrationTest,
  );
}

function etagFromRequest(req: HttpRequest): string {
  return (req.headers.get("if-match") ?? "").replace(/^W\//, "").replaceAll("\"", "").trim();
}

app.http("integrationConnectionsGet", {
  route: "settings/integrations",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      if (!await profileFor(req, "view")) return forbidden();
      return ok(await readIntegrationConnections());
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("integrationSeaweedTestTransient", {
  route: "settings/integrations/object-storage/seaweedfs/test",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await profileFor(req, "test_object_storage");
      if (!user) return forbidden();
      const limited = await limitTest(req, user.id);
      if (limited) return limited;
      const parsed = SeaweedTestSchema.safeParse(await json(req));
      if (!parsed.success) return firstIssue(parsed.error);
      return ok({ result: await testTransientSeaweedFSConnection(parsed.data, user) });
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("integrationSeaweedSave", {
  route: "settings/integrations/object-storage/seaweedfs",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await profileFor(req, "edit_object_storage");
      if (!user) return forbidden();
      const limited = await limitTest(req, user.id);
      if (limited) return limited;
      const parsed = SeaweedSaveSchema.safeParse(await json(req));
      if (!parsed.success) return firstIssue(parsed.error);
      return ok(await saveSeaweedFSConnection(parsed.data, user));
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("integrationSeaweedTestSaved", {
  route: "settings/integrations/object-storage/seaweedfs/test-saved",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await profileFor(req, "test_object_storage");
      if (!user) return forbidden();
      const limited = await limitTest(req, user.id);
      if (limited) return limited;
      return ok(await testSavedSeaweedFSConnection(user));
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("integrationExternalDatabaseTestTransient", {
  route: "settings/integrations/external-databases/test",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await profileFor(req, "test_database");
      if (!user) return forbidden();
      const limited = await limitTest(req, user.id);
      if (limited) return limited;
      const parsed = ExternalDatabaseTestSchema.safeParse(await json(req));
      if (!parsed.success) return firstIssue(parsed.error);
      return ok({ result: await testTransientExternalDatabaseConnection(parsed.data, user) });
    } catch (error) {
      return serverError(error);
    }
  },
});

async function saveExternal(req: HttpRequest, edit: boolean): Promise<HttpResponseInit> {
  try {
    const user = await profileFor(req, edit ? "edit_database" : "create_database");
    if (!user) return forbidden();
    const limited = await limitTest(req, user.id);
    if (limited) return limited;
    const parsed = ExternalDatabaseSaveSchema.safeParse(await json(req));
    if (!parsed.success) return firstIssue(parsed.error);
    const routeId = edit ? req.params.id : undefined;
    if (edit && (!routeId || parsed.data.id !== routeId)) {
      return badRequest("El identificador de la conexión no coincide con la ruta.");
    }
    return ok(await saveExternalDatabaseConnection(parsed.data, user));
  } catch (error) {
    return serverError(error);
  }
}

app.http("integrationExternalDatabaseCreate", {
  route: "settings/integrations/external-databases",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (req) => saveExternal(req, false),
});

app.http("integrationExternalDatabaseUpdate", {
  route: "settings/integrations/external-databases/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: (req) => saveExternal(req, true),
});

app.http("integrationExternalDatabaseTestSaved", {
  route: "settings/integrations/external-databases/{id}/test",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await profileFor(req, "test_database");
      if (!user) return forbidden();
      const limited = await limitTest(req, user.id);
      if (limited) return limited;
      return ok(await testSavedExternalDatabaseConnection(req.params.id, user));
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("integrationExternalDatabaseDelete", {
  route: "settings/integrations/external-databases/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await profileFor(req, "delete_database");
      if (!user) return forbidden();
      const etag = etagFromRequest(req);
      const parsed = Etag.safeParse(etag);
      if (!parsed.success) return firstIssue(parsed.error);
      const deleted = await deleteExternalDatabaseConnection(req.params.id, parsed.data, user);
      return deleted ? noContent() : serverError(Object.assign(new Error("Conexión externa no encontrada."), { status: 404 }));
    } catch (error) {
      return serverError(error);
    }
  },
});
