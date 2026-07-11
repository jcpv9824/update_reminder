import { describe, expect, it } from "vitest";
import {
  canPerformTaskActionWithRoleDefinitions,
  canViewTaskWithRoleDefinitions,
  resolveRoleDefinitionsForUser,
} from "../lib/taskAccess";
import type { RoleDefinition } from "../lib/permissionModel";
import type { CurrentUser, UpdateTask } from "../types/models";

function user(id: string, roles: string[]): CurrentUser {
  return { id, email: `${id}@empresa.com`, displayName: id, roles };
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

function role(overrides: Partial<RoleDefinition>): RoleDefinition {
  return {
    id: "custom_role",
    name: "Rol Personalizado",
    permissions: [],
    taskVisibility: { domain: "none", database: "none" },
    system: false,
    ...overrides,
  };
}

describe("task access resolver", () => {
  it("resolves legacy admin as protected super admin during compatibility migration", () => {
    const roles = resolveRoleDefinitionsForUser(user("admin_1", ["admin"]));

    expect(roles.map((item) => item.id)).toEqual(["super_admin"]);
    expect(canViewTaskWithRoleDefinitions(user("admin_1", ["admin"]), task({ assignedUserIds: ["other"] }))).toBe(true);
  });

  it("allows database updater to open tasks and see assigned database tasks only", () => {
    const current = user("ana", ["database_updater"]);

    expect(canViewTaskWithRoleDefinitions(current, task({ assignedUserIds: ["ana"] }))).toBe(true);
    expect(canViewTaskWithRoleDefinitions(current, task({ assignedUserIds: ["other"] }))).toBe(false);
    expect(canViewTaskWithRoleDefinitions(current, task({
      targetType: "domain",
      taskBucket: "2026-06-30_domain",
      assignedRole: "domain_updater",
      assignedUserIds: ["ana"],
    }))).toBe(false);
  });

  it("allows domain updater to open tasks and see assigned domain tasks only", () => {
    const current = user("diego", ["domain_updater"]);

    expect(canViewTaskWithRoleDefinitions(current, task({
      targetType: "domain",
      taskBucket: "2026-06-30_domain",
      assignedRole: "domain_updater",
      assignedUserIds: ["diego"],
    }))).toBe(true);
    expect(canViewTaskWithRoleDefinitions(current, task({ assignedUserIds: ["diego"] }))).toBe(false);
  });

  it("lets a role with database visibility all see all database tasks and no domain tasks", () => {
    const current = user("lead", ["database_supervisor"]);
    const availableRoles = [
      role({
        id: "database_supervisor",
        permissions: ["updates.tasks.view"],
        taskVisibility: { domain: "none", database: "all" },
      }),
    ];

    expect(canViewTaskWithRoleDefinitions(current, task({ assignedUserIds: ["other"] }), availableRoles)).toBe(true);
    expect(canViewTaskWithRoleDefinitions(current, task({
      targetType: "domain",
      taskBucket: "2026-06-30_domain",
      assignedRole: "domain_updater",
      assignedUserIds: ["lead"],
    }), availableRoles)).toBe(false);
  });

  it("keeps page access separate from task visibility", () => {
    const current = user("viewer", ["task_page_only"]);
    const availableRoles = [
      role({
        id: "task_page_only",
        permissions: ["updates.tasks.view"],
        taskVisibility: { domain: "none", database: "none" },
      }),
    ];

    expect(canViewTaskWithRoleDefinitions(current, task({ assignedUserIds: ["viewer"] }), availableRoles)).toBe(false);
  });

  it("requires both action permission and task visibility for task actions", () => {
    const current = user("ana", ["database_worker"]);
    const visibleOnly = [
      role({
        id: "database_worker",
        permissions: ["updates.tasks.view"],
        taskVisibility: { domain: "none", database: "assigned" },
      }),
    ];
    const completer = [
      role({
        id: "database_worker",
        permissions: ["updates.tasks.view", "updates.tasks.complete"],
        taskVisibility: { domain: "none", database: "assigned" },
      }),
    ];

    expect(canPerformTaskActionWithRoleDefinitions(current, task({ assignedUserIds: ["ana"] }), "complete", visibleOnly)).toBe(false);
    expect(canPerformTaskActionWithRoleDefinitions(current, task({ assignedUserIds: ["ana"] }), "complete", completer)).toBe(true);
    expect(canPerformTaskActionWithRoleDefinitions(current, task({ assignedUserIds: ["other"] }), "complete", completer)).toBe(false);
  });

  it("keeps default updater roles able to perform assigned update work", () => {
    const dbUpdater = user("ana", ["database_updater"]);
    const domainUpdater = user("diego", ["domain_updater"]);

    expect(canPerformTaskActionWithRoleDefinitions(dbUpdater, task({ assignedUserIds: ["ana"] }), "complete")).toBe(true);
    expect(canPerformTaskActionWithRoleDefinitions(dbUpdater, task({ assignedUserIds: ["ana"] }), "reveal_database_password")).toBe(true);
    expect(canPerformTaskActionWithRoleDefinitions(domainUpdater, task({
      targetType: "domain",
      taskBucket: "2026-06-30_domain",
      assignedRole: "domain_updater",
      assignedUserIds: ["diego"],
    }), "complete")).toBe(true);
    expect(canPerformTaskActionWithRoleDefinitions(domainUpdater, task({
      targetType: "domain",
      taskBucket: "2026-06-30_domain",
      assignedRole: "domain_updater",
      assignedUserIds: ["diego"],
    }), "reveal_database_password")).toBe(false);
  });
});
