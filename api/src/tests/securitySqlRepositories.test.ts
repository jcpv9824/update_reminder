import { describe, expect, it } from "vitest";
import { mapSqlRoleDefinition, roleDefinitionParityShape } from "../lib/securityRolesSqlRepository";
import { mapSqlPublicUser } from "../lib/securityUsersSqlRepository";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("Security SQL read repositories", () => {
  it("reconstructs granular permissions and task visibility for a role", () => {
    const role = mapSqlRoleDefinition({
      role_id: "database_supervisor", name: "Supervisor de bases", active: true,
      system_role: false, protected_role: false, domain_task_visibility: "none",
      database_task_visibility: "all", created_at: at, created_by: "admin",
      updated_at: at, updated_by: "admin",
      permissions_json: '[{"value":"updates.tasks.view"},{"value":"updates.tasks.complete"}]',
    });
    expect(role).toMatchObject({
      id: "database_supervisor", permissions: ["updates.tasks.view", "updates.tasks.complete"],
      taskVisibility: { domain: "none", database: "all" },
    });
    expect(roleDefinitionParityShape([role])).not.toContain("Supervisor de bases");
  });

  it("maps only the public user projection and normalized role assignments", () => {
    const user = mapSqlPublicUser({
      source_id: "user-1", display_name: "Usuario", email: "user@example.test", active: true,
      password_updated_at: at, password_expires_at: null, must_change_password: false,
      last_login_at: at, created_at: at, created_by: "admin", updated_at: at,
      updated_by: "admin", roles_json: '[{"value":"database_updater"}]', total_count: 1,
    });
    expect(user).toMatchObject({ id: "user-1", roles: ["database_updater"], active: true });
    expect(JSON.stringify(user)).not.toContain("passwordHash");
    expect(JSON.stringify(user)).not.toContain("resetToken");
    expect(JSON.stringify(user)).not.toContain("tokenVersion");
  });
});
