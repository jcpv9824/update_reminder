import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PrivateImageReaderContext } from "../queHayDeNuevo/componentes/archivosPrivados";
import { checklistsApi } from "./api";
import { ChecklistDialog, ErrorNotice } from "./components";
import type { Evidence, RichDoc } from "./types";
const safeLink = (url: string | undefined) => { try { const u = new URL(url ?? ""); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function PointMediaProvider({ checklistId, pointId, evidence, children }: { checklistId: string; pointId: string; evidence: Evidence[]; children: ReactNode }) {
  const ids = evidence.filter(e => e.kind === "image" && e.pointId === pointId).map(e => e.id).sort().join(",");
  const reader = useMemo(() => { const own = new Set(ids.split(",")); return async (id: string, signal: AbortSignal) => { if (!uuid.test(id) || !own.has(id)) throw new Error("Imagen no disponible para este punto."); return checklistsApi.evidenceContent(id, signal); }; }, [checklistId, pointId, ids]);
  return <PrivateImageReaderContext.Provider value={reader}>{children}</PrivateImageReaderContext.Provider>;
}
function EvidenceImage({ evidence }: { evidence: Evidence }) {
  const [media, setMedia] = useState<{ id: string; url: string }>(); const [error, setError] = useState(false); const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!uuid.test(evidence.id)) return;
    const control = new AbortController(); let url: string | undefined;
    setError(false);
    void checklistsApi.evidenceContent(evidence.id, control.signal).then(blob => { if (control.signal.aborted) return; if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(blob.type)) throw new Error(); url = URL.createObjectURL(blob); setMedia({ id: evidence.id, url }); }).catch(() => { if (!control.signal.aborted) setError(true); });
    return () => { control.abort(); if (url) URL.revokeObjectURL(url); };
  }, [evidence.id, attempt]);
  return <>{media?.id === evidence.id ? <button type="button" className="checklists-thumbnail" onClick={() => setOpen(true)}><img src={media.url} alt={evidence.fileName ?? "Imagen de evidencia"} style={{ maxHeight: "48px", maxWidth: "64px" }} /></button> : <span>{error ? <>Imagen no disponible <button type="button" onClick={() => setAttempt(n => n + 1)}>Reintentar imagen</button></> : "Cargando imagen…"}</span>}{open && media && <ChecklistDialog title={evidence.fileName ?? "Imagen de evidencia"} close={() => setOpen(false)}><img src={media.url} alt={evidence.fileName ?? "Imagen de evidencia"} style={{ maxWidth: "100%" }} /></ChecklistDialog>}</>;
}
function EvidenceDownload({ evidence }: { evidence: Evidence }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const request = useRef<AbortController>(); const urls = useRef<Set<string>>(new Set());
  useEffect(() => () => { request.current?.abort(); urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear(); }, []);
  return <><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { const control = new AbortController(); request.current = control; const bytes = await checklistsApi.evidenceContent(evidence.id, control.signal); control.signal.throwIfAborted(); const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })); urls.current.add(url); try { const a = document.createElement("a"); a.href = url; a.download = evidence.fileName ?? "archivo"; a.rel = "noopener noreferrer"; a.click(); } finally { setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000); } } catch (e) { setError(e); } finally { setBusy(false); } }}>{busy ? "Descargando…" : evidence.fileName ?? "Descargar archivo"}</button><ErrorNotice error={error} /></>;
}
export function EvidencePanel({ checklistId, pointId, evidence, editable, busy, onAdd, onRemove, upload, onJsonBusy }: { checklistId: string; pointId: string; evidence: Evidence[]; editable: boolean; busy: boolean; onAdd: (e: Evidence) => void; onRemove: (e: Evidence) => void; onJsonBusy?: (busy: boolean) => void; upload?: (file: File, kind: "image" | "video" | "file") => Promise<Evidence> }) {
  const [menu, setMenu] = useState(false); const [kind, setKind] = useState<Evidence["kind"] | null>(null); const [value, setValue] = useState(""); const [working, setWorking] = useState(false); const [error, setError] = useState<unknown>(null);
  const trigger = useRef<HTMLButtonElement>(null); const menuRef = useRef<HTMLDivElement>(null); const menuId = useId(); const previousKind = useRef(kind);
  useEffect(() => { if (menu) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }, [menu]);
  useEffect(() => { if (previousKind.current && !kind) trigger.current?.focus(); previousKind.current = kind; }, [kind]);
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(false); trigger.current?.focus(); return; }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []); const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
    if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
  }
  async function addJson() {
    setError(null); if (kind !== "link" && kind !== "text") return;
    if (kind === "link" && !safeLink(value)) return setError(new Error("Escriba un enlace HTTP o HTTPS válido."));
    if (kind === "text" && !value.trim()) return setError(new Error("Escriba el texto de la evidencia."));
    setWorking(true); onJsonBusy?.(true);
    try { const result = await checklistsApi.addEvidence(checklistId, pointId, kind === "link" ? { kind, url: value.trim() } : { kind, text: value.trim() }); if (result.pointId !== pointId || !uuid.test(result.id)) throw new Error("La respuesta de evidencia no es válida."); onAdd(result); setKind(null); setValue(""); } catch (e) { setError(e); } finally { setWorking(false); onJsonBusy?.(false); }
  }
  async function addFile(file: File | undefined) {
    if (!file || !kind || kind === "link" || kind === "text") return;
    setWorking(true); setError(null);
    try { const result = upload ? await upload(file, kind) : await checklistsApi.uploadEvidence(checklistId, pointId, kind, file); if (!upload) { if (result.pointId !== pointId || !uuid.test(result.id)) throw new Error("La respuesta de evidencia no es válida."); onAdd(result); } setKind(null); } catch (e) { setError(e); } finally { setWorking(false); }
  }
  return <div className="checklists-evidence"><div className="checklists-evidence-chips">{evidence.map(e => <span className="checklists-evidence-chip" key={e.id}>{e.kind === "image" ? <EvidenceImage evidence={e} /> : e.kind === "link" ? safeLink(e.url) ? <a href={safeLink(e.url)!} target="_blank" rel="noopener noreferrer">{e.url}</a> : <span>Enlace no válido</span> : e.kind === "text" ? <span title={e.text}>✎ {e.text}</span> : <EvidenceDownload evidence={e} />}{e.status === "pending" && <small>Pendiente de guardar</small>}{editable && <button type="button" disabled={busy || working} aria-label={`Quitar ${e.fileName ?? e.text ?? e.url ?? "evidencia"}`} onClick={() => onRemove(e)}>×</button>}</span>)}</div>
    {editable && <div className="checklists-evidence-action"><button ref={trigger} type="button" aria-expanded={menu} aria-controls={menu ? menuId : undefined} disabled={busy || working || evidence.length >= 20} onClick={() => setMenu(!menu)}>Evidencia</button>{evidence.length >= 20 && <small>Máximo 20 evidencias por punto.</small>}{menu && <div id={menuId} ref={menuRef} role="menu" aria-label="Agregar evidencia" onKeyDown={menuKeys}>{[["link", "Enlace"], ["image", "Imagen"], ["video", "Video"], ["file", "Archivo"], ["text", "Texto"]].map(([v,label]) => <button role="menuitem" type="button" key={v} onClick={() => { setKind(v as Evidence["kind"]); setMenu(false); setValue(""); setError(null); }}>{label}</button>)}</div>}</div>}
    {kind && <ChecklistDialog title="Agregar evidencia" close={() => { if (!working) setKind(null); }} busy={working}><ErrorNotice error={error} />{kind === "link" || kind === "text" ? <><label>{kind === "link" ? "URL del enlace" : "Texto"}<textarea maxLength={2000} rows={2} value={value} disabled={working} onChange={e => setValue(e.target.value)} /></label><button type="button" className="primario" disabled={working} onClick={() => void addJson()}>Agregar evidencia</button></> : <><label>{kind === "image" ? "Imagen" : kind === "video" ? "Video" : "Archivo"}<input type="file" disabled={working} accept={kind === "image" ? "image/png,image/jpeg,image/gif,image/webp" : kind === "video" ? "video/mp4,video/webm,video/quicktime,.mov" : undefined} onChange={e => { void addFile(e.target.files?.[0]); e.target.value = ""; }} /></label><p className="texto-ayuda">{kind === "image" ? "Imágenes hasta 10 MB" : kind === "video" ? "Videos hasta 100 MB" : "Archivos hasta 25 MB"}. Queda pendiente hasta guardar el checklist.</p></>}{working && <p role="status">Guardando evidencia…</p>}</ChecklistDialog>}
  </div>;
}
export function removeEvidenceFromNotes(doc: RichDoc | null, id: string): RichDoc | null {
  if (!doc) return null;
  const visit = (node: RichDoc): RichDoc[] => {
    if (["image", "adjuntoArchivo"].includes(node.type ?? "") && node.attrs?.fileId === id) return [];
    const content = node.content?.flatMap(visit);
    if (node.type === "imageWithText" && content?.length === 1) return content;
    return [{ ...node, ...(content ? { content } : {}) }];
  };
  return visit(doc)[0] ?? { type: "doc", content: [{ type: "paragraph" }] };
}
