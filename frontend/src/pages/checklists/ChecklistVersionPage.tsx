import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical, LockKeyhole, X } from "lucide-react";
import { templatesApi } from "./api";
import { basePath, Breadcrumb, ErrorNotice, Loading, Status, useRefreshTemplates, useTemplateKeys, useTemplateUnsaved } from "./components";
import type { SaveVersion, VersionDetail } from "./types";
export default function ChecklistVersionPage() {
  const { templateId = "", number = "" } = useParams(); const keys = useTemplateKeys();
  const valid = /^[1-9][0-9]*$/.test(number) && Number.isSafeInteger(Number(number)) && Number(number) <= 2147483647;
  const detail = useQuery({ queryKey: [...keys, "version", templateId, number], queryFn: () => templatesApi.version(templateId, Number(number)), enabled: valid });
  if (!valid) return <p role="alert">El número de versión no es válido.</p>;
  if (detail.isPending) return <Loading />;
  if (detail.error) return <><ErrorNotice error={detail.error} /><button onClick={() => detail.refetch()}>Reintentar</button></>;
  return <VersionEditor initial={detail.data} key={detail.data.id} />;
}
type LocalPoint = { key: string; id?: string; title: string; detail: string };
const localPoints = (v: VersionDetail): LocalPoint[] => [...v.points].sort((a,b) => a.position - b.position).map(p => ({ key: p.id, id: p.id, title: p.title, detail: p.detail ?? "" }));
/** P06 / RN-22,29,37–39: local draft only, explicit full-form save with original rowVersion. */
function VersionEditor({ initial }: { initial: VersionDetail }) {
  const [points, setPoints] = useState(() => localPoints(initial)); const [environment, setEnvironment] = useState(initial.requiresEnvironment); const [rowVersion, setRowVersion] = useState(initial.rowVersion);
  const [baseline, setBaseline] = useState(() => JSON.stringify({ points: localPoints(initial), environment: initial.requiresEnvironment }));
  const [title, setTitle] = useState(""); const [detail, setDetail] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState(""); const dragged = useRef<string | null>(null); const refresh = useRefreshTemplates();
  const [mode, setMode] = useState(initial.status); const [remoteConflict, setRemoteConflict] = useState(false);
  const editable = mode === "editing"; const dirty = JSON.stringify({ points, environment }) !== baseline || !!title || !!detail;
  useEffect(() => { if (initial.rowVersion !== rowVersion || initial.status !== mode) setRemoteConflict(true); }, [initial.rowVersion, initial.status]);
  const blocked = remoteConflict;
  useTemplateUnsaved(dirty);
  const save = useMutation({ mutationFn: (body: SaveVersion) => templatesApi.saveVersion(initial.templateId, initial.number, body), onSuccess: async v => { const rows = localPoints(v); setPoints(rows); setRowVersion(v.rowVersion); setEnvironment(v.requiresEnvironment); setBaseline(JSON.stringify({ points: rows, environment: v.requiresEnvironment })); setMessage("Cambios guardados."); await refresh(); } });
  function move(from: number, to: number) {
    if (!editable || blocked || save.isPending || from < 0 || to < 0 || to >= points.length || from === to) return;
    const result = [...points]; const [item] = result.splice(from, 1); result.splice(to, 0, item); setPoints(result); setMessage(`${item.title}: posición ${to + 1} de ${result.length}.`);
  }
  function addPoint() {
    setError("");
    if (!title.trim()) return setError("Escriba el título del punto");
    if (title.trim().length > 200 || detail.length > 1000) return setError("El título admite hasta 200 caracteres y el detalle hasta 1000.");
    if (points.length >= 100) return setError("La versión admite hasta 100 puntos.");
    setPoints(rows => [...rows, { key: crypto.randomUUID(), title: title.trim(), detail }]); setTitle(""); setDetail(""); setMessage("Punto agregado. Guarde los cambios.");
  }
  function submit() {
    if (blocked) return;
    setError(""); setMessage("");
    if (title || detail) return setError("Agregue el punto que está escribiendo o vacíe sus campos antes de guardar.");
    if (points.some(p => !p.title.trim())) return setError("Escriba el título del punto");
    if (points.length > 100 || points.some(p => p.title.trim().length > 200 || p.detail.length > 1000)) return setError("Revise los límites de los puntos: título 200, detalle 1000 y hasta 100 puntos.");
    save.mutate({ requiresEnvironment: environment, points: points.map(p => ({ ...(p.id ? { id: p.id } : {}), title: p.title.trim(), detail: p.detail.trim() ? p.detail : null })), rowVersion });
  }
  function reloadVersion() {
    if (dirty && !window.confirm("Tiene cambios sin guardar. ¿Salir sin guardar?")) return;
    const rows = localPoints(initial); setPoints(rows); setEnvironment(initial.requiresEnvironment); setRowVersion(initial.rowVersion); setMode(initial.status); setBaseline(JSON.stringify({ points: rows, environment: initial.requiresEnvironment })); setTitle(""); setDetail(""); setRemoteConflict(false); setError(""); save.reset();
  }
  return <><Breadcrumb><Link to={`${basePath}/${initial.templateId}`}>{initial.templateName}</Link> › v{initial.number}.0</Breadcrumb><section className="tarjeta"><header className="checklists-heading"><Link to={`${basePath}/${initial.templateId}`}>Volver</Link><h1>Puntos de la versión {initial.number}.0</h1><Status status={initial.status} /></header>{!editable && <p><LockKeyhole size={16} aria-hidden="true" /> Versión publicada: solo lectura. Para cambiar los puntos, cree otra versión.</p>}
    <label className="checklists-checkbox"><input type="checkbox" checked={environment} disabled={!editable || blocked || save.isPending} onChange={e => setEnvironment(e.target.checked)} />Esta versión exige escoger el ambiente (Pruebas, Producción o Demostración)</label>
    {remoteConflict && <div role="alert" className="alerta alerta-error"><p>Alguien cambió esta versión mientras usted la editaba. Copie lo que necesite y recargue.</p><button onClick={reloadVersion}>Recargar versión</button></div>}
    {editable && <p className="texto-ayuda">Arrastre el asa para cambiar el orden o use los botones Subir y Bajar con el teclado.</p>}
    <ol className="checklists-points">{points.map((p,i) => <li key={p.key} draggable={editable && !blocked && !save.isPending} onDragStart={e => { dragged.current = p.key; e.dataTransfer?.setData("text/plain", p.key); }} onDragOver={e => { if (editable) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragged.current) move(points.findIndex(point => point.key === dragged.current), i); dragged.current = null; }} onDragEnd={() => { dragged.current = null; }}>
      {editable && <GripVertical className="checklists-grip" size={18} aria-hidden="true" />}<span className="checklists-position">{i + 1}.</span><div className="checklists-point-content">{editable ? <><label htmlFor={`point-title-${p.key}`} className="sr-only">Título del punto {i + 1}</label><input id={`point-title-${p.key}`} value={p.title} maxLength={200} disabled={save.isPending} readOnly={blocked} onChange={e => setPoints(rows => rows.map(point => point.key === p.key ? { ...point, title: e.target.value } : point))} /><label htmlFor={`point-detail-${p.key}`} className="sr-only">Detalle del punto {i + 1}</label><textarea id={`point-detail-${p.key}`} value={p.detail} maxLength={1000} rows={1} disabled={save.isPending} readOnly={blocked} placeholder="Detalle (opcional)" onChange={e => setPoints(rows => rows.map(point => point.key === p.key ? { ...point, detail: e.target.value } : point))} /></> : <><strong>{p.title}</strong>{p.detail.trim() && <p className="checklists-point-detail">{p.detail}</p>}</>}</div>
      {editable && <div className="checklists-point-actions"><button aria-label={`Subir ${p.title}`} disabled={i === 0 || blocked || save.isPending} onClick={() => move(i, i - 1)}><ArrowUp size={15} aria-hidden="true" /></button><button aria-label={`Bajar ${p.title}`} disabled={i === points.length - 1 || blocked || save.isPending} onClick={() => move(i, i + 1)}><ArrowDown size={15} aria-hidden="true" /></button><button aria-label={`Quitar ${p.title}`} disabled={blocked || save.isPending} onClick={() => setPoints(rows => rows.filter(point => point.key !== p.key))}><X size={15} aria-hidden="true" /></button></div>}
    </li>)}</ol>{points.length === 0 && <p>Esta versión todavía no tiene puntos.</p>}
    {editable && <><fieldset className="checklists-add" disabled={blocked || save.isPending || points.length >= 100}><legend>Agregar punto</legend><label htmlFor="new-point-title">Título del punto</label><input id="new-point-title" maxLength={200} value={title} onChange={e => { setTitle(e.target.value); setError(""); }} /><label htmlFor="new-point-detail">Detalle (opcional)</label><textarea id="new-point-detail" maxLength={1000} rows={2} value={detail} onChange={e => setDetail(e.target.value)} /><button onClick={addPoint}>Agregar punto</button></fieldset>{points.length >= 100 && <p>La versión admite hasta 100 puntos.</p>}<p className="texto-ayuda">La versión en edición tampoco se autoguarda.</p>{error && <div role="alert" className="alerta alerta-error">{error}</div>}<ErrorNotice error={save.error} /><div className="acciones-formulario"><Link to={`${basePath}/${initial.templateId}`}>Volver a versiones</Link><button className="primario" disabled={blocked || save.isPending} onClick={submit}>Guardar cambios</button></div></>}
    <p role="status" aria-live="polite">{message}</p>
  </section></>;
}
