import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const schema = z.strictObject({ reviewId: z.string().regex(uuid) });
export type CatalogCopyRequester = { actorId: string; actorEmail: string;
  allowedKinds: readonly ("domain" | "database")[]; allowLicensing: boolean };
type Outcome = { id: string; status: "created" | "replayed" };

/** Requester-only. Neither reviewer identity nor any schedule fields cross this boundary. */
export function createCatalogScheduleCopyActivateHttp(io: {
  authorize(request: HttpRequest): Promise<CatalogCopyRequester | { status: 401 | 403 }>;
  activate(actor: CatalogCopyRequester, proposalId: string, reviewId: string): Promise<Outcome | null>;
  subject?: "copia" | "programación";
}) {
  const reply = (status: number, jsonBody: unknown): HttpResponseInit =>
    ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
  const unavailable = () => reply(409, { error: "La revisión o la selección ya no se puede verificar." });
  return async (request: HttpRequest) => {
    try {
      const actor = await io.authorize(request);
      if ("status" in actor) return reply(actor.status, { error: `No tiene acceso a la ${io.subject ?? "copia"}.` });
      const { proposalId } = request.params;
      if (!proposalId || !uuid.test(proposalId)) return reply(400, { error: "Indique una solicitud y revisión válidas." });
      const declaredLength = request.headers.get("content-length");
      if (declaredLength && (!/^\d{1,5}$/.test(declaredLength) || Number(declaredLength) > 1024)) return reply(413, { error: "Solicitud demasiado grande." });
      let input: unknown;
      try {
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 1024) return reply(413, { error: "Solicitud demasiado grande." });
        input = JSON.parse(raw);
      } catch { return reply(400, { error: "Solicitud inválida." }); }
      const parsed = schema.safeParse(input);
      if (!parsed.success) return reply(400, { error: "Indique una revisión válida." });
      const result = await io.activate(actor, proposalId, parsed.data.reviewId);
      return result ? reply(result.status === "created" ? 201 : 200, { id: result.id, status: result.status }) : unavailable();
    } catch (error) {
      if ((error as { status?: number } | null)?.status === 409) return unavailable();
      return reply(503, { error: `No fue posible activar la ${io.subject ?? "copia"} ahora.` });
    }
  };
}
