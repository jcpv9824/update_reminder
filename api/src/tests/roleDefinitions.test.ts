import { describe, expect, it } from "vitest";
import {
  createRoleDefinitionRecord,
  mergeRoleDefinitions,
  parseRoleDefinitionPayload,
  updateRoleDefinitionRecord,
  validateAssignableRoleIds,
} from "../lib/roleDefinitions";
import { allPermissionKeys, DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../lib/permissionModel";
import type { CurrentUser } from "../types/models";

const actor: CurrentUser = {
  id: "admin_1",
  email: "admin@empresa.com",
  displayName: "Admin",
  roles: ["super_admin"],
};

function stored(overrides: Partial<RoleDefinition> = {}) {
  return {
    id: "custom_role",
    name: "Rol Personalizado",
    permissions: ["updates.tasks.view"],
    taskVisibility: { domain: "none", database: "assigned" },
    system: false,
    active: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "admin_1",
    updatedAt: "2026-07-01T00:00:00.000Z",
    updatedBy: "admin_1",
    ...overrides,
  };
}

describe("role definitions", () => {
  it("only allows active role definitions to be assigned to users", () => {
    const available = [
      stored({ id: "active_role", active: true }),
      stored({ id: "inactive_role", active: false }),
    ];

    expect(validateAssignableRoleIds(["active_role"], available)).toBeNull();
    expect(validateAssignableRoleIds(["inactive_role"], available)).toMatch(/inactivo/i);
    expect(validateAssignableRoleIds(["missing_role"], available)).toMatch(/no existe/i);
  });

  it("rejects permissions that are not declared in the permission catalog", () => {
    expect(() => parseRoleDefinitionPayload({
      name: "Rol con permiso inválido",
      permissions: ["updates.tasks.view", "updates.tasks.destroy_everything"],
      taskVisibility: { domain: "none", database: "none" },
    })).toThrow("Permiso no reconocido: updates.tasks.destroy_everything");
  });

  it("creates custom role records with normalized ids and audit metadata", () => {
    const record = createRoleDefinitionRecord({
      name: "Supervisor de Bases",
      permissions: ["updates.tasks.view"],
      taskVisibility: { domain: "none", database: "all" },
    }, actor, "2026-07-10T12:00:00.000Z");

    expect(record).toMatchObject({
      id: "supervisor_de_bases",
      name: "Supervisor de Bases",
      permissions: ["updates.tasks.view"],
      taskVisibility: { domain: "none", database: "all" },
      system: false,
      active: true,
      createdBy: "admin_1",
      updatedBy: "admin_1",
    });
  });

  it("merges stored roles with defaults and preserves editable system roles", () => {
    const merged = mergeRoleDefinitions([
      stored({
        id: "database_updater",
        name: "Actualizador DB Personalizado",
        permissions: ["updates.tasks.view", "updates.tasks.complete"],
      }),
      stored({ id: "custom_role", name: "Rol Manual" }),
    ]);

    expect(merged.find((role) => role.id === "database_updater")).toMatchObject({
      name: "Actualizador DB Personalizado",
      permissions: ["updates.tasks.view", "updates.tasks.complete"],
      system: true,
    });
    expect(merged.find((role) => role.id === "custom_role")).toMatchObject({
      name: "Rol Manual",
      system: false,
    });
  });

  it("protects super_admin from losing universal permissions or visibility", () => {
    const merged = mergeRoleDefinitions([
      stored({
        id: "super_admin",
        name: "Super Admin Renombrado",
        permissions: [],
        taskVisibility: { domain: "none", database: "none" },
      }),
    ]);
    const superAdmin = merged.find((role) => role.id === "super_admin")!;

    expect(superAdmin.name).toBe("Super Admin Renombrado");
    expect(superAdmin.permissions).toEqual(allPermissionKeys());
    expect(superAdmin.taskVisibility).toEqual({ domain: "all", database: "all" });
    expect(superAdmin.protected).toBe(true);
    expect(superAdmin.active).toBe(true);
  });

  it("updates protected super_admin without allowing universal access removal", () => {
    const updated = updateRoleDefinitionRecord(DEFAULT_ROLE_DEFINITIONS[0], {
      name: "Super Administrador Principal",
      permissions: [],
      taskVisibility: { domain: "none", database: "none" },
      active: false,
    }, actor, "2026-07-10T12:00:00.000Z");

    expect(updated.name).toBe("Super Administrador Principal");
    expect(updated.permissions).toEqual(allPermissionKeys());
    expect(updated.taskVisibility).toEqual({ domain: "all", database: "all" });
    expect(updated.active).toBe(true);
  });
});
