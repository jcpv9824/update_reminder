import { describe, expect, it } from "vitest";
import { mapSqlAuditLog } from "../lib/auditLogsSqlRepository";

describe("Audit Logs SQL mapping", () => {
  it("reconstructs the existing API contract from normalized SQL references", () => {
    const record = mapSqlAuditLog({
      source_id: "audit-1",
      entity_type: "client",
      entity_source_id: "client-1",
      client_source_id: "client-1",
      client_name_snapshot: "Cliente Uno",
      domain_source_id: null,
      domain_name_snapshot: null,
      company_name_snapshot: null,
      action: "client_updated",
      performed_by: "user-1",
      performed_by_email: "actor@example.test",
      performed_at: new Date("2026-07-21T12:00:00.000Z"),
      before_json: '{"status":"inactive"}',
      after_json: '{"status":"active"}',
      metadata_json: null,
    });
    expect(record).toMatchObject({
      id: "audit-1",
      clientId: "client-1",
      performedAt: "2026-07-21T12:00:00.000Z",
      before: { status: "inactive" },
      after: { status: "active" },
    });
  });
});
