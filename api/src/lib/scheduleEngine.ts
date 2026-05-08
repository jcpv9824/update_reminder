import type { UpdateSchedule, Weekday } from "../types/models";

const WEEKDAY_INDEX: Record<Weekday, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

function parseDateOnly(d: string): Date {
  // "YYYY-MM-DD" interpretado como medianoche UTC para evitar drift por zona local.
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function diffInDays(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function getWeekdayUTC(date: Date): Weekday {
  const map: Weekday[] = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ];
  return map[date.getUTCDay()];
}

export function isScheduleDueOnDate(
  schedule: UpdateSchedule,
  isoDate: string
): boolean {
  if (!schedule.active) return false;
  const target = parseDateOnly(isoDate);
  const start = parseDateOnly(schedule.startDate);
  if (target.getTime() < start.getTime()) return false;
  if (schedule.endDate) {
    const end = parseDateOnly(schedule.endDate);
    if (target.getTime() > end.getTime()) return false;
  }

  switch (schedule.frequencyType) {
    case "manual":
      return false;

    case "weekly": {
      const weekdays = schedule.weekdays ?? [];
      const everyN = schedule.everyNWeeks ?? 1;
      const weekday = getWeekdayUTC(target);
      if (!weekdays.includes(weekday)) return false;
      const weeksSinceStart = Math.floor(diffInDays(target, start) / 7);
      return weeksSinceStart % everyN === 0;
    }

    case "interval": {
      const interval = schedule.intervalDays ?? 1;
      const days = diffInDays(target, start);
      if (days % interval !== 0) return false;
      if (schedule.preferredWeekdays && schedule.preferredWeekdays.length > 0) {
        const weekday = getWeekdayUTC(target);
        if (!schedule.preferredWeekdays.includes(weekday)) return false;
      }
      return true;
    }

    case "monthly": {
      const day = target.getUTCDate();
      return day === (schedule.dayOfMonth ?? 1);
    }

    default:
      return false;
  }
}

export function getTaskDateBucket(
  isoDate: string,
  targetType: "domain" | "database"
): string {
  return `${isoDate}_${targetType}`;
}

export function buildTaskId(
  scheduleId: string,
  targetId: string,
  isoDate: string
): string {
  return `${scheduleId}_${targetId}_${isoDate}`;
}
