import { api } from "../../api/client";
import type { DatosFormulario, DocEnriquecido, EstadoEntrada, Sistema, TipoEntrada } from "./tipos";

export type Me = { user: { id: string; displayName: string; email: string }; views: string[]; defaultView: string | null; areas: string[]; permissions: string[]; publicEnabled: boolean; storageAvailable: boolean; clientCatalogAvailable: boolean };
export type RouteDto = { via: "barra_lateral" | "barra_navegacion"; submenus: string[]; option: string };
export type ActionDto = { code: string; label: string; detail: DocEnriquecido | null };
export type AttachmentDto = { group: "reglas_negocio" | "video"; kind: "enlace"; url: string; label?: string | null } | { group: "reglas_negocio" | "video"; kind: "archivo"; fileId: string };
export type RoundDto = { id: string; roundNo: number; revisionNo: number; holderId: string; holderName: string; status: string; etag: string; takenAt: string | null; closedAt: string | null; checklist: { itemNo: number; label: string; checked: boolean }[]; notes: { id: string; body: DocEnriquecido; createdAt: string; createdById: string }[]; noteDraft: DocEnriquecido | null };
export type EntryDto = { id: string; number: string; status: EstadoEntrada; type: TipoEntrada | null; system: Sistema | null; developer: { id: string; displayName: string }; clientName: string | null; initialTesterId: string | null; whatChanged: DocEnriquecido | null; summary: string | null; primaryRoute: string | null; routes: RouteDto[]; requiredActions: ActionDto[]; attachments: AttachmentDto[]; rounds: RoundDto[]; findings: { id: string; number: number; roundNo: number; body: DocEnriquecido; createdById: string; annulled: { reason: string; at: string } | null }[]; participants: { id: string; displayName: string; role: string }[]; log: { action: string; byId: string; at: string; reason: string | null }[]; revisions: { revisionNo: number; kind: string; correctionNote: DocEnriquecido | null; publishedAt: string }[]; clientText: { showToClients: boolean; title: string | null; body: DocEnriquecido | null; etag: string } | null; etag: string; createdAt: string; updatedAt: string; releaseMonth: string | null };
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type EntrySummary = Pick<EntryDto, "id" | "number" | "status" | "type" | "system" | "developer" | "summary" | "primaryRoute" | "initialTesterId" | "etag" | "createdAt" | "updatedAt" | "releaseMonth"> & { holder: { id: string; displayName: string } | null; checklistDone: number; checklistTotal: number; openFindings: number; resultAt: string | null };
export type PublicItem = { publicId: string; category: string; releaseMonth: string; title: string; summary: string; whereToFind: string };
export type PublicDetail = PublicItem & { body: DocEnriquecido };
export type UserLookup = { id: string; displayName: string; email?: string; active?: boolean };
export type ErpClientLookup = { id: string; label: string };
export type ConfigDto = { settings: { publicEnabled: boolean; etag: string }; actions: { id: string; code: string; label: string; active: boolean; sortOrder: number; isOther: boolean; etag: string }[]; publicUrl: string };
export type ReportPreview = { html: string; entryCount: number; approvedCount: number; failedCount: number };
export type ReportInput = { include: "todas" | "aprobadas" | "fallidas"; filters?: Record<string, string> };
type Filters = Record<string, string | number | undefined>;
const query = (filters: Filters) => new URLSearchParams(Object.entries(filters).filter(([,v]) => v !== undefined && v !== "").map(([k,v]) => [k, String(v)])).toString();
export function mutationOptions(etag?: string, persistent = false, idempotencyKey?: string) { return { headers: { ...(etag ? { "If-Match": etag } : {}), ...(persistent ? { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() } : {}) } }; }
export const whatsNewApi = {
  me: () => api.get<Me>("/whats-new/me"),
  list: (filters: Filters, queue = false) => api.get<Page<EntrySummary>>(`/whats-new/${queue ? "queue" : "entries"}?${query(filters)}`),
  detail: (id: string) => api.get<EntryDto>(`/whats-new/entries/${encodeURIComponent(id)}`),
  draft: (body: ReturnType<typeof draftFromForm>, entry?: EntryDto, createKey?: string) => entry ? api.put<EntryDto>(`/whats-new/entries/${entry.id}/draft`, body, mutationOptions(entry.etag)) : api.post<EntryDto>("/whats-new/entries", body, mutationOptions(undefined, true, createKey)),
  command: (id: string, action: string, etag: string, body: unknown = {}) => api.post<EntryDto>(`/whats-new/entries/${encodeURIComponent(id)}/${action}`, body, mutationOptions(etag, true)),
  lookup: <T = UserLookup>(kind: string, q = "") => api.get<T[]>(`/whats-new/lookups/${kind}?${query({ q })}`),
  lookupErpClients: (q: string) => api.get<ErpClientLookup[]>(`/whats-new/lookups/clients?${query({ q })}`),
  preview: (body: ReportInput) => api.post<ReportPreview>("/whats-new/reports/preview", body),
  send: (body: ReportInput & { recipientIds: string[] }) => api.post<{ id: string }>("/whats-new/reports", body, mutationOptions(undefined, true)),
  publicList: (filters: Filters) => api.get<Page<PublicItem> & { enabled: boolean }>(`/public/novedades?${query({ pageSize: 20, ...filters })}`),
  publicDetail: (id: string) => api.get<PublicDetail>(`/public/novedades/${encodeURIComponent(id)}`),
};

/** One session per mounted form/actor. Resolve an uncertain create before updating
 * changed input: replay the original body and key, then PUT the latest form to
 * that same entry. Never retain draft contents globally or in browser storage. */
export function createDraftSaveSession() {
  type Draft = ReturnType<typeof draftFromForm>;
  let pending: { body: Draft; serialized: string; key: string } | undefined;
  let created: EntryDto | undefined;
  return async (body: Draft, entry?: EntryDto): Promise<EntryDto> => {
    const existing = entry ?? created;
    if (existing) { const result = await whatsNewApi.draft(body, existing); created = result; return result; }
    const serialized = JSON.stringify(body);
    pending ??= { body: JSON.parse(serialized) as Draft, serialized, key: crypto.randomUUID() };
    const original = pending;
    // Retain original state for uncertain outcomes (network/5xx/timeouts). Only
    // explicit validation or pre-mutation denials permit a corrected new POST.
    try { created = await whatsNewApi.draft(original.body, undefined, original.key); }
    catch (error) {
      const status = (error as { status?: number }).status;
      if (status && [400, 401, 403, 404, 413, 415, 422, 428, 429].includes(status)) pending = undefined;
      throw error;
    }
    pending = undefined;
    if (serialized !== original.serialized) created = await whatsNewApi.draft(body, created);
    return created;
  };
}

export function draftFromForm(data: DatosFormulario, clientId?: string | null) {
  const isNew = data.tipo === "nuevo";
  return { type: data.tipo, system: data.sistema,
    routes: data.rutas.map(r => ({ via: r.niveles[0]?.valor === "Barra lateral" ? "barra_lateral" as const : "barra_navegacion" as const, submenus: r.niveles.slice(1, -1).map(l => l.valor.trim()), option: r.niveles.at(-1)?.valor.trim() ?? "" })),
    whatChanged: data.queCambio, requiredActions: data.acciones.map(a => ({ actionCode: a.accionId, detail: a.texto })),
    ...(isNew && clientId !== undefined ? { clientId } : {}), initialTesterId: isNew ? data.asesorInicialId || null : null,
    attachments: isNew ? [...data.reglasNegocio.map(a => ({ group: "reglas_negocio" as const, kind: "enlace" as const, url: a.url, label: a.nombre })), ...data.videos.map(a => ({ group: "video" as const, kind: "enlace" as const, url: a.url, label: a.nombre }))] : [],
  };
}
export function formFromEntry(e: EntryDto): DatosFormulario { return { tipo: e.type, sistema: e.system, rutas: e.routes.map((r,i) => ({ id: `route-${i}`, niveles: [{ valor: r.via === "barra_lateral" ? "Barra lateral" : "Barra de navegación" }, ...r.submenus.map(valor => ({ valor })), { valor: r.option }] })), queCambio: e.whatChanged, acciones: e.requiredActions.map(a => ({ accionId: a.code, nombre: a.label, texto: a.detail })), cliente: e.clientName ?? "", asesorInicialId: e.initialTesterId ?? "", reglasNegocio: e.attachments.filter(a => a.group === "reglas_negocio" && a.kind === "enlace").map((a,i) => ({ id: `rules-${i}`, clase: "enlace", nombre: a.kind === "enlace" ? a.label ?? "" : "", url: a.kind === "enlace" ? a.url : "" })), videos: e.attachments.filter(a => a.group === "video" && a.kind === "enlace").map((a,i) => ({ id: `video-${i}`, clase: "enlace", nombre: a.kind === "enlace" ? a.label ?? "" : "", url: a.kind === "enlace" ? a.url : "" })) }; }

/** Rendering boundary: no network-bearing file nodes while storage is pending. Public content also excludes code and mentions, never copies private prose automatically. */
export function safeDisplayDoc(doc: DocEnriquecido | null, publicProfile = false): DocEnriquecido | null {
  if (!doc) return null;
  function clean(node: DocEnriquecido, depth: number): DocEnriquecido | null {
    if (depth > 10 || ["image", "adjuntoArchivo"].includes(node.type ?? "") || (publicProfile && ["mencion", "codeBlock"].includes(node.type ?? ""))) return null;
    if (publicProfile && node.marks?.some(m => m.type === "code")) return null;
    const allowed = ["doc", "paragraph", "text", "heading", "bulletList", "orderedList", "listItem", "blockquote", "hardBreak", "horizontalRule", "codeBlock", "mencion"];
    if (!allowed.includes(node.type ?? "")) return null;
    const marks = node.marks?.flatMap(m => {
      if (["bold", "italic", "underline", "strike", ...(!publicProfile ? ["code"] : [])].includes(m.type)) return [{ type: m.type }];
      if (m.type === "textStyle" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(m.attrs?.color ?? "")) return [{ type: "textStyle", attrs: { color: m.attrs?.color } }];
      if (m.type === "link") { try { const u = new URL(m.attrs?.href); if (["https:", "http:", ...(!publicProfile ? ["mailto:"] : [])].includes(u.protocol) && !u.username && !u.password) return [{ type: "link", attrs: { href: u.href } }]; } catch { /* unsafe URL omitted */ } }
      return [];
    });
    return { type: node.type, ...(node.text !== undefined ? { text: node.text } : {}), ...(node.attrs && ["heading", "orderedList", "mencion"].includes(node.type ?? "") ? { attrs: node.attrs } : {}), ...(marks?.length ? { marks } : {}), ...(node.content ? { content: node.content.slice(0, 3000).map(n => clean(n, depth + 1)).filter((n): n is DocEnriquecido => !!n) } : {}) };
  }
  return clean(doc, 0);
}
export const storagePending = "El almacenamiento de archivos todavía no está conectado. Las imágenes, documentos y videos no se pueden subir ni descargar todavía.";
export function errorMessage(error: unknown) { const e = error as Error & { status?: number }; return e.status === 409 ? "Otra persona modificó esta información. Recarga para ver la versión vigente; tus cambios no se han enviado." : e.message || "No fue posible completar la operación."; }
