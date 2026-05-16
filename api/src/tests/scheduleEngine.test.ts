import { describe, it, expect } from "vitest";
import {
  isScheduleDueOnDate,
  getTaskDateBucket,
  buildTaskId,
} from "../lib/scheduleEngine";
import type { UpdateSchedule } from "../types/models";

const baseSchedule = (
  overrides: Partial<UpdateSchedule> = {}
): UpdateSchedule => ({
  id: "schedule_1",
  clientId: "client_1",
  clientName: "Cliente",
  domainId: "domain_1",
  domainName: "ejemplo.sagerp.co",
  targetType: "database",
  targetIds: ["db_1"],
  frequencyType: "weekly",
  startDate: "2026-05-01",
  timezone: "America/Bogota",
  assignedRole: "database_updater",
  assignedUserIds: [],
  active: true,
  createdAt: "2026-05-01T00:00:00Z",
  createdBy: "system",
  updatedAt: "2026-05-01T00:00:00Z",
  updatedBy: "system",
  ...overrides,
});

describe("scheduleEngine - frecuencia semanal", () => {
  it("se ejecuta cuando el día coincide con weekdays", () => {
    const s = baseSchedule({
      frequencyType: "weekly",
      everyNWeeks: 1,
      weekdays: ["FRIDAY"],
      startDate: "2026-05-01",
    });
    // 2026-05-08 es viernes
    expect(isScheduleDueOnDate(s, "2026-05-08")).toBe(true);
    // 2026-05-09 es sábado
    expect(isScheduleDueOnDate(s, "2026-05-09")).toBe(false);
  });

  it("respeta everyNWeeks=2", () => {
    const s = baseSchedule({
      frequencyType: "weekly",
      everyNWeeks: 2,
      weekdays: ["FRIDAY"],
      startDate: "2026-05-01",
    });
    expect(isScheduleDueOnDate(s, "2026-05-01")).toBe(true);
    expect(isScheduleDueOnDate(s, "2026-05-08")).toBe(false);
    expect(isScheduleDueOnDate(s, "2026-05-15")).toBe(true);
  });
});

describe("scheduleEngine - frecuencia por intervalo", () => {
  it("se ejecuta cada N días desde startDate", () => {
    const s = baseSchedule({
      frequencyType: "interval",
      intervalDays: 15,
      startDate: "2026-05-01",
    });
    expect(isScheduleDueOnDate(s, "2026-05-01")).toBe(true);
    expect(isScheduleDueOnDate(s, "2026-05-16")).toBe(true);
    expect(isScheduleDueOnDate(s, "2026-05-10")).toBe(false);
  });
});

describe("scheduleEngine - frecuencia mensual", () => {
  it("se ejecuta el día indicado del mes", () => {
    const s = baseSchedule({
      frequencyType: "monthly",
      dayOfMonth: 15,
      startDate: "2026-05-01",
    });
    expect(isScheduleDueOnDate(s, "2026-05-15")).toBe(true);
    expect(isScheduleDueOnDate(s, "2026-06-15")).toBe(true);
    expect(isScheduleDueOnDate(s, "2026-05-14")).toBe(false);
  });
});

describe("scheduleEngine - frecuencia manual", () => {
  it("nunca se ejecuta automáticamente", () => {
    const s = baseSchedule({ frequencyType: "manual" });
    expect(isScheduleDueOnDate(s, "2026-05-15")).toBe(false);
  });
});

describe("scheduleEngine - frecuencia única", () => {
  it("se ejecuta solo en la fecha de actualización", () => {
    const s = baseSchedule({
      frequencyType: "once",
      startDate: "2026-05-20",
    });
    expect(isScheduleDueOnDate(s, "2026-05-19")).toBe(false);
    expect(isScheduleDueOnDate(s, "2026-05-20")).toBe(true);
    expect(isScheduleDueOnDate(s, "2026-05-21")).toBe(false);
  });
});

describe("scheduleEngine - fecha de fin", () => {
  it("no ejecuta frecuencias después de endDate", () => {
    const s = baseSchedule({
      frequencyType: "weekly",
      everyNWeeks: 1,
      weekdays: ["FRIDAY"],
      startDate: "2026-05-01",
      endDate: "2026-05-08",
    });
    expect(isScheduleDueOnDate(s, "2026-05-08")).toBe(true);
    expect(isScheduleDueOnDate(s, "2026-05-15")).toBe(false);
  });
});

describe("scheduleEngine - identificadores deterministas", () => {
  it("genera bucket por fecha y tipo", () => {
    expect(getTaskDateBucket("2026-05-08", "database")).toBe(
      "2026-05-08_database"
    );
    expect(getTaskDateBucket("2026-05-08", "domain")).toBe(
      "2026-05-08_domain"
    );
  });

  it("genera ID determinista", () => {
    expect(buildTaskId("schedule_1", "db_1", "2026-05-08")).toBe(
      "schedule_1_db_1_2026-05-08"
    );
  });
});
