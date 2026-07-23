import { randomUUID } from "node:crypto";
import sql from "mssql";
import type { ClientRecord, EntityStatus } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { normalizeComparableText } from "./duplicateValidation";
import { runSqlTransaction } from "./sqlTransaction";

type Actor = { id: string; email: string };
type LicenseReference = { id: string; name: string };
type RequestedLicense = LicenseReference & { status: EntityStatus };

export type ClientMutationInput = {
  name?: string;
  externalId?: string;
  notes?: string;
  status?: EntityStatus;
  licenseModuleIds?: string[];
};

type ClientRow = {
  client_key: number;
  source_id: string;
  external_id: string | null;
  name: string;
  status: EntityStatus;
  notes: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  deleted_at: Date | null;
  deleted_by: string | null;
};

type ModuleRow = {
  module_key: number;
  source_id: string;
  name: string;
  status: EntityStatus;
};

type AssignmentRow = {
  assignment_key: number;
  module_key: number;
  source_id: string;
  module_source_id: string;
  module_name: string;
};

export function buildClientMutationValues(
  input: Omit<ClientMutationInput, "licenseModuleIds"> & { name: string; status: EntityStatus },
  actorId: string,
  now = new Date(),
) {
  const status = input.status;
  return {
    name: input.name.trim().replace(/\s+/g, " "),
    nameNormalized: normalizeComparableText(input.name),
    externalId: input.externalId?.trim().replace(/\s+/g, " ") || null,
    notes: input.notes?.trim() || null,
    status,
    updatedBy: actorId,
    updatedAt: now,
    deletedAt: status === "deleted" ? now : null,
    deletedBy: status === "deleted" ? actorId : null,
  };
}

export function planClientLicenseReconciliation(
  current: LicenseReference[],
  requested: RequestedLicense[],
) {
  const currentIds = new Set(current.map((item) => item.id));
  for (const module of requested) {
    if (module.status === "deleted") throw Object.assign(new Error("Una de las licencias seleccionadas no existe."), { status: 400 });
    if (module.status !== "active" && !currentIds.has(module.id)) {
      throw Object.assign(new Error("Solo puede asignar licencias activas al cliente."), { status: 400 });
    }
  }
  const requestedIds = new Set(requested.map((item) => item.id));
  return {
    ids: requested.map((item) => item.id),
    names: requested.map((item) => item.name),
    added: requested.filter((item) => !currentIds.has(item.id)).map((item) => item.id),
    removed: current.filter((item) => !requestedIds.has(item.id)).map((item) => item.id),
    retained: requested.filter((item) => currentIds.has(item.id)).map((item) => item.id),
  };
}

export function isSqlUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { number?: number; originalError?: { info?: { number?: number } } };
  const number = candidate?.number ?? candidate?.originalError?.info?.number;
  return number === 2601 || number === 2627;
}

function uniqueIds(ids: string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

function recordFromRow(row: ClientRow, licenses: LicenseReference[]): ClientRecord {
  return {
    id: row.source_id,
    externalId: row.external_id ?? undefined,
    name: row.name,
    status: row.status,
    notes: row.notes ?? undefined,
    licenseModuleIds: licenses.map((item) => item.id),
    licenseModuleNames: licenses.map((item) => item.name),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    deletedBy: row.deleted_by,
  };
}

async function loadModules(
  transaction: sql.Transaction,
  ids: string[],
): Promise<ModuleRow[]> {
  if (ids.length === 0) return [];
  const request = new sql.Request(transaction);
  const parameters = ids.map((id, index) => {
    const name = `module${index}`;
    request.input(name, sql.NVarChar(150), id);
    return `@${name}`;
  });
  const result = await request.query<ModuleRow>(`
    SELECT module_key,source_id,name,status
    FROM licensing.license_modules WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id IN (${parameters.join(",")})
    ORDER BY name,source_id;
  `);
  if (result.recordset.length !== ids.length) {
    throw Object.assign(new Error("Una de las licencias seleccionadas no existe."), { status: 400 });
  }
  const byId = new Map(result.recordset.map((item) => [item.source_id, item]));
  return ids.map((id) => byId.get(id)!);
}

async function loadAssignments(
  transaction: sql.Transaction,
  clientKey: number,
): Promise<AssignmentRow[]> {
  const request = new sql.Request(transaction);
  request.input("clientKey", sql.BigInt, clientKey);
  const result = await request.query<AssignmentRow>(`
    SELECT a.assignment_key,a.module_key,a.source_id,m.source_id AS module_source_id,
      COALESCE(a.module_name_snapshot,m.name) AS module_name
    FROM licensing.license_assignments AS a WITH (UPDLOCK,HOLDLOCK)
    JOIN licensing.license_modules AS m ON m.module_key=a.module_key
    WHERE a.target_type='client' AND a.client_key=@clientKey AND a.status<>'deleted'
    ORDER BY m.name,m.source_id;
  `);
  return result.recordset;
}

async function insertAssignment(
  transaction: sql.Transaction,
  clientKey: number,
  module: ModuleRow,
  actorId: string,
  now: Date,
): Promise<void> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), `license_client_${randomUUID()}`);
  request.input("moduleKey", sql.BigInt, module.module_key);
  request.input("moduleName", sql.NVarChar(200), module.name);
  request.input("clientKey", sql.BigInt, clientKey);
  request.input("now", sql.DateTime2(3), now);
  request.input("actorId", sql.NVarChar(150), actorId);
  await request.query(`
    INSERT licensing.license_assignments
      (source_id,module_key,module_name_snapshot,target_type,client_key,environment_id,status,
       active_legacy,created_at,created_by,updated_at,updated_by)
    VALUES
      (@sourceId,@moduleKey,@moduleName,'client',@clientKey,NULL,'active',1,@now,@actorId,@now,@actorId);
  `);
}

async function reconcileAssignments(
  transaction: sql.Transaction,
  clientKey: number,
  requestedIds: string[],
  actorId: string,
  now: Date,
): Promise<LicenseReference[]> {
  const currentRows = await loadAssignments(transaction, clientKey);
  const current = currentRows.map((item) => ({ id: item.module_source_id, name: item.module_name }));
  const modules = await loadModules(transaction, requestedIds);
  const plan = planClientLicenseReconciliation(current, modules.map((item) => ({
    id: item.source_id, name: item.name, status: item.status,
  })));

  if (plan.removed.length > 0) {
    const request = new sql.Request(transaction);
    request.input("clientKey", sql.BigInt, clientKey);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actorId);
    const parameters = plan.removed.map((id, index) => {
      const name = `removed${index}`;
      request.input(name, sql.NVarChar(150), id);
      return `@${name}`;
    });
    await request.query(`
      UPDATE a
      SET status='deleted',active_legacy=0,deleted_at=@now,deleted_by=@actorId,
          updated_at=@now,updated_by=@actorId
      FROM licensing.license_assignments AS a
      JOIN licensing.license_modules AS m ON m.module_key=a.module_key
      WHERE a.target_type='client' AND a.client_key=@clientKey AND a.status<>'deleted'
        AND m.source_id IN (${parameters.join(",")});
    `);
  }

  const moduleById = new Map(modules.map((item) => [item.source_id, item]));
  for (const id of plan.added) await insertAssignment(transaction, clientKey, moduleById.get(id)!, actorId, now);
  return plan.ids.map((id, index) => ({ id, name: plan.names[index] }));
}

export async function createSqlClient(
  sourceId: string,
  input: Required<Pick<ClientMutationInput, "name">> & ClientMutationInput,
  actor: Actor,
): Promise<ClientRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const now = new Date();
      const values = buildClientMutationValues({ ...input, status: "active" }, actor.id, now);
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), sourceId);
      request.input("externalId", sql.NVarChar(100), values.externalId);
      request.input("name", sql.NVarChar(200), values.name);
      request.input("nameNormalized", sql.NVarChar(200), values.nameNormalized);
      request.input("notes", sql.NVarChar(sql.MAX), values.notes);
      request.input("now", sql.DateTime2(3), now);
      request.input("actorId", sql.NVarChar(150), actor.id);
      const inserted = await request.query<ClientRow>(`
        INSERT core.clients
          (source_id,external_id,name,name_normalized,status,notes,created_at,created_by,updated_at,updated_by)
        OUTPUT INSERTED.client_key,INSERTED.source_id,INSERTED.external_id,INSERTED.name,INSERTED.status,
          INSERTED.notes,INSERTED.created_at,INSERTED.created_by,INSERTED.updated_at,INSERTED.updated_by,
          INSERTED.deleted_at,INSERTED.deleted_by
        VALUES (@sourceId,@externalId,@name,@nameNormalized,'active',@notes,@now,@actorId,@now,@actorId);
      `);
      const row = inserted.recordset[0];
      const licenses = await reconcileAssignments(transaction, row.client_key, uniqueIds(input.licenseModuleIds), actor.id, now);
      const record = recordFromRow(row, licenses);
      await writeSqlAuditLog(transaction, {
        entityType: "client", entityId: record.id, clientId: record.id, clientName: record.name,
        action: "client_created", performedBy: actor.id, performedByEmail: actor.email, after: record,
      });
      return record;
    });
  } catch (error) {
    if (isSqlUniqueConstraintError(error)) {
      throw Object.assign(new Error("Ya existe un cliente con este nombre o ID."), { status: 409 });
    }
    throw error;
  }
}

export async function updateSqlClient(
  sourceId: string,
  patch: ClientMutationInput,
  actor: Actor,
  action = "client_updated",
): Promise<ClientRecord | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const lock = new sql.Request(transaction);
      lock.input("sourceId", sql.NVarChar(150), sourceId);
      const existing = await lock.query<ClientRow>(`
        SELECT client_key,source_id,external_id,name,status,notes,created_at,created_by,
          updated_at,updated_by,deleted_at,deleted_by
        FROM core.clients WITH (UPDLOCK,HOLDLOCK)
        WHERE source_id=@sourceId;
      `);
      const row = existing.recordset[0];
      if (!row) return null;

      const currentAssignments = await loadAssignments(transaction, row.client_key);
      const currentLicenses = currentAssignments.map((item) => ({ id: item.module_source_id, name: item.module_name }));
      const before = recordFromRow(row, currentLicenses);
      const now = new Date();
      const values = buildClientMutationValues({
        name: patch.name ?? row.name,
        externalId: patch.externalId !== undefined ? patch.externalId : row.external_id ?? undefined,
        notes: patch.notes !== undefined ? patch.notes : row.notes ?? undefined,
        status: patch.status ?? row.status,
      }, actor.id, now);

      const request = new sql.Request(transaction);
      request.input("clientKey", sql.BigInt, row.client_key);
      request.input("externalId", sql.NVarChar(100), values.externalId);
      request.input("name", sql.NVarChar(200), values.name);
      request.input("nameNormalized", sql.NVarChar(200), values.nameNormalized);
      request.input("status", sql.VarChar(20), values.status);
      request.input("notes", sql.NVarChar(sql.MAX), values.notes);
      request.input("now", sql.DateTime2(3), now);
      request.input("actorId", sql.NVarChar(150), actor.id);
      request.input("deletedAt", sql.DateTime2(3), values.deletedAt);
      request.input("deletedBy", sql.NVarChar(150), values.deletedBy);
      await request.query(`
        UPDATE core.clients
        SET external_id=@externalId,name=@name,name_normalized=@nameNormalized,status=@status,notes=@notes,
            updated_at=@now,updated_by=@actorId,deleted_at=@deletedAt,deleted_by=@deletedBy
        WHERE client_key=@clientKey;
      `);

      const licenses = patch.licenseModuleIds === undefined
        ? currentLicenses
        : await reconcileAssignments(transaction, row.client_key, uniqueIds(patch.licenseModuleIds), actor.id, now);
      const updated: ClientRecord = {
        ...before,
        externalId: values.externalId ?? undefined,
        name: values.name,
        status: values.status,
        notes: values.notes ?? undefined,
        licenseModuleIds: licenses.map((item) => item.id),
        licenseModuleNames: licenses.map((item) => item.name),
        updatedAt: now.toISOString(),
        updatedBy: actor.id,
        deletedAt: values.deletedAt?.toISOString() ?? null,
        deletedBy: values.deletedBy,
      };
      await writeSqlAuditLog(transaction, {
        entityType: "client", entityId: sourceId, clientId: sourceId, clientName: updated.name,
        action, performedBy: actor.id, performedByEmail: actor.email, before, after: updated,
      });
      return updated;
    });
  } catch (error) {
    if (isSqlUniqueConstraintError(error)) {
      throw Object.assign(new Error("Ya existe un cliente con este nombre o ID."), { status: 409 });
    }
    throw error;
  }
}
