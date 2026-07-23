import { createHash } from "node:crypto";
import sql from "mssql";
import type { DatabaseRecord } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { isSqlUniqueConstraintError } from "./clientsSqlWriteRepository";
import { normalizeComparableText } from "./duplicateValidation";
import { runSqlTransaction } from "./sqlTransaction";
import { cancelOpenSqlTasksForTarget } from "./workflowTaskCleanupSqlRepository";

type Actor = { id: string; email: string };
type Assignee = { id: string; active: boolean };
type AccessInput = DatabaseRecord["dbAccess"];

export type DatabaseMutationInput = {
  companyName?: string;
  environment?: string;
  currentDbVersion?: string;
  assignedUpdaterIds?: string[];
  notes?: string;
  dbAccess?: AccessInput;
};

type HierarchyRow = {
  client_key: number; client_source_id: string; client_name: string; client_status: DatabaseRecord["status"];
  domain_key: number; domain_source_id: string; domain_name: string; domain_status: DatabaseRecord["status"];
};
type DatabaseRow = {
  database_key: number; source_id: string; client_key: number; client_source_id: string; client_name: string;
  domain_key: number; domain_source_id: string; domain_name: string; access_profile_key: number;
  company_name: string; environment_id: string; current_db_version: string | null;
  status: DatabaseRecord["status"]; notes: string | null; created_at: Date; created_by: string;
  updated_at: Date; updated_by: string; deleted_at: Date | null; deleted_by: string | null;
  last_updated_at: Date | null; last_updated_by: string | null; server_host_port: string;
  initial_catalog: string; sql_user_id: string; password_secret_name: string;
};
type AssigneeRow = { user_key: number; source_id: string; active: boolean };

export function buildDatabaseConnectionFingerprint(parts: Pick<AccessInput, "serverHostPort" | "initialCatalog" | "userId">): Buffer {
  const normalized = [parts.serverHostPort, parts.initialCatalog, parts.userId]
    .map((value) => value.trim().toLowerCase())
    .join("\0");
  return createHash("sha256").update(Buffer.from(normalized, "utf16le")).digest();
}

export function databaseSqlConflictMessage(error: unknown): string | null {
  if (!isSqlUniqueConstraintError(error)) return null;
  const candidate = error as { message?: string; originalError?: { info?: { message?: string } } };
  const message = `${candidate.message ?? ""} ${candidate.originalError?.info?.message ?? ""}`;
  if (message.includes("UX_database_access_fingerprint_active")) {
    return "Ya existe una base de datos con esta cadena de conexión.";
  }
  if (message.includes("UX_databases_company_domain_active")) {
    return "Ya existe una empresa con este nombre en el dominio.";
  }
  return "Ya existe una base de datos con estos datos.";
}

export function planDatabaseAssigneeReconciliation(currentIds: string[], requested: Assignee[]) {
  const current = new Set(currentIds);
  for (const user of requested) {
    if (!user.active && !current.has(user.id)) {
      throw Object.assign(new Error("Solo puede asignar usuarios activos a la base de datos."), { status: 400 });
    }
  }
  const ids = requested.map((user) => user.id);
  const requestedSet = new Set(ids);
  return {
    ids,
    added: ids.filter((id) => !current.has(id)),
    removed: currentIds.filter((id) => !requestedSet.has(id)),
    retained: ids.filter((id) => current.has(id)),
  };
}

const uniqueIds = (ids: string[] | undefined) => Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
const iso = (value: Date | null) => value?.toISOString() ?? null;

function toRecord(row: DatabaseRow, assigneeIds: string[]): DatabaseRecord {
  return {
    id: row.source_id, clientId: row.client_source_id, clientName: row.client_name,
    domainId: row.domain_source_id, domainName: row.domain_name, companyName: row.company_name,
    environment: row.environment_id,
    dbAccess: {
      serverHostPort: row.server_host_port, initialCatalog: row.initial_catalog,
      userId: row.sql_user_id, passwordSecretName: row.password_secret_name,
    },
    currentDbVersion: row.current_db_version ?? undefined, assignedUpdaterIds: assigneeIds,
    status: row.status, notes: row.notes ?? undefined,
    createdAt: row.created_at.toISOString(), createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by,
    deletedAt: iso(row.deleted_at), deletedBy: row.deleted_by,
    lastUpdatedAt: iso(row.last_updated_at), lastUpdatedBy: row.last_updated_by,
  };
}

function safeAuditRecord(record: DatabaseRecord) {
  return {
    ...record,
    dbAccess: {
      serverHostPort: record.dbAccess.serverHostPort,
      initialCatalog: record.dbAccess.initialCatalog,
      userId: record.dbAccess.userId,
    },
  };
}

async function loadRequestedAssignees(transaction: sql.Transaction, ids: string[]): Promise<AssigneeRow[]> {
  if (ids.length === 0) return [];
  const request = new sql.Request(transaction);
  const parameters = ids.map((id, index) => {
    const name = `user${index}`;
    request.input(name, sql.NVarChar(150), id);
    return `@${name}`;
  });
  const result = await request.query<AssigneeRow>(`
    SELECT user_key,source_id,active FROM security.users WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id IN (${parameters.join(",")}) ORDER BY source_id;
  `);
  if (result.recordset.length !== ids.length) {
    throw Object.assign(new Error("Uno de los responsables seleccionados no existe."), { status: 400 });
  }
  const byId = new Map(result.recordset.map((user) => [user.source_id, user]));
  return ids.map((id) => byId.get(id)!);
}

async function loadCurrentAssignees(transaction: sql.Transaction, databaseKey: number): Promise<AssigneeRow[]> {
  const request = new sql.Request(transaction);
  request.input("databaseKey", sql.BigInt, databaseKey);
  const result = await request.query<AssigneeRow>(`
    SELECT u.user_key,u.source_id,u.active
    FROM core.database_assignees AS a WITH (UPDLOCK,HOLDLOCK)
    JOIN security.users AS u ON u.user_key=a.user_key
    WHERE a.database_key=@databaseKey ORDER BY u.source_id;
  `);
  return result.recordset;
}

async function reconcileAssignees(
  transaction: sql.Transaction, databaseKey: number, requestedIds: string[], actorId: string, now: Date,
): Promise<string[]> {
  const current = await loadCurrentAssignees(transaction, databaseKey);
  const requested = await loadRequestedAssignees(transaction, requestedIds);
  const plan = planDatabaseAssigneeReconciliation(
    current.map((user) => user.source_id),
    requested.map((user) => ({ id: user.source_id, active: user.active })),
  );
  if (plan.removed.length > 0) {
    const request = new sql.Request(transaction);
    request.input("databaseKey", sql.BigInt, databaseKey);
    const parameters = plan.removed.map((id, index) => {
      const name = `removed${index}`;
      request.input(name, sql.NVarChar(150), id);
      return `@${name}`;
    });
    await request.query(`
      DELETE a FROM core.database_assignees AS a
      JOIN security.users AS u ON u.user_key=a.user_key
      WHERE a.database_key=@databaseKey AND u.source_id IN (${parameters.join(",")});
    `);
  }
  const requestedById = new Map(requested.map((user) => [user.source_id, user]));
  for (const id of plan.added) {
    const request = new sql.Request(transaction);
    request.input("databaseKey", sql.BigInt, databaseKey);
    request.input("userKey", sql.BigInt, requestedById.get(id)!.user_key);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actorId);
    await request.query(`
      INSERT core.database_assignees(database_key,user_key,assigned_at,assigned_by)
      VALUES(@databaseKey,@userKey,@now,@actorId);
    `);
  }
  return plan.ids;
}

async function lockDatabase(transaction: sql.Transaction, sourceId: string): Promise<DatabaseRow | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), sourceId);
  const result = await request.query<DatabaseRow>(`
    SELECT db.database_key,db.source_id,db.client_key,c.source_id AS client_source_id,c.name AS client_name,
      db.domain_key,d.source_id AS domain_source_id,d.domain_name,db.access_profile_key,
      db.company_name,db.environment_id,db.current_db_version,db.status,db.notes,db.created_at,
      db.created_by,db.updated_at,db.updated_by,db.deleted_at,db.deleted_by,db.last_updated_at,
      db.last_updated_by,p.server_host_port,p.initial_catalog,p.sql_user_id,p.password_secret_name
    FROM core.databases AS db WITH (UPDLOCK,HOLDLOCK)
    JOIN core.clients AS c ON c.client_key=db.client_key
    JOIN core.domains AS d ON d.domain_key=db.domain_key
    JOIN core.database_access_profiles AS p WITH (UPDLOCK,HOLDLOCK) ON p.access_profile_key=db.access_profile_key
    WHERE db.source_id=@sourceId;
  `);
  return result.recordset[0] ?? null;
}

export async function createSqlDatabase(record: DatabaseRecord, actor: Actor): Promise<DatabaseRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const hierarchyRequest = new sql.Request(transaction);
      hierarchyRequest.input("clientSourceId", sql.NVarChar(150), record.clientId);
      hierarchyRequest.input("domainSourceId", sql.NVarChar(150), record.domainId);
      const hierarchyResult = await hierarchyRequest.query<HierarchyRow>(`
        SELECT c.client_key,c.source_id AS client_source_id,c.name AS client_name,c.status AS client_status,
          d.domain_key,d.source_id AS domain_source_id,d.domain_name,d.status AS domain_status
        FROM core.domains AS d WITH (UPDLOCK,HOLDLOCK)
        JOIN core.clients AS c WITH (UPDLOCK,HOLDLOCK) ON c.client_key=d.client_key
        WHERE c.source_id=@clientSourceId AND d.source_id=@domainSourceId
          AND c.status<>'deleted' AND d.status<>'deleted';
      `);
      const hierarchy = hierarchyResult.recordset[0];
      if (!hierarchy) throw Object.assign(new Error("Cliente o dominio no encontrado, o no pertenecen a la misma jerarquía."), { status: 400 });

      const now = new Date();
      const access = record.dbAccess;
      const profileRequest = new sql.Request(transaction);
      profileRequest.input("sourceId", sql.NVarChar(150), record.id);
      profileRequest.input("serverHostPort", sql.NVarChar(500), access.serverHostPort.trim());
      profileRequest.input("initialCatalog", sql.NVarChar(256), access.initialCatalog.trim());
      profileRequest.input("sqlUserId", sql.NVarChar(256), access.userId.trim());
      profileRequest.input("passwordSecretName", sql.NVarChar(256), access.passwordSecretName);
      profileRequest.input("fingerprint", sql.VarBinary(32), buildDatabaseConnectionFingerprint(access));
      profileRequest.input("now", sql.DateTime2(3), now);
      profileRequest.input("actorId", sql.NVarChar(150), actor.id);
      const profileResult = await profileRequest.query<{ access_profile_key: number }>(`
        INSERT core.database_access_profiles
          (source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
           connection_fingerprint,active,created_at,created_by,updated_at,updated_by)
        OUTPUT INSERTED.access_profile_key
        VALUES(@sourceId,@serverHostPort,@initialCatalog,@sqlUserId,@passwordSecretName,
          @fingerprint,1,@now,@actorId,@now,@actorId);
      `);

      const companyName = record.companyName.trim().replace(/\s+/g, " ");
      const insert = new sql.Request(transaction);
      insert.input("sourceId", sql.NVarChar(150), record.id);
      insert.input("clientKey", sql.BigInt, hierarchy.client_key);
      insert.input("clientName", sql.NVarChar(200), hierarchy.client_name);
      insert.input("domainKey", sql.BigInt, hierarchy.domain_key);
      insert.input("domainName", sql.NVarChar(500), hierarchy.domain_name);
      insert.input("accessProfileKey", sql.BigInt, profileResult.recordset[0].access_profile_key);
      insert.input("companyName", sql.NVarChar(240), companyName);
      insert.input("companyNameNormalized", sql.NVarChar(240), normalizeComparableText(companyName));
      insert.input("environment", sql.VarChar(20), String(record.environment).toLowerCase());
      insert.input("currentDbVersion", sql.NVarChar(80), record.currentDbVersion?.trim() || null);
      insert.input("notes", sql.NVarChar(sql.MAX), record.notes?.trim() || null);
      insert.input("now", sql.DateTime2(3), now);
      insert.input("actorId", sql.NVarChar(150), actor.id);
      const inserted = await insert.query<{ database_key: number }>(`
        INSERT core.databases
          (source_id,client_key,client_name_snapshot,domain_key,domain_name_snapshot,access_profile_key,
           company_name,company_name_normalized,environment_id,current_db_version,status,notes,
           created_at,created_by,updated_at,updated_by)
        OUTPUT INSERTED.database_key
        VALUES(@sourceId,@clientKey,@clientName,@domainKey,@domainName,@accessProfileKey,
          @companyName,@companyNameNormalized,@environment,@currentDbVersion,'active',@notes,
          @now,@actorId,@now,@actorId);
      `);
      const assignees = await reconcileAssignees(transaction, inserted.recordset[0].database_key,
        uniqueIds(record.assignedUpdaterIds), actor.id, now);
      const created: DatabaseRecord = {
        ...record, clientName: hierarchy.client_name, domainName: hierarchy.domain_name,
        companyName, environment: String(record.environment).toLowerCase(),
        currentDbVersion: record.currentDbVersion?.trim() || undefined, notes: record.notes?.trim() || undefined,
        assignedUpdaterIds: assignees, status: "active", createdAt: now.toISOString(), createdBy: actor.id,
        updatedAt: now.toISOString(), updatedBy: actor.id, deletedAt: null, deletedBy: null,
        lastUpdatedAt: null, lastUpdatedBy: null,
      };
      await writeSqlAuditLog(transaction, {
        entityType: "database", entityId: created.id, clientId: created.clientId, clientName: created.clientName,
        domainId: created.domainId, domainName: created.domainName, companyName: created.companyName,
        action: "database_created", performedBy: actor.id, performedByEmail: actor.email,
        after: safeAuditRecord(created),
      });
      return created;
    });
  } catch (error) {
    const message = databaseSqlConflictMessage(error);
    if (message) throw Object.assign(new Error(message), { status: 409 });
    throw error;
  }
}

export async function updateSqlDatabase(
  sourceId: string, patch: DatabaseMutationInput, actor: Actor,
): Promise<{ record: DatabaseRecord; previousSecretName?: string } | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const row = await lockDatabase(transaction, sourceId);
      if (!row) return null;
      const currentAssignees = await loadCurrentAssignees(transaction, row.database_key);
      const before = toRecord(row, currentAssignees.map((user) => user.source_id));
      const now = new Date();
      const access = patch.dbAccess ?? before.dbAccess;
      if (patch.dbAccess) {
        const profile = new sql.Request(transaction);
        profile.input("accessProfileKey", sql.BigInt, row.access_profile_key);
        profile.input("serverHostPort", sql.NVarChar(500), access.serverHostPort.trim());
        profile.input("initialCatalog", sql.NVarChar(256), access.initialCatalog.trim());
        profile.input("sqlUserId", sql.NVarChar(256), access.userId.trim());
        profile.input("passwordSecretName", sql.NVarChar(256), access.passwordSecretName);
        profile.input("fingerprint", sql.VarBinary(32), buildDatabaseConnectionFingerprint(access));
        profile.input("now", sql.DateTime2(3), now);
        profile.input("actorId", sql.NVarChar(150), actor.id);
        await profile.query(`
          UPDATE core.database_access_profiles
          SET server_host_port=@serverHostPort,initial_catalog=@initialCatalog,sql_user_id=@sqlUserId,
              password_secret_name=@passwordSecretName,connection_fingerprint=@fingerprint,
              updated_at=@now,updated_by=@actorId
          WHERE access_profile_key=@accessProfileKey;
        `);
      }
      const companyName = (patch.companyName ?? row.company_name).trim().replace(/\s+/g, " ");
      const environment = (patch.environment ?? row.environment_id).trim().toLowerCase();
      const currentDbVersion = patch.currentDbVersion !== undefined ? patch.currentDbVersion.trim() || null : row.current_db_version;
      const notes = patch.notes !== undefined ? patch.notes.trim() || null : row.notes;
      const update = new sql.Request(transaction);
      update.input("databaseKey", sql.BigInt, row.database_key);
      update.input("companyName", sql.NVarChar(240), companyName);
      update.input("companyNameNormalized", sql.NVarChar(240), normalizeComparableText(companyName));
      update.input("environment", sql.VarChar(20), environment);
      update.input("currentDbVersion", sql.NVarChar(80), currentDbVersion);
      update.input("notes", sql.NVarChar(sql.MAX), notes);
      update.input("now", sql.DateTime2(3), now);
      update.input("actorId", sql.NVarChar(150), actor.id);
      await update.query(`
        UPDATE core.databases
        SET company_name=@companyName,company_name_normalized=@companyNameNormalized,
            environment_id=@environment,current_db_version=@currentDbVersion,notes=@notes,
            updated_at=@now,updated_by=@actorId
        WHERE database_key=@databaseKey;
      `);
      const assignees = patch.assignedUpdaterIds === undefined
        ? currentAssignees.map((user) => user.source_id)
        : await reconcileAssignees(transaction, row.database_key, uniqueIds(patch.assignedUpdaterIds), actor.id, now);
      const updated: DatabaseRecord = {
        ...before, companyName, environment, currentDbVersion: currentDbVersion ?? undefined,
        notes: notes ?? undefined, dbAccess: access, assignedUpdaterIds: assignees,
        updatedAt: now.toISOString(), updatedBy: actor.id,
      };
      await writeSqlAuditLog(transaction, {
        entityType: "database", entityId: sourceId, clientId: row.client_source_id, clientName: row.client_name,
        domainId: row.domain_source_id, domainName: row.domain_name, companyName,
        action: "database_updated", performedBy: actor.id, performedByEmail: actor.email,
        before: safeAuditRecord(before), after: safeAuditRecord(updated),
        metadata: patch.dbAccess ? { credentialReferenceRotated: true } : undefined,
      });
      return {
        record: updated,
        previousSecretName: patch.dbAccess && row.password_secret_name !== access.passwordSecretName
          ? row.password_secret_name : undefined,
      };
    });
  } catch (error) {
    const message = databaseSqlConflictMessage(error);
    if (message) throw Object.assign(new Error(message), { status: 409 });
    throw error;
  }
}

export async function setSqlDatabaseStatus(
  sourceId: string, status: "active" | "inactive",
  action: "database_deactivated" | "database_reactivated", actor: Actor, obsoleteReason?: string,
): Promise<{ record: DatabaseRecord; obsoletedTasks: number } | null> {
  return runSqlTransaction(async (transaction) => {
    const row = await lockDatabase(transaction, sourceId);
    if (!row) return null;
    const currentAssignees = await loadCurrentAssignees(transaction, row.database_key);
    const before = toRecord(row, currentAssignees.map((user) => user.source_id));
    const now = new Date();
    const request = new sql.Request(transaction);
    request.input("databaseKey", sql.BigInt, row.database_key);
    request.input("status", sql.VarChar(20), status);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE core.databases SET status=@status,updated_at=@now,updated_by=@actorId,
        deleted_at=NULL,deleted_by=NULL WHERE database_key=@databaseKey;
    `);
    const obsoletedTasks = status === "inactive" && obsoleteReason
      ? await cancelOpenSqlTasksForTarget(transaction, { type: "database", key: row.database_key }, actor, obsoleteReason, now)
      : 0;
    const record: DatabaseRecord = {
      ...before, status, updatedAt: now.toISOString(), updatedBy: actor.id, deletedAt: null, deletedBy: null,
    };
    await writeSqlAuditLog(transaction, {
      entityType: "database", entityId: sourceId, clientId: row.client_source_id, clientName: row.client_name,
      domainId: row.domain_source_id, domainName: row.domain_name, companyName: row.company_name,
      action, performedBy: actor.id, performedByEmail: actor.email,
      metadata: { obsoletedTasks }, before: safeAuditRecord(before), after: { status },
    });
    return { record, obsoletedTasks };
  });
}
