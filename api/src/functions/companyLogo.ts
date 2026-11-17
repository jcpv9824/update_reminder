import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, forbidden, ok } from "../lib/http";
import { canUploadCompanyLogo } from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { writeAuditLog } from "../lib/audit";
import { checkCompanyStorage, CompanyLogoError, databaseNameSchema, StorageSchema } from "../lib/companyLogo";
import { legacyCheck, LegacyConnectionSchema, legacyUpload, LegacyUploadSchema } from "../lib/companyLogoLegacy";
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
    const databaseName = parsed.data.database.databaseName;
    // Auditoría OBLIGATORIA antes de tocar nada: si no se puede registrar la
    // intención, no se escribe en la base de la compañía.
    // Nunca servidor, usuario, contraseña, bucket, llaves ni URL.
    try {
      await writeAuditLog({
        entityType: "companyStorage",
        entityId: databaseName,
        companyName: databaseName,
        action: "company_storage_configuration_requested",
        performedBy: user.id,
        performedByEmail: user.email,
        metadata: { logoRequested: Boolean(parsed.data.logo), confirmed: Boolean(parsed.data.confirmationToken) },
      });
    } catch {
      return {
        status: 503,
        jsonBody: { error: "No fue posible registrar la auditoría. No se cambió nada: intente de nuevo en unos minutos.", databaseChanged: false, stage: "audit" },
      };
    }
    let result;
    try {
      result = await applyCompanyStorage(parsed.data);
    } catch (error) {
      const details = (error as CompanyLogoError).details ?? {};
      await writeAuditLog({
        entityType: "companyStorage",
        entityId: databaseName,
        companyName: databaseName,
        action: "company_storage_configuration_failed",
        performedBy: user.id,
        performedByEmail: user.email,
        metadata: { stage: String(details.stage ?? "unknown"), status: (error as CompanyLogoError).status ?? 500 },
      }).catch(() => undefined);
      throw error;
    }
    // Resultado: la base YA cambió. Si este registro falla, se informa en la
    // respuesta (auditRecorded=false) sin ocultar que el cambio se aplicó.
    const auditRecorded = await writeAuditLog({
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
    }).then(() => true, () => false);
    return ok({ ...result, auditRecorded });
  }),
});

/*
  COMPATIBILIDAD TEMPORAL: rutas del frontend anterior (/check y /upload).
  Permiten publicar el API antes que el frontend y revertir el frontend sin
  revertir el API. RETIRAR en el siguiente despliegue, con el frontend nuevo
  ya verificado en producción.
*/
app.http("companyLogoCheckLegacy", {
  route: "implementation/company-logo/check",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: handler(async (body) => {
    const parsed = LegacyConnectionSchema.safeParse(body);
    if (!parsed.success) return badRequest(firstIssue(parsed.error));
    return ok(await legacyCheck(parsed.data));
  }),
});

app.http("companyLogoUploadLegacy", {
  route: "implementation/company-logo/upload",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: handler(async (body, user) => {
    const parsed = LegacyUploadSchema.safeParse(body);
    if (!parsed.success) return badRequest(firstIssue(parsed.error));
    const result = await legacyUpload(parsed.data);
    await writeAuditLog({
      entityType: "companyLogo",
      entityId: result.fileName,
      companyName: parsed.data.databaseName,
      action: "company_logo_uploaded",
      performedBy: user.id,
      performedByEmail: user.email,
      metadata: {
        assetKind: result.fileName.slice(result.fileName.lastIndexOf(".") + 1),
        bytes: result.bytes,
        previousLogoCount: result.replacedCount,
      },
    }).catch(() => undefined);
    return ok(result);
  }),
});
