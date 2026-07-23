import sql from "mssql";
import { buildAuditLogEntry, type BuildAuditLogInput } from "./audit";
import type { AuditLog } from "../types/models";
import { runSqlTransaction } from "./sqlTransaction";

export type SqlAuditRecord = {
  entry: AuditLog;
  beforeJson: string | null;
  afterJson: string | null;
  metadataJson: string | null;
  dataClassification: "confidential";
};

function assertLength(label: string, value: string | undefined, maximum: number): void {
  if (value && value.length > maximum) throw new Error(`${label} excede el máximo SQL permitido.`);
}

const jsonOrNull = (value: unknown): string | null => value === undefined ? null : JSON.stringify(value);

export function buildSqlAuditRecord(input: BuildAuditLogInput): SqlAuditRecord {
  const entry = buildAuditLogEntry(input);
  assertLength("audit.source_id", entry.id, 150);
  assertLength("audit.entity_type", entry.entityType, 100);
  assertLength("audit.entity_source_id", entry.entityId, 260);
  assertLength("audit.client_id", entry.clientId, 150);
  assertLength("audit.client_name", entry.clientName, 200);
  assertLength("audit.domain_id", entry.domainId, 150);
  assertLength("audit.domain_name", entry.domainName, 500);
  assertLength("audit.company_name", entry.companyName, 240);
  assertLength("audit.action", entry.action, 160);
  assertLength("audit.performed_by", entry.performedBy, 150);
  assertLength("audit.performed_by_email", entry.performedByEmail, 254);
  return {
    entry,
    beforeJson: jsonOrNull(entry.before),
    afterJson: jsonOrNull(entry.after),
    metadataJson: jsonOrNull(entry.metadata),
    dataClassification: "confidential",
  };
}

export async function writeSqlAuditLog(
  transaction: sql.Transaction,
  input: BuildAuditLogInput,
): Promise<AuditLog> {
  const record = buildSqlAuditRecord(input);
  const { entry } = record;
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), entry.id);
  request.input("entityType", sql.NVarChar(100), entry.entityType);
  request.input("entitySourceId", sql.NVarChar(260), entry.entityId);
  request.input("clientSourceId", sql.NVarChar(150), entry.clientId ?? null);
  request.input("clientName", sql.NVarChar(200), entry.clientName ?? null);
  request.input("domainSourceId", sql.NVarChar(150), entry.domainId ?? null);
  request.input("domainName", sql.NVarChar(500), entry.domainName ?? null);
  request.input("companyName", sql.NVarChar(240), entry.companyName ?? null);
  request.input("action", sql.NVarChar(160), entry.action);
  request.input("performedBy", sql.NVarChar(150), entry.performedBy);
  request.input("performedByEmail", sql.NVarChar(254), entry.performedByEmail || null);
  request.input("performedAt", sql.DateTime2(3), new Date(entry.performedAt));
  request.input("beforeJson", sql.NVarChar(sql.MAX), record.beforeJson);
  request.input("afterJson", sql.NVarChar(sql.MAX), record.afterJson);
  request.input("metadataJson", sql.NVarChar(sql.MAX), record.metadataJson);
  request.input("classification", sql.VarChar(20), record.dataClassification);
  await request.query(`
    INSERT audit.audit_logs
    (
      source_id,entity_type,entity_source_id,client_key,client_name_snapshot,
      domain_key,domain_name_snapshot,company_name_snapshot,action,performed_by,
      performed_by_email,performed_at,before_json,after_json,metadata_json,
      schema_version,data_classification
    )
    VALUES
    (
      @sourceId,@entityType,@entitySourceId,
      (SELECT client_key FROM core.clients WHERE source_id=@clientSourceId),@clientName,
      (SELECT domain_key FROM core.domains WHERE source_id=@domainSourceId),@domainName,@companyName,
      @action,@performedBy,@performedByEmail,@performedAt,@beforeJson,@afterJson,@metadataJson,1,@classification
    );
  `);
  return entry;
}

export async function appendSqlAuditLog(input: BuildAuditLogInput): Promise<AuditLog> {
  return runSqlTransaction((transaction) => writeSqlAuditLog(transaction, input));
}
