import { describe, it, expect } from "vitest";
import {
  buildScheduleRecord,
  deactivateDomainDefaultSchedule,
  isDomainDefaultScheduleForDomain,
  normalizeFrequencyResponsibility,
  validateFrequency,
} from "../lib/scheduleService";
import { filterSchedulesByOrigin } from "../lib/scheduleFilters";

const user = { id: "u1", email: "u@x", displayName: "U", roles: ["admin"] };

describe("validateFrequency", () => {
  it("valida frecuencia semanal con días", () => {
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", assignedRole: "domain_updater" })).not.toThrow();
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: [], startDate: "2026-05-01", assignedRole: "x" } as any)).toThrow(/al menos un día/i);
  });
  it("rechaza intervalo sin días", () => {
    expect(() => validateFrequency({ frequencyType: "interval", intervalDays: 0, startDate: "2026-05-01", assignedRole: "x" })).toThrow();
    expect(() => validateFrequency({ frequencyType: "interval", intervalDays: 15, startDate: "2026-05-01", assignedRole: "x" })).not.toThrow();
  });
  it("rechaza fecha inválida", () => {
    expect(() => validateFrequency({ frequencyType: "manual", startDate: "no", assignedRole: "x" })).toThrow();
  });

  it("permite programación única sin campos recurrentes", () => {
    expect(() => validateFrequency({ frequencyType: "once", startDate: "2026-05-20", assignedRole: "domain_updater" })).not.toThrow();
    expect(() => validateFrequency({ frequencyType: "once", startDate: "2026-05-20", endDate: "2026-05-21", assignedRole: "domain_updater" })).toThrow(/única/i);
  });

  it("valida recordatorios específicos de una programación", () => {
    expect(() => validateFrequency({
      frequencyType: "once",
      startDate: "2026-05-20",
      assignedRole: "domain_updater",
      reminders: { remindersEnabled: true, reminderDaysBefore: [2, 1, 0], reminderTime: "07:30", reminderRecipientsMode: "roleUsers" },
    })).not.toThrow();
    expect(() => validateFrequency({
      frequencyType: "once",
      startDate: "2026-05-20",
      assignedRole: "domain_updater",
      reminders: { remindersEnabled: true, reminderDaysBefore: [], reminderTime: "07:30", reminderRecipientsMode: "roleUsers" },
    })).toThrow(/recordatorio/i);
    expect(() => validateFrequency({
      frequencyType: "once",
      startDate: "2026-05-20",
      assignedRole: "domain_updater",
      reminders: { remindersEnabled: true, reminderDaysBefore: [1], reminderTime: "730", reminderRecipientsMode: "roleUsers" },
    })).toThrow(/HH:mm/i);
  });

  it("permite frecuencia sin rol manual y valida fecha de fin opcional", () => {
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", endDate: "2026-05-31" })).not.toThrow();
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-31", endDate: "2026-05-01" })).toThrow(/fecha de fin/i);
  });
});

describe("buildScheduleRecord", () => {
  it("construye una frecuencia tipo dominio asociada al dominio recién creado", () => {
    const r = buildScheduleRecord({
      input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", assignedRole: "domain_updater" },
      clientId: "c1", clientName: "C",
      domainId: "d1", domainName: "x.com",
      targetType: "domain", targetIds: ["d1"],
      currentUser: user,
    });
    expect(r.targetType).toBe("domain");
    expect(r.targetIds).toEqual(["d1"]);
    expect(r.id).toMatch(/^schedule_/);
    expect(r.assignedRole).toBe("domain_updater");
  });

  it("infiere el rol responsable según el tipo de objetivo", () => {
    const r = buildScheduleRecord({
      input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01" },
      clientId: "c1", clientName: "C",
      domainId: "d1", domainName: "x.com",
      targetType: "database", targetIds: ["db1"],
      currentUser: user,
    });
    expect(r.assignedRole).toBe("database_updater");
    expect(r.endDate).toBeNull();
  });

  it("guarda origin domain_default para frecuencias creadas desde dominio", () => {
    const r = buildScheduleRecord({
      input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", origin: "domain_default" },
      clientId: "c1", clientName: "C",
      domainId: "d1", domainName: "x.com",
      targetType: "domain", targetIds: ["d1"],
      currentUser: user,
    });
    expect(r.origin).toBe("domain_default");
  });

  it("guarda origin special para programaciones especiales", () => {
    const r = buildScheduleRecord({
      input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", origin: "special" },
      clientId: "c1", clientName: "C",
      targetType: "database", targetIds: ["db1"],
      currentUser: user,
    });
    expect(r.origin).toBe("special");
  });
});

describe("normalizeFrequencyResponsibility", () => {
  it("al volver a rol predeterminado limpia assignedUserIds y usa roleUsers", () => {
    const r = normalizeFrequencyResponsibility({
      frequencyType: "weekly",
      weekdays: ["FRIDAY"],
      startDate: "2026-05-01",
      assignedRole: "domain_updater",
      assignedUserIds: [],
      reminders: {
        remindersEnabled: true,
        reminderDaysBefore: [1, 0],
        reminderTime: "08:00",
        reminderRecipientsMode: "assignedUsers",
        customReminderEmails: ["viejo@empresa.com"],
      },
    });
    expect(r.assignedUserIds).toEqual([]);
    expect(r.reminders?.reminderRecipientsMode).toBe("roleUsers");
    expect(r.reminders?.customReminderEmails).toEqual([]);
  });

  it("mantiene modo manual solo cuando hay assignedUserIds", () => {
    const r = normalizeFrequencyResponsibility({
      frequencyType: "weekly",
      weekdays: ["FRIDAY"],
      startDate: "2026-05-01",
      assignedRole: "domain_updater",
      assignedUserIds: ["rodrigo"],
      reminders: {
        remindersEnabled: true,
        reminderDaysBefore: [1, 0],
        reminderTime: "08:00",
        reminderRecipientsMode: "roleUsers",
      },
    });
    expect(r.assignedUserIds).toEqual(["rodrigo"]);
    expect(r.reminders?.reminderRecipientsMode).toBe("assignedUsers");
  });

  it("limpia responsables heredados de bases al volver a rol predeterminado", () => {
    const r = normalizeFrequencyResponsibility({
      frequencyType: "weekly",
      weekdays: ["FRIDAY"],
      startDate: "2026-05-01",
      assignedRole: "domain_updater",
      assignedUserIds: [],
      databaseAssignedUserIds: [],
      databaseReminderRecipientsMode: "assignedUsers",
    });
    expect(r.databaseAssignedUserIds).toEqual([]);
    expect(r.databaseReminderRecipientsMode).toBe("roleUsers");
  });
});

describe("filterSchedulesByOrigin", () => {
  const base = buildScheduleRecord({
    input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", origin: "domain_default" },
    clientId: "c1", clientName: "C",
    targetType: "domain", targetIds: ["d1"],
    currentUser: user,
  });
  const special = { ...base, id: "schedule_special", origin: "special" };
  const legacy = { ...base, id: "schedule_legacy", origin: undefined };

  it("GET /api/schedules?origin=special debe devolver solo programaciones especiales", () => {
    expect(filterSchedulesByOrigin([base, special, legacy], "special").map((s) => s.id)).toEqual(["schedule_special"]);
  });

  it("los registros sin origin no rompen el filtro ni aparecen como especiales", () => {
    expect(filterSchedulesByOrigin([legacy], "special")).toEqual([]);
    expect(filterSchedulesByOrigin([legacy], undefined)).toEqual([legacy]);
  });
});

describe("desactivación de frecuencia automática de dominio", () => {
  const base = buildScheduleRecord({
    input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", origin: "domain_default" },
    clientId: "c1",
    clientName: "C",
    domainId: "d1",
    domainName: "https://cliente.sagerp.co",
    targetType: "domain",
    targetIds: ["d1"],
    currentUser: user,
  });

  it("identifica solo programaciones recurrentes domain_default del dominio", () => {
    expect(isDomainDefaultScheduleForDomain(base, "d1")).toBe(true);
    expect(isDomainDefaultScheduleForDomain({ ...base, origin: "special" }, "d1")).toBe(false);
    expect(isDomainDefaultScheduleForDomain({ ...base, targetType: "database" }, "d1")).toBe(false);
    expect(isDomainDefaultScheduleForDomain({ ...base, domainId: "otro", targetIds: ["otro"] }, "d1")).toBe(false);
  });

  it("desactiva la frecuencia sin borrar el registro ni cambiar dominio/base relacionados", () => {
    const disabled = deactivateDomainDefaultSchedule(base, "admin_1", "2026-05-16T10:00:00.000Z");
    expect(disabled.id).toBe(base.id);
    expect(disabled.clientId).toBe(base.clientId);
    expect(disabled.domainId).toBe("d1");
    expect(disabled.targetIds).toEqual(["d1"]);
    expect(disabled.active).toBe(false);
    expect(disabled.updatedBy).toBe("admin_1");
    expect(disabled.updatedAt).toBe("2026-05-16T10:00:00.000Z");
  });
});
