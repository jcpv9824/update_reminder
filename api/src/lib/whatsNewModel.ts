/* Qué hay de nuevo · tipos, enumeraciones, límites y error controlado del módulo.
   Fuente: docs/que-hay-de-nuevo (01 decisiones de segunda ronda, 03, 04, 05, 06). */

export const ENTRY_STATUSES = ["borrador", "sin_probar", "en_pruebas", "probado", "fallida", "archivada", "eliminada"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ENTRY_TYPES = ["nuevo", "mejora", "regla_negocio", "sp_critico", "rediseno"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const SYSTEM_CODES = ["sag_web", "sag_clasico"] as const;
export type SystemCode = (typeof SYSTEM_CODES)[number];

/** Nivel 1 de la ruta: selector fijo. Lo demás se escribe a mano. */
export const VIA_CODES = ["barra_navegacion", "barra_lateral"] as const;
export type ViaCode = (typeof VIA_CODES)[number];
export const VIA_LABELS: Record<ViaCode, string> = {
  barra_navegacion: "Barra de navegación",
  barra_lateral: "Barra lateral",
};

export const AREA_CODES = ["soporte", "desarrollo", "ventas", "administrativa"] as const;
export type AreaCode = (typeof AREA_CODES)[number];

export const ROUND_STATUSES = ["tomada", "soltada", "fallida", "probada"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const REPORT_INCLUDE = ["todas", "aprobadas", "fallidas"] as const;
export type ReportInclude = (typeof REPORT_INCLUDE)[number];

export const PROBADAS_RESULT = ["sin_errores", "fallidas", "ambas"] as const;
export type ProbadasResult = (typeof PROBADAS_RESULT)[number];

export const QUEUE_TABS = ["sin_probar", "en_pruebas", "probadas"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const FILE_TARGETS = ["que_cambio", "accion", "reglas_negocio", "video", "nota", "hallazgo", "texto_cliente"] as const;
export type FileTarget = (typeof FILE_TARGETS)[number];

export const LOG_ACTIONS = [
  "crear", "editar_borrador", "publicar", "corregir", "corregir_en_nombre", "eliminar", "tomar", "soltar",
  "forzar_soltar", "checklist", "registrar_nota", "registrar_hallazgo", "anular_hallazgo", "marcar_probado",
  "marcar_fallida", "texto_clientes", "archivar", "reporte_enviado",
] as const;
export type LogAction = (typeof LOG_ACTIONS)[number];

export const LIMITS = {
  routes: 10,
  submenusMin: 1,
  submenusMax: 3,
  segment: 120,
  actions: 10,
  attachmentsPerGroup: 10,
  clientName: 200,
  clientTitle: 120,
  reason: { min: 10, max: 500 },
  reportEntries: 200,
  reportRecipients: 30,
  reportMessage: 500,
  pageSize: 50,
  publicItems: 100,
  idempotencyDays: 7,
  /** Cargas en temporales/ que nadie usa se borran a las 24 h. */
  tempUploadHours: 24,
} as const;

export const PERMISSIONS = {
  view: "updates.whats_new.view",
  author: "updates.whats_new.author",
  test: "updates.whats_new.test",
  publishClient: "updates.whats_new.publish_client",
  report: "updates.whats_new.report",
  viewAll: "updates.whats_new.view_all",
  configView: "configuration.whats_new.view",
  manage: "configuration.whats_new.manage",
} as const;

export type UserRef = { id: string; displayName: string; active: boolean };

/** Error de negocio con código estable (`04` §1.1). El handler lo traduce sin detalle interno. */
export class WhatsNewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WhatsNewError";
  }
}

export const STATUS_LABELS: Record<EntryStatus, string> = {
  borrador: "borrador",
  sin_probar: "sin probar",
  en_pruebas: "en pruebas",
  probado: "probado",
  fallida: "fallida",
  archivada: "archivada",
  eliminada: "eliminada",
};

export const TYPE_LABELS: Record<EntryType, string> = {
  nuevo: "Nuevo",
  mejora: "Mejora o cambio de funcionalidad",
  regla_negocio: "Regla de negocio",
  sp_critico: "SP crítico",
  rediseno: "Rediseño o refactorización",
};

export const SYSTEM_LABELS: Record<SystemCode, string> = { sag_web: "SAG Web", sag_clasico: "SAG Clásico" };

export function formatEntryNumber(value: number): string {
  return `QHN-${String(value).padStart(6, "0")}`;
}

export function normalizeForCompare(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* America/Bogota es UTC−5 todo el año (sin horario de verano). */
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

export function bogotaMonth(date: Date): string {
  const local = new Date(date.getTime() - BOGOTA_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Inicio UTC del mes de Bogotá `YYYY-MM` desplazado `offsetMonths`. */
export function bogotaMonthStartUtc(month: string, offsetMonths = 0): Date {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1 + offsetMonths, 1) + BOGOTA_OFFSET_MS);
}

/** Inicio UTC del día de Bogotá `YYYY-MM-DD` desplazado `offsetDays`. */
export function bogotaDayStartUtc(day: string, offsetDays = 0): Date {
  const [year, mon, dd] = day.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1, dd + offsetDays) + BOGOTA_OFFSET_MS);
}
