// Pruebas que cubren explícitamente el bug "created=0 cuando hay un schedule
// activo dentro de la ventana": evaluamos toda la ventana, no una sola fecha.
import { describe, it, expect } from "vitest";
import { expandSchedulesWithDomainInheritance, summarizeTaskGenerationForDate } from "../lib/taskGenerator";
import { isScheduleDueOnDate } from "../lib/scheduleEngine";
import type { DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

function listDates(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    const [y, m, d] = cur.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    cur = dt.toISOString().slice(0, 10);
  }
  return out;
}

describe("Escenario SAMPEDRO — generación por ventana con alcance explícito", () => {
  const cliente = "client_sampedro";
  const dominio: DomainRecord = {
    id: "domain_sampedro",
    clientId: cliente,
    clientName: "SAMPEDRO",
    domainName: "https://sampedro.sagerp.cloud:54678/",
    environment: "production",
    assignedUpdaterIds: [],
    status: "active",
    createdAt: "", createdBy: "", updatedAt: "", updatedBy: "",
    lastUpdatedAt: null, lastUpdatedBy: null,
  };
  const baseDeDatos: DatabaseRecord = {
    id: "db_sampedro_1",
    clientId: cliente,
    clientName: "SAMPEDRO",
    domainId: dominio.id,
    domainName: dominio.domainName,
    companyName: "Sampedro",
    environment: "production",
    dbAccess: { serverHostPort: "x", initialCatalog: "SAMPEDRO", userId: "x", passwordSecretName: "secret-x" },
    assignedUpdaterIds: [],
    status: "active",
    createdAt: "", createdBy: "", updatedAt: "", updatedBy: "",
    lastUpdatedAt: null, lastUpdatedBy: null,
  };
  const schedule: UpdateSchedule = {
    id: "schedule_sampedro",
    clientId: cliente,
    clientName: "SAMPEDRO",
    domainId: dominio.id,
    domainName: dominio.domainName,
    targetType: "domain",
    targetIds: [dominio.id],
    frequencyType: "weekly",
    everyNWeeks: 1,
    weekdays: ["FRIDAY"],
    startDate: "2026-05-07",
    timezone: "America/Bogota",
    assignedRole: "domain_updater",
    assignedUserIds: [],
    active: true,
    createdAt: "", createdBy: "", updatedAt: "", updatedBy: "",
  };

  it("startDate jueves 2026-05-07 con weekday FRIDAY genera el viernes 2026-05-08", () => {
    expect(isScheduleDueOnDate(schedule, "2026-05-08")).toBe(true);
    expect(isScheduleDueOnDate(schedule, "2026-05-07")).toBe(false);
  });

  it("una programación plana de dominio no crea schedule heredado para la base", () => {
    const expanded = expandSchedulesWithDomainInheritance([schedule], [dominio], [baseDeDatos]);
    expect(expanded).toHaveLength(1);
    const dominioSch = expanded.find((s) => s.targetType === "domain")!;
    expect(dominioSch.targetIds).toEqual([dominio.id]);
    expect(expanded.find((s) => s.targetType === "database")).toBeUndefined();
  });

  it("recorriendo la ventana genera solo dominio si la base no está en el alcance", () => {
    const ventana = listDates("2026-04-30", "2026-05-14");
    const expanded = expandSchedulesWithDomainInheritance([schedule], [dominio], [baseDeDatos]);
    const existing: UpdateTask[] = [];
    let creadas = 0;
    let dominioCount = 0;
    let dbCount = 0;
    for (const d of ventana) {
      const r = summarizeTaskGenerationForDate(expanded, d, existing, (id) => id);
      for (const t of r.tasks) {
        existing.push(t);
        creadas++;
        if (t.targetType === "domain") dominioCount++;
        if (t.targetType === "database") dbCount++;
      }
    }
    expect(creadas).toBe(1);
    expect(dominioCount).toBe(1);
    expect(dbCount).toBe(0);
    const fechas = existing.map((t) => t.taskDate);
    expect(fechas).toContain("2026-05-08");
  });

  it("incluye dominio y base cuando el alcance manual marca incluir todas las bases", () => {
    const manualSchedule: UpdateSchedule = {
      ...schedule,
      origin: "special",
      selectionMode: "manual",
      manualTargetTypes: "domains_and_databases",
      scopeGroups: [{
        clientId: cliente,
        includeAllDomains: false,
        domains: [{ domainId: dominio.id, includeAllDatabases: true, databaseIds: [] }],
      }],
      targetIds: [],
    };
    const expanded = expandSchedulesWithDomainInheritance([manualSchedule], [dominio], [baseDeDatos]);
    const result = summarizeTaskGenerationForDate(expanded, "2026-05-08", [], (id) => id);
    expect(result.tasks.map((task) => task.targetType).sort()).toEqual(["database", "domain"]);
    expect(result.tasks.every((task) => task.rootScheduleId === schedule.id)).toBe(true);
  });

  it("idempotencia: ejecutar dos veces no duplica las tareas", () => {
    const ventana = listDates("2026-04-30", "2026-05-14");
    const expanded = expandSchedulesWithDomainInheritance([schedule], [dominio], [baseDeDatos]);
    const existing: UpdateTask[] = [];
    function corrida() {
      let c = 0, s = 0;
      for (const d of ventana) {
        const r = summarizeTaskGenerationForDate(expanded, d, existing, (id) => id);
        for (const t of r.tasks) { existing.push(t); c++; }
        s += r.skipped;
      }
      return { c, s };
    }
    const r1 = corrida();
    const r2 = corrida();
    expect(r1.c).toBe(1);
    expect(r2.c).toBe(0);
    expect(r2.s).toBeGreaterThanOrEqual(1);
  });

  it("dominio inactivo no genera tareas", () => {
    const inactivo = { ...dominio, status: "inactive" as const };
    const expanded = expandSchedulesWithDomainInheritance([schedule], [inactivo], [baseDeDatos]);
    expect(expanded).toHaveLength(0);
  });
});
