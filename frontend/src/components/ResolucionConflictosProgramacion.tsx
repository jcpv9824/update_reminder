import { useEffect, useId, useRef, useState } from "react";

export type ScheduleConflictLink = Readonly<{ id: string; label: string; verified: boolean }>;
export type ScheduleConflictGroup = Readonly<{
  kind: "domain" | "database";
  physicalTargetId: string;
  label: string;
  conflict?: Readonly<{ id: string; reason: string }>;
  links: readonly ScheduleConflictLink[];
}>;
export type ScheduleConflictPreview = Readonly<{
  /** Opaque server-side authorized preview bound to its current revision. */
  previewId: string;
  groups: readonly ScheduleConflictGroup[];
}>;

export type RemainingScheduleDraft = Readonly<{
  kind: "new";
  previewId: string;
  linkIds: readonly string[];
}>;
export type ExplicitScheduleDoubleChoice = Readonly<{
  previewId: string;
  conflictIds: readonly string[];
  reason: string;
}>;

type Props = {
  preview: ScheduleConflictPreview;
  /** Opens an editable new schedule, not a save operation or an edit of the original. */
  onOpenDraft: (draft: RemainingScheduleDraft) => void;
  /** Future authorized server operation; omitted until the server supports it. */
  onAllowDouble?: (choice: ExplicitScheduleDoubleChoice) => void;
  busy?: boolean;
};

const MAX_MOTIVO = 500;
type Mode = "preview" | "confirm-double";
const targetKey = (group: ScheduleConflictGroup) => JSON.stringify([group.kind, group.physicalTargetId]);
const kindLabel = { domain: "Dominio", database: "Base de datos" } as const;

/** Separate by kind AND physical target, never by parent domain or visible label. */
function readyLinks(groups: readonly ScheduleConflictGroup[]): ScheduleConflictLink[] {
  const conflictedTargets = new Set(groups.filter(group => group.conflict).map(targetKey));
  const available = new Map<string, ScheduleConflictLink>();
  const excluded = new Set<string>();
  for (const group of groups) {
    for (const link of group.links) {
      if (!link.id.trim() || !group.physicalTargetId.trim() || !link.verified ||
          conflictedTargets.has(targetKey(group))) excluded.add(link.id);
      else available.set(link.id, link);
    }
  }
  return [...available.values()].filter(link => !excluded.has(link.id));
}

function toggle(current: ReadonlySet<string>, id: string, checked: boolean): ReadonlySet<string> {
  const next = new Set(current);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

/** Keep consent confined to a single preview revision. */
export default function ResolucionConflictosProgramacion(props: Props) {
  return <VistaConflictos key={props.preview.previewId} {...props} />;
}

function VistaConflictos({ preview, onOpenDraft, onAllowDouble, busy = false }: Props) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("preview");
  const [pickedConflicts, setPickedConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [reason, setReason] = useState("");
  const doubleHeading = useRef<HTMLHeadingElement>(null);
  const doubleTrigger = useRef<HTMLButtonElement>(null);
  const eligible = readyLinks(preview.groups);
  const conflicts = [...new Map(preview.groups.flatMap(group => group.conflict?.id.trim()
    ? [[group.conflict.id, { conflict: group.conflict, label: group.label, kind: group.kind }] as const] : [])).values()];
  const conflictIds = conflicts.filter(row => pickedConflicts.has(row.conflict.id)).map(row => row.conflict.id);
  const hasPreview = preview.previewId.trim().length > 0;
  const normalizedReason = reason.trim();
  const canDouble = hasPreview && !busy && !!onAllowDouble && conflictIds.length > 0 &&
    normalizedReason.length > 0 && normalizedReason.length <= MAX_MOTIVO;

  useEffect(() => {
    if (mode === "confirm-double") doubleHeading.current?.focus();
  }, [mode]);

  function openRemainingDraft() {
    if (!hasPreview || busy || !eligible.length) return;
    onOpenDraft({ kind: "new", previewId: preview.previewId, linkIds: eligible.map(link => link.id) });
  }

  function confirmDouble() {
    if (!canDouble || !onAllowDouble) return;
    // Do not represent intent as a successful write. The server-owning host handles the outcome.
    onAllowDouble({ previewId: preview.previewId, conflictIds, reason: normalizedReason });
    setPickedConflicts(new Set());
    setReason("");
    setMode("preview");
    doubleTrigger.current?.focus();
  }

  return (
    <section className="tarjeta tarjeta-compacta" aria-labelledby={`${id}-titulo`}>
      <h4 id={`${id}-titulo`}>Conflictos de programación</h4>
      {conflicts.length ? (
        <ul aria-label="Destinos con conflicto">
          {conflicts.map(({ conflict, kind, label }) => (
            <li key={conflict.id}><strong>{kindLabel[kind]}: {label}</strong> — {conflict.reason}</li>
          ))}
        </ul>
      ) : <p>No hay conflictos en esta vista previa.</p>}
      {!eligible.length && <p role="status">No quedan destinos verificados sin conflicto.</p>}
      <div className="acciones-formulario">
        <button type="button" className="secundario"
          disabled={!hasPreview || busy || !eligible.length} onClick={openRemainingDraft}>
          Trabajar con las restantes
        </button>
        <button ref={doubleTrigger} type="button" className="advertencia"
          disabled={!hasPreview || busy || !conflicts.length || !onAllowDouble || mode === "confirm-double"}
          aria-expanded={mode === "confirm-double"} aria-controls={mode === "confirm-double" ? `${id}-doble` : undefined}
          onClick={() => { setPickedConflicts(new Set()); setReason(""); setMode("confirm-double"); }}>
          Permitir doble
        </button>
      </div>

      {mode === "confirm-double" && onAllowDouble && (
        <section id={`${id}-doble`} aria-labelledby={`${id}-titulo-doble`}>
          <h5 ref={doubleHeading} tabIndex={-1} id={`${id}-titulo-doble`}>Confirmar trabajo doble</h5>
          <p className="texto-ayuda">Elija los conflictos que desea permitir expresamente y registre el motivo para auditoría.</p>
          <div>
            <fieldset disabled={busy}>
              <legend>Conflictos que permite</legend>
              {conflicts.map(({ conflict, kind, label }) => (
                <label key={conflict.id} className="fila-seleccion">
                  <input type="checkbox" checked={pickedConflicts.has(conflict.id)}
                    onChange={event => setPickedConflicts(toggle(pickedConflicts, conflict.id, event.target.checked))} />
                  <span>{kindLabel[kind]}: {label}</span>
                </label>
              ))}
              <div className="fila-formulario">
                <label htmlFor={`${id}-motivo`}>Motivo</label>
                <textarea id={`${id}-motivo`} required maxLength={MAX_MOTIVO} value={reason}
                  onChange={event => setReason(event.target.value)} />
              </div>
            </fieldset>
            <div className="acciones-formulario">
              <button type="button" className="secundario" onClick={() => {
                setMode("preview");
                requestAnimationFrame(() => doubleTrigger.current?.focus());
              }}>Volver a los conflictos</button>
              <button type="button" className="advertencia" disabled={!canDouble} onClick={confirmDouble}>Confirmar Permitir doble</button>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
