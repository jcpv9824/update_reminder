// Utilidades de fecha en la zona horaria de la aplicación.
// Bogotá es UTC-5 sin horario de verano.
const APP_OFFSET_HORAS = -5;

// Devuelve la fecha "YYYY-MM-DD" actual en zona Bogotá.
// Usar esto en vez de `new Date().toISOString().slice(0,10)` que devuelve
// la fecha UTC (a las 7pm Bogotá ya está en el día siguiente UTC).
export function hoyEnBogotaIso(now: Date = new Date()): string {
  const ms = now.getTime() + APP_OFFSET_HORAS * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function sumarDiasIso(isoDate: string, dias: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

export type ClasificacionTarea = "vencidas" | "hoy" | "proximas" | "completadas" | "fueraVentana";

// Clasifica una tarea por su fecha y estado, comparando con "today" en
// zona Bogotá (no UTC).
export function clasificarTareaPorFecha(
  taskDate: string,
  status: string,
  hoyIso: string = hoyEnBogotaIso(),
  completedAt?: string | null
): ClasificacionTarea {
  if (status === "cancelled" || status === "deleted") return "fueraVentana";
  const limiteProximas = sumarDiasIso(hoyIso, 4);
  const desdeCompletadas = sumarDiasIso(hoyIso, -4);
  if (status === "completed") {
    const fechaCompletada = completedAt?.slice(0, 10);
    const completadaReciente = !!fechaCompletada && fechaCompletada >= desdeCompletadas && fechaCompletada <= hoyIso;
    const programadaReciente = taskDate >= desdeCompletadas && taskDate <= hoyIso;
    return completadaReciente || programadaReciente ? "completadas" : "fueraVentana";
  }
  if (taskDate < hoyIso) return "vencidas";
  if (taskDate === hoyIso) return "hoy";
  if (taskDate <= limiteProximas) return "proximas";
  return "fueraVentana";
}
