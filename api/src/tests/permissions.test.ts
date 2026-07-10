import { describe, it, expect } from "vitest";
import {
  hasRole,
  canManageClients,
  canManageUsers,
  canManageSchedules,
  canGenerateTasks,
  canSendMastersReport,
  canCompleteDatabaseTask,
  canCompleteDomainTask,
  canRevealDatabaseSecret,
  canAccessDatabaseTaskConnection,
  canManagePrintFormats,
  canManagePublicDownloads,
} from "../lib/permissions";
import { buildDatabaseAccessInfo } from "../lib/databaseAccessInfo";
import type { CurrentUser, UpdateTask, DatabaseRecord } from "../types/models";

const user = (roles: string[]): CurrentUser => ({
  id: "u1",
  email: "u@x.com",
  displayName: "U",
  roles,
});

function baseTask(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    id: "t1",
    taskDate: "2026-05-08",
    taskBucket: "2026-05-08_database",
    clientId: "c1",
    clientName: "C",
    domainId: "d1",
    domainName: "d",
    targetType: "database",
    targetId: "db1",
    targetName: "BD",
    scheduleId: "s1",
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
    ...overrides,
  };
}

describe("permissions", () => {
  it("hasRole detecta el rol", () => {
    expect(hasRole(user(["admin"]), "admin")).toBe(true);
    expect(hasRole(user(["viewer"]), "admin")).toBe(false);
  });

  it("admin puede gestionar todo", () => {
    const u = user(["admin"]);
    expect(canManageClients(u)).toBe(true);
    expect(canManageUsers(u)).toBe(true);
    expect(canManageSchedules(u)).toBe(true);
  });

  it("client_manager puede gestionar clientes pero no usuarios", () => {
    const u = user(["client_manager"]);
    expect(canManageClients(u)).toBe(true);
    expect(canManageUsers(u)).toBe(false);
    expect(canManageSchedules(u)).toBe(true);
  });

  it("solo admin y client_manager pueden generar tareas y enviar el reporte maestro", () => {
    expect(canGenerateTasks(user(["admin"]))).toBe(true);
    expect(canGenerateTasks(user(["client_manager"]))).toBe(true);
    expect(canGenerateTasks(user(["database_updater"]))).toBe(false);
    expect(canSendMastersReport(user(["admin"]))).toBe(true);
    expect(canSendMastersReport(user(["client_manager"]))).toBe(true);
    expect(canSendMastersReport(user(["viewer"]))).toBe(false);
  });

  it("viewer no puede gestionar nada", () => {
    const u = user(["viewer"]);
    expect(canManageClients(u)).toBe(false);
    expect(canManageUsers(u)).toBe(false);
    expect(canManageSchedules(u)).toBe(false);
  });

  it("solo admin o formatos_impresion.admin pueden administrar Formatos de Impresión", () => {
    expect(canManagePrintFormats(user(["admin"]))).toBe(true);
    expect(canManagePrintFormats(user(["formatos_impresion.admin"]))).toBe(true);
    expect(canManagePrintFormats(user(["client_manager"]))).toBe(false);
    expect(canManagePrintFormats(user(["viewer"]))).toBe(false);
  });

  it("solo admin o public_downloads.admin pueden administrar Descargas públicas", () => {
    expect(canManagePublicDownloads(user(["admin"]))).toBe(true);
    expect(canManagePublicDownloads(user(["public_downloads.admin"]))).toBe(true);
    expect(canManagePublicDownloads(user(["client_manager"]))).toBe(false);
    expect(canManagePublicDownloads(user(["viewer"]))).toBe(false);
  });

  it("database_updater asignado puede completar su tarea de base de datos", () => {
    const u = user(["database_updater"]);
    u.id = "user_x";
    const task: UpdateTask = {
      id: "t1",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "c1",
      clientName: "C",
      domainId: "d1",
      domainName: "d",
      targetType: "database",
      targetId: "db1",
      targetName: "BD",
      scheduleId: "s1",
      assignedRole: "database_updater",
      assignedUserIds: ["user_x"],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    };
    expect(canCompleteDatabaseTask(u, task)).toBe(true);
    // Domain updater no puede completar tareas de DB
    expect(canCompleteDatabaseTask(user(["domain_updater"]), task)).toBe(
      false
    );
  });

  it("admin puede acceder a metadata de conexión de una tarea de base por rol", () => {
    expect(canAccessDatabaseTaskConnection(user(["admin"]), baseTask())).toBe(true);
  });

  it("database_updater puede acceder a conexión cuando assignedUserIds está vacío y assignedRole es database_updater", () => {
    expect(canAccessDatabaseTaskConnection(user(["database_updater"]), baseTask({ assignedUserIds: [], assignedRole: "database_updater" }))).toBe(true);
  });

  it("usuario directamente asignado puede acceder a conexión aunque la tarea tenga responsible manual", () => {
    const assigned = user(["viewer"]);
    assigned.id = "rodrigo";
    expect(canAccessDatabaseTaskConnection(assigned, baseTask({ assignedUserIds: ["rodrigo"] }))).toBe(true);
  });

  it("database_updater no asignado no accede a conexión cuando assignedUserIds tiene otro usuario", () => {
    const other = user(["database_updater"]);
    other.id = "otro";
    expect(canAccessDatabaseTaskConnection(other, baseTask({ assignedUserIds: ["rodrigo"] }))).toBe(false);
  });

  it("domain_updater no accede a conexión de tareas de base por rol", () => {
    expect(canAccessDatabaseTaskConnection(user(["domain_updater"]), baseTask())).toBe(false);
  });

  it("metadata de conexión no incluye contraseña ni nombre de secreto", () => {
    const db: DatabaseRecord = {
      id: "db1",
      clientId: "c1",
      clientName: "C",
      domainId: "d1",
      domainName: "d",
      companyName: "X",
      environment: "production",
      dbAccess: {
        serverHostPort: "server,1433",
        initialCatalog: "ERP",
        userId: "sql_user",
        passwordSecretName: "kv-secret-name",
      },
      assignedUpdaterIds: [],
      status: "active",
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      updatedBy: "",
      lastUpdatedAt: null,
      lastUpdatedBy: null,
    };
    const info = buildDatabaseAccessInfo(db);
    expect(info).toEqual({ server: "server,1433", databaseName: "ERP", user: "sql_user", hasPassword: true });
    expect(JSON.stringify(info)).not.toContain("kv-secret-name");
    expect(JSON.stringify(info).toLowerCase()).not.toContain("passwordsecretname");
  });

  it("domain_updater no puede completar tareas de tipo database", () => {
    const u = user(["domain_updater"]);
    const task: UpdateTask = {
      id: "t1",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "c1",
      clientName: "C",
      domainId: "d1",
      domainName: "d",
      targetType: "database",
      targetId: "db1",
      targetName: "BD",
      scheduleId: "s1",
      assignedRole: "database_updater",
      assignedUserIds: [u.id],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    };
    expect(canCompleteDomainTask(u, task)).toBe(false);
  });

  it("actualizadores pueden cambiar tareas de su tipo cuando no hay usuario asignado explícito", () => {
    const baseTask: UpdateTask = {
      id: "t1",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_database",
      clientId: "c1",
      clientName: "C",
      domainId: "d1",
      domainName: "d",
      targetType: "database",
      targetId: "db1",
      targetName: "BD",
      scheduleId: "s1",
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
    };
    expect(canCompleteDatabaseTask(user(["database_updater"]), baseTask)).toBe(true);
    expect(canCompleteDomainTask(user(["domain_updater"]), { ...baseTask, targetType: "domain", taskBucket: "2026-05-08_domain", assignedRole: "domain_updater" })).toBe(true);
  });

  it("responsable manual limita la tarea al usuario asignado o admin", () => {
    const assignedTask: UpdateTask = {
      id: "t1",
      taskDate: "2026-05-08",
      taskBucket: "2026-05-08_domain",
      clientId: "c1",
      clientName: "C",
      domainId: "d1",
      domainName: "d",
      targetType: "domain",
      targetId: "d1",
      targetName: "Dominio",
      scheduleId: "s1",
      assignedRole: "domain_updater",
      assignedUserIds: ["mateo"],
      status: "pending",
      result: null,
      notes: "",
      createdAt: "",
      createdBy: "system",
      updatedAt: "",
      updatedBy: "system",
      completedAt: null,
      completedBy: null,
    };
    const other = user(["domain_updater"]);
    other.id = "otro";
    const assigned = user(["domain_updater"]);
    assigned.id = "mateo";
    expect(canCompleteDomainTask(other, assignedTask)).toBe(false);
    expect(canCompleteDomainTask(assigned, assignedTask)).toBe(true);
    expect(canCompleteDomainTask(user(["admin"]), assignedTask)).toBe(true);
  });


  it("domain_updater no puede revelar contraseña de base de datos", () => {
    const db: DatabaseRecord = {
      id: "db1",
      clientId: "c1",
      clientName: "C",
      domainId: "d1",
      domainName: "d",
      companyName: "X",
      environment: "production",
      dbAccess: {
        serverHostPort: "x",
        initialCatalog: "x",
        userId: "x",
        passwordSecretName: "kv-x",
      },
      assignedUpdaterIds: ["u1"],
      status: "active",
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      updatedBy: "",
      lastUpdatedAt: null,
      lastUpdatedBy: null,
    };
    expect(canRevealDatabaseSecret(user(["domain_updater"]), db)).toBe(false);
    expect(canRevealDatabaseSecret(user(["admin"]), db)).toBe(true);
  });

  it("database_updater solo puede revelar contraseñas de bases asignadas", () => {
    const db: DatabaseRecord = {
      id: "db1",
      clientId: "c1",
      clientName: "C",
      domainId: "d1",
      domainName: "d",
      companyName: "X",
      environment: "production",
      dbAccess: {
        serverHostPort: "x",
        initialCatalog: "x",
        userId: "x",
        passwordSecretName: "kv-x",
      },
      assignedUpdaterIds: ["assigned_user"],
      status: "active",
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      updatedBy: "",
      lastUpdatedAt: null,
      lastUpdatedBy: null,
    };
    const assigned = user(["database_updater"]);
    assigned.id = "assigned_user";
    const other = user(["database_updater"]);
    other.id = "other_user";
    expect(canRevealDatabaseSecret(assigned, db)).toBe(true);
    expect(canRevealDatabaseSecret(other, db)).toBe(false);
  });
});
