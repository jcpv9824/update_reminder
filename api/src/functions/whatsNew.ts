import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { enforceRequestRateLimit } from "../lib/rateLimit";
import { getSqlPool } from "../lib/sql";
import { buildActor, access, requirePermission, type WhatsNewActor } from "../lib/whatsNewAccess";
import { WhatsNewError } from "../lib/whatsNewModel";
import { areasFor, query } from "../lib/whatsNewSqlRepository";
import { mutate, assertIdempotencyKey, type Operation } from "../lib/whatsNewSqlWriteRepository";
import * as service from "../lib/whatsNewService";

type Handler = (req: HttpRequest, actor: WhatsNewActor | null) => Promise<unknown>;
export function whatsNewRateLimit(method: string, url: string, authenticated: boolean) {
  const preview = authenticated && url.includes("/reports/preview");
  const write = authenticated && method !== "GET";
  return { scope: !authenticated ? "whats_new_public" : preview ? "whats_new_preview" : write ? "whats_new_write" : "whats_new_read",
    policy: { maxAttempts: preview ? 10 : write ? 30 : 120, windowSeconds: 60, blockSeconds: 60 } };
}
export type WhatsNewHttpDependencies = {
  authenticate(req: HttpRequest): Promise<WhatsNewActor>;
  enabled(): boolean;
  limit(req: HttpRequest, actor?: WhatsNewActor): Promise<HttpResponseInit | null>;
};
const defaults: WhatsNewHttpDependencies = {
  enabled: () => process.env.WHATS_NEW_ENABLED === "true",
  authenticate: async (req) => {
    const user = await requireUser(req); const profile = await loadUserProfile(user);
    if (!profile) throw new WhatsNewError(401, "no_autenticado", "No autenticado.");
    return buildActor(profile, await loadRoleDefinitions(), await areasFor(profile.id));
  },
  limit: (req, actor) => {
    const { scope, policy } = whatsNewRateLimit(req.method, req.url, !!actor);
    return enforceRequestRateLimit(req, scope, actor?.id, policy);
  },
};
export function httpBoundary(handler: Handler, isPublic = false, deps = defaults) {
  return async (req: HttpRequest, _context?: InvocationContext): Promise<HttpResponseInit> => {
    const headers = { "Cache-Control": isPublic ? "no-store" : "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    try {
      if (!deps.enabled()) throw new WhatsNewError(404, "no_encontrado", "No encontrado.");
      const actor = isPublic ? null : await deps.authenticate(req);
      const limited = await deps.limit(req, actor ?? undefined);
      if (limited) return { ...limited, headers: { ...headers, ...limited.headers } };
      const result = await handler(req, actor);
      if (result && typeof result === "object" && "response" in result) return { ...(result as { response: HttpResponseInit }).response, headers: { ...headers, ...(result as { response: HttpResponseInit }).response.headers } };
      const detail = result && typeof result === "object" && "etag" in result ? (result as { etag: string }).etag : undefined;
      return { status: 200, headers: { ...headers, ...(detail ? { ETag: detail } : {}) }, jsonBody: result };
    } catch (error) {
      if (error instanceof z.ZodError) return { status: 400, headers, jsonBody: { error: error.issues[0]?.message ?? "La solicitud no es válida.", code: "solicitud_invalida" } };
      if (error instanceof WhatsNewError) return { status: error.status, headers, jsonBody: { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) } };
      if (typeof error === "object" && error && "status" in error && error.status === 401) return { status: 401, headers, jsonBody: { error: "No autenticado.", code: "no_autenticado" } };
      return { status: 503, headers, jsonBody: { error: "El servicio de novedades no está disponible.", code: "servicio_no_disponible" } };
    }
  };
}
async function body(req: HttpRequest): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > 600_000) throw new WhatsNewError(413, "contenido_muy_grande", "El contenido supera el tamaño permitido.");
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > 600_000) throw new WhatsNewError(413, "contenido_muy_grande", "El contenido supera el tamaño permitido.");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new WhatsNewError(400, "solicitud_invalida", "El cuerpo JSON no es válido."); }
}
const filters = (req: HttpRequest) => Object.fromEntries(req.query.entries());
const register = (name: string, route: string, methods: string[], handler: Handler, isPublic = false) => app.http(name, {
  route, methods: methods as ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[], authLevel: "anonymous", handler: httpBoundary(handler, isPublic),
});
const param = (req: HttpRequest, name = "id") => req.params[name] ?? "";

register("whatsNewMe", "whats-new/me", ["GET"], (_r, a) => service.me(a!));
register("whatsNewEntries", "whats-new/entries", ["GET", "POST"], async (r, a) => r.method === "GET" ? service.listEntries(a!, filters(r)) : mutation(r, a!, "create", null));
register("whatsNewQueue", "whats-new/queue", ["GET"], (r, a) => service.listEntries(a!, filters(r), true));
register("whatsNewEntry", "whats-new/entries/{id}", ["GET", "DELETE"], (r, a) => r.method === "GET" ? service.getEntry(a!, param(r)) : mutation(r, a!, "delete", param(r)));
const operations = ["draft", "publish", "correct", "take", "release", "force-release", "mark-tested", "mark-failed", "archive", "client-text"] as const;
for (const operation of operations) register(`whatsNewEntry_${operation.replaceAll("-", "_")}`, `whats-new/entries/{id}/${operation}`, [operation === "draft" || operation === "client-text" ? "PUT" : "POST"], (r, a) => mutation(r, a!, operation, param(r)));
for (const operation of ["checklist", "notes", "findings", "note-draft"] as const) register(`whatsNewRound_${operation.replaceAll("-", "_")}`, `whats-new/rounds/{id}/${operation}`,
  [operation === "checklist" ? "PATCH" : operation === "note-draft" ? "PUT" : "POST"], (r, a) => mutation(r, a!, operation, param(r)));
register("whatsNewFindingAnnul", "whats-new/findings/{id}/annul", ["POST"], (r, a) => mutation(r, a!, "annul", param(r)));
async function mutation(req: HttpRequest, actor: WhatsNewActor, operation: Operation, id: string | null) {
  const result = await mutate({ actor, operation, id, body: await body(req), etag: req.headers.get("if-match"), idempotencyKey: req.headers.get("idempotency-key") });
  return { response: { status: operation === "create" ? 201 : operation === "delete" ? 204 : 200,
    headers: { ETag: result.detail.etag, ...(result.replayed ? { "Idempotency-Replayed": "true" } : {}) }, ...(operation === "delete" ? {} : { jsonBody: result.detail }) } };
}
register("whatsNewLookups", "whats-new/lookups/{kind}", ["GET"], (r, a) => service.lookups(a!, param(r, "kind"), r.query.get("q") ?? ""));
register("whatsNewConfig", "whats-new/config", ["GET"], (_r, a) => service.readConfig(a!));
register("whatsNewConfigSettings", "whats-new/config/settings", ["PUT"], async (r, a) => { await service.saveConfig(a!, "settings", null, await body(r), r.headers.get("if-match")); return service.readConfig(a!); });
register("whatsNewConfigActions", "whats-new/config/actions", ["POST"], async (r, a) => { await service.saveConfig(a!, "action-create", null, await body(r), null); return service.readConfig(a!); });
register("whatsNewConfigAction", "whats-new/config/actions/{id}", ["PUT"], async (r, a) => { await service.saveConfig(a!, "action-edit", param(r), await body(r), r.headers.get("if-match")); return service.readConfig(a!); });
register("whatsNewAreas", "whats-new/business-areas", ["GET"], (_r, a) => service.businessAreas(a!, null));
register("whatsNewUserAreas", "whats-new/users/{id}/business-areas", ["GET", "PUT"], async (r, a) => service.businessAreas(a!, param(r), r.method === "PUT" ? await body(r) : undefined, r.headers.get("if-match")));
register("whatsNewReportPreview", "whats-new/reports/preview", ["POST"], async (r, a) => service.previewReport(a!, await body(r)));
register("whatsNewReportsCreate", "whats-new/reports", ["POST"], async (r, a) => {
  requirePermission(a!, access.report); assertIdempotencyKey(r.headers.get("idempotency-key"));
  const input = service.ReportSendInput.parse(await body(r));
  const db = await getSqlPool();
  for (const id of input.recipientIds) {
    const [user] = await query(db, "SELECT source_id FROM security.users WHERE source_id=@id AND active=1;", { id });
    if (!user) throw new WhatsNewError(400, "solicitud_invalida", "Los destinatarios deben ser usuarios activos del portal.");
  }
  return service.pendingStorage(); // no snapshot, outbox or partial SQL writes while disconnected
});
// The HTTP boundary validates any active persisted user; report reading intentionally has no option/area/recipient ACL.
register("whatsNewReportRead", "whats-new/reports/{id}", ["GET"], async () => service.pendingStorage());
register("whatsNewUpload", "whats-new/entries/{id}/uploads", ["POST"], async (r, a) => { await service.getEntry(a!, param(r)); return service.pendingStorage(); });
register("whatsNewUploadComplete", "whats-new/entries/{id}/uploads/{fileId}/complete", ["POST"], async (r, a) => { await service.getEntry(a!, param(r)); return service.pendingStorage(); });
register("whatsNewFileRead", "whats-new/files/{id}", ["GET"], async () => service.pendingStorage());
register("whatsNewPublic", "public/novedades", ["GET"], (r) => service.publicNews(filters(r)), true);
register("whatsNewPublicDetail", "public/novedades/{id}", ["GET"], (r) => service.publicNews({}, param(r)), true);
register("whatsNewPublicImage", "public/novedades/{publicId}/imagenes/{fileId}", ["GET"], async () => service.pendingStorage(), true);
