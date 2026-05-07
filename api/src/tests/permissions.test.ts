import { describe, it, expect } from "vitest";
import {
  hasRole,
  canManageClients,
  canManageUsers,
  canManageSchedules,
  canCompleteDatabaseTask,
  canCompleteDomainTask,
  canRevealDatabaseSecret,
} from "../lib/permissions";
import type { CurrentUser, UpdateTask, DatabaseRecord } from "../types/models";

const user = (roles: string[]): CurrentUser => ({
  id: "u1",
  email: "u@x.com",
  displayName: "U",
  roles,
});

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

  it("viewer no puede gestionar nada", () => {
    const u = user(["viewer"]);
    expect(canManageClients(u)).toBe(false);
    expect(canManageUsers(u)).toBe(false);
    expect(canManageSchedules(u)).toBe(false);
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
