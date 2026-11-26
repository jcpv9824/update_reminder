import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChecklistError } from "../lib/checklistDomain";
import { TemplateEntityIdSchema } from "../lib/checklistTemplateSchemas";
import { authenticateChecklistRequest } from "./implementationChecklists";
import { createChecklistEvidenceService, type ChecklistEvidenceService } from "../lib/checklistEvidenceService";
import { createChecklistEvidenceSqlStore } from "../lib/checklistEvidenceSqlRepository";
import { checklistEvidenceStorage } from "../lib/checklistEvidenceStorage";
import { assertChecklistEvidenceSize, readChecklistEvidenceLimits, type ChecklistEvidenceBinaryKind } from "../lib/checklistEvidenceValidation";
import { buildObjectContentDisposition } from "../lib/objectStorage";
import { enforceRequestRateLimit } from "../lib/rateLimit";
import type { ChecklistActor } from "../lib/checklistSqlRepository";
const invalid = () => new ChecklistError(400, "invalid_evidence", "Envíe un tipo de evidencia válido y un solo archivo.");
async function boundedBody(req: HttpRequest, maximum: number): Promise<Uint8Array> {
  const raw = req.headers.get("content-length");
  if (raw !== null && (!/^[0-9]+$/.test(raw) || Number(raw) > maximum)) throw new ChecklistError(413, "too_large", "El cuerpo de la carga supera el límite permitido.");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { void reader.cancel().catch(() => undefined); throw new ChecklistError(413, "too_large", "El cuerpo de la carga supera el límite permitido."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let at = 0;
  for (const part of parts) { body.set(part, at); at += part.byteLength; }
  return body;
}
/** Endpoint-local bounds, no app.setup, worker setting, direct-upload URL or
 * host cap change. The 100 MB video boundary must still be proven in QA. */
export async function parseChecklistEvidenceMultipart(req: HttpRequest) {
  const limits = readChecklistEvidenceLimits(), maximum = Math.max(limits.image, limits.file, limits.video) + 65_536;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.length > 140 || !/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw invalid();
  const bytes = await boundedBody(req, maximum);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "content-type": contentType } }).formData(); } catch { throw invalid(); }
  if ([...form.keys()].length !== 2 || form.getAll("kind").length !== 1 || form.getAll("file").length !== 1) throw invalid();
  const kind = form.get("kind"), file = form.get("file");
  if ((kind !== "image" && kind !== "video" && kind !== "file") || !file || typeof file === "string") throw invalid();
  assertChecklistEvidenceSize(kind, file.size, limits);
  return { kind: kind as ChecklistEvidenceBinaryKind, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
}
let transferring = false;
export async function withChecklistEvidenceTransfer<T>(operation: () => Promise<T>): Promise<T> {
  if (transferring) throw new ChecklistError(503, "transfer_busy", "Hay una transferencia privada en curso. Intente de nuevo.");
  transferring = true;
  try { return await operation(); } finally { transferring = false; }
}
export type ChecklistEvidenceHttpDependencies = {
  authenticate(req: HttpRequest): Promise<ChecklistActor | null>; service: ChecklistEvidenceService;
  limit?(req: HttpRequest, actor: ChecklistActor, upload: boolean): Promise<HttpResponseInit | null>;
};
export function createChecklistEvidenceHandlers(deps: ChecklistEvidenceHttpDependencies) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  const wrap = (upload: boolean, work: (req: HttpRequest, actor: ChecklistActor) => Promise<HttpResponseInit>) => async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const actor = await deps.authenticate(req);
      if (!actor) throw new ChecklistError(401, "unauthenticated", "No autenticado.");
      if (!actor.canView && !actor.isSuperAdmin) throw new ChecklistError(403, "forbidden", "No tiene permiso para ver checklists.");
      const limited = await deps.limit?.(req, actor, upload); if (limited) return { ...limited, headers: { ...headers, ...limited.headers } };
      const response = await withChecklistEvidenceTransfer(() => work(req, actor));
      return { ...response, headers: { ...headers, ...response.headers } };
    } catch (error) {
      if (error instanceof ChecklistError) return { status: error.status, headers, jsonBody: { error: error.error, message: error.message, ...(error.details ? { details: error.details } : {}) } };
      if (error instanceof z.ZodError) return { status: 400, headers, jsonBody: { error: "invalid_evidence", message: "Los datos de la evidencia no son válidos." } };
      if (typeof error === "object" && error && "status" in error && error.status === 401) return { status: 401, headers, jsonBody: { error: "unauthenticated", message: "No autenticado." } };
      return { status: 503, headers, jsonBody: { error: "storage_unavailable", message: "No se pudo completar la operación de evidencia privada." } };
    }
  };
  return {
    create: wrap(true, async (req, actor) => {
      const id = TemplateEntityIdSchema.parse(req.params.id), pointId = TemplateEntityIdSchema.parse(req.params.pointId);
      await deps.service.preflight(actor, id, pointId); // authorization before body consumption
      const contentType = req.headers.get("content-type") ?? "";
      if (/^application\/json(?:\s*;|$)/i.test(contentType)) {
        let json: unknown;
        try { json = JSON.parse(Buffer.from(await boundedBody(req, 16_384)).toString("utf8")); } catch (error) { if (error instanceof ChecklistError) throw error; throw invalid(); }
        return { status: 201, jsonBody: await deps.service.createJson(actor, id, pointId, json) };
      }
      const file = await parseChecklistEvidenceMultipart(req);
      return { status: 201, jsonBody: await deps.service.createBinary(actor, id, pointId, file.kind, file.name, file.bytes) };
    }),
    content: wrap(false, async (req, actor) => {
      const file = await deps.service.content(actor, TemplateEntityIdSchema.parse(req.params.id));
      return { status: 200, body: file.bytes, headers: { "Content-Type": file.contentType, "Content-Length": String(file.bytes.length),
        "Content-Disposition": buildObjectContentDisposition(file.disposition, file.fileName),
        "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'", "X-Download-Options": "noopen" } };
    }),
  };
}
export function registerChecklistEvidenceRoutes(): void {
  const handlers = createChecklistEvidenceHandlers({ authenticate: authenticateChecklistRequest,
    service: createChecklistEvidenceService({ store: createChecklistEvidenceSqlStore(), storage: checklistEvidenceStorage, newId: randomUUID, now: () => new Date() }),
    limit: (req, actor, upload) => enforceRequestRateLimit(req, upload ? "checklist_evidence_upload" : "checklist_evidence_read", actor.id, { maxAttempts: upload ? 6 : 120, windowSeconds: 60, blockSeconds: 60 }),
  });
  app.http("checklistEvidenceUpload", { route: "implementation/checklists/{id}/points/{pointId}/evidence", authLevel: "anonymous", methods: ["POST"], handler: handlers.create });
  app.http("checklistEvidenceContent", { route: "implementation/checklists/evidence/{id}/content", authLevel: "anonymous", methods: ["GET"], handler: handlers.content });
}
