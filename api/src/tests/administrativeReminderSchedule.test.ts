import { describe, expect, it } from "vitest";
import { administrativeReminderDueToday, scheduledAdministrativeReminderDates } from "../lib/administrativeReminderSchedule";
import type { AdministrativeReminderSettings } from "../types/models";

const base: AdministrativeReminderSettings = {
  enabled: true,
  recipients: ["admin@empresa.com"],
  sendRule: "last_business_day",
  dayOfMonth: 15,
  time: "08:00",
  timezone: "America/Bogota",
  subject: "Recordatorio",
};

describe("administrative reminder schedule", () => {
  it("último día hábil entre lunes y viernes envía solo ese día", () => {
    expect(scheduledAdministrativeReminderDates(base, 2026, 2)).toEqual([
      { period: "2026-03", sendDate: "2026-03-31", scheduledFor: "2026-03-31 08:00" },
    ]);
  });

  it("si el mes termina sábado genera viernes anterior y lunes siguiente", () => {
    expect(scheduledAdministrativeReminderDates(base, 2026, 0)).toEqual([
      { period: "2026-01", sendDate: "2026-01-30", scheduledFor: "2026-01-30 08:00" },
      { period: "2026-01", sendDate: "2026-02-02", scheduledFor: "2026-02-02 08:00" },
    ]);
  });

  it("si el mes termina domingo genera viernes anterior y lunes siguiente con periodo anterior", () => {
    const due = scheduledAdministrativeReminderDates(base, 2026, 4);
    expect(due).toEqual([
      { period: "2026-05", sendDate: "2026-05-29", scheduledFor: "2026-05-29 08:00" },
      { period: "2026-05", sendDate: "2026-06-01", scheduledFor: "2026-06-01 08:00" },
    ]);
    expect(administrativeReminderDueToday(base, new Date("2026-06-01T08:30:00.000Z"))?.period).toBe("2026-05");
  });

  it("primer día, último día y día fijo funcionan", () => {
    expect(scheduledAdministrativeReminderDates({ ...base, sendRule: "first_day" }, 2026, 4)[0].sendDate).toBe("2026-05-01");
    expect(scheduledAdministrativeReminderDates({ ...base, sendRule: "last_day" }, 2026, 4)[0].sendDate).toBe("2026-05-31");
    expect(scheduledAdministrativeReminderDates({ ...base, sendRule: "fixed_day", dayOfMonth: 8 }, 2026, 4)[0].sendDate).toBe("2026-05-08");
  });

  it("día fijo inválido se rechaza", () => {
    expect(() => scheduledAdministrativeReminderDates({ ...base, sendRule: "fixed_day", dayOfMonth: 31 }, 2026, 4)).toThrow(/1 y 28/);
  });
});
