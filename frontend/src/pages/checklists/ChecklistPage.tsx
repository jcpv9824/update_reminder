import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorEnriquecido } from "../queHayDeNuevo/componentes/EditorEnriquecido";
import { checklistsApi } from "./api";
import { ChecklistDialog, ErrorNotice, Loading, useRefreshTemplates, useTemplateKeys, useTemplateUnsaved } from "./components";
import { implementationPath } from "./ImplementationChecklistsRoutes";
import { checklistDate, environmentNames } from "./ChecklistsPage";
import { ExistingChecklistLink } from "./NewChecklistPage";
import { EvidencePanel, PointMediaProvider, removeEvidenceFromNotes } from "./ChecklistEvidence";
import type { ChecklistDetail, ChecklistPoint, RichDoc, SaveChecklist, Evidence } from "./types";
export default function ChecklistPage() {
  const { id = "" } = useParams(); const keys = useTemplateKeys();
  const detail = useQuery({ queryKey: [...keys, "detail", id], queryFn: () => checklistsApi.detail(id) });
  if (detail.isPending) return <Loading />;
  if (detail.error) return <><ErrorNotice error={detail.error} /><button onClick={() => detail.refetch()}>Reintentar</button></>;
  return <ChecklistEditor initial={detail.data} key={id} />;
}
const meaningful = (doc: RichDoc | null): boolean => !!doc && (!!doc.text?.trim() || (doc.type === "image" && !!doc.attrs?.fileId) || !!doc.content?.some(meaningful));
const snapshot = (points: ChecklistPoint[]) => JSON.stringify(points.map(p => ({ id: p.id, checked: p.checked, notes: p.notes, evidence: p.evidence.map(e => e.id) })));
/** P03 / CA12–15,21,34–36. All edits are local until explicit save/complete. */
function ChecklistEditor({ initial }: { initial: ChecklistDetail }) {
  const [saved, setSaved] = useState(initial); const [points, setPoints] = useState(() => [...initial.points].sort((a,b) => a.position - b.position)); const [baseline, setBaseline] = useState(() => snapshot(initial.points));
  const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [missing, setMissing] = useState<string[]>([]); const [deleting, setDeleting] = useState(false);
  const [removedEvidence, setRemovedEvidence] = useState<string[]>([]); const [uploading, setUploading] = useState(0);
  const transfers = useRef<AbortController>();
  useEffect(() => { const control = new AbortController(); transfers.current = control; return () => control.abort(); }, []);
  const keys = useTemplateKeys(); const qc = useQueryClient(); const refresh = useRefreshTemplates(); const navigate = useNavigate();
  const dirty = snapshot(points) !== baseline || removedEvidence.length > 0; useTemplateUnsaved(dirty);
  const remoteChanged = initial.rowVersion !== saved.rowVersion;
  const editable = saved.status === "in_progress" && saved.canEdit && initial.canEdit && !remoteChanged;
  const write = useMutation({ mutationFn: ({ complete, body }: { complete: boolean; body: SaveChecklist }) => complete ? checklistsApi.complete(saved.id, body) : checklistsApi.save(saved.id, body), onSuccess: async (result, request) => { setSaved(result); setPoints([...result.points].sort((a,b) => a.position - b.position)); setBaseline(snapshot(result.points)); setMissing([]); setRemovedEvidence([]); setMessage(request.complete ? "Checklist completado" : "Borrador guardado"); qc.setQueryData([...keys, "detail", saved.id], result); await refresh(); }, onError: e => { const data = (e as { data?: { details?: { pointIds?: string[] } } }).data; if (Array.isArray(data?.details?.pointIds)) setMissing(data.details.pointIds); } });
  const reopen = useMutation({ mutationFn: () => checklistsApi.reopen(saved.id), onSuccess: async result => { setSaved(result); setPoints(result.points); setBaseline(snapshot(result.points)); qc.setQueryData([...keys, "detail", saved.id], result); setMessage("Checklist reabierto"); await refresh(); } });
  const remove = useMutation({ mutationFn: () => checklistsApi.remove(saved.id), onSuccess: async () => { await refresh(); navigate(implementationPath); } });
  const busy = write.isPending || reopen.isPending || remove.isPending || uploading > 0;
  function addEvidence(pointId: string, evidence: Evidence) {
    setPoints(rows => rows.map(point => point.id === pointId ? { ...point, evidence: [...point.evidence.filter(e => e.id !== evidence.id), evidence] } : point));
  }
  function removeEvidence(pointId: string, evidence: Evidence) {
    if (evidence.status === "saved") setRemovedEvidence(ids => [...new Set([...ids, evidence.id])]);
    setPoints(rows => rows.map(point => point.id === pointId ? { ...point, notes: removeEvidenceFromNotes(point.notes, evidence.id), evidence: point.evidence.filter(e => e.id !== evidence.id) } : point));
  }
  async function uploadEvidence(point: ChecklistPoint, file: File, kind: "image" | "video" | "file") {
    if (!editable || point.evidence.length >= 20) throw new Error("No puede agregar más evidencias a este punto.");
    const transfer = transfers.current; if (!transfer || transfer.signal.aborted) throw new Error("La sesión de carga terminó.");
    setUploading(count => count + 1);
    try { const result = await checklistsApi.uploadEvidence(saved.id, point.id, kind, file, transfer.signal); transfer.signal.throwIfAborted(); if (result.pointId !== point.id || result.kind !== kind || result.status !== "pending" || !/^[0-9a-f-]{36}$/i.test(result.id)) throw new Error("La respuesta de evidencia no es válida."); addEvidence(point.id, result); return result; }
    finally { setUploading(count => count - 1); }
  }
  function submit(complete: boolean) {
    setError(""); setMessage(""); setMissing([]);
    const pending = points.filter(p => !p.checked).map(p => p.id);
    if (complete && pending.length) { setMissing(pending); setError(`Faltan ${pending.length} puntos por marcar`); return; }
    write.mutate({ complete, body: { points: points.map(p => ({ pointId: p.id, checked: p.checked, notes: meaningful(p.notes) ? p.notes : null })), evidence: { add: points.flatMap(p => p.evidence.filter(e => e.status === "pending").map(e => e.id)), remove: removedEvidence }, rowVersion: saved.rowVersion } });
  }
  const progress = points.length ? Math.round(100 * points.filter(p => p.checked).length / points.length) : 0;
  return <><nav className="checklists-migas" aria-label="Migas de pan">Implementación › <Link to={implementationPath}>Checklists</Link> › {saved.clientName}</nav><section className="tarjeta"><header className="checklists-heading"><Link to={implementationPath}>Volver</Link><h1>{saved.templateName} · v{saved.versionNumber}.0</h1><span className="checklists-estado">{saved.status === "completed" ? "Completado" : "En progreso"}</span></header>
    <div className="checklists-metadata"><span><strong>Cliente:</strong> {saved.clientName}</span>{saved.environment && <span><strong>Ambiente:</strong> {environmentNames[saved.environment]}</span>}<span><strong>Responsable:</strong> {saved.ownerName}</span><span><strong>Creado:</strong> {checklistDate(saved.createdAt)}</span><span><strong>Finalizado:</strong> {checklistDate(saved.completedAt)}</span><span>Avance: <progress max={100} value={progress} aria-label="Avance" /> {progress} %</span></div>
    {remoteChanged && <p role="alert" className="alerta alerta-error">Alguien guardó este checklist mientras usted lo editaba. Copie lo que necesite y recargue.</p>}
    <div className="checklists-run-points">{points.map(p => <section key={p.id} className={`checklists-run-point${missing.includes(p.id) ? " checklists-point-missing" : ""}`}><label className="checklists-checkbox"><input type="checkbox" checked={p.checked} disabled={!editable || busy} aria-invalid={missing.includes(p.id) || undefined} onChange={e => { setPoints(rows => rows.map(point => point.id === p.id ? { ...point, checked: e.target.checked } : point)); setMissing(ids => ids.filter(id => id !== p.id)); }} />{p.title}</label>{p.detail?.trim() && <p className="checklists-point-detail">{p.detail}</p>}
      <PointMediaProvider checklistId={saved.id} pointId={p.id} evidence={p.evidence}>{editable && p.checked ? <div className="checklists-point-notes"><EditorEnriquecido valor={p.notes} onChange={notes => setPoints(rows => rows.map(point => point.id === p.id ? { ...point, notes } : point))} ariaLabel={`Notas de ${p.title}`} tamano="compacto" perfil="medio" archivosPrivados hideFileAttachments soloLectura={write.isPending} cargarArchivo={async (file, kind) => { if (kind !== "imagen") throw new Error("Adjunte los documentos desde Evidencia."); const result = await uploadEvidence(p, file, "image"); return { fileId: result.id, name: result.fileName ?? file.name, mime: result.contentType ?? file.type, bytes: result.sizeBytes ?? file.size }; }} /></div> : !editable && p.notes && <div className="checklists-point-notes"><EditorEnriquecido valor={p.notes} soloLectura perfil="medio" archivosPrivados hideAttachments /></div>}</PointMediaProvider>
      <EvidencePanel checklistId={saved.id} pointId={p.id} evidence={p.evidence.filter(e => editable || e.status === "saved")} editable={editable} busy={busy} onAdd={e => addEvidence(p.id, e)} onRemove={e => removeEvidence(p.id, e)} upload={(file, kind) => uploadEvidence(p, file, kind)} onJsonBusy={active => setUploading(count => count + (active ? 1 : -1))} />
    </section>)}</div><ErrorNotice error={write.error || reopen.error || remove.error} />{error && <div role="alert" className="alerta alerta-error">{error}</div>}<ExistingChecklistLink error={reopen.error} /><p role="status">{message}</p>
    {editable && <div className="acciones-formulario"><span className="texto-ayuda">Sin autoguardado: guarde el borrador antes de salir.</span><button disabled={busy} onClick={() => submit(false)}>Guardar borrador</button><button className="primario" disabled={busy} onClick={() => submit(true)}>Finalizar checklist</button></div>}
    {!editable && !remoteChanged && <div className="acciones-formulario">{saved.canReopen && <button disabled={busy} onClick={() => reopen.mutate()}>Reabrir</button>}</div>}{saved.canDelete && <button className="peligro" disabled={busy} onClick={() => setDeleting(true)}>Eliminar</button>}
    </section>{deleting && <ChecklistDialog title="Eliminar checklist" close={() => setDeleting(false)} busy={busy}><p>¿Eliminar este checklist? Se conservará su historial.{dirty && " Los cambios locales sin guardar se descartarán."}</p><ErrorNotice error={remove.error} /><button disabled={busy} onClick={() => setDeleting(false)}>Cancelar</button><button className="peligro" disabled={busy} onClick={() => remove.mutate()}>Confirmar eliminación</button></ChecklistDialog>}</>;
}
