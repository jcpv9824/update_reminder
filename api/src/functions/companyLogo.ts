import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, forbidden, ok } from "../lib/http";
import { canUploadCompanyLogo } from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { writeAuditLog } from "../lib/audit";
import { checkCompanyStorage, CompanyLogoError, databaseNameSchema, StorageSchema } from "../lib/companyLogo";
import {
  applyCompanyStorage,
  ApplyCompanyStorageSchema,
  checkCompanyDatabase,
  CheckDatabaseSchema,
} from "../lib/companyStorageSetup";

/*
  Seguridad: el cuerpo de estas solicitudes trae llaves del almacenamiento y
  usuario/contraseña de SQL del cliente. Nunca se registra (context.log), nunca
  se audita y nunca se devuelve. Los errores salen con mensajes controlados;
  jamás el detalle del proveedor o de SQL Server.
*/

const NO_STORE = { "Cache-Control": "no-store" };

const StorageCheckSchema = z.object({
  storage: StorageSchema,
  databaseName: z.union([databaseNameSchema, z.literal("")]).optional(),
}).strict();

function withNoStore(response: HttpResponseInit): HttpResponseInit {
  return { ...response, headers: { ...(response.headers as Record<string, string> | undefined), ...NO_STORE } };
}

async function authorize(req: HttpRequest): Promise<{ id: string; email: string } | HttpResponseInit> {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) return forbidden("Usuario no registrado.");
  if (!canUploadCompanyLogo(profile, await loadRoleDefinitions())) return forbidden();
  const limited = await enforceRequestRateLimit(req, "company_logo", profile.id, RATE_LIMIT_POLICIES.companyLogo);
  if (limited) return limited;
  return { id: profile.id, email: profile.email };
}

async function readJson(req: HttpRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new CompanyLogoError("La solicitud no tiene un formato válido.", 400);
  }
}

function failure(error: unknown): HttpResponseInit {
  const candidate = error as { status?: number };
  if (error instanceof CompanyLogoError) {
    return { status: error.status, jsonBody: { error: error.message, ...(error.details ?? {}) } };
  }
  if (candidate?.status === 401) return { status: 401, jsonBody: { error: "No autenticado." } };
  if (candidate?.status === 403) return forbidden();
  return { status: 500, jsonBody: { error: "No fue posible completar la operación. Intente de nuevo." } };
}

function isResponse(value: unknown): value is HttpResponseInit {
  return typeof (value as HttpResponseInit)?.status === "number";
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.code === "unrecognized_keys") return "La solicitud trae datos que no se esperan.";
  return issue?.message ?? "Datos no válidos.";
}

function handler(run: (body: unknown, user: { id: string; email: string }) => Promise<HttpResponseInit>) {
  return async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const user = await authorize(req);
      if (isResponse(user)) return withNoStore(user);
      return withNoStore(await run(await readJson(req), user));
    } catch (error) {
      return withNoStore(failure(error));
    }
  };
}

app.http("companyStorageCheck", {
  route: "implementation/company-logo/storage/check",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: handler(async (body) => {
    const parsed = StorageCheckSchema.safeParse(body);
    if (!parsed.success) return badRequest(firstIssue(parsed.error));
    return ok(await checkCompanyStorage(parsed.data.storage, parsed.data.databaseName || null));
  }),
});

app.http("companyDatabaseCheck", {
  route: "implementation/company-logo/database/check",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: handler(async (body) => {
    const parsed = CheckDatabaseSchema.safeParse(body);
    if (!parsed.success) return badRequest(firstIssue(parsed.error));
    return ok(await checkCompanyDatabase(parsed.data.database));
  }),
});

app.http("companyStorageApply", {
  route: "implementation/company-logo/apply",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: handler(async (body, user) => {
    const parsed = ApplyCompanyStorageSchema.safeParse(body);
    if (!parsed.success) return badRequest(firstIssue(parsed.error));
    const result = await applyCompanyStorage(parsed.data);
    // Auditoría mínima: quién, cuándo, en qué base y qué se hizo.
    // Nunca servidor, usuario, contraseña, bucket, llaves ni URL.
    await writeAuditLog({
      entityType: "companyStorage",
      entityId: result.databaseName,
      companyName: result.databaseName,
      action: "company_storage_configured",
      performedBy: user.id,
      performedByEmail: user.email,
      metadata: {
        logoUpdated: result.logoUpdated,
        assetKind: result.fileName ? result.fileName.slice(result.fileName.lastIndexOf(".") + 1) : null,
        bytes: result.bytes,
        previousLogoCount: result.previousLogoCount,
        changedFieldCount: result.changes.length,
        keysChanged: result.keysChanged,
      },
    }).catch(() => undefined);
    return ok(result);
  }),
});
