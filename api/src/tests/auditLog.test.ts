import { describe, it, expect } from "vitest";
import { AUDIT_DATA_CLASSIFICATION, buildAuditLogEntry, sanitizeStoredAuditLogEntry } from "../lib/audit";

describe("buildAuditLogEntry", () => {
  it("genera id y performedAt automáticamente", () => {
    const entry = buildAuditLogEntry({
      entityType: "client",
      entityId: "c1",
      clientId: "c1",
      action: "client_created",
      performedBy: "u1",
      performedByEmail: "u1@x.com",
      after: { name: "Nuevo cliente" },
    });
    expect(entry.id).toMatch(/^audit_/);
    expect(entry.performedAt).toBeTruthy();
    expect(entry.action).toBe("client_created");
  });

  it("nunca incluye contraseñas aunque vengan en after", () => {
    const entry = buildAuditLogEntry({
      entityType: "database",
      entityId: "db1",
      clientId: "c1",
      action: "database_created",
      performedBy: "u1",
      performedByEmail: "u@x.com",
      after: {
        companyName: "X",
        password: "no-debe-aparecer",
        Password: "tampoco",
        rawDbAccess: "...; Password = secreto;",
      } as any,
    });
    const json = JSON.stringify(entry);
    expect(json).not.toContain("no-debe-aparecer");
    expect(json).not.toContain("secreto");
    expect(json).not.toContain("tampoco");
  });

  it("audita estado MFA sin guardar secreto, time step ni códigos de recuperación", () => {
    const entry = buildAuditLogEntry({
      entityType: "user", entityId: "u1", action: "mfa_enabled",
      performedBy: "u1", performedByEmail: "u@x.com",
      after: { id: "u1", mfaEnabled: true, mfaEnrolledAt: "2026-07-02T15:00:00Z", mfaSecretName: "mfa-secreto", mfaLastTimeStep: 123, mfaRecoveryCodeHashes: ["hash-secreto"] },
    });
    expect(entry.after).toEqual({ id: "u1", mfaEnabled: true, mfaEnrolledAt: "2026-07-02T15:00:00Z" });
    expect(JSON.stringify(entry)).not.toContain("mfa-secreto");
    expect(JSON.stringify(entry)).not.toContain("hash-secreto");
  });

  it("usa allowlist de entidad y elimina variantes sensibles y cuerpos HTTP", () => {
    const entry = buildAuditLogEntry({
      entityType: "database",
      entityId: "db1",
      action: "database_updated",
      performedBy: "u1",
      performedByEmail: "u@x.com",
      after: {
        id: "db1",
        companyName: "Empresa segura",
        environment: "production",
        connectionString: "Server=sql;Password=secreto",
        authorization: "Bearer token-muy-secreto",
        cookie: "session=secreto",
        apiKey: "clave-api",
        genericValue: "secreto-bajo-clave-generica",
        body: { password: "secreto-en-body" },
        headers: { authorization: "Bearer otro" },
        dbAccess: {
          initialCatalog: "ERP_CLIENTE",
          serverHostPort: "sql.internal:1433",
          userId: "sql_user",
          passwordSecretName: "kv-secret-name",
        },
      },
    });

    expect(entry.after).toEqual({
      id: "db1",
      companyName: "Empresa segura",
      environment: "production",
      dbAccess: { initialCatalog: "ERP_CLIENTE" },
    });
    const json = JSON.stringify(entry);
    for (const forbidden of ["connectionString", "authorization", "cookie", "apiKey", "genericValue", "secreto", "sql.internal", "sql_user", "kv-secret-name"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("aplica allowlist por acción a metadata y omite destinatarios y errores externos", () => {
    const entry = buildAuditLogEntry({
      entityType: "task",
      entityId: "overdue_summary",
      action: "overdue_alert_failed",
      performedBy: "system",
      performedByEmail: "system",
      metadata: {
        date: "2026-06-30",
        recipient: "persona@empresa.com",
        recipientsCount: 2,
        domainCount: 1,
        databaseCount: 3,
        error: "Authorization: Bearer secreto",
        requestBody: { password: "oculto" },
      },
    });

    expect(entry.metadata).toEqual({
      date: "2026-06-30",
      recipientsCount: 2,
      domainCount: 1,
      databaseCount: 3,
    });
    expect(JSON.stringify(entry)).not.toContain("persona@empresa.com");
    expect(JSON.stringify(entry)).not.toContain("Bearer secreto");
  });

  it("redacta secretos incrustados dentro de un campo permitido", () => {
    const entry = buildAuditLogEntry({
      entityType: "task",
      entityId: "t1",
      action: "task_obsoleted",
      performedBy: "system",
      performedByEmail: "system",
      metadata: {
        reason: "connectionString=Server=sql;Password=ultrasecreto",
        taskId: "t1",
      },
    });
    expect(entry.metadata).toEqual({ reason: "[REDACTED]", taskId: "t1" });
    expect(JSON.stringify(entry)).not.toContain("ultrasecreto");
  });

  it.each([
    "Authorization: Bearer abc.def.ghi",
    "eyJabc.eyJdef.firma-secreta",
    "apiKey=clave-super-secreta",
    "cookie=sessionid-secreto",
    "Password=clave-super-secreta",
    "https://usuario:password@servidor.example.com/recurso",
    "https://servicio.example.com/callback?token=token-secreto",
    "-----BEGIN PRIVATE KEY----- material-privado",
  ])("redacta una variante sensible dentro de metadata permitida: %s", (sensitiveValue) => {
    const entry = buildAuditLogEntry({
      entityType: "task",
      entityId: "t1",
      action: "task_obsoleted",
      performedBy: "system",
      performedByEmail: "system",
      metadata: { reason: sensitiveValue },
    });
    expect(entry.metadata).toEqual({ reason: "[REDACTED]" });
    expect(JSON.stringify(entry)).not.toContain(sensitiveValue);
  });

  it("omite snapshots y metadata de tipos/eventos sin contrato", () => {
    const entry = buildAuditLogEntry({
      entityType: "unknown",
      entityId: "x",
      action: "unknown_action",
      performedBy: "u1",
      performedByEmail: "u@x.com",
      before: { name: "No debe persistirse", password: "secreto" },
      after: { status: "active", body: { anything: true } },
      metadata: { value: "dato generico", token: "secreto" },
    });
    expect(entry.before).toBeUndefined();
    expect(entry.after).toBeUndefined();
    expect(entry.metadata).toBeUndefined();
  });

  it("conserva transiciones y alcance estructurado autorizados", () => {
    const taskEntry = buildAuditLogEntry({
      entityType: "task",
      entityId: "t1",
      action: "task_completed",
      performedBy: "u1",
      performedByEmail: "u@x.com",
      before: { id: "t1", status: "pending", notes: "texto libre" },
      after: { id: "t1", status: "completed", completedBy: "u1", completionNote: "texto libre" },
      metadata: { previousStatus: "pending", newStatus: "completed" },
    });
    expect(taskEntry.before).toEqual({ id: "t1", status: "pending" });
    expect(taskEntry.after).toEqual({ id: "t1", status: "completed", completedBy: "u1" });
    expect(taskEntry.metadata).toEqual({ previousStatus: "pending", newStatus: "completed" });

    const scheduleEntry = buildAuditLogEntry({
      entityType: "schedule",
      entityId: "s1",
      action: "schedule_created",
      performedBy: "u1",
      performedByEmail: "u@x.com",
      after: {
        id: "s1",
        scopeGroups: [{ clientId: "c1", includeAllDomains: false, domains: [{ domainId: "d1", databaseIds: ["db1"], unsafe: "drop" }] }],
        licensingScope: { licenseModuleIds: ["m1"], excludedDomainIds: ["d2"], customEmails: ["secret@example.com"] },
      },
    });
    expect(scheduleEntry.after).toEqual({
      id: "s1",
      scopeGroups: [{ clientId: "c1", includeAllDomains: false, domains: [{ domainId: "d1", databaseIds: ["db1"] }] }],
      licensingScope: { licenseModuleIds: ["m1"], excludedDomainIds: ["d2"] },
    });
  });

  it("documenta clasificación de datos de auditoría", () => {
    expect(AUDIT_DATA_CLASSIFICATION.operational).toContain("allowlist");
    expect(AUDIT_DATA_CLASSIFICATION.secret).toContain("nunca");
  });

  it("sanea registros históricos conservando id, fecha y partición", () => {
    const sanitized = sanitizeStoredAuditLogEntry({
      id: "audit_historico",
      entityType: "database",
      entityId: "db1",
      clientId: "c1",
      action: "database_updated",
      performedBy: "u1",
      performedByEmail: "u@x.com",
      performedAt: "2026-01-01T00:00:00.000Z",
      before: { companyName: "Empresa", connectionString: "Server=x;Password=secreto" },
      after: { companyName: "Empresa", authorization: "Bearer secreto" },
      metadata: { body: { password: "secreto" } },
    });
    expect(sanitized.id).toBe("audit_historico");
    expect(sanitized.performedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(sanitized.clientId).toBe("c1");
    expect(sanitized.before).toEqual({ companyName: "Empresa" });
    expect(sanitized.after).toEqual({ companyName: "Empresa" });
    expect(sanitized.metadata).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain("secreto");
  });
});
