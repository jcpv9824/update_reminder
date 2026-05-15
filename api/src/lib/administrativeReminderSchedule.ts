import type { AdministrativeReminderSettings } from "../types/models";

export type AdministrativeReminderDue = {
  period: string;
  sendDate: string;
  scheduledFor: string;
};

function isoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function monthPeriod(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

export function scheduledAdministrativeReminderDates(reminder: AdministrativeReminderSettings, year: number, monthIndex: number): AdministrativeReminderDue[] {
  const rule = reminder.sendRule ?? "last_business_day";
  const period = monthPeriod(year, monthIndex);
  if (rule === "first_day") {
    const sendDate = `${period}-01`;
    return [{ period, sendDate, scheduledFor: `${sendDate} ${reminder.time}` }];
  }
  if (rule === "fixed_day") {
    if (reminder.dayOfMonth < 1 || reminder.dayOfMonth > 28) throw new Error("El día fijo del mes debe estar entre 1 y 28.");
    const sendDate = `${period}-${String(reminder.dayOfMonth).padStart(2, "0")}`;
    return [{ period, sendDate, scheduledFor: `${sendDate} ${reminder.time}` }];
  }

  const last = lastDayOfMonth(year, monthIndex);
  if (rule === "last_day") {
    const sendDate = isoDateUtc(last);
    return [{ period, sendDate, scheduledFor: `${sendDate} ${reminder.time}` }];
  }

  const day = last.getUTCDay();
  if (day === 6) {
    const friday = isoDateUtc(addDays(last, -1));
    const monday = isoDateUtc(addDays(last, 2));
    return [
      { period, sendDate: friday, scheduledFor: `${friday} ${reminder.time}` },
      { period, sendDate: monday, scheduledFor: `${monday} ${reminder.time}` },
    ];
  }
  if (day === 0) {
    const friday = isoDateUtc(addDays(last, -2));
    const monday = isoDateUtc(addDays(last, 1));
    return [
      { period, sendDate: friday, scheduledFor: `${friday} ${reminder.time}` },
      { period, sendDate: monday, scheduledFor: `${monday} ${reminder.time}` },
    ];
  }
  const sendDate = isoDateUtc(last);
  return [{ period, sendDate, scheduledFor: `${sendDate} ${reminder.time}` }];
}

export function administrativeReminderDueToday(reminder: AdministrativeReminderSettings, now: Date): AdministrativeReminderDue | null {
  if (!reminder.enabled) return null;
  const today = isoDateUtc(now);
  const hhmm = now.toISOString().slice(11, 16);
  const candidates = [
    ...scheduledAdministrativeReminderDates(reminder, now.getUTCFullYear(), now.getUTCMonth()),
    ...scheduledAdministrativeReminderDates(reminder, addDays(now, -7).getUTCFullYear(), addDays(now, -7).getUTCMonth()),
  ];
  return candidates.find((candidate) => candidate.sendDate === today && hhmm >= reminder.time) ?? null;
}
