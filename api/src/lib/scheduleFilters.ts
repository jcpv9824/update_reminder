import type { UpdateSchedule } from "../types/models";

export function filterSchedulesByOrigin(schedules: UpdateSchedule[], origin?: string | null): UpdateSchedule[] {
  if (!origin) return schedules;
  return schedules.filter((s) => s.origin === origin);
}
