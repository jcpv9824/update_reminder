import sql from "mssql";
import type { DomainRecord, EntityStatus } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { isSqlUniqueConstraintError } from "./clientsSqlWriteRepository";
import { normalizeDomainUrl } from "./duplicateValidation";
import { runSqlTransaction } from "./sqlTransaction";
import { cancelOpenSqlTasksForTarget } from "./workflowTaskCleanupSqlRepository";

type Actor = { id: string; email: string };
type Assignee = { id: string; active: boolean };

export type DomainMutationInput = {
  domainName?: string;
  environment?: string;
  currentWebVersion?: string;
  assignedUpdaterIds?: string[];
  notes?: string;
  status?: EntityStatus;
};

type DomainRow = {
  domain_key: number;
  source_id: string;
  client_source_id: string;
  client_name: string;
  domain_name: string;
  environment_id: string;
  current_web_version: string | null;
  status: EntityStatus;
  notes: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  deleted_at: Date | null;
  deleted_by: string | null;
  last_updated_at: Date | null;
  last_updated_by: string | null;
};

type ClientRow = { client_key: number; source_id: string; name: string; status: EntityStatus };
type AssigneeRow = { user_key: number; source_id: string; active: boolean };

export function buildDomainMutationValues(
  input: Omit<DomainMutationInput, "assignedUpdaterIds"> & {
    domainName: string; environment: string; status: EntityStatus;
  },
  actorId: string,
  now = new Date(),
) {
  const displayName = input.domainName.trim();
  return {
    domainName: displayName,
    domainNameNormalized: normalizeDomainUrl(input.domainName),
    publishableDomain: displayName,
    environment: input.environment.trim().toLowerCase(),
    currentWebVersion: input.currentWebVersion?.trim() || null,
    notes: input.notes?.trim() || null,
    status: input.status,
    updatedBy: actorId,
    updatedAt: now,
    deletedAt: input.status === "deleted" ? now : null,
    deletedBy: input.status === "deleted" ? actorId : null,
  };
}

export function planDomainAssigneeReconciliation(currentIds: string[], requested: Assignee[]) {
  const current = new Set(currentIds);
  for (const user of requested) {
    if (!user.active && !current.has(user.id)) {
      throw Object.assign(new Error("Solo puede asignar usuarios activos al dominio."), { status: 400 });
    }
  }
  const requestedIds = requested.map((user) => user.id);
  const requestedSet = new Set(requestedIds);
  return {
    ids: requestedIds,
    added: requestedIds.filter((id) => !current.has(id)),
    removed: currentIds.filter((id) => !requestedSet.has(id)),
    retained: requestedIds.filter((id) => current.has(id)),
  };
}

function uniqueIds(ids: string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

function toRecord(row: DomainRow, assigneeIds: string[]): DomainRecord {
  return {
    id: row.source_id,
    clientId: row.client_source_id,
    clientName: row.client_name,
    domainName: row.domain_name,
    environment: row.environment_id,
    currentWebVersion: row.current_web_version ?? undefined,
    assignedUpdaterIds: assigneeIds,
    status: row.status,
    notes: row.notes ?? undefined,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    deletedBy: row.deleted_by,
    lastUpdatedAt: row.last_updated_at?.toISOString() ?? null,
    lastUpdatedBy: row.last_updated_by,
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
    SELECT user_key,source_id,active
    FROM security.users WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id IN (${parameters.join(",")})
    ORDER BY source_id;
  `);
  if (result.recordset.length !== ids.length) {
    throw Object.assign(new Error("Uno de los responsables seleccionados no existe."), { status: 400 });
  }
  const byId = new Map(result.recordset.map((user) => [user.source_id, user]));
  return ids.map((id) => byId.get(id)!);
}

async function loadCurrentAssignees(transaction: sql.Transaction, domainKey: number): Promise<AssigneeRow[]> {
  const request = new sql.Request(transaction);
  request.input("domainKey", sql.BigInt, domainKey);
  const result = await request.query<AssigneeRow>(`
    SELECT u.user_key,u.source_id,u.active
    FROM core.domain_assignees AS a WITH (UPDLOCK,HOLDLOCK)
    JOIN security.users AS u ON u.user_key=a.user_key
    WHERE a.domain_key=@domainKey
    ORDER BY u.source_id;
  `);
  return result.recordset;
}

async function reconcileAssignees(
  transaction: sql.Transaction,
  domainKey: number,
  requestedIds: string[],
  actorId: string,
  now: Date,
): Promise<string[]> {
  const current = await loadCurrentAssignees(transaction, domainKey);
  const requested = await loadRequestedAssignees(transaction, requestedIds);
  const plan = planDomainAssigneeReconciliation(
    current.map((user) => user.source_id),
    requested.map((user) => ({ id: user.source_id, active: user.active })),
  );
  if (plan.removed.length > 0) {
    const request = new sql.Request(transaction);
    request.input("domainKey", sql.BigInt, domainKey);
    const parameters = plan.removed.map((id, index) => {
      const name = `removed${index}`;
      request.input(name, sql.NVarChar(150), id);
      return `@${name}`;
    });
    await request.query(`
      DELETE a
      FROM core.domain_assignees AS a
      JOIN security.users AS u ON u.user_key=a.user_key
      WHERE a.domain_key=@domainKey AND u.source_id IN (${parameters.join(",")});
    `);
  }
  const requestedById = new Map(requested.map((user) => [user.source_id, user]));
  for (const id of plan.added) {
    const request = new sql.Request(transaction);
    request.input("domainKey", sql.BigInt, domainKey);
    request.input("userKey", sql.BigInt, requestedById.get(id)!.user_key);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actorId);
    await request.query(`
      INSERT core.domain_assignees(domain_key,user_key,assigned_at,assigned_by)
      VALUES(@domainKey,@userKey,@now,@actorId);
    `);
  }
  return plan.ids;
}

async function lockDomain(transaction: sql.Transaction, sourceId: string): Promise<DomainRow | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), sourceId);
  const result = await request.query<DomainRow>(`
    SELECT d.domain_key,d.source_id,c.source_id AS client_source_id,c.name AS client_name,
      d.domain_name,d.environment_id,d.current_web_version,d.status,d.notes,d.created_at,d.created_by,
      d.updated_at,d.updated_by,d.deleted_at,d.deleted_by,d.last_updated_at,d.last_updated_by
    FROM core.domains AS d WITH (UPDLOCK,HOLDLOCK)
    JOIN core.clients AS c ON c.client_key=d.client_key
    WHERE d.source_id=@sourceId;
  `);
  return result.recordset[0] ?? null;
}

export async function createSqlDomain(
  sourceId: string,
  clientSourceId: string,
  input: Required<Pick<DomainMutationInput, "domainName" | "environment">> & DomainMutationInput,
  actor: Actor,
): Promise<DomainRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const clientRequest = new sql.Request(transaction);
      clientRequest.input("clientSourceId", sql.NVarChar(150), clientSourceId);
      const clientResult = await clientRequest.query<ClientRow>(`
        SELECT client_key,source_id,name,status
        FROM core.clients WITH (UPDLOCK,HOLDLOCK)
        WHERE source_id=@clientSourceId AND status<>'deleted';
      `);
      const client = clientResult.recordset[0];
      if (!client) throw Object.assign(new Error("Cliente no encontrado."), { status: 400 });

      const now = new Date();
      const values = buildDomainMutationValues({ ...input, status: "active" }, actor.id, now);
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), sourceId);
      request.input("clientKey", sql.BigInt, client.client_key);
      request.input("clientName", sql.NVarChar(200), client.name);
      request.input("domainName", sql.NVarChar(500), values.domainName);
      request.input("domainNameNormalized", sql.NVarChar(500), values.domainNameNormalized);
      request.input("publishableDomain", sql.NVarChar(500), values.publishableDomain);
      request.input("environment", sql.VarChar(20), values.environment);
      request.input("currentWebVersion", sql.NVarChar(80), values.currentWebVersion);
      request.input("notes", sql.NVarChar(sql.MAX), values.notes);
      request.input("now", sql.DateTime2(3), now);
      request.input("actorId", sql.NVarChar(150), actor.id);
      const inserted = await request.query<DomainRow>(`
        INSERT core.domains
          (source_id,client_key,client_name_snapshot,domain_name,domain_name_normalized,publishable_domain,
           environment_id,current_web_version,status,notes,created_at,created_by,updated_at,updated_by)
        OUTPUT INSERTED.domain_key,INSERTED.source_id,@clientSourceId AS client_source_id,
          @clientName AS client_name,INSERTED.domain_name,INSERTED.environment_id,
          INSERTED.current_web_version,INSERTED.status,INSERTED.notes,INSERTED.created_at,
          INSERTED.created_by,INSERTED.updated_at,INSERTED.updated_by,INSERTED.deleted_at,
          INSERTED.deleted_by,INSERTED.last_updated_at,INSERTED.last_updated_by
        VALUES
          (@sourceId,@clientKey,@clientName,@domainName,@domainNameNormalized,@publishableDomain,
           @environment,@currentWebVersion,'active',@notes,@now,@actorId,@now,@actorId);
      `);
      const row = inserted.recordset[0];
      const assignees = await reconcileAssignees(transaction, row.domain_key,
        uniqueIds(input.assignedUpdaterIds), actor.id, now);
      const record = toRecord(row, assignees);
      await writeSqlAuditLog(transaction, {
        entityType: "domain", entityId: sourceId, clientId: client.source_id, clientName: client.name,
        domainId: sourceId, domainName: record.domainName, action: "domain_created",
        performedBy: actor.id, performedByEmail: actor.email, after: record,
      });
      return record;
    });
  } catch (error) {
    if (isSqlUniqueConstraintError(error)) {
      throw Object.assign(new Error("Ya existe un dominio con esta URL."), { status: 409 });
    }
    throw error;
  }
}

export async function updateSqlDomain(
  sourceId: string,
  patch: DomainMutationInput,
  actor: Actor,
): Promise<DomainRecord | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const row = await lockDomain(transaction, sourceId);
      if (!row) return null;
      const currentAssignees = await loadCurrentAssignees(transaction, row.domain_key);
      const before = toRecord(row, currentAssignees.map((user) => user.source_id));
      const now = new Date();
      const values = buildDomainMutationValues({
        domainName: patch.domainName ?? row.domain_name,
        environment: patch.environment ?? row.environment_id,
        currentWebVersion: patch.currentWebVersion !== undefined ? patch.currentWebVersion : row.current_web_version ?? undefined,
        notes: patch.notes !== undefined ? patch.notes : row.notes ?? undefined,
        status: patch.status ?? row.status,
      }, actor.id, now);
      const request = new sql.Request(transaction);
      request.input("domainKey", sql.BigInt, row.domain_key);
      request.input("domainName", sql.NVarChar(500), values.domainName);
      request.input("domainNameNormalized", sql.NVarChar(500), values.domainNameNormalized);
      request.input("publishableDomain", sql.NVarChar(500), values.publishableDomain);
      request.input("environment", sql.VarChar(20), values.environment);
      request.input("currentWebVersion", sql.NVarChar(80), values.currentWebVersion);
      request.input("notes", sql.NVarChar(sql.MAX), values.notes);
      request.input("status", sql.VarChar(20), values.status);
      request.input("now", sql.DateTime2(3), now);
      request.input("actorId", sql.NVarChar(150), actor.id);
      request.input("deletedAt", sql.DateTime2(3), values.deletedAt);
      request.input("deletedBy", sql.NVarChar(150), values.deletedBy);
      await request.query(`
        UPDATE core.domains
        SET domain_name=@domainName,domain_name_normalized=@domainNameNormalized,
            publishable_domain=@publishableDomain,environment_id=@environment,
            current_web_version=@currentWebVersion,notes=@notes,status=@status,
            updated_at=@now,updated_by=@actorId,deleted_at=@deletedAt,deleted_by=@deletedBy
        WHERE domain_key=@domainKey;
      `);
      const assignees = patch.assignedUpdaterIds === undefined
        ? currentAssignees.map((user) => user.source_id)
        : await reconcileAssignees(transaction, row.domain_key, uniqueIds(patch.assignedUpdaterIds), actor.id, now);
      const updated: DomainRecord = {
        ...before, domainName: values.domainName, environment: values.environment,
        currentWebVersion: values.currentWebVersion ?? undefined, notes: values.notes ?? undefined,
        status: values.status, assignedUpdaterIds: assignees, updatedAt: now.toISOString(),
        updatedBy: actor.id, deletedAt: values.deletedAt?.toISOString() ?? null, deletedBy: values.deletedBy,
      };
      await writeSqlAuditLog(transaction, {
        entityType: "domain", entityId: sourceId, clientId: row.client_source_id,
        clientName: row.client_name, domainId: sourceId, domainName: updated.domainName,
        action: "domain_updated", performedBy: actor.id, performedByEmail: actor.email,
        before, after: updated,
      });
      return updated;
    });
  } catch (error) {
    if (isSqlUniqueConstraintError(error)) {
      throw Object.assign(new Error("Ya existe un dominio con esta URL."), { status: 409 });
    }
    throw error;
  }
}

export async function setSqlDomainStatus(
  sourceId: string,
  status: "active" | "inactive",
  action: "domain_deactivated" | "domain_reactivated",
  actor: Actor,
  obsoleteReason?: string,
): Promise<{ domain: DomainRecord; obsoletedTasks: number } | null> {
  return runSqlTransaction(async (transaction) => {
    const row = await lockDomain(transaction, sourceId);
    if (!row) return null;
    const currentAssignees = await loadCurrentAssignees(transaction, row.domain_key);
    const before = toRecord(row, currentAssignees.map((user) => user.source_id));
    const now = new Date();
    const request = new sql.Request(transaction);
    request.input("domainKey", sql.BigInt, row.domain_key);
    request.input("status", sql.VarChar(20), status);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE core.domains
      SET status=@status,updated_at=@now,updated_by=@actorId,deleted_at=NULL,deleted_by=NULL
      WHERE domain_key=@domainKey;
    `);
    const obsoletedTasks = status === "inactive" && obsoleteReason
      ? await cancelOpenSqlTasksForTarget(transaction, { type: "domain", key: row.domain_key }, actor, obsoleteReason, now)
      : 0;
    const domain: DomainRecord = {
      ...before, status, updatedAt: now.toISOString(), updatedBy: actor.id,
      deletedAt: null, deletedBy: null,
    };
    await writeSqlAuditLog(transaction, {
      entityType: "domain", entityId: sourceId, clientId: row.client_source_id,
      clientName: row.client_name, domainId: sourceId, domainName: row.domain_name,
      action, performedBy: actor.id, performedByEmail: actor.email,
      metadata: { obsoletedTasks }, before, after: domain,
    });
    return { domain, obsoletedTasks };
  });
}
