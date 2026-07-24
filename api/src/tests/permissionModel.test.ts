import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_DEFINITIONS,
  PERMISSION_CATALOG,
  allPermissionKeys,
  eligibleRolesForTaskAssignment,
  effectiveTaskVisibility,
  hasPermissionFromRoles,
  migrateLegacyRoleIds,
  modulePermissionKeys,
  optionPermissionKeys,
} from "../lib/permissionModel";

describe("permission model", () => {
  it("only offers active roles with task access and matching visibility for schedule assignment", () => {
    const roles = [
      { id: "domain_worker", name: "Especialista de Dominios", permissions: ["updates.tasks.view"], taskVisibility: { domain: "assigned", database: "none" }, system: false, active: true },
      { id: "database_supervisor", name: "Supervisor de Bases", permissions: ["updates.tasks.view"], taskVisibility: { domain: "none", database: "all" }, system: false, active: true },
      { id: "task_page_only", name: "Solo página de tareas", permissions: ["updates.tasks.view"], taskVisibility: { domain: "none", database: "none" }, system: false, active: true },
      { id: "inactive_domain_worker", name: "Inactivo", permissions: ["updates.tasks.view"], taskVisibility: { domain: "assigned", database: "none" }, system: false, active: false },
    ];

    expect(eligibleRolesForTaskAssignment(roles, "domain").map((role) => role.id)).toEqual(["domain_worker"]);
    expect(eligibleRolesForTaskAssignment(roles, "database").map((role) => role.id)).toEqual(["database_supervisor"]);
  });

  it("exposes option-specific actions instead of universal CRUD", () => {
    const tasks = PERMISSION_CATALOG
      .find((module) => module.id === "updates")!
      .options.find((option) => option.id === "tasks")!;
    const dashboard = PERMISSION_CATALOG
      .find((module) => module.id === "visibility")!
      .options.find((option) => option.id === "dashboard")!;

    expect(optionPermissionKeys(tasks)).toContain("updates.tasks.complete");
    expect(optionPermissionKeys(tasks)).toContain("updates.tasks.reveal_database_password");
    expect(optionPermissionKeys(tasks)).not.toContain("updates.tasks.create");
    expect(optionPermissionKeys(dashboard)).toEqual(["visibility.dashboard.view"]);
  });

  it("separates forced downloads from inline public files and retires section actions", () => {
    const implementation = PERMISSION_CATALOG.find((module) => module.id === "implementation")!;
    const downloads = implementation.options.find((option) => option.id === "public_downloads")!;
    const publicFiles = implementation.options.find((option) => option.id === "public_files")!;

    expect(optionPermissionKeys(downloads)).toEqual([
      "implementation.public_downloads.view",
      "implementation.public_downloads.create_document",
      "implementation.public_downloads.edit_document",
      "implementation.public_downloads.delete_document",
      "implementation.public_downloads.replace_file",
    ]);
    expect(optionPermissionKeys(downloads)).not.toContain("implementation.public_downloads.create_section");
    expect(optionPermissionKeys(publicFiles)).toEqual([
      "implementation.public_files.view",
      "implementation.public_files.create_file",
      "implementation.public_files.edit_file",
      "implementation.public_files.delete_file",
      "implementation.public_files.replace_file",
    ]);
  });

  it("selecting a module resolves all supported child option actions", () => {
    const configurationKeys = modulePermissionKeys("configuration");

    expect(configurationKeys).toContain("configuration.users.reset_password");
    expect(configurationKeys).toContain("configuration.roles.manage_task_visibility");
    expect(configurationKeys).toContain("configuration.print_formats.replace_pdf");
    expect(configurationKeys).not.toContain("configuration.dashboard.view");
  });

  it("super admin has every catalog permission and all task visibility", () => {
    const superAdmin = DEFAULT_ROLE_DEFINITIONS.find((role) => role.id === "super_admin")!;

    expect(superAdmin.protected).toBe(true);
    expect(superAdmin.permissions).toEqual(allPermissionKeys());
    expect(effectiveTaskVisibility([superAdmin])).toEqual({ domain: "all", database: "all" });
    expect(hasPermissionFromRoles([superAdmin], "configuration.roles.manage_permissions")).toBe(true);
  });

  it("default updater roles separate page access from task visibility", () => {
    const databaseUpdater = DEFAULT_ROLE_DEFINITIONS.find((role) => role.id === "database_updater")!;
    const domainUpdater = DEFAULT_ROLE_DEFINITIONS.find((role) => role.id === "domain_updater")!;

    expect(databaseUpdater.permissions).toEqual(expect.arrayContaining([
      "updates.tasks.view",
      "updates.tasks.complete",
      "updates.tasks.reveal_database_password",
    ]));
    expect(databaseUpdater.taskVisibility).toEqual({ domain: "none", database: "assigned" });
    expect(domainUpdater.permissions).toEqual(expect.arrayContaining([
      "updates.tasks.view",
      "updates.tasks.complete",
    ]));
    expect(domainUpdater.permissions).not.toContain("updates.tasks.reveal_database_password");
    expect(domainUpdater.taskVisibility).toEqual({ domain: "assigned", database: "none" });
  });

  it("combines task visibility using the strongest level per task type", () => {
    const visibility = effectiveTaskVisibility([
      { id: "a", name: "A", permissions: [], taskVisibility: { domain: "assigned", database: "none" }, system: false },
      { id: "b", name: "B", permissions: [], taskVisibility: { domain: "none", database: "all" }, system: false },
    ]);

    expect(visibility).toEqual({ domain: "assigned", database: "all" });
  });

  it("migrates legacy roles to least-privilege editable role definitions", () => {
    expect(migrateLegacyRoleIds([
      "admin",
      "formatos_impresion.admin",
      "database_updater",
      "domain_updater",
      "client_manager",
      "viewer",
      "public_downloads.admin",
      "admin",
    ])).toEqual([
      "super_admin",
      "print_formats_admin",
      "database_updater",
      "domain_updater",
      "client_operations_manager",
      "audit_viewer",
      "public_downloads_manager",
    ]);
  });

  it("keeps only the permanent default roles after compatibility cleanup", () => {
    expect(DEFAULT_ROLE_DEFINITIONS.map((role) => role.id)).toEqual([
      "super_admin",
      "database_updater",
      "domain_updater",
      "print_formats_admin",
    ]);
  });
});
