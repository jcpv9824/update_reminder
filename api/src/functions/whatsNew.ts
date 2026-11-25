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
import { listSavedReports, readSavedReport, savePrivateReport, withdrawSavedReport } from "../lib/whatsNewSavedReports";
import { buildObjectContentDisposition } from "../lib/objectStorage";
import {
  WHATS_NEW_UPLOAD_BODY_MAX, assertWhatsNewMediaSize, inspectWhatsNewMedia, parseWhatsNewMediaFields,
  preflightWhatsNewUpload, readWhatsNewMedia, uploadWhatsNewMedia,
} from "../lib/whatsNewMedia";

type Handler = (req: HttpRequest, actor: WhatsNewActor | null) => Promise<unknown>;
export function whatsNewRateLimit(method: string, url: string, authenticated: boolean) {
  const path = new URL(url, "https://portal.invalid").pathname;
  const mediaUpload = authenticated && method === "POST" && /\/whats-new\/entries\/[^/]+\/uploads$/.test(path);
  const mediaRead = authenticated && method === "GET" && /\/whats-new\/files\/[^/]+$/.test(path);
  if (mediaUpload || mediaRead) return { scope: mediaUpload ? "whats_new_media_write" : "whats_new_media_read",
    policy: { maxAttempts: mediaUpload ? 6 : 32, windowSeconds: 60, blockSeconds: 60 } };
  const preview = authenticated && method === "POST" && /\/reports\/(preview|saved)$/.test(path);
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
    const [roleDefinitions, areas] = await Promise.all([loadRoleDefinitions(), areasFor(profile.id)]);
    return buildActor(profile, roleDefinitions, areas);
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
register("whatsNewSavedReports", "whats-new/reports/saved", ["GET", "POST"], async (r, a) => {
  if (r.method === "GET") return listSavedReports(a!, filters(r));
  requirePermission(a!, access.savedReports);
  const key = assertIdempotencyKey(r.headers.get("idempotency-key"));
  const result = await savePrivateReport(a!, await body(r), key);
  return { response: { status: result.replayed ? 200 : 201, jsonBody: { id: result.id },
    headers: result.replayed ? { "Idempotency-Replayed": "true" } : {} } };
});
register("whatsNewReportRead", "whats-new/reports/{id}", ["GET", "DELETE"], async (r, a) => {
  if (r.method === "DELETE") {
    requirePermission(a!, access.savedReports);
    z.object({}).strict().parse(await body(r));
    await withdrawSavedReport(a!, param(r));
    return { response: { status: 204 } };
  }
  return { response: { status: 200, body: await readSavedReport(a!, param(r)), headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  } } };
});
export async function parseWhatsNewMultipart(req: HttpRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  const declared = req.headers.get("content-length");
  const tooBig = () => new WhatsNewError(413, "contenido_muy_grande", "El archivo supera el tamaño permitido.");
  const invalid = () => new WhatsNewError(400, "archivo_invalido", "Envíe un archivo y su sección de destino.");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > WHATS_NEW_UPLOAD_BODY_MAX)) throw tooBig();
  if (contentType.length > 140 || !/^multipart\/form-data;\s*boundary=/i.test(contentType) || !req.body) throw invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > WHATS_NEW_UPLOAD_BODY_MAX) {
        void reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try {
    const payload = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { payload.set(chunk, position); position += chunk.byteLength; }
    form = await new Response(payload, { headers: { "content-type": contentType } }).formData();
  } catch { throw invalid(); }
  if ([...form.keys()].length !== 3 || form.getAll("kind").length !== 1 || form.getAll("target").length !== 1 ||
      form.getAll("file").length !== 1) throw invalid();
  const fields = parseWhatsNewMediaFields(form.get("kind"), form.get("target"));
  const file = form.get("file");
  if (!file || typeof file === "string") throw invalid();
  assertWhatsNewMediaSize(fields.kind, file.size);
  return inspectWhatsNewMedia(fields, file.name, Buffer.from(await file.arrayBuffer()));
}
let activeMediaTransfers = 0;
export async function withWhatsNewMediaSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeMediaTransfers >= 2) throw new WhatsNewError(503, "archivo_en_proceso", "Hay otras transferencias en curso. Intente de nuevo.");
  activeMediaTransfers++;
  try { return await operation(); }
  finally { activeMediaTransfers--; }
}
register("whatsNewUpload", "whats-new/entries/{id}/uploads", ["POST"], async (r, a) => {
  const id = param(r);
  const key = assertIdempotencyKey(r.headers.get("idempotency-key"));
  await preflightWhatsNewUpload(a!, id);
  return withWhatsNewMediaSlot(async () => {
    const { replayed, ...file } = await uploadWhatsNewMedia(a!, id, key, await parseWhatsNewMultipart(r));
    return { response: { status: replayed ? 200 : 201, jsonBody: file,
      ...(replayed ? { headers: { "Idempotency-Replayed": "true" } } : {}) } };
  });
});
register("whatsNewUploadComplete", "whats-new/entries/{id}/uploads/{fileId}/complete", ["POST"], async (r, a) => { await service.getEntry(a!, param(r)); return service.pendingStorage(); });
register("whatsNewFileRead", "whats-new/files/{id}", ["GET"], async (r, a) => withWhatsNewMediaSlot(async () => {
  const file = await readWhatsNewMedia(a!, param(r));
  return { response: { status: 200, body: file.bytes, headers: {
    "Content-Type": file.mime, "Content-Length": String(file.bytes.length),
    "Content-Disposition": buildObjectContentDisposition(file.kind === "documento" ? "attachment" : "inline", file.name),
  } } };
}));
register("whatsNewPublic", "public/novedades", ["GET"], (r) => service.publicNews(filters(r)), true);
register("whatsNewPublicDetail", "public/novedades/{id}", ["GET"], (r) => service.publicNews({}, param(r)), true);
register("whatsNewPublicImage", "public/novedades/{publicId}/imagenes/{fileId}", ["GET"], async () => service.pendingStorage(), true);
