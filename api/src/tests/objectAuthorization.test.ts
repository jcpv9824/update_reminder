import { describe, expect, it } from "vitest";
import {
  canReadDatabase,
  canReadDatabaseConnection,
  canReadDatabaseInDomain,
  canReadDatabasePassword,
  canReadDomain,
  canReadTask,
  filterClientIdsForUser,
  filterDatabasesForUser,
  filterTasksForUser,
} from "../lib/objectAuthorization";
import type { CurrentUser, DatabaseRecord, DomainRecord, UpdateTask } from "../types/models";

function user(id: string, roles: string[]): CurrentUser {
  return { id, email: `${id}@empresa.com`, displayName: id, roles };
}

function database(overrides: Partial<DatabaseRecord> = {}): DatabaseRecord {
  return {
    id: "db_1",
    clientId: "client_1",
    clientName: "Cliente 1",
    domainId: "domain_1",
    domainName: "https://cliente.example.com",
    companyName: "Empresa 1",
    environment: "production",
    dbAccess: {
      serverHostPort: "sql.internal:1433",
      initialCatalog: "ERP_CLIENTE",
      userId: "sql_user",
      passwordSecretName: "db-secret-name",
    },
    assignedUpdaterIds: ["db_assigned"],
    status: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    createdBy: "admin",
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "admin",
    ...overrides,
  };
}

function domain(overrides: Partial<DomainRecord> = {}): DomainRecord {
  return {
    id: "domain_1",
    clientId: "client_1",
    clientName: "Cliente 1",
    domainName: "https://cliente.example.com",
    environment: "production",
    assignedUpdaterIds: ["domain_assigned"],
    status: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    createdBy: "admin",
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "admin",
    ...overrides,
  };
}

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    id: "task_1",
    taskDate: "2026-06-30",
    taskBucket: "2026-06-30_database",
    clientId: "client_1",
    clientName: "Cliente 1",
    domainId: "domain_1",
    domainName: "https://cliente.example.com",
    targetType: "database",
    targetId: "db_1",
    targetName: "ERP_CLIENTE",
    scheduleId: "schedule_1",
    rootScheduleId: "schedule_1",
    assignedRole: "database_updater",
    assignedUserIds: [],
    status: "pending",
    result: null,
    notes: "",
    createdAt: "2026-06-01T00:00:00.000Z",
    createdBy: "system",
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "system",
    completedAt: null,
    completedBy: null,
    ...overrides,
  };
}

describe("SEC-002 - autorización BOLA/IDOR por rol", () => {
  for (const role of ["admin", "client_manager", "viewer"]) {
    it(`${role} conserva lectura global de metadata y tareas`, () => {
      const current = user(`${role}_1`, [role]);
      expect(canReadDatabase(current, database())).toBe(true);
      expect(canReadDomain(current, domain())).toBe(true);
      expect(canReadTask(current, task())).toBe(true);
    });
  }

  it("database_updater solo lee la base asignada y no puede adivinar otra por ID", () => {
    const current = user("db_assigned", ["database_updater"]);
    const own = database();
    const other = database({ id: "db_other", assignedUpdaterIds: ["other_user"] });

    expect(canReadDatabase(current, own)).toBe(true);
    expect(canReadDatabase(current, other)).toBe(false);
    expect(filterDatabasesForUser(current, [own, other]).map((item) => item.id)).toEqual(["db_1"]);
  });

  it("una tarea asignada concede metadata solo de su objetivo y relaciones directas", () => {
    const current = user("task_user", ["database_updater"]);
    const ownTask = task({ assignedUserIds: ["task_user"] });
    const own = database({ assignedUpdaterIds: [] });
    const other = database({ id: "db_other", clientId: "client_2", domainId: "domain_2", assignedUpdaterIds: [] });
    const domains = [domain(), domain({ id: "domain_2", clientId: "client_2", assignedUpdaterIds: [] })];

    expect(canReadDatabase(current, own, [ownTask])).toBe(true);
    expect(canReadDatabase(current, other, [ownTask])).toBe(false);
    expect(canReadDomain(current, domains[0], [own], [ownTask])).toBe(true);
    expect(Array.from(filterClientIdsForUser(current, domains, [own, other], [ownTask]) ?? [])).toEqual(["client_1"]);
  });

  it("domain_updater solo lee el dominio asignado y metadata de sus bases en ese contexto", () => {
    const current = user("domain_assigned", ["domain_updater"]);
    const ownDomain = domain();
    const otherDomain = domain({ id: "domain_other", assignedUpdaterIds: ["other_user"] });
    const ownDomainDatabase = database();

    expect(canReadDomain(current, ownDomain)).toBe(true);
    expect(canReadDomain(current, otherDomain)).toBe(false);
    expect(canReadDatabase(current, ownDomainDatabase)).toBe(false);
    expect(canReadDatabaseInDomain(current, ownDomainDatabase, ownDomain)).toBe(true);
  });

  it("una asignación individual de tarea prevalece sobre el fallback por rol", () => {
    const assigned = user("assigned_user", ["database_updater"]);
    const sameRoleButOther = user("other_user", ["database_updater"]);
    const individuallyAssigned = task({ assignedUserIds: ["assigned_user"] });

    expect(canReadTask(assigned, individuallyAssigned)).toBe(true);
    expect(canReadTask(sameRoleButOther, individuallyAssigned)).toBe(false);
  });

  it("el fallback por rol solo aplica si no hay usuarios específicos", () => {
    const dbUpdater = user("db_role_user", ["database_updater"]);
    const domainUpdater = user("domain_role_user", ["domain_updater"]);
    const dbTask = task({ assignedUserIds: [] });
    const domainTask = task({
      id: "task_domain",
      targetType: "domain",
      targetId: "domain_1",
      assignedRole: "domain_updater",
      assignedUserIds: [],
    });

    expect(canReadTask(dbUpdater, dbTask)).toBe(true);
    expect(canReadTask(dbUpdater, domainTask)).toBe(false);
    expect(canReadTask(domainUpdater, domainTask)).toBe(true);
    expect(canReadTask(domainUpdater, dbTask)).toBe(false);
  });

  it("el listado de tareas no puede ampliarse con parámetros del cliente", () => {
    const current = user("assigned_user", ["database_updater"]);
    const own = task({ id: "task_own", assignedUserIds: ["assigned_user"] });
    const foreign = task({ id: "task_foreign", assignedUserIds: ["other_user"] });
    expect(filterTasksForUser(current, [own, foreign]).map((item) => item.id)).toEqual(["task_own"]);
  });

  it("los clientes visibles para actualizadores se derivan de sus objetos asignados", () => {
    const dbUpdater = user("db_assigned", ["database_updater"]);
    const domainUpdater = user("domain_assigned", ["domain_updater"]);
    const domains = [domain(), domain({ id: "domain_2", clientId: "client_2", assignedUpdaterIds: ["other"] })];
    const databases = [database(), database({ id: "db_2", clientId: "client_2", domainId: "domain_2", assignedUpdaterIds: ["other"] })];

    expect(Array.from(filterClientIdsForUser(dbUpdater, domains, databases) ?? [])).toEqual(["client_1"]);
    expect(Array.from(filterClientIdsForUser(domainUpdater, domains, databases) ?? [])).toEqual(["client_1"]);
  });

  it("un rol desconocido no obtiene objetos operativos", () => {
    const unknown = user("unknown", ["custom_role"]);
    expect(canReadDatabase(unknown, database())).toBe(false);
    expect(canReadDomain(unknown, domain())).toBe(false);
    expect(canReadTask(unknown, task())).toBe(false);
  });
});

describe("SEC-002/SEC-003 - acceso explícito a conexión", () => {
  it("viewer y domain_updater no pueden obtener servidor, usuario ni contraseña", () => {
    const db = database();
    for (const role of ["viewer", "domain_updater"]) {
      const current = user(`${role}_1`, [role]);
      expect(canReadDatabaseConnection(current, db)).toBe(false);
      expect(canReadDatabasePassword(current, db)).toBe(false);
    }
  });

  it("client_manager puede administrar metadata de conexión pero no revelar contraseña", () => {
    const current = user("manager", ["client_manager"]);
    expect(canReadDatabaseConnection(current, database())).toBe(true);
    expect(canReadDatabasePassword(current, database())).toBe(false);
  });

  it("database_updater accede por asignación de base o por su tarea, nunca por una tarea ajena", () => {
    const current = user("task_user", ["database_updater"]);
    const db = database({ assignedUpdaterIds: [] });
    const ownTask = task({ assignedUserIds: ["task_user"] });
    const foreignTask = task({ id: "task_other", assignedUserIds: ["other_user"] });

    expect(canReadDatabaseConnection(current, db, ownTask)).toBe(true);
    expect(canReadDatabasePassword(current, db, ownTask)).toBe(true);
    expect(canReadDatabaseConnection(current, db, foreignTask)).toBe(false);
    expect(canReadDatabasePassword(current, db, foreignTask)).toBe(false);
  });

  it("una tarea de otra base no autoriza acceso aunque esté asignada al usuario", () => {
    const current = user("task_user", ["database_updater"]);
    const wrongTargetTask = task({ targetId: "db_other", assignedUserIds: ["task_user"] });
    expect(canReadDatabaseConnection(current, database(), wrongTargetTask)).toBe(false);
    expect(canReadDatabasePassword(current, database(), wrongTargetTask)).toBe(false);
  });
});
