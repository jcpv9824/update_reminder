import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "..", "migration", "sql", "027_integration_connections.sql"),
  "utf8",
);

describe("migration 027 integration connections", () => {
  it("stores secret references and never secret values", () => {
    expect(sql).toContain("access_key_secret_name");
    expect(sql).toContain("secret_key_secret_name");
    expect(sql).toContain("password_secret_name");
    expect(sql).not.toMatch(/\baccess_key_value\b/i);
    expect(sql).not.toMatch(/\bsecret_key_value\b/i);
    expect(sql).not.toMatch(/\bpassword_value\b/i);
  });

  it("enforces TLS, optimistic concurrency and soft deletion", () => {
    expect(sql).toMatch(/encrypt_connection\s+BIT\s+NOT NULL/i);
    expect(sql).toContain("CHECK(encrypt_connection=1)");
    expect(sql).toContain("ROWVERSION NOT NULL");
    expect(sql).toContain("status='deleted'");
    expect(sql).toContain("WHERE status<>'deleted'");
  });

  it("registers all option-action permissions for super administrators", () => {
    for (const action of [
      "view",
      "edit_object_storage",
      "test_object_storage",
      "create_database",
      "edit_database",
      "delete_database",
      "test_database",
    ]) {
      expect(sql).toContain(`configuration.integrations.${action}`);
    }
    expect(sql).toContain("super_admin");
  });
});
