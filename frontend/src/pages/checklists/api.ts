import { api, type ApiError } from "../../api/client";
import type { SaveVersion, TemplateDetail, TemplateSummary, VersionDetail } from "./types";
import type { ChecklistDetail, ChecklistList, CreateChecklist, SaveChecklist, RichDoc, Evidence } from "./types";
const base = "/configuration/checklist-templates";
/** Shared client keeps machine error in data.error. Do not display it as Spanish prose. */
export function checklistMessage(error: unknown): string {
  const e = error as ApiError;
  return typeof e?.data?.message === "string" ? e.data.message : e?.message ?? "No se pudo completar la operación.";
}
export const templatesApi = {
  list: () => api.get<{ items: TemplateSummary[] }>(base),
  create: (name: string) => api.post<TemplateDetail>(base, { name: name.trim() }),
  detail: (id: string) => api.get<TemplateDetail>(`${base}/${encodeURIComponent(id)}`),
  remove: (id: string) => api.del<void>(`${base}/${encodeURIComponent(id)}`),
  createVersion: (id: string) => api.post<VersionDetail>(`${base}/${encodeURIComponent(id)}/versions`),
  version: (id: string, number: number) => api.get<VersionDetail>(`${base}/${encodeURIComponent(id)}/versions/${number}`),
  saveVersion: (id: string, number: number, body: SaveVersion) => api.put<VersionDetail>(`${base}/${encodeURIComponent(id)}/versions/${number}`, body),
  publish: (id: string, number: number) => api.post<VersionDetail>(`${base}/${encodeURIComponent(id)}/versions/${number}/publish`),
  removeVersion: (id: string, number: number) => api.del<void>(`${base}/${encodeURIComponent(id)}/versions/${number}`),
};
const checklistsBase = "/implementation/checklists";
// Match the API's bounded one-transfer storage lane. Abort is checked before a
// queued request starts so an unmounted actor cannot initiate a later transfer.
let evidenceTransfer: Promise<unknown> = Promise.resolve();
const queueEvidence = <T,>(work: () => Promise<T>): Promise<T> => { const task = evidenceTransfer.then(work); evidenceTransfer = task.then(() => undefined, () => undefined); return task; };
/** View-only image URLs (including blob URLs) never cross the save boundary. */
export function checklistNotesForSave(doc: RichDoc | null): RichDoc | null {
  if (!doc) return null;
  const visit = (node: RichDoc): RichDoc => {
    const { src: _src, ...imageAttrs } = node.attrs ?? {};
    return { ...node, ...(node.type === "image" && node.attrs ? { attrs: imageAttrs } : {}), ...(node.content ? { content: node.content.map(visit) } : {}) };
  };
  return visit(doc);
}
const saveBody = (body: SaveChecklist): SaveChecklist => ({ ...body, points: body.points.map(p => ({ ...p, notes: checklistNotesForSave(p.notes) })) });
export const checklistsApi = {
  list: (filters: { status?: string; q?: string; page?: number } = {}) => api.get<ChecklistList>(`${checklistsBase}?${new URLSearchParams(Object.entries(filters).filter(([,v]) => v !== undefined && v !== "").map(([k,v]) => [k, String(v)]))}`),
  clients: async (q: string, signal?: AbortSignal) => {
    if ((q.match(/\p{L}/gu)?.length ?? 0) < 3) return [];
    const response = await api.get<{ items: { id: string; name: string }[] }>(`${checklistsBase}/client-search?${new URLSearchParams({ q: q.trim() })}`, { signal });
    return response.items.slice(0, 20).map(c => ({ id: c.id, label: c.name }));
  },
  create: (body: CreateChecklist) => api.post<ChecklistDetail>(checklistsBase, body),
  detail: (id: string) => api.get<ChecklistDetail>(`${checklistsBase}/${encodeURIComponent(id)}`),
  save: (id: string, body: SaveChecklist) => api.put<ChecklistDetail>(`${checklistsBase}/${encodeURIComponent(id)}`, saveBody(body)),
  complete: (id: string, body: SaveChecklist) => api.post<ChecklistDetail>(`${checklistsBase}/${encodeURIComponent(id)}/complete`, saveBody(body)),
  reopen: (id: string) => api.post<ChecklistDetail>(`${checklistsBase}/${encodeURIComponent(id)}/reopen`),
  remove: (id: string) => api.del<void>(`${checklistsBase}/${encodeURIComponent(id)}`),
  addEvidence: (id: string, pointId: string, input: { kind: "link"; url: string } | { kind: "text"; text: string }) => api.post<Evidence>(`${checklistsBase}/${encodeURIComponent(id)}/points/${encodeURIComponent(pointId)}/evidence`, input),
  uploadEvidence: (id: string, pointId: string, kind: "image" | "video" | "file", file: File, signal?: AbortSignal) => {
    const limits = { image: 10, video: 100, file: 25 };
    if (!file.size) return Promise.reject(new Error("El archivo no puede estar vacío."));
    if (file.size > limits[kind] * 1_000_000) return Promise.reject(new Error(`El archivo supera el límite de ${limits[kind]} MB.`));
    if (kind === "image" && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) return Promise.reject(new Error("Seleccione una imagen PNG, JPG, GIF o WEBP."));
    if (kind === "video" && !["video/mp4", "video/webm", "video/quicktime"].includes(file.type)) return Promise.reject(new Error("Seleccione un video MP4, WEBM o MOV."));
    const form = new FormData(); form.set("kind", kind); form.set("file", file);
    return queueEvidence(() => { signal?.throwIfAborted(); return api.postForm<Evidence>(`${checklistsBase}/${encodeURIComponent(id)}/points/${encodeURIComponent(pointId)}/evidence`, form, signal ? { signal } : undefined); });
  },
  evidenceContent: (id: string, signal?: AbortSignal) => queueEvidence(() => { signal?.throwIfAborted(); return api.getBlob(`${checklistsBase}/evidence/${encodeURIComponent(id)}/content`, { credentials: "include", ...(signal ? { signal } : {}) }); }),
};
