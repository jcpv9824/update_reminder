import { describe, it, expect } from "vitest";
import { expandSchedulesWithDomainInheritance, expectedTaskKeysForDate, generateTasksForDate, markOneTimeScheduleCompleted, obsoleteTasksOutsideExpected, oneTimeSchedulesReadyToComplete, summarizeTaskGenerationForDate, taskBelongsToSchedule, taskTargetKey } from "../lib/taskGenerator";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseModuleRecord, UpdateSchedule, UpdateTask } from "../types/models";

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

  it("frecuencia de dominio sin usuarios manuales crea tarea asignada al rol", () => {
    const roleSchedule: UpdateSchedule = {
      ...domainSchedule,
      assignedUserIds: [],
    };
    const tasks = generateTasksForDate([roleSchedule], "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignedRole).toBe("domain_updater");
    expect(tasks[0].assignedUserIds).toEqual([]);
  });

  it("frecuencia de dominio con usuarios manuales crea tarea asignada a esas personas", () => {
    const manualSchedule: UpdateSchedule = {
      ...domainSchedule,
      assignedUserIds: ["mateo", "laura"],
    };
    const tasks = generateTasksForDate([manualSchedule], "2026-05-08", [], (id) => id);
    expect(tasks[0].assignedRole).toBe("domain_updater");
    expect(tasks[0].assignedUserIds).toEqual(["mateo", "laura"]);
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

  it("la generacion sigue usando frecuencias domain_default", () => {
    const tasks = generateTasksForDate([{ ...schedule, origin: "domain_default" }], "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(2);
  });

  it("la generacion sigue usando programaciones especiales", () => {
    const tasks = generateTasksForDate([{ ...schedule, origin: "special" }], "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(2);
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

  it("sincroniza responsables de una tarea pendiente existente cuando la frecuencia volvió a rol", () => {
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
        targetName: "BD vieja",
        scheduleId: "schedule_1",
        assignedRole: "database_updater",
        assignedUserIds: ["rodrigo"],
        status: "pending",
        result: null,
        notes: "",
        createdAt: "",
        createdBy: "system",
        updatedAt: "",
        updatedBy: "system",
        completedAt: null,
        completedBy: null,
      },
    ];
    const roleSchedule: UpdateSchedule = { ...schedule, targetIds: ["db_1"], assignedUserIds: [] };
    const summary = summarizeTaskGenerationForDate([roleSchedule], "2026-05-08", existing, () => "BD actual");
    expect(summary.tasks).toHaveLength(0);
    expect(summary.skipped).toBe(1);
    expect(summary.syncedTasks).toHaveLength(1);
    expect(existing[0].assignedUserIds).toEqual([]);
    expect(existing[0].assignedRole).toBe("database_updater");
    expect(existing[0].targetName).toBe("BD actual");
  });

  it("no sincroniza responsables de tareas completadas", () => {
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
        targetName: "BD vieja",
        scheduleId: "schedule_1",
        assignedRole: "database_updater",
        assignedUserIds: ["rodrigo"],
        status: "completed",
        completedWithProblems: true,
        result: null,
        notes: "",
        createdAt: "",
        createdBy: "system",
        updatedAt: "",
        updatedBy: "system",
        completedAt: "2026-05-08T10:00:00Z",
        completedBy: "rodrigo",
      },
    ];
    const roleSchedule: UpdateSchedule = { ...schedule, targetIds: ["db_1"], assignedUserIds: [] };
    const summary = summarizeTaskGenerationForDate([roleSchedule], "2026-05-08", existing, () => "BD actual");
    expect(summary.syncedTasks).toHaveLength(0);
    expect(existing[0].assignedUserIds).toEqual(["rodrigo"]);
  });

  it("ignora frecuencias inactivas", () => {
    const inactive = { ...schedule, active: false };
    const tasks = generateTasksForDate([inactive], "2026-05-08", [], (i) => i);
    expect(tasks).toHaveLength(0);
  });

  it("reactiva una tarea obsoleta cancelada cuando la programación activa vuelve a requerirla", () => {
    const existing: UpdateTask[] = [{
      id: "schedule_1_db_1_2026-05-08",
      dedupeKey: "database:db_1:2026-05-08",
      sources: [],
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "ejemplo.sagerp.co",
      targetType: "database",
      targetId: "db_1",
      targetName: "Nombre anterior",
      scheduleId: "schedule_1",
      assignedRole: "database_updater",
      assignedUserIds: [],
      status: "cancelled",
      result: "obsolete",
      notes: "Cancelada por refresh anterior.",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    }];
    const summary = summarizeTaskGenerationForDate([{ ...schedule, targetIds: ["db_1"] }], "2026-05-08", existing, (id) => `Nombre de ${id}`);
    expect(summary.tasks).toHaveLength(0);
    expect(summary.syncedTasks).toHaveLength(1);
    expect(summary.syncedTasks[0].status).toBe("pending");
    expect(summary.syncedTasks[0].result).toBeNull();
    expect(summary.syncedTasks[0].targetName).toBe("Nombre de db_1");
  });

  it("una tarea completada existente sigue bloqueando duplicados para la misma entidad y día", () => {
    const existing: UpdateTask[] = [{
      id: "schedule_1_db_1_2026-05-08",
      dedupeKey: "database:db_1:2026-05-08",
      sources: [],
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "ejemplo.sagerp.co",
      targetType: "database",
      targetId: "db_1",
      targetName: "Nombre de db_1",
      scheduleId: "schedule_1",
      assignedRole: "database_updater",
      assignedUserIds: [],
      status: "completed",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: "2026-05-08T10:00:00Z",
      completedBy: "user",
    }];
    const summary = summarizeTaskGenerationForDate([{ ...schedule, targetIds: ["db_1"] }], "2026-05-08", existing, (id) => `Nombre de ${id}`);
    expect(summary.tasks).toHaveLength(0);
    expect(summary.syncedTasks).toHaveLength(0);
    expect(summary.skipped).toBeGreaterThan(0);
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

  it("reconciliación marca obsoleta una tarea pendiente cuyo dominio ya no está esperado", () => {
    const existing = [{
      id: "old_domain_task",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_domain",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_deleted",
      domainName: "sampedro.sagerp.cloud",
      targetType: "domain",
      targetId: "domain_deleted",
      targetName: "sampedro.sagerp.cloud",
      scheduleId: "schedule_deleted",
      assignedRole: "domain_updater",
      assignedUserIds: [],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    }] as UpdateTask[];
    const obsoleted = obsoleteTasksOutsideExpected(existing, new Set(), "2026-05-08T12:00:00Z");
    expect(obsoleted).toHaveLength(1);
    expect(existing[0].status).toBe("cancelled");
    expect(existing[0].result).toBe("obsolete");
  });

  it("reconciliación preserva vencidas abiertas aunque ya no estén esperadas", () => {
    const oldPending = {
      id: "old_pending_task",
      taskDate: "2026-04-18",
      taskBucket: "2026-04-18_domain",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "cliente.pya.com.co",
      targetType: "domain",
      targetId: "domain_1",
      targetName: "cliente.pya.com.co",
      scheduleId: "schedule_domain",
      assignedRole: "domain_updater",
      assignedUserIds: [],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    } as UpdateTask;
    const oldBlocked = { ...oldPending, id: "old_blocked_task", status: "blocked" as const };
    const oldInProgress = { ...oldPending, id: "old_in_progress_task", status: "in_progress" as const };
    const obsoleted = obsoleteTasksOutsideExpected([oldPending, oldBlocked, oldInProgress], new Set(), "2026-05-08T12:00:00Z", "2026-05-08");
    expect(obsoleted).toHaveLength(0);
    expect(oldPending.status).toBe("pending");
    expect(oldBlocked.status).toBe("blocked");
    expect(oldInProgress.status).toBe("in_progress");
  });

  it("reconciliación preserva tareas abiertas de hoy para no cancelar programaciones únicas ya ejecutadas", () => {
    const todayPending = {
      id: "today_pending_task",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_domain",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "cliente.pya.com.co",
      targetType: "domain",
      targetId: "domain_1",
      targetName: "cliente.pya.com.co",
      scheduleId: "schedule_once",
      assignedRole: "domain_updater",
      assignedUserIds: [],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    } as UpdateTask;
    const obsoleted = obsoleteTasksOutsideExpected([todayPending], new Set(), "2026-05-08T12:00:00Z", "2026-05-08");
    expect(obsoleted).toHaveLength(0);
    expect(todayPending.status).toBe("pending");
  });

  it("reconciliación marca obsoleta una tarea pendiente de base heredada si el dominio padre ya no está esperado", () => {
    const existing = [{
      id: "old_database_task",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_deleted",
      domainName: "sampedro.sagerp.cloud",
      targetType: "database",
      targetId: "db_1",
      targetName: "SAMPEDRO",
      scheduleId: "schedule_domain__db_inherited_db_1",
      assignedRole: "database_updater",
      assignedUserIds: [],
      status: "reopened",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    }] as UpdateTask[];
    const obsoleted = obsoleteTasksOutsideExpected(existing, new Set(), "2026-05-08T12:00:00Z");
    expect(obsoleted).toHaveLength(1);
    expect(existing[0].status).toBe("cancelled");
  });

  it("reconciliación no elimina tareas completadas ni completadas con problemas", () => {
    const completed = {
      id: "completed_task",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_deleted",
      domainName: "sampedro.sagerp.cloud",
      targetType: "database",
      targetId: "db_1",
      targetName: "SAMPEDRO",
      scheduleId: "schedule_deleted",
      assignedRole: "database_updater",
      assignedUserIds: [],
      status: "completed",
      completedWithProblems: true,
      result: "completed_with_problems",
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: "2026-05-08T10:00:00Z",
      completedBy: "u",
    } as UpdateTask;
    const obsoleted = obsoleteTasksOutsideExpected([completed], new Set(), "2026-05-08T12:00:00Z");
    expect(obsoleted).toHaveLength(0);
    expect(completed.status).toBe("completed");
  });

  it("reconciliación preserva tareas pendientes que siguen en el conjunto esperado", () => {
    const existing = [{
      id: "expected_task",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_domain",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "cliente.pya.com.co",
      targetType: "domain",
      targetId: "domain_1",
      targetName: "cliente.pya.com.co",
      scheduleId: "schedule_domain",
      assignedRole: "domain_updater",
      assignedUserIds: [],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    }] as UpdateTask[];
    const expected = new Set([taskTargetKey("domain", "domain_1", "2026-05-08")]);
    const obsoleted = obsoleteTasksOutsideExpected(existing, expected, "2026-05-08T12:00:00Z");
    expect(obsoleted).toHaveLength(0);
    expect(existing[0].status).toBe("pending");
  });

  it("expectedTaskKeysForDate contiene solo tareas que aplican ese día", () => {
    const expectedSchedule: UpdateSchedule = { ...schedule, targetType: "domain", targetIds: ["domain_1"], assignedRole: "domain_updater" };
    const expected = expectedTaskKeysForDate([expectedSchedule], "2026-05-08");
    expect(expected.has(taskTargetKey("domain", "domain_1", "2026-05-08"))).toBe(true);
    expect(expectedTaskKeysForDate([expectedSchedule], "2026-05-09").size).toBe(0);
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
  it("una programación plana de dominio no genera bases implícitas", () => {
    const expanded = expandSchedulesWithDomainInheritance([domainSchedule], [domain], [db("db_1")]);
    const tasks = generateTasksForDate(expanded, "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].targetType).toBe("domain");
    expect(tasks[0].rootScheduleId).toBe("schedule_domain");
  });

  it("el alcance explícito puede incluir todas las bases activas del dominio", () => {
    const scheduleWithDbUsers: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_manual_all_dbs",
      origin: "special",
      selectionMode: "manual",
      manualTargetTypes: "domains_and_databases",
      scopeGroups: [{
        clientId: "client_1",
        includeAllDomains: false,
        domains: [{ domainId: "domain_1", includeAllDatabases: true, databaseIds: [] }],
      }],
      assignmentMode: "users",
      targetIds: [],
      databaseAssignedUserIds: ["db_user_1", "db_user_2"],
      databaseReminderRecipientsMode: "assignedUsers",
      reminders: {
        remindersEnabled: true,
        reminderDaysBefore: [1, 0],
        reminderTime: "08:00",
        reminderRecipientsMode: "roleUsers",
      },
    };
    const expanded = expandSchedulesWithDomainInheritance([scheduleWithDbUsers], [domain], [db("db_1")]);
    const databaseSchedule = expanded.find((s) => s.targetType === "database");
    const tasks = generateTasksForDate(expanded, "2026-05-08", [], (id) => id);
    expect(tasks.map((t) => t.targetType).sort()).toEqual(["database", "domain"]);
    expect(databaseSchedule?.assignedRole).toBe("database_updater");
    expect(databaseSchedule?.assignedUserIds).toEqual(["db_user_1", "db_user_2"]);
    expect(tasks.find((task) => task.targetType === "database")?.rootScheduleId).toBe("schedule_manual_all_dbs");
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

  it("programaciones de dominio y base explícitas pueden coexistir sin herencia oculta", () => {
    const dbSpecific: UpdateSchedule = { ...schedule, id: "schedule_db_specific", targetIds: ["db_1"], active: true };
    const expanded = expandSchedulesWithDomainInheritance([domainSchedule, dbSpecific], [domain], [db("db_1")]);
    const tasks = generateTasksForDate(expanded, "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(2);
    expect(tasks.some((t) => t.scheduleId === "schedule_db_specific" && t.targetId === "db_1")).toBe(true);
    expect(tasks.some((t) => t.scheduleId.includes("__db_inherited"))).toBe(false);
  });

  it("programación por licenciamiento incluye clientes licenciados agregados después", () => {
    const module: LicenseModuleRecord = { id: "lic_mobile", name: "Mobile App", status: "active" };
    const client: ClientRecord = { id: "client_1", name: "Cliente", status: "active", licenseModuleIds: ["lic_mobile"], createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" };
    const licensingSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_licensing",
      selectionMode: "licensing",
      licensingScope: {
        licenseModuleIds: ["lic_mobile"],
        licenseMatchMode: "any",
        environment: "production",
        targetTypes: "domains_and_databases",
        activeOnly: true,
      },
      scopeGroups: undefined,
      targetIds: [],
      origin: "licensing",
    };
    const expanded = expandSchedulesWithDomainInheritance([licensingSchedule], [domain], [db("db_1")], [client], [module]);
    const tasks = generateTasksForDate(expanded, "2026-05-08", [], (id) => id);
    expect(tasks.map((task) => task.targetType).sort()).toEqual(["database", "domain"]);
  });

  it("programación por licenciamiento y normal el mismo día crean una sola tarea por entidad", () => {
    const module: LicenseModuleRecord = { id: "lic_mobile", name: "Mobile App", status: "active" };
    const client: ClientRecord = { id: "client_1", name: "Cliente", status: "active", licenseModuleIds: ["lic_mobile"], createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" };
    const licensingSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_licensing",
      selectionMode: "licensing",
      licensingScope: {
        licenseModuleIds: ["lic_mobile"],
        licenseMatchMode: "any",
        environment: "production",
        targetTypes: "domains_only",
        activeOnly: true,
      },
      scopeGroups: undefined,
      targetIds: [],
      origin: "licensing",
    };
    const expanded = expandSchedulesWithDomainInheritance([domainSchedule, licensingSchedule], [domain], [db("db_1")], [client], [module]);
    const summary = summarizeTaskGenerationForDate(expanded, "2026-05-08", [], (id) => id);
    expect(summary.tasks.filter((task) => task.targetType === "domain" && task.targetId === "domain_1")).toHaveLength(1);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  });

  it("normal y licenciamiento sobre la misma base el mismo día crean una sola tarea", () => {
    const module: LicenseModuleRecord = { id: "lic_mobile", name: "Mobile App", status: "active" };
    const client: ClientRecord = { id: "client_1", name: "Cliente", status: "active", licenseModuleIds: ["lic_mobile"], createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" };
    const normalDbSchedule: UpdateSchedule = { ...schedule, id: "schedule_db_normal", targetIds: ["db_1"], origin: "domain_default" };
    const licensingSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_licensing_db",
      selectionMode: "licensing",
      licensingScope: {
        licenseModuleIds: ["lic_mobile"],
        licenseMatchMode: "any",
        environment: "production",
        targetTypes: "databases_only",
        activeOnly: true,
      },
      scopeGroups: undefined,
      targetIds: [],
      origin: "licensing",
    };
    const expanded = expandSchedulesWithDomainInheritance([normalDbSchedule, licensingSchedule], [domain], [db("db_1")], [client], [module]);
    const summary = summarizeTaskGenerationForDate(expanded, "2026-05-08", [], (id) => id);
    const dbTasks = summary.tasks.filter((task) => task.targetType === "database" && task.targetId === "db_1");
    expect(dbTasks).toHaveLength(1);
    expect(dbTasks[0].sources?.map((source) => source.scheduleId).sort()).toEqual(["schedule_db_normal", "schedule_licensing_db__lic_db_db_1"].sort());
  });

  it("manual especial y licenciamiento sobre el mismo dominio el mismo día crean una sola tarea", () => {
    const module: LicenseModuleRecord = { id: "lic_mobile", name: "Mobile App", status: "active" };
    const client: ClientRecord = { id: "client_1", name: "Cliente", status: "active", licenseModuleIds: ["lic_mobile"], createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" };
    const manualSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_manual",
      origin: "special",
      scopeGroups: [{ clientId: "client_1", includeAllDomains: false, domains: [{ domainId: "domain_1", includeAllDatabases: false, databaseIds: [] }] }],
      targetIds: [],
    };
    const licensingSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_licensing_manual",
      selectionMode: "licensing",
      licensingScope: {
        licenseModuleIds: ["lic_mobile"],
        licenseMatchMode: "any",
        environment: "production",
        targetTypes: "domains_only",
        activeOnly: true,
      },
      scopeGroups: undefined,
      targetIds: [],
      origin: "licensing",
    };
    const expanded = expandSchedulesWithDomainInheritance([manualSchedule, licensingSchedule], [domain], [db("db_1")], [client], [module]);
    const summary = summarizeTaskGenerationForDate(expanded, "2026-05-08", [], (id) => id);
    const domainTasks = summary.tasks.filter((task) => task.targetType === "domain" && task.targetId === "domain_1");
    expect(domainTasks).toHaveLength(1);
    expect(domainTasks[0].sources?.map((source) => source.scheduleId).sort()).toEqual(["schedule_manual__domain_domain_1", "schedule_licensing_manual__lic_domain_domain_1"].sort());
  });

  it("programación manual solo bases crea tareas de base sin tarea de dominio", () => {
    const manualSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_manual_db_only",
      origin: "special",
      selectionMode: "manual",
      manualTargetTypes: "databases_only",
      scopeGroups: [{ clientId: "client_1", includeAllDomains: false, domains: [{ domainId: "domain_1", includeAllDatabases: false, databaseIds: ["db_1"] }] }],
      targetIds: [],
    };
    const expanded = expandSchedulesWithDomainInheritance([manualSchedule], [domain], [db("db_1")]);
    const summary = summarizeTaskGenerationForDate(expanded, "2026-05-08", [], (id) => id);
    expect(summary.tasks.map((task) => task.targetType)).toEqual(["database"]);
    expect(summary.tasks[0].targetId).toBe("db_1");
    expect(summary.tasks[0].scheduleId).toBe("schedule_manual_db_only__db_db_1");
  });

  it("programación manual solo dominios no crea tareas de base aunque haya bases seleccionadas", () => {
    const manualSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_manual_domain_only",
      origin: "special",
      selectionMode: "manual",
      manualTargetTypes: "domains_only",
      scopeGroups: [{ clientId: "client_1", includeAllDomains: false, domains: [{ domainId: "domain_1", includeAllDatabases: false, databaseIds: ["db_1"] }] }],
      targetIds: [],
    };
    const expanded = expandSchedulesWithDomainInheritance([manualSchedule], [domain], [db("db_1")]);
    const summary = summarizeTaskGenerationForDate(expanded, "2026-05-08", [], (id) => id);
    expect(summary.tasks.map((task) => task.targetType)).toEqual(["domain"]);
    expect(summary.tasks[0].targetId).toBe("domain_1");
  });

  it("misma entidad en días diferentes crea tareas diferentes", () => {
    const viernes = generateTasksForDate([domainSchedule], "2026-05-08", [], (id) => id);
    const viernesSiguiente = generateTasksForDate([domainSchedule], "2026-05-15", viernes, (id) => id);
    expect(viernes).toHaveLength(1);
    expect(viernesSiguiente).toHaveLength(1);
    expect(viernes[0].dedupeKey).toBe("domain:domain_1:2026-05-08");
    expect(viernesSiguiente[0].dedupeKey).toBe("domain:domain_1:2026-05-15");
  });

  it("programación única genera en runDate pero no se cierra hasta que sus tareas estén cerradas", () => {
    const onceSchedule: UpdateSchedule = {
      ...domainSchedule,
      id: "schedule_once",
      frequencyType: "once",
      startDate: "2026-05-08",
      endDate: null,
    };
    const tasks = generateTasksForDate([onceSchedule], "2026-05-08", [], (id) => id);
    expect(tasks).toHaveLength(1);
    expect(generateTasksForDate([onceSchedule], "2026-05-09", [], (id) => id)).toHaveLength(0);

    expect(oneTimeSchedulesReadyToComplete([onceSchedule], tasks, "2026-05-08")).toEqual([]);
    const closedTasks = tasks.map((task) => ({ ...task, status: "completed" as const, completedAt: "2026-05-08T12:00:00Z" }));
    const ready = oneTimeSchedulesReadyToComplete([onceSchedule], closedTasks, "2026-05-08");
    expect(ready.map((item) => item.id)).toEqual(["schedule_once"]);
    expect(oneTimeSchedulesReadyToComplete([onceSchedule], closedTasks, "2026-05-07")).toEqual([]);
    const completed = markOneTimeScheduleCompleted(onceSchedule, "2026-05-08T12:00:00Z", "system");
    expect(completed.active).toBe(false);
    expect(completed.completedReason).toBe("one_time_schedule_executed");
    expect(completed.completedAt).toBe("2026-05-08T12:00:00Z");
  });

  it("reconoce tareas expandidas como pertenecientes a la programación base", () => {
    const task = {
      id: "schedule_once__db_db_1_db_1_2026-05-08",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "cliente.pya.com.co",
      targetType: "database",
      targetId: "db_1",
      targetName: "Empresa db_1",
      scheduleId: "schedule_once__db_db_1",
      sources: [{ scheduleId: "schedule_once__db_db_1", scheduleType: "special", createdAt: "2026-05-08T08:00:00Z" }],
      assignedRole: "database_updater",
      assignedUserIds: [],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    } as UpdateTask;
    expect(taskBelongsToSchedule(task, "schedule_once")).toBe(true);
    expect(taskBelongsToSchedule(task, "schedule_other")).toBe(false);
  });
});
