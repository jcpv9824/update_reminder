import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { ETIQUETAS_FRECUENCIA, type Frecuencia } from "../types";
import { hoyEnBogotaIso, sumarDiasIso } from "../utils/fechas";
import ResolucionConflictosProgramacion, {
  type RemainingScheduleDraft, type ScheduleConflictGroup, type ScheduleConflictLink, type ScheduleConflictPreview,
} from "./ResolucionConflictosProgramacion";
import SolicitudesCopiaCatalogo, { catalogCopyProposalsKey } from "./SolicitudesCopiaCatalogo";

type Preview = ScheduleConflictPreview & { coverage: "verified" | "partial" };
type Request = { date: string; attempt: number };
type Draft = RemainingScheduleDraft & { selected: ReadonlySet<string> };
type Original = Pick<Frecuencia, "id" | "name" | "clientName" | "frequencyType">;

const maxRelations = 5000;
const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/\p{C}/u.test(value);
const opaque = (value: unknown): value is string => validText(value, 260) && value === value.trim();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const invalidPreview = (): never => { throw new Error("catalog_copy_preview_invalid"); };

function readPreview(value: unknown): Preview {
  if (!record(value) || !opaque(value.previewId) ||
      (value.coverage !== "verified" && value.coverage !== "partial") ||
      !Array.isArray(value.groups) || value.groups.length > maxRelations) return invalidPreview();
  let relationCount = 0;
  const groups = value.groups.map((group: unknown): ScheduleConflictGroup => {
    if (!record(group) || (group.kind !== "domain" && group.kind !== "database") ||
        !validText(group.label, 512) || !opaque(group.physicalTargetId) ||
        !Array.isArray(group.links) || (relationCount += group.links.length) > maxRelations) return invalidPreview();
    const links = group.links.map((link: unknown): ScheduleConflictLink => {
      if (!record(link) || !opaque(link.id) || !validText(link.label, 750) || typeof link.verified !== "boolean")
        return invalidPreview();
      return { id: link.id, label: link.label, verified: link.verified };
    });
    const conflict = group.conflict === undefined ? undefined : readConflict(group.conflict);
    return { kind: group.kind, label: group.label, physicalTargetId: group.physicalTargetId, links,
      ...(conflict ? { conflict } : {}) };
  });
  return { previewId: value.previewId, coverage: value.coverage, groups };
}

function readConflict(value: unknown): NonNullable<ScheduleConflictGroup["conflict"]> {
  if (!record(value) || !opaque(value.id) || !validText(value.reason, 512)) return invalidPreview();
  return { id: value.id, reason: value.reason };
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) return false;
  const instant = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === date;
}

/** Editable copy request. Saving it never inherits task state or activates work. */
export default function CopiaProgramacionCatalogo({ original }: { original: Original }) {
  const uid = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const nextAttempt = useRef(1);
  const [today] = useState(() => hoyEnBogotaIso());
  const lastDate = sumarDiasIso(today, 7);
  const [date, setDate] = useState(today);
  const [name, setName] = useState(() => original.name ? `${original.name} (copia)` : "Actualización programada (copia)");
  const [request, setRequest] = useState<Request | null>(() => ({ date, attempt: 0 }));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const qc = useQueryClient();
  const canRequest = import.meta.env.VITE_PORTAL_CATALOG_COPY_PROPOSALS_ENABLED === "true";
  const proposal = useMutation({
    mutationFn: async (body: { date: string; name: string; previewId: string; linkIds: readonly string[] }) => {
      const result = await api.post<unknown>(`/schedules/${encodeURIComponent(original.id)}/catalog-copy-proposals`, body);
      if (!record(result) || result.status !== "pending_approval" || typeof result.proposalId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.proposalId)) return invalidPreview();
      return result.proposalId;
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: catalogCopyProposalsKey(original.id) }); },
    retry: false,
  });
  const preview = useQuery({
    queryKey: ["schedules", "catalog-copy-preview", original.id, uid, request?.date, request?.attempt],
    queryFn: async ({ signal }) => {
      if (!request) return invalidPreview();
      const params = new URLSearchParams({ date: request.date });
      return readPreview(await api.get<unknown>(`/schedules/${encodeURIComponent(original.id)}/catalog-copy-preview?${params}`, { signal }));
    },
    enabled: request !== null,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
  });
  const data = request?.date === date ? preview.data : undefined;
  const dateIsAllowed = validDate(date) && date >= today && date <= lastDate;
  const activeDraft = draft?.previewId === data?.previewId ? draft : null;
  const locked = proposal.isPending || proposal.isSuccess;
  const labels = new Map(data?.groups.flatMap(group => group.links.map(link => [link.id, link.label] as const)));
  const eligibleDraftLinks = activeDraft?.linkIds;
  useEffect(() => {
    if (eligibleDraftLinks) heading.current?.focus();
  }, [eligibleDraftLinks]);

  function openDraft(next: RemainingScheduleDraft) {
    if (!data || preview.isFetching || locked || next.previewId !== data.previewId) return;
    setDraft({ ...next, selected: new Set(next.linkIds) });
  }

  function toggleChoice(linkId: string, checked: boolean) {
    setDraft(current => {
      if (!current?.linkIds.includes(linkId)) return current;
      const selected = new Set(current.selected);
      if (checked) selected.add(linkId);
      else selected.delete(linkId);
      return { ...current, selected };
    });
  }

  function submitProposal() {
    if (!canRequest || locked || !activeDraft || !activeDraft.selected.size || !dateIsAllowed || !name.trim() ||
        /\p{C}/u.test(name) || preview.isFetching) return;
    proposal.mutate({ date, name: name.trim(), previewId: activeDraft.previewId,
      linkIds: activeDraft.linkIds.filter(id => activeDraft.selected.has(id)) });
  }

  return (
    <section aria-labelledby={`${uid}-copy-title`}>
      <h4 id={`${uid}-copy-title`}>Borrador de copia</h4>
      <p>Cliente: {original.clientName} · Frecuencia original: {ETIQUETAS_FRECUENCIA[original.frequencyType]}</p>
      <div className="campo">
        <label htmlFor={`${uid}-name`}>Nombre de la copia</label>
        <input id={`${uid}-name`} value={name} maxLength={200} disabled={locked} onChange={event => setName(event.target.value)} />
      </div>
      <div className="campo">
        <label htmlFor={`${uid}-date`}>Fecha de la copia</label>
        <input id={`${uid}-date`} type="date" value={date} min={today} max={lastDate} disabled={locked} aria-describedby={`${uid}-date-help`} onChange={event => {
          proposal.reset();
          setDate(event.target.value);
          setRequest(null);
          setDraft(null);
        }} />
        <span id={`${uid}-date-help`} className="texto-ayuda">Fechas disponibles: hoy y los próximos siete días (Bogotá).</span>
      </div>
      <div className="acciones-formulario">
        <button type="button" className="secundario" disabled={locked || !dateIsAllowed || (request !== null && preview.isFetching)}
          onClick={() => {
            if (!dateIsAllowed) return;
            proposal.reset();
            setDraft(null);
            setRequest({ date, attempt: nextAttempt.current++ });
          }}>
          Verificar destinos
        </button>
      </div>
      {request && preview.isFetching && <p role="status">Verificando conflictos para la fecha de la copia…</p>}
      {request && preview.isError && <p className="alerta alerta-error" role="alert">No se pudo verificar la copia para esta fecha.</p>}
      {data && <>
        {data.coverage === "partial" &&
          <p role="status">Cobertura parcial: solo se pueden seleccionar destinos verificados y sin conflicto.</p>}
        <ResolucionConflictosProgramacion preview={data} onOpenDraft={openDraft} busy={locked || preview.isFetching} />
      </>}
      {activeDraft && <section aria-labelledby={`${uid}-remaining`}>
        <h4 id={`${uid}-remaining`} tabIndex={-1} ref={heading}>Destinos restantes del borrador</h4>
        <p role="status">{activeDraft.selected.size} de {activeDraft.linkIds.length} destinos seleccionados</p>
        <fieldset disabled={locked}>
          <legend>Puede quitar o volver a marcar destinos verificados</legend>
          {activeDraft.linkIds.map(linkId => <label key={linkId} className="fila-seleccion">
            <input type="checkbox" checked={activeDraft.selected.has(linkId)}
              onChange={event => toggleChoice(linkId, event.target.checked)} />
            <span>{labels.get(linkId)}</span>
          </label>)}
        </fieldset>
        {canRequest && !proposal.isSuccess && <button type="button"
          disabled={locked || !activeDraft.selected.size || !dateIsAllowed || !name.trim() || /\p{C}/u.test(name) || preview.isFetching}
          onClick={submitProposal}>Solicitar copia</button>}
      </section>}
      {proposal.isError && <p role="alert">No se pudo confirmar la solicitud. Verifique los destinos antes de reintentar.</p>}
      {proposal.isSuccess && confirmed !== proposal.data
        ? <p role="status">Solicitud guardada, pendiente de aprobación. Todavía no se creó una programación ni se enviaron avisos.</p>
        : <p className="texto-ayuda">{canRequest
          ? "La solicitud no modifica la programación original ni genera tareas mientras esté pendiente."
          : "Este borrador no se guarda y no modifica la programación original."}</p>}
      {canRequest && <SolicitudesCopiaCatalogo originalId={original.id}
        justSaved={proposal.data ? { id: proposal.data, date, name: name.trim(), status: "pending_approval" } : null}
        onActivated={setConfirmed} />}
    </section>
  );
}
