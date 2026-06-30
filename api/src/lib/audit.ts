import { randomUUID } from "node:crypto";
import type { AuditLog } from "../types/models";

const SENSITIVE_KEYS = ["password", "passwordhash", "rawDbAccess", "secret", "passwordPlain", "token", "jwt"];

function sanitize(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
        // Se omite la clave sensible por completo.
        continue;
      }
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

export type BuildAuditLogInput = {
  entityType: string;
  entityId: string;
  clientId?: string;
  clientName?: string;
  domainId?: string;
  domainName?: string;
  companyName?: string;
  action: string;
  performedBy: string;
  performedByEmail: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

export function buildAuditLogEntry(input: BuildAuditLogInput): AuditLog {
  return {
    id: `audit_${randomUUID()}`,
    entityType: input.entityType,
    entityId: input.entityId,
    clientId: input.clientId,
    clientName: input.clientName,
    domainId: input.domainId,
    domainName: input.domainName,
    companyName: input.companyName,
    action: input.action,
    performedBy: input.performedBy,
    performedByEmail: input.performedByEmail,
    performedAt: new Date().toISOString(),
    before: sanitize(input.before),
    after: sanitize(input.after),
    metadata: input.metadata ? (sanitize(input.metadata) as Record<string, unknown>) : undefined,
  };
}

// Escribe una entrada de auditoría en Cosmos DB. Se importa perezosamente
// para que las pruebas unitarias del builder no requieran credenciales.
export async function writeAuditLog(input: BuildAuditLogInput): Promise<AuditLog> {
  const entry = buildAuditLogEntry(input);
  const { getContainer } = await import("./cosmos");
  const container = getContainer("auditLogs");
  await container.items.create(entry);
  return entry;
}
