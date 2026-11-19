import { STATUS_LABELS, WhatsNewError, type EntryStatus } from "./whatsNewModel";

/* Máquina de estados de la entrada (`03` §5, decisiones de segunda ronda).

   borrador ─publicar─▶ sin_probar ─tomar─▶ en_pruebas ─marcar_probado─▶ probado ─archivar─▶ archivada
       │                  ▲   ▲                │  │
   eliminar              │   └──── soltar ─────┘  └─marcar_fallida─▶ fallida
       ▼                  └──── corregir (sin_probar o fallida) ──────────┘
   eliminada

   - Soltar y forzar_soltar devuelven a sin_probar: la prueba empieza de nuevo y no se envía nada.
   - Corregir siempre termina en sin_probar (nunca en borrador).
   - Cualquier otro par (estado, acción) es 409 sin efectos. */

export type EntryAction =
  | "guardar_borrador" | "publicar" | "eliminar" | "corregir" | "tomar" | "soltar" | "forzar_soltar"
  | "marcar_probado" | "marcar_fallida" | "archivar"
  | "checklist" | "registrar_nota" | "registrar_hallazgo" | "anular_hallazgo" | "texto_clientes";

export const TRANSITIONS: Record<EntryAction, { from: EntryStatus[]; to: EntryStatus | null }> = {
  guardar_borrador: { from: ["borrador"], to: null },
  publicar: { from: ["borrador"], to: "sin_probar" },
  eliminar: { from: ["borrador"], to: "eliminada" },
  corregir: { from: ["sin_probar", "fallida"], to: "sin_probar" },
  tomar: { from: ["sin_probar"], to: "en_pruebas" },
  soltar: { from: ["en_pruebas"], to: "sin_probar" },
  forzar_soltar: { from: ["en_pruebas"], to: "sin_probar" },
  marcar_probado: { from: ["en_pruebas"], to: "probado" },
  marcar_fallida: { from: ["en_pruebas"], to: "fallida" },
  archivar: { from: ["probado"], to: "archivada" },
  checklist: { from: ["en_pruebas"], to: null },
  registrar_nota: { from: ["en_pruebas"], to: null },
  registrar_hallazgo: { from: ["en_pruebas"], to: null },
  // Anular se permite con la ronda abierta (quien lo registró) o, con `manage`, en cualquier estado publicado.
  anular_hallazgo: { from: ["en_pruebas", "sin_probar", "fallida", "probado", "archivada"], to: null },
  texto_clientes: { from: ["en_pruebas", "probado"], to: null },
};

export function canTransition(action: EntryAction, from: EntryStatus): boolean {
  return TRANSITIONS[action].from.includes(from);
}

/** Devuelve el estado destino (o el mismo si la acción no cambia el estado). Lanza 409 si no se permite. */
export function nextStatus(action: EntryAction, from: EntryStatus): EntryStatus {
  if (action === "corregir" && from === "en_pruebas") {
    throw new WhatsNewError(409, "en_pruebas_pidale_soltar", "La entrada está en pruebas. Pídale al asesor que la suelte.");
  }
  if (!canTransition(action, from)) {
    throw new WhatsNewError(409, "estado_no_permite_accion",
      `La entrada está en ${STATUS_LABELS[from]} y no permite esta acción.`, { status: from, action });
  }
  return TRANSITIONS[action].to ?? from;
}
