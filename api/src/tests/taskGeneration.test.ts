import { describe, it, expect } from "vitest";
import { expandSchedulesWithDomainInheritance, generateTasksForDate, summarizeTaskGenerationForDate } from "../lib/taskGenerator";
import type { DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

const schedule: UpdateSchedule = {
  id: "schedule_1",
  clientId: "client_1",
  clientName: "Cliente",
  domainId: "domain_1",
  domainName: "ejemplo.sagerp.co",
  targetType: "database",
  targetIds: ["db_1", "db_2"],
  frequencyType: "weekly",
  everyNWeeks: 1,
  weekdays: ["FRIDAY"],
  startDate: "2026-05-01",
  timezone: "America/Bogota",
  assignedRole: "database_updater",
  assignedUserIds: ["user_a"],
  active: true,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

describe("generateTasksForDate", () => {
  it("genera una tarea por target cuando aplica la frecuencia", () => {
    const targetNameResolver = (id: string) => `Nombre de ${id}`;
    const tasks = generateTasksForDate(
      [schedule],
      "2026-05-08",
      [],
      targetNameResolver
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("schedule_1_db_1_2026-05-08");
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].targetType).toBe("database");
    expect(tasks[0].assignedUserIds).toEqual(["user_a"]);
  });

  it("no genera tareas en una fecha que no aplica", () => {
    const tasks = generateTasksForDate(
      [schedule],
      "2026-05-09",
      [],
      (id) => id
    );
    expect(tasks).toHaveLength(0);
  });

  it("no duplica tareas existentes (idempotencia)", () => {
    const existing: UpdateTask[] = [
      {
        id: "schedule_1_db_1_2026-05-08",
        taskDate: "2026-05-08",
        taskBucket: "2026-05-08_database",
        clientId: "client_1",
        clientName: "Cliente",
        domainId: "domain_1",
        domainName: "ejemplo.sagerp.co",
        targetType: "database",
        targetId: "db_1",
        targetName: "BD 1",
        scheduleId: "schedule_1",
        assignedRole: "database_updater",
        assignedUserIds: ["user_a"],
        status: "pending",
        result: null,
        notes: "",
        createdAt: "",
        createdBy: "",
        updatedAt: "",
        updatedBy: "",
        completedAt: null,
        completedBy: null,
      },
    ];
    const tasks = generateTasksForDate(
      [schedule],
      "2026-05-08",
      existing,
      (id) => id
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].targetId).toBe("db_2");
  });

  it("ignora frecuencias inactivas", () => {
    const inactive = { ...schedule, active: false };
    const tasks = generateTasksForDate([inactive], "2026-05-08", [], (i) => i);
    expect(tasks).toHaveLength(0);
  });

  it("devuelve resumen con tareas creadas y omitidas por duplicado", () => {
    const existing = [{
      id: "schedule_1_db_1_2026-05-08",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "ejemplo.sagerp.co",
      targetType: "database",
      targetId: "db_1",
      targetName: "BD 1",
      scheduleId: "schedule_1",
      assignedRole: "database_updater",
      assignedUserIds: ["user_a"],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      updatedBy: "",
      completedAt: null,
      completedBy: null,
    }] as UpdateTask[];
    const summary = summarizeTaskGenerationForDate([schedule], "2026-05-08", existing, (id) => id);
    expect(summary.tasks).toHaveLength(1);
    expect(summary.skipped).toBe(1);
  });
});

const domain: DomainRecord = {
  id: "domain_1",
  clientId: "client_1",
  clientName: "Cliente",
  domainName: "cliente.pya.com.co",
  environment: "production",
  assignedUpdaterIds: ["domain_user"],
  status: "active",
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const db = (id: string, status: "active" | "inactive" | "deleted" = "active"): DatabaseRecord => ({
  id,
  clientId: "client_1",
  clientName: "Cliente",
  domainId: "domain_1",
  domainName: "cliente.pya.com.co",
  companyName: `Empresa ${id}`,
  environment: "production",
  dbAccess: { serverHostPort: "server", initialCatalog: `CAT_${id}`, userId: "sql_user", passwordSecretName: `secret_${id}` },
  assignedUpdaterIds: [`updater_${id}`],
  status,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
});

const domainSchedule: UpdateSchedule = {
  ...schedule,
  id: "schedule_domain",
  targetType: "domain",
  targetIds: ["domain_1"],
  assignedRole: "domain_updater",
  assignedUserIds: ["domain_user"],
};

describe("expandSchedulesWithDomainInheritance", () => {
  it("base de datos hereda frecuencia activa del dominio y genera tarea de dominio y de base", () => {
    const expanded = expandSchedulesWithDomainInheritance([domainSchedule], [domain], [db("db_1")]);
    const tasks = generateTasksForDate(expanded, "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.targetType).sort()).toEqual(["database", "domain"]);
    expect(tasks.find((t) => t.targetType === "database")?.scheduleId).toBe("schedule_domain__db_inherited_db_1");
  });

  it("no genera tareas heredadas para bases inactivas o eliminadas", () => {
    const expanded = expandSchedulesWithDomainInheritance([domainSchedule], [domain], [db("db_inactiva", "inactive"), db("db_eliminada", "deleted")]);
    const tasks = generateTasksForDate(expanded, "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].targetType).toBe("domain");
  });

  it("no genera tareas si el dominio está inactivo", () => {
    const inactiveDomain = { ...domain, status: "inactive" as const };
    const expanded = expandSchedulesWithDomainInheritance([domainSchedule], [inactiveDomain], [db("db_1")]);
    expect(expanded).toHaveLength(0);
  });

  it("la frecuencia específica activa de base de datos tiene prioridad sobre la herencia del dominio", () => {
    const dbSpecific: UpdateSchedule = { ...schedule, id: "schedule_db_specific", targetIds: ["db_1"], active: true };
    const expanded = expandSchedulesWithDomainInheritance([domainSchedule, dbSpecific], [domain], [db("db_1")]);
    const tasks = generateTasksForDate(expanded, "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(2);
    expect(tasks.some((t) => t.scheduleId === "schedule_db_specific" && t.targetId === "db_1")).toBe(true);
    expect(tasks.some((t) => t.scheduleId.includes("__db_inherited"))).toBe(false);
  });
});
