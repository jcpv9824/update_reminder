import { describe, expect, it } from "vitest";
import { toPublicDatabase, toPublicTask } from "../lib/publicDtos";
import type { DatabaseRecord, UpdateTask } from "../types/models";

describe("SEC-002 - minimización de DTOs públicos", () => {
  it("el DTO de base no expone servidor, usuario SQL ni referencia de Key Vault", () => {
    const record = {
      id: "db_1",
      clientId: "client_1",
      clientName: "Cliente",
      domainId: "domain_1",
      domainName: "https://cliente.example.com",
      companyName: "Empresa",
      environment: "production",
      dbAccess: {
        serverHostPort: "sql.internal:1433",
        initialCatalog: "ERP_CLIENTE",
        userId: "sql_user",
        passwordSecretName: "kv-secret-name",
      },
      assignedUpdaterIds: [],
      status: "active",
      createdAt: "2026-06-01T00:00:00.000Z",
      createdBy: "admin_1",
      updatedAt: "2026-06-01T00:00:00.000Z",
      updatedBy: "admin_1",
      deletedBy: "admin_2",
    } satisfies DatabaseRecord;

    const dto = toPublicDatabase(record);
    const serialized = JSON.stringify(dto);
    expect(dto.dbAccess).toEqual({ initialCatalog: "ERP_CLIENTE" });
    expect(serialized).not.toContain("serverHostPort");
    expect(serialized).not.toContain("sql.internal");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("sql_user");
    expect(serialized).not.toContain("passwordSecretName");
    expect(serialized).not.toContain("kv-secret-name");
    expect(serialized).not.toContain("createdBy");
    expect(serialized).not.toContain("updatedBy");
    expect(serialized).not.toContain("deletedBy");
    expect(serialized).not.toContain("assignedUpdaterIds");
    expect(serialized).not.toContain("lastUpdatedBy");
  });

  it("el DTO de tarea omite dedupe, buckets, fuentes e idempotencia de correo", () => {
    const task = {
      id: "task_1",
      dedupeKey: "database:db_1:2026-06-30",
      sources: [{ scheduleId: "schedule_1", scheduleType: "special", createdAt: "2026-06-01T00:00:00.000Z" }],
      taskDate: "2026-06-30",
      taskBucket: "2026-06-30_database",
      clientId: "client_1",
      clientName: "Cliente",
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
      remindersSent: [{ daysBefore: 1, sentAt: "2026-06-29T13:00:00.000Z" }],
      overdueAlertSentDates: ["2026-07-01"],
    } satisfies UpdateTask;

    const serialized = JSON.stringify(toPublicTask(task));
    for (const internalField of [
      "dedupeKey",
      "sources",
      "taskBucket",
      "createdBy",
      "updatedBy",
      "remindersSent",
      "overdueAlertSentDates",
    ]) {
      expect(serialized).not.toContain(internalField);
    }
  });
});
