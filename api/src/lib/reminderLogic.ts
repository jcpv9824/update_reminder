// Lógica pura para decidir qué recordatorios deben enviarse en una ejecución
// del timer trigger. Aislada del IO para poder probarse fácilmente.
import type { RemindersConfig, UpdateTask, UpdateSchedule } from "../types/models";

// Se ejecuta cada minuto para respetar la hora HH:mm elegida por el usuario.
// La deduplicación del outbox impide dobles envíos si una ejecución se repite.
export const SCHEDULED_REMINDERS_TIMER_SCHEDULE = "0 * * * * *";

export type ReminderDecision = {
  task: UpdateTask;
  daysBefore: number;
  type: "before" | "sameDay";
};

function diffInDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ad0 = Date.UTC(ay, am - 1, ad);
  const bd0 = Date.UTC(by, bm - 1, bd);
  return Math.round((ad0 - bd0) / (1000 * 60 * 60 * 24));
}

// Decide qué recordatorios corresponde enviar para la fecha "ahoraIsoDate"
// considerando la frecuencia asociada a cada tarea y los recordatorios
// ya enviados.
export function decidirRecordatorios(args: {
  ahoraIsoDate: string;          // "YYYY-MM-DD" en zona local del sistema
  ahoraHoraLocal: string;        // "HH:mm"
  tareas: UpdateTask[];
  frecuenciasPorId: Map<string, UpdateSchedule>;
  globalDefaults?: RemindersConfig;
}): ReminderDecision[] {
  const decisiones: ReminderDecision[] = [];
  for (const t of args.tareas) {
    if (t.status === "completed" || t.status === "cancelled") continue;
    const sch = args.frecuenciasPorId.get(t.scheduleId);
    const cfg = sch?.reminders ?? args.globalDefaults;
    if (!cfg || !cfg.remindersEnabled) continue;
    if (!cfg.reminderDaysBefore || cfg.reminderDaysBefore.length === 0) continue;
    const dias = diffInDays(t.taskDate, args.ahoraIsoDate);
    if (dias < 0) continue;
    if (!cfg.reminderDaysBefore.includes(dias)) continue;
    if (cfg.reminderTime && args.ahoraHoraLocal < cfg.reminderTime) continue;
    const yaEnviado = (t.remindersSent ?? []).some((r) => r.daysBefore === dias && diffInDays(r.sentAt.slice(0, 10), args.ahoraIsoDate) === 0);
    if (yaEnviado) continue;
    decisiones.push({ task: t, daysBefore: dias, type: dias === 0 ? "sameDay" : "before" });
  }
  return decisiones;
}

export function valoresRecordatoriosPorDefecto(): RemindersConfig {
  return {
    remindersEnabled: true,
    reminderDaysBefore: [1, 0],
    reminderTime: "08:00",
    reminderRecipientsMode: "roleUsers",
    customReminderEmails: [],
  };
}
