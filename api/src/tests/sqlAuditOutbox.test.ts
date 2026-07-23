import { describe, expect, it } from "vitest";
import { buildSqlAuditRecord } from "../lib/auditSqlWriter";
import { buildPasswordResetOutboxRecord } from "../lib/notificationOutboxSqlRepository";

describe("SQL audit and notification outbox contracts", () => {
  it("serializes only allowlisted audit data and classifies actor email as confidential", () => {
    const record = buildSqlAuditRecord({
      entityType: "user", entityId: "user-1", action: "password_reset_requested",
      performedBy: "user-1", performedByEmail: "user@example.test",
      after: { id: "user-1", passwordHash: "never-store-this" },
      metadata: { expiresAt: "2026-07-21T15:00:00.000Z", token: "never-store-token" },
    });
    const serialized = JSON.stringify(record);
    expect(record.dataClassification).toBe("confidential");
    expect(record.metadataJson).toContain("expiresAt");
    expect(serialized).not.toContain("never-store-this");
    expect(serialized).not.toContain("never-store-token");
  });

  it("builds a deduplicated reset outbox row without a token, URL or email body", () => {
    const first = buildPasswordResetOutboxRecord({
      userId: "user-1", email: "User@Example.Test", displayName: "Usuario",
      requestedBy: "user-1", nowMs: 1_000,
      ...( { token: "must-be-ignored", resetUrl: "must-be-ignored" } as any ),
    });
    const sameWindow = buildPasswordResetOutboxRecord({
      userId: "user-1", email: "User@Example.Test", requestedBy: "user-1", nowMs: 899_000,
    });
    const nextWindow = buildPasswordResetOutboxRecord({
      userId: "user-1", email: "User@Example.Test", requestedBy: "user-1", nowMs: 901_000,
    });
    const serialized = JSON.stringify(first);
    expect(first.emailNormalized).toBe("user@example.test");
    expect(first.idempotencyKey).toBe(sameWindow.idempotencyKey);
    expect(first.idempotencyKey).not.toBe(nextWindow.idempotencyKey);
    expect(first.metadataJson).toContain("claim_time");
    for (const forbidden of ["must-be-ignored", "resetUrl", "token\""]) expect(serialized).not.toContain(forbidden);
  });

  it("rejects invalid recipient and oversized identifiers before SQL", () => {
    expect(() => buildPasswordResetOutboxRecord({
      userId: "user-1", email: "not-an-email", requestedBy: "system",
    })).toThrow(/Correo/);
    expect(() => buildPasswordResetOutboxRecord({
      userId: "x".repeat(151), email: "user@example.test", requestedBy: "system",
    })).toThrow(/source_id/);
  });

  it("accepts the migrated 260-character task entity identifier contract", () => {
    expect(() => buildSqlAuditRecord({
      entityType: "task", entityId: "t".repeat(260), action: "task_started",
      performedBy: "user-1", performedByEmail: "user@example.test",
    })).not.toThrow();
    expect(() => buildSqlAuditRecord({
      entityType: "task", entityId: "t".repeat(261), action: "task_started",
      performedBy: "user-1", performedByEmail: "user@example.test",
    })).toThrow(/entity_source_id/);
  });

  it("audits task-status delivery without persisting message bodies or recipients", () => {
    const record = buildSqlAuditRecord({
      entityType: "task", entityId: "task-1", action: "task_status_notification_sent",
      performedBy: "email-worker", performedByEmail: "system",
      metadata: {
        notificationType: "completed_with_problems",
        html: "private message body",
        recipients: ["private@example.test"],
      },
    });
    expect(record.metadataJson).toContain("completed_with_problems");
    expect(record.metadataJson).not.toContain("private message body");
    expect(record.metadataJson).not.toContain("private@example.test");
  });

  it("keeps video classification while excluding the removed print-source description", () => {
    const video = buildSqlAuditRecord({
      entityType: "publicDownloadDocument", entityId: "asset-1", action: "public_download_document_created",
      performedBy: "admin", performedByEmail: "admin@example.test",
      after: { id: "asset-1", assetKind: "video", archivoMimeType: "video/mp4" },
      metadata: { fileLoaded: true, assetKind: "video" },
    });
    const source = buildSqlAuditRecord({
      entityType: "fuenteFormato", entityId: "source-1", action: "fuente_formato_updated",
      performedBy: "admin", performedByEmail: "admin@example.test",
      after: { id: "source-1", nombre: "Fuente", descripcion: "obsolete" },
    });
    expect(video.afterJson).toContain("video");
    expect(source.afterJson).not.toContain("obsolete");
  });
});
