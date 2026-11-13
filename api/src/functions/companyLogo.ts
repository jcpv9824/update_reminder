import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, conflict, forbidden, ok } from "../lib/http";
import { canUploadCompanyLogo } from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { writeAuditLog } from "../lib/audit";
import {
  checkCompanyLogoStorage,
  CompanyLogoConnectionSchema,
  CompanyLogoError,
  CompanyLogoUploadSchema,
  uploadCompanyLogo,
} from "../lib/companyLogo";

/*
  Seguridad: el cuerpo de estas solicitudes trae llaves del almacenamiento del
  cliente. Nunca se registra (context.log), nunca se audita y nunca se devuelve.
  Los errores salen con mensajes controlados; jamás el detalle del proveedor.
*/

const NO_STORE = { "Cache-Control": "no-store" };

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
    return error.status === 409 ? conflict(error.message) : { status: error.status, jsonBody: { error: error.message } };
  }
  if (candidate?.status === 401) return { status: 401, jsonBody: { error: "No autenticado." } };
  if (candidate?.status === 403) return forbidden();
  return { status: 500, jsonBody: { error: "No fue posible completar la operación. Intente de nuevo." } };
}

function isResponse(value: unknown): value is HttpResponseInit {
  return typeof (value as HttpResponseInit)?.status === "number";
}

app.http("companyLogoCheck", {
  route: "implementation/company-logo/check",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await authorize(req);
      if (isResponse(user)) return withNoStore(user);
      const parsed = CompanyLogoConnectionSchema.safeParse(await readJson(req));
      if (!parsed.success) return withNoStore(badRequest(parsed.error.issues[0].message));
      return withNoStore(ok(await checkCompanyLogoStorage(parsed.data)));
    } catch (error) {
      return withNoStore(failure(error));
    }
  },
});

app.http("companyLogoUpload", {
  route: "implementation/company-logo/upload",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await authorize(req);
      if (isResponse(user)) return withNoStore(user);
      const parsed = CompanyLogoUploadSchema.safeParse(await readJson(req));
      if (!parsed.success) return withNoStore(badRequest(parsed.error.issues[0].message));
      const result = await uploadCompanyLogo(parsed.data);
      // Auditoría mínima: quién, cuándo y para qué compañía (nombre de la base).
      // Nunca bucket, llaves ni URL.
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
      return withNoStore(ok(result));
    } catch (error) {
      return withNoStore(failure(error));
    }
  },
});
