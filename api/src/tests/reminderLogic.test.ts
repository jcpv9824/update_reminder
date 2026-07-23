import { describe, it, expect } from "vitest";
import { decidirRecordatorios, SCHEDULED_REMINDERS_TIMER_SCHEDULE, valoresRecordatoriosPorDefecto } from "../lib/reminderLogic";
import type { UpdateSchedule, UpdateTask } from "../types/models";

const sch: UpdateSchedule = {
  id: "s1", clientId: "c1", clientName: "C", targetType: "domain", targetIds: ["d1"],
  frequencyType: "weekly", startDate: "2026-05-01", timezone: "America/Bogota",
  assignedRole: "domain_updater", assignedUserIds: [], active: true,
  createdAt: "", createdBy: "", updatedAt: "", updatedBy: "",
  reminders: {
    remindersEnabled: true,
    reminderDaysBefore: [3, 1, 0],
    reminderTime: "08:00",
    reminderRecipientsMode: "assignedUsers",
  },
};

function tarea(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    id: "t1", taskDate: "2026-05-10", taskBucket: "2026-05-10_domain",
    clientId: "c1", clientName: "C", domainId: "d1", domainName: "x.com",
    targetType: "domain", targetId: "d1", targetName: "x.com",
    scheduleId: "s1", assignedRole: "domain_updater", assignedUserIds: [],
    status: "pending", result: null, notes: "",
    createdAt: "", createdBy: "", updatedAt: "", updatedBy: "",
    completedAt: null, completedBy: null,
    ...overrides,
  };
}

describe("decidirRecordatorios", () => {
  const map = new Map([[sch.id, sch]]);

  it("envía recordatorio 3 días antes a la hora configurada", () => {
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-07",
      ahoraHoraLocal: "08:30",
      tareas: [tarea()],
      frecuenciasPorId: map,
    });
    expect(r).toHaveLength(1);
    expect(r[0].daysBefore).toBe(3);
    expect(r[0].type).toBe("before");
  });

  it("envía recordatorio el mismo día con daysBefore=0", () => {
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-10",
      ahoraHoraLocal: "08:00",
      tareas: [tarea()],
      frecuenciasPorId: map,
    });
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("sameDay");
    expect(r[0].daysBefore).toBe(0);
  });

  it("no envía si todavía no es la hora configurada", () => {
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-07",
      ahoraHoraLocal: "07:00",
      tareas: [tarea()],
      frecuenciasPorId: map,
    });
    expect(r).toHaveLength(0);
  });

  it("no duplica recordatorios ya enviados el mismo día con el mismo daysBefore", () => {
    const t = tarea({ remindersSent: [{ type: "before", daysBefore: 3, sentAt: "2026-05-07T09:00:00Z", recipients: ["a@b"] }] });
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-07",
      ahoraHoraLocal: "10:00",
      tareas: [t],
      frecuenciasPorId: map,
    });
    expect(r).toHaveLength(0);
  });

  it("no envía si la frecuencia tiene reminders deshabilitados", () => {
    const sch2 = { ...sch, reminders: { ...sch.reminders!, remindersEnabled: false } };
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-10",
      ahoraHoraLocal: "08:00",
      tareas: [tarea()],
      frecuenciasPorId: new Map([[sch2.id, sch2]]),
    });
    expect(r).toHaveLength(0);
  });
});

describe("valoresRecordatoriosPorDefecto", () => {
  it("revisa cada minuto para respetar la hora HH:mm configurada", () => {
    expect(SCHEDULED_REMINDERS_TIMER_SCHEDULE).toBe("0 * * * * *");
  });

  it("usa rol por defecto, recordatorios activos y dias 1,0", () => {
    expect(valoresRecordatoriosPorDefecto()).toEqual({
      remindersEnabled: true,
      reminderDaysBefore: [1, 0],
      reminderTime: "08:00",
      reminderRecipientsMode: "roleUsers",
      customReminderEmails: [],
    });
  });

  it("usa configuración global si la frecuencia no tiene recordatorios propios", () => {
    const schSinOverride = { ...sch, reminders: undefined };
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-09",
      ahoraHoraLocal: "08:10",
      tareas: [tarea({ taskDate: "2026-05-10" })],
      frecuenciasPorId: new Map([[sch.id, schSinOverride]]),
      globalDefaults: {
        remindersEnabled: true,
        reminderDaysBefore: [1],
        reminderTime: "08:00",
        reminderRecipientsMode: "roleUsers",
      },
    });
    expect(r).toHaveLength(1);
  });

  it("el override de la frecuencia prevalece sobre la configuración global", () => {
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-09",
      ahoraHoraLocal: "08:10",
      tareas: [tarea({ taskDate: "2026-05-10" })],
      frecuenciasPorId: new Map([[sch.id, { ...sch, reminders: { ...sch.reminders!, reminderDaysBefore: [3] } }]]),
      globalDefaults: {
        remindersEnabled: true,
        reminderDaysBefore: [1],
        reminderTime: "08:00",
        reminderRecipientsMode: "roleUsers",
      },
    });
    expect(r).toHaveLength(0);
  });

  it("las tareas pendientes pueden enviar recordatorio aunque la programación ya esté inactiva", () => {
    const sch2 = { ...sch, active: false };
    const r = decidirRecordatorios({
      ahoraIsoDate: "2026-05-10",
      ahoraHoraLocal: "08:00",
      tareas: [tarea()],
      frecuenciasPorId: new Map([[sch2.id, sch2]]),
    });
    expect(r).toHaveLength(1);
    expect(r[0].task.id).toBe("t1");
  });
});
