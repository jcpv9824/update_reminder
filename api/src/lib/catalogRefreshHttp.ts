import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { badRequest, forbidden, notFound, ok, unauthorized } from "./http";
import type { CatalogRefreshScope, CatalogRefreshSettings, CatalogRefreshStatus } from "./catalogRefreshQueueSqlRepository";
import { catalogSourceIdSchema } from "./catalogSourceId";

const sourceIdsSchema = z.array(catalogSourceIdSchema).max(50)
  .refine(values => new Set(values).size === values.length);
const requestSchema = z.object({ sourceIds: sourceIdsSchema.optional() }).strict();
type Method = "request" | "status";
type Dependencies = {
  enabled: () => boolean;
  configuration: () => CatalogRefreshSettings | null;
  authorize: (request: HttpRequest) => Promise<{ actorId: string } | { status: 401 | 403 }>;
  rateLimit: (request: HttpRequest, actorId: string, method: Method) => Promise<HttpResponseInit | null>;
  enqueue: (input: CatalogRefreshScope & CatalogRefreshSettings) => Promise<{ accepted: number; coalesced: number } | null>;
  status: (input: CatalogRefreshScope & CatalogRefreshSettings) => Promise<CatalogRefreshStatus | null>;
};
const problem = (): HttpResponseInit => ({ status: 503, jsonBody: { error: "La actualización del catálogo no está disponible." } });
const invalid = () => badRequest("La selección de fuentes no es válida.");

export function createCatalogRefreshHttp(io: Dependencies) {
  return async (request: HttpRequest, method: Method): Promise<HttpResponseInit> => {
    if (!io.enabled()) return notFound();
    try {
      const actor = await io.authorize(request);
      if ("status" in actor) return actor.status === 401 ? unauthorized() : forbidden();
      const config = io.configuration();
      if (!config) return problem();
      const rateLimited = await io.rateLimit(request, actor.actorId, method);
      if (rateLimited) return rateLimited;
      if (method === "request") {
        // IDs only. No client-supplied binding, version, actor, environment, origin or secret.
        let text: string;
        try { text = await request.text(); } catch { return invalid(); }
        if (text.length > 4096 || [...request.query.keys()].length) return invalid();
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { return invalid(); }
        const input = requestSchema.safeParse(raw);
        if (!input.success) return invalid();
        if (input.data.sourceIds?.length === 0) return { status: 202, jsonBody: { accepted: 0, coalesced: 0 } };
        const result = await io.enqueue({ ...config, actorId: actor.actorId, sourceIds: input.data.sourceIds });
        return result === null ? forbidden() : { status: 202, jsonBody: { accepted: result.accepted, coalesced: result.coalesced } };
      }
      if ([...request.query.keys()].some(key => key !== "sourceIds") || request.query.getAll("sourceIds").length > 1) return invalid();
      const raw = request.query.get("sourceIds");
      if (raw !== null && raw.length > 50 * 37) return invalid();
      const input = sourceIdsSchema.optional().safeParse(raw === null ? undefined : raw === "" ? [] : raw.split(","));
      if (!input.success) return invalid();
      const result = await io.status({ ...config, actorId: actor.actorId, sourceIds: input.data });
      if (result === null) return forbidden();
      return { ...ok({ pending: result.pending, items: result.items.map(({ sourceId, status, updatedAt }) => ({ sourceId, status, updatedAt })) }),
        headers: { "Cache-Control": "private, no-store" } };
    } catch { return problem(); }
  };
}
