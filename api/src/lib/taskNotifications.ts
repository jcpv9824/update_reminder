// Decisión pura de qué notificación corresponde a un cambio de estado de tarea.
// Implementa la matriz acordada "Atención + fallida + éxito":
//   - completada CON PROBLEMAS / bloqueada / fallida → correo de "problema".
//   - completada CON ÉXITO (sin problemas)          → correo de "éxito".
//   - en progreso / cancelada / reabierta (pending) → sin correo.
// Bloqueada y fallida se gobiernan por `blockedAlertsEnabled` (igual que las
// alertas de bloqueo). Completada (con o sin problemas) siempre notifica.
export type NotificacionEstado = "problema" | "exito" | "none";

export function decidirNotificacionPorEstado(args: {
  newStatus: string;
  completedWithProblems: boolean;
  blockedAlertsEnabled: boolean;
}): NotificacionEstado {
  const { newStatus, completedWithProblems, blockedAlertsEnabled } = args;
  if (newStatus === "completed") {
    return completedWithProblems ? "problema" : "exito";
  }
  if (newStatus === "blocked" || newStatus === "failed") {
    return blockedAlertsEnabled ? "problema" : "none";
  }
  return "none";
}
