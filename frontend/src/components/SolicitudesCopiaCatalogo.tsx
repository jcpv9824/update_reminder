import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const statusLabels = {
  pending_approval: "Pendiente de aprobación", expired: "Fecha de la solicitud vencida",
  changed: "La programación original cambió", scheduled: "Programada para su fecha de inicio",
  active: "Activada", held: "En espera de verificación", cancelled: "Finalizada o cancelada", removed: "Eliminada",
} as const;
type CopyStatus = keyof typeof statusLabels;
export type SolicitudCopia = { id: string; date: string; name: string; status: CopyStatus };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function parseList(value: unknown): SolicitudCopia[] {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 20) throw new Error("invalid_copy_proposals");
  const ids = new Set<string>();
  return value.items.map((row: unknown) => {
    if (!object(row) || typeof row.id !== "string" || !uuid.test(row.id) || ids.has(row.id) ||
        typeof row.name !== "string" || !row.name.trim() || row.name.length > 200 || /\p{C}/u.test(row.name) ||
        typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        typeof row.status !== "string" || !Object.hasOwn(statusLabels, row.status)) throw new Error("invalid_copy_proposals");
    ids.add(row.id);
    return { id: row.id, name: row.name, date: row.date, status: row.status as CopyStatus };
  });
}

export const catalogCopyProposalsKey = (originalId: string) => ["schedules", "catalog-copy-proposals", originalId] as const;
const catalogDraftProposalsKey = ["schedules", "catalog-draft-proposals"] as const;

export default function SolicitudesCopiaCatalogo({ originalId, justSaved, onActivated }: {
  originalId?: string; justSaved?: SolicitudCopia | null; onActivated?: (proposalId: string) => void;
}) {
  const sectionId = useId();
  const copy = originalId !== undefined;
  const queryKey = copy ? catalogCopyProposalsKey(originalId) : catalogDraftProposalsKey;
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => parseList(await api.get<unknown>(copy
      ? `/schedules/${encodeURIComponent(originalId)}/catalog-copy-proposals` : "/schedules/catalog-draft-proposals", { signal })),
    gcTime: 0, retry: false, refetchOnWindowFocus: false,
  });
  const rows = query.isError ? [] : query.data ?? [];
  const visible = !query.isError && justSaved && !rows.some(row => row.id === justSaved.id) ? [justSaved, ...rows] : rows;

  return <section aria-labelledby={sectionId}>
    <h4 id={sectionId}>{copy ? "Mis solicitudes de copia" : "Solicitudes recientes"}</h4>
    <button type="button" className="secundario" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Actualizar solicitudes</button>
    {query.isFetching && <p role="status">Consultando solicitudes…</p>}
    {query.isError && <p role="alert">{copy ? "No se pudieron consultar todas sus solicitudes de copia." : "No se pudieron consultar sus solicitudes."}</p>}
    {!visible.length && query.isSuccess && <p>{copy ? "No tiene solicitudes de copia para esta programación." : "No tiene solicitudes de programación."}</p>}
    {visible.map(row => <Solicitud key={row.id} row={row} copy={copy} queryKey={queryKey} onActivated={onActivated} />)}
  </section>;
}

function Solicitud({ row, copy, queryKey, onActivated }: {
  row: SolicitudCopia; copy: boolean; queryKey: readonly string[]; onActivated?: (id: string) => void;
}) {
  const uid = useId();
  const field = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"idle" | "invalid" | "error" | "confirmed">("idle");
  const qc = useQueryClient();
  useEffect(() => () => { inFlight.current?.abort(); }, []);

  async function activate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || row.status !== "pending_approval" || stage === "confirmed") return;
    const reviewId = field.current?.value.trim() ?? "";
    if (!uuid.test(reviewId)) {
      setStage("invalid");
      field.current?.focus();
      return;
    }
    if (field.current) field.current.value = "";
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setStage("idle");
    try {
      const variant = copy ? "copy" : "draft";
      const response = await api.post<unknown>(`/schedules/catalog-${variant}-proposals/${row.id}/activate`, { reviewId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!object(response) || response.id !== `catalog-${variant}-${row.id}` ||
          (response.status !== "created" && response.status !== "replayed")) throw new Error("invalid_catalog_activation");
      setStage("confirmed");
      onActivated?.(row.id);
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["frecuencias"] });
      void qc.invalidateQueries({ queryKey: ["tareas"] });
    } catch {
      if (!controller.signal.aborted) {
        setStage("error");
        if (!copy) void qc.invalidateQueries({ queryKey });
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  return <article aria-labelledby={`${uid}-title`} className="tarjeta tarjeta-compacta">
    <h5 id={`${uid}-title`}>{row.name}</h5>
    <p>Fecha: {row.date} · {stage === "confirmed" && row.status === "pending_approval" ? "Confirmada; actualizando estado" : statusLabels[row.status]}</p>
    <p className="texto-ayuda">Identificador de solicitud: <code>{row.id}</code></p>
    {row.status === "pending_approval" && stage !== "confirmed" &&
      <form onSubmit={activate}>
        <div className="campo">
          <label htmlFor={`${uid}-receipt`}>Recibo de revisión</label>
          <input id={`${uid}-receipt`} type="password" autoComplete="off" spellCheck={false} required maxLength={64}
            aria-describedby={`${uid}-tip`} disabled={busy} ref={field} />
          <span id={`${uid}-tip`} className="texto-ayuda">Pídale el recibo al revisor autorizado. No se guarda en este navegador.</span>
        </div>
        <button type="submit" className="primario" disabled={busy}>{busy ? "Confirmando…" : copy ? "Confirmar copia revisada" : "Confirmar programación revisada"}</button>
      </form>}
    {stage === "invalid" && <p role="alert">Ingrese el identificador completo del recibo de revisión.</p>}
    {stage === "error" && <p role="alert">No se confirmó la {copy ? "copia" : "programación"}. Compruebe que el recibo y la selección sigan vigentes.</p>}
    {stage === "confirmed" && <p role="status">{copy ? "Copia confirmada. La programación original no cambió." : "Programación confirmada. Consulte su estado en esta lista."}</p>}
  </article>;
}
