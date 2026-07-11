import { describe, expect, it } from "vitest";
import type { RoleDefinition } from "../permissionModel";
import { hasTaskVisibilityForRoleIds, resolveTaskVisibilityForRoleIds } from "../permissionAccess";

const roles: RoleDefinition[] = [
  {
    id: "super_admin",
    name: "Super Administrador",
    permissions: [],
    taskVisibility: { domain: "none", database: "none" },
    system: true,
    protected: true,
    active: true,
  },
  {
    id: "domain_assigned",
    name: "Dominios Asignados",
    permissions: ["updates.tasks.view"],
    taskVisibility: { domain: "assigned", database: "none" },
    system: false,
    active: true,
  },
  {
    id: "database_all",
    name: "Todas Las Bases",
    permissions: ["updates.tasks.view"],
    taskVisibility: { domain: "none", database: "all" },
    system: false,
    active: true,
  },
  {
    id: "inactive_all",
    name: "Inactivo",
    permissions: ["updates.tasks.view"],
    taskVisibility: { domain: "all", database: "all" },
    system: false,
    active: false,
  },
];

describe("permissionAccess task visibility", () => {
  it("super_admin conserva visibilidad total aunque la definicion almacenada sea incompleta", () => {
    expect(resolveTaskVisibilityForRoleIds(["super_admin"], roles)).toEqual({ domain: "all", database: "all" });
    expect(resolveTaskVisibilityForRoleIds(["admin"], roles)).toEqual({ domain: "all", database: "all" });
  });

  it("combina visibilidad de tareas de roles activos", () => {
    expect(resolveTaskVisibilityForRoleIds(["domain_assigned", "database_all"], roles)).toEqual({
      domain: "assigned",
      database: "all",
    });
  });

  it("ignora roles inactivos al resolver visibilidad", () => {
    expect(resolveTaskVisibilityForRoleIds(["inactive_all"], roles)).toEqual({ domain: "none", database: "none" });
    expect(hasTaskVisibilityForRoleIds(["inactive_all"], "domain", roles)).toBe(false);
  });
});
