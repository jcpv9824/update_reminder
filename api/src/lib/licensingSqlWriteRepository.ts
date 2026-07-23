import { randomUUID } from "node:crypto";
import sql from "mssql";
import type { EntityStatus, LicenseAssignmentLevel, LicenseAssignmentRecord, LicenseModuleRecord } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { normalizeLicenseCode, normalizeLicenseName, generateLicenseCodeFromName } from "./licenseRules";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";

type Actor = { id: string; email: string };

export type LicenseModuleMutationInput = {
  name?: string;
  code?: string;
  description?: string;
  status?: EntityStatus;
};

export type LicenseAssignmentMutationInput = {
  moduleId?: string;
  targetType?: LicenseAssignmentLevel;
  clientId?: string;
  domainId?: string;
  databaseId?: string;
  environment?: string;
  status?: EntityStatus;
};

type ModuleRow = {
  module_key: number;
  source_id: string;
  name: string;
  code: string | null;
  description: string | null;
  status: EntityStatus;
  notes: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  deleted_at: Date | null;
  deleted_by: string | null;
};

type AssignmentRow = {
  assignment_key: number;
  source_id: string;
  module_source_id: string;
  module_name: string;
  module_code: string | null;
  target_type: LicenseAssignmentLevel;
  client_source_id: string;
  client_name: string;
  domain_source_id: string | null;
  domain_name: string | null;
  database_source_id: string | null;
  database_name: string | null;
  environment_id: string | null;
  status: EntityStatus;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  deleted_at: Date | null;
  deleted_by: string | null;
};

type AssignmentTarget = {
  moduleKey: number;
  moduleName: string;
  moduleCode: string | null;
  clientKey: number | null;
  domainKey: number | null;
  databaseKey: number | null;
  environmentId: "production" | "test" | "demo" | null;
};

export type LicenseDeleteDependency = { clientId: string; clientName: string; assignments: number };
export type DeleteSqlLicenseModuleResult =
  | { found: false; dependencies: [] }
  | { found: true; deleted: false; dependencies: LicenseDeleteDependency[] }
  | { found: true; deleted: true; dependencies: [] };

const collapse = (value: string): string => value.trim().replace(/\s+/g, " ");

export function buildLicenseModuleMutationValues(
  input: Required<Pick<LicenseModuleMutationInput, "name" | "status">> & LicenseModuleMutationInput,
  actorId: string,
  now = new Date(),
) {
  const name = collapse(input.name);
  const code = input.code?.trim() ? normalizeLicenseCode(input.code) : null;
  const description = input.description?.trim() || null;
  const status = input.status;
  return {
    name,
    nameNormalized: normalizeLicenseName(name),
    code,
    codeNormalized: code,
    description,
    status,
    activeLegacy: status === "active",
    updatedAt: now,
    updatedBy: actorId,
    deletedAt: status === "deleted" ? now : null,
    deletedBy: status === "deleted" ? actorId : null,
  };
}

export function selectUniqueSqlLicenseCode(name: string, requestedCode: string | undefined, existingCodes: string[]): string {
  if (requestedCode?.trim()) return normalizeLicenseCode(requestedCode);
  const occupied = new Set(existingCodes.map(normalizeLicenseCode));
  const base = normalizeLicenseCode(generateLicenseCodeFromName(name)) || "MODULO";
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

export function normalizeLicenseAssignmentEnvironment(value: string | undefined): "production" | "test" | "demo" | null {
  const normalized = (value ?? "all").trim().toLowerCase();
  if (!normalized || normalized === "all") return null;
  if (normalized === "production" || normalized === "test" || normalized === "demo") return normalized;
  throw Object.assign(new Error("El ambiente de la asignación no es válido."), { status: 400 });
}

export function isSqlLicenseUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { number?: number; originalError?: { info?: { number?: number } } };
  const number = candidate?.number ?? candidate?.originalError?.info?.number;
  return number === 2601 || number === 2627;
}

function moduleFromRow(row: ModuleRow): LicenseModuleRecord {
  return {
    id: row.source_id,
    name: row.name,
    code: row.code ?? undefined,
    description: row.description ?? undefined,
    status: row.status,
    active: row.status === "active",
    notes: row.notes ?? undefined,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    deletedBy: row.deleted_by,
  };
}

function assignmentFromRow(row: AssignmentRow): LicenseAssignmentRecord {
  const targetId = row.target_type === "client"
    ? row.client_source_id
    : row.target_type === "domain"
      ? row.domain_source_id!
      : row.database_source_id!;
  return {
    id: row.source_id,
    moduleId: row.module_source_id,
    moduleName: row.module_name,
    moduleCode: row.module_code ?? undefined,
    targetType: row.target_type,
    targetId,
    clientId: row.client_source_id,
    clientName: row.client_name,
    domainId: row.domain_source_id ?? undefined,
    domainName: row.domain_name ?? undefined,
    databaseId: row.database_source_id ?? undefined,
    databaseName: row.database_name ?? undefined,
    environment: row.environment_id ?? "all",
    status: row.status,
    active: row.status === "active",
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    deletedBy: row.deleted_by,
  };
}

const moduleColumns = `module_key,source_id,name,code,description,status,notes,created_at,created_by,
  updated_at,updated_by,deleted_at,deleted_by`;

async function lockModule(transaction: sql.Transaction, sourceId: string): Promise<ModuleRow | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), sourceId);
  const result = await request.query<ModuleRow>(`
    SELECT ${moduleColumns}
    FROM licensing.license_modules WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id=@sourceId;
  `);
  return result.recordset[0] ?? null;
}

async function loadExistingCodes(transaction: sql.Transaction, excludeSourceId?: string): Promise<string[]> {
  const request = new sql.Request(transaction);
  request.input("excludeSourceId", sql.NVarChar(150), excludeSourceId ?? null);
  const result = await request.query<{ code: string }>(`
    SELECT code
    FROM licensing.license_modules WITH (UPDLOCK,HOLDLOCK)
    WHERE status<>'deleted' AND code IS NOT NULL
      AND (@excludeSourceId IS NULL OR source_id<>@excludeSourceId);
  `);
  return result.recordset.map((row) => row.code);
}

async function readAssignment(transaction: sql.Transaction, sourceId: string, lock = false): Promise<AssignmentRow | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), sourceId);
  const hint = lock ? "WITH (UPDLOCK,HOLDLOCK)" : "";
  const result = await request.query<AssignmentRow>(`
    SELECT a.assignment_key,a.source_id,m.source_id AS module_source_id,
      COALESCE(a.module_name_snapshot,m.name) AS module_name,
      COALESCE(a.module_code_snapshot,m.code) AS module_code,a.target_type,
      COALESCE(client_direct.source_id,domain_client.source_id,database_client.source_id) AS client_source_id,
      COALESCE(client_direct.name,domain_client.name,database_client.name) AS client_name,
      COALESCE(domain_direct.source_id,database_domain.source_id) AS domain_source_id,
      COALESCE(domain_direct.domain_name,database_domain.domain_name) AS domain_name,
      database_record.source_id AS database_source_id,access_profile.initial_catalog AS database_name,
      a.environment_id,a.status,a.created_at,a.created_by,a.updated_at,a.updated_by,a.deleted_at,a.deleted_by
    FROM licensing.license_assignments AS a ${hint}
    JOIN licensing.license_modules AS m ON m.module_key=a.module_key
    LEFT JOIN core.clients AS client_direct ON client_direct.client_key=a.client_key
    LEFT JOIN core.domains AS domain_direct ON domain_direct.domain_key=a.domain_key
    LEFT JOIN core.clients AS domain_client ON domain_client.client_key=domain_direct.client_key
    LEFT JOIN core.databases AS database_record ON database_record.database_key=a.database_key
    LEFT JOIN core.clients AS database_client ON database_client.client_key=database_record.client_key
    LEFT JOIN core.domains AS database_domain ON database_domain.domain_key=database_record.domain_key
    LEFT JOIN core.database_access_profiles AS access_profile ON access_profile.access_profile_key=database_record.access_profile_key
    WHERE a.source_id=@sourceId;
  `);
  return result.recordset[0] ?? null;
}

async function resolveAssignmentTarget(
  transaction: sql.Transaction,
  input: Required<Pick<LicenseAssignmentMutationInput, "moduleId" | "targetType" | "clientId">> & LicenseAssignmentMutationInput,
): Promise<AssignmentTarget> {
  const environmentId = normalizeLicenseAssignmentEnvironment(input.environment);
  const moduleRequest = new sql.Request(transaction);
  moduleRequest.input("moduleId", sql.NVarChar(150), input.moduleId);
  const modules = await moduleRequest.query<{ module_key: number; name: string; code: string | null; status: EntityStatus }>(`
    SELECT module_key,name,code,status
    FROM licensing.license_modules WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id=@moduleId;
  `);
  const module = modules.recordset[0];
  if (!module || module.status !== "active") {
    throw Object.assign(new Error("El módulo seleccionado no está activo."), { status: 400 });
  }

  const clientRequest = new sql.Request(transaction);
  clientRequest.input("clientId", sql.NVarChar(150), input.clientId);
  const clients = await clientRequest.query<{ client_key: number }>(`
    SELECT client_key FROM core.clients WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id=@clientId AND status='active';
  `);
  const client = clients.recordset[0];
  if (!client) throw Object.assign(new Error("El cliente seleccionado no está activo."), { status: 400 });

  let domainKey: number | null = null;
  let databaseKey: number | null = null;
  if (input.targetType === "domain" || input.targetType === "database") {
    if (!input.domainId?.trim()) throw Object.assign(new Error("Seleccione un dominio."), { status: 400 });
    const domainRequest = new sql.Request(transaction);
    domainRequest.input("domainId", sql.NVarChar(150), input.domainId);
    domainRequest.input("clientKey", sql.BigInt, client.client_key);
    const domains = await domainRequest.query<{ domain_key: number }>(`
      SELECT domain_key FROM core.domains WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@domainId AND client_key=@clientKey AND status='active';
    `);
    domainKey = domains.recordset[0]?.domain_key ?? null;
    if (!domainKey) {
      throw Object.assign(new Error("El dominio seleccionado no pertenece al cliente o no está activo."), { status: 400 });
    }
  }
  if (input.targetType === "database") {
    if (!input.databaseId?.trim()) throw Object.assign(new Error("Seleccione una base de datos."), { status: 400 });
    const databaseRequest = new sql.Request(transaction);
    databaseRequest.input("databaseId", sql.NVarChar(150), input.databaseId);
    databaseRequest.input("clientKey", sql.BigInt, client.client_key);
    databaseRequest.input("domainKey", sql.BigInt, domainKey);
    const databases = await databaseRequest.query<{ database_key: number }>(`
      SELECT database_key FROM core.databases WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@databaseId AND client_key=@clientKey AND domain_key=@domainKey AND status='active';
    `);
    databaseKey = databases.recordset[0]?.database_key ?? null;
    if (!databaseKey) {
      throw Object.assign(new Error("La base de datos seleccionada no pertenece al cliente/dominio o no está activa."), { status: 400 });
    }
  }

  return {
    moduleKey: module.module_key,
    moduleName: module.name,
    moduleCode: module.code,
    clientKey: input.targetType === "client" ? client.client_key : null,
    domainKey: input.targetType === "domain" ? domainKey : null,
    databaseKey: input.targetType === "database" ? databaseKey : null,
    environmentId,
  };
}

function throwSanitizedLicenseConflict(error: unknown): never {
  if (isSqlLicenseUniqueConstraintError(error)) {
    throw Object.assign(new Error("Ya existe un módulo o una asignación de licencia con esos datos."), { status: 409 });
  }
  throw error;
}

export async function findSqlLicenseModule(sourceId: string): Promise<LicenseModuleRecord | null> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sourceId", sql.NVarChar(150), sourceId);
  const result = await request.query<ModuleRow>(`
    SELECT ${moduleColumns} FROM licensing.license_modules WHERE source_id=@sourceId;
  `);
  return result.recordset[0] ? moduleFromRow(result.recordset[0]) : null;
}

export async function createSqlLicenseModule(
  sourceId: string,
  input: Required<Pick<LicenseModuleMutationInput, "name" | "status">> & LicenseModuleMutationInput,
  actor: Actor,
): Promise<LicenseModuleRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const now = new Date();
      const existingCodes = await loadExistingCodes(transaction);
      const code = selectUniqueSqlLicenseCode(input.name, input.code, existingCodes);
      const values = buildLicenseModuleMutationValues({ ...input, code }, actor.id, now);
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), sourceId);
      request.input("name", sql.NVarChar(200), values.name);
      request.input("nameNormalized", sql.NVarChar(200), values.nameNormalized);
      request.input("code", sql.NVarChar(80), values.code);
      request.input("codeNormalized", sql.NVarChar(80), values.codeNormalized);
      request.input("description", sql.NVarChar(2000), values.description);
      request.input("status", sql.VarChar(20), values.status);
      request.input("activeLegacy", sql.Bit, values.activeLegacy);
      request.input("now", sql.DateTime2(3), now);
      request.input("actorId", sql.NVarChar(150), actor.id);
      request.input("deletedAt", sql.DateTime2(3), values.deletedAt);
      request.input("deletedBy", sql.NVarChar(150), values.deletedBy);
      const inserted = await request.query<ModuleRow>(`
        INSERT licensing.license_modules
          (source_id,name,name_normalized,code,code_normalized,description,status,active_legacy,
           created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
        OUTPUT INSERTED.module_key,INSERTED.source_id,INSERTED.name,INSERTED.code,INSERTED.description,
          INSERTED.status,INSERTED.notes,INSERTED.created_at,INSERTED.created_by,INSERTED.updated_at,
          INSERTED.updated_by,INSERTED.deleted_at,INSERTED.deleted_by
        VALUES (@sourceId,@name,@nameNormalized,@code,@codeNormalized,@description,@status,@activeLegacy,
          @now,@actorId,@now,@actorId,@deletedAt,@deletedBy);
      `);
      const record = moduleFromRow(inserted.recordset[0]);
      await writeSqlAuditLog(transaction, {
        entityType: "licenseModule", entityId: sourceId, action: "license_module_created",
        performedBy: actor.id, performedByEmail: actor.email, after: record,
      });
      return record;
    });
  } catch (error) {
    return throwSanitizedLicenseConflict(error);
  }
}

export async function updateSqlLicenseModule(
  sourceId: string,
  patch: LicenseModuleMutationInput,
  actor: Actor,
): Promise<LicenseModuleRecord | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const current = await lockModule(transaction, sourceId);
      if (!current || current.status === "deleted") return null;
      const before = moduleFromRow(current);
      const name = patch.name ?? current.name;
      const existingCodes = await loadExistingCodes(transaction, sourceId);
      const code = patch.code !== undefined
        ? selectUniqueSqlLicenseCode(name, patch.code, existingCodes)
        : current.code ?? selectUniqueSqlLicenseCode(name, undefined, existingCodes);
      const values = buildLicenseModuleMutationValues({
        name,
        code,
        description: patch.description !== undefined ? patch.description : current.description ?? undefined,
        status: patch.status ?? current.status,
      }, actor.id);
      const request = new sql.Request(transaction);
      request.input("moduleKey", sql.BigInt, current.module_key);
      request.input("name", sql.NVarChar(200), values.name);
      request.input("nameNormalized", sql.NVarChar(200), values.nameNormalized);
      request.input("code", sql.NVarChar(80), values.code);
      request.input("codeNormalized", sql.NVarChar(80), values.codeNormalized);
      request.input("description", sql.NVarChar(2000), values.description);
      request.input("status", sql.VarChar(20), values.status);
      request.input("activeLegacy", sql.Bit, values.activeLegacy);
      request.input("now", sql.DateTime2(3), values.updatedAt);
      request.input("actorId", sql.NVarChar(150), actor.id);
      request.input("deletedAt", sql.DateTime2(3), values.deletedAt);
      request.input("deletedBy", sql.NVarChar(150), values.deletedBy);
      const updated = await request.query<ModuleRow>(`
        UPDATE licensing.license_modules
        SET name=@name,name_normalized=@nameNormalized,code=@code,code_normalized=@codeNormalized,
          description=@description,status=@status,active_legacy=@activeLegacy,updated_at=@now,updated_by=@actorId,
          deleted_at=@deletedAt,deleted_by=@deletedBy
        OUTPUT INSERTED.module_key,INSERTED.source_id,INSERTED.name,INSERTED.code,INSERTED.description,
          INSERTED.status,INSERTED.notes,INSERTED.created_at,INSERTED.created_by,INSERTED.updated_at,
          INSERTED.updated_by,INSERTED.deleted_at,INSERTED.deleted_by
        WHERE module_key=@moduleKey;
      `);
      const record = moduleFromRow(updated.recordset[0]);
      await writeSqlAuditLog(transaction, {
        entityType: "licenseModule", entityId: sourceId, action: "license_module_updated",
        performedBy: actor.id, performedByEmail: actor.email, before, after: record,
      });
      return record;
    });
  } catch (error) {
    return throwSanitizedLicenseConflict(error);
  }
}

export async function deleteSqlLicenseModule(sourceId: string, actor: Actor): Promise<DeleteSqlLicenseModuleResult> {
  return runSqlTransaction(async (transaction) => {
    const current = await lockModule(transaction, sourceId);
    if (!current || current.status === "deleted") return { found: false, dependencies: [] };
    const dependenciesRequest = new sql.Request(transaction);
    dependenciesRequest.input("moduleKey", sql.BigInt, current.module_key);
    const dependencies = await dependenciesRequest.query<LicenseDeleteDependency>(`
      SELECT c.source_id AS clientId,c.name AS clientName,COUNT_BIG(*) AS assignments
      FROM licensing.license_assignments AS a WITH (UPDLOCK,HOLDLOCK)
      LEFT JOIN core.clients AS direct_client ON direct_client.client_key=a.client_key
      LEFT JOIN core.domains AS d ON d.domain_key=a.domain_key
      LEFT JOIN core.clients AS domain_client ON domain_client.client_key=d.client_key
      LEFT JOIN core.databases AS db ON db.database_key=a.database_key
      LEFT JOIN core.clients AS database_client ON database_client.client_key=db.client_key
      JOIN core.clients AS c ON c.client_key=COALESCE(direct_client.client_key,domain_client.client_key,database_client.client_key)
      WHERE a.module_key=@moduleKey AND a.status='active' AND c.status='active'
      GROUP BY c.source_id,c.name
      ORDER BY c.name,c.source_id;
    `);
    if (dependencies.recordset.length > 0) {
      return {
        found: true,
        deleted: false,
        dependencies: dependencies.recordset.map((dependency) => ({
          ...dependency,
          assignments: Number(dependency.assignments),
        })),
      };
    }
    const before = moduleFromRow(current);
    const now = new Date();
    const request = new sql.Request(transaction);
    request.input("moduleKey", sql.BigInt, current.module_key);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE licensing.license_modules
      SET status='deleted',active_legacy=0,deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId
      WHERE module_key=@moduleKey;
    `);
    await writeSqlAuditLog(transaction, {
      entityType: "licenseModule", entityId: sourceId, action: "license_module_deleted",
      performedBy: actor.id, performedByEmail: actor.email, before, after: { status: "deleted" },
    });
    return { found: true, deleted: true, dependencies: [] };
  });
}

export async function findSqlLicenseAssignment(sourceId: string): Promise<LicenseAssignmentRecord | null> {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    const row = await readAssignment(transaction, sourceId);
    await transaction.commit();
    return row ? assignmentFromRow(row) : null;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

export async function createSqlLicenseAssignment(
  sourceId: string,
  input: Required<Pick<LicenseAssignmentMutationInput, "moduleId" | "targetType" | "clientId" | "status">> & LicenseAssignmentMutationInput,
  actor: Actor,
): Promise<LicenseAssignmentRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const target = await resolveAssignmentTarget(transaction, input);
      const now = new Date();
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), sourceId);
      request.input("moduleKey", sql.BigInt, target.moduleKey);
      request.input("moduleName", sql.NVarChar(200), target.moduleName);
      request.input("moduleCode", sql.NVarChar(80), target.moduleCode);
      request.input("targetType", sql.VarChar(20), input.targetType);
      request.input("clientKey", sql.BigInt, target.clientKey);
      request.input("domainKey", sql.BigInt, target.domainKey);
      request.input("databaseKey", sql.BigInt, target.databaseKey);
      request.input("environmentId", sql.VarChar(20), target.environmentId);
      request.input("status", sql.VarChar(20), input.status);
      request.input("activeLegacy", sql.Bit, input.status === "active");
      request.input("now", sql.DateTime2(3), now);
      request.input("actorId", sql.NVarChar(150), actor.id);
      request.input("deletedAt", sql.DateTime2(3), input.status === "deleted" ? now : null);
      request.input("deletedBy", sql.NVarChar(150), input.status === "deleted" ? actor.id : null);
      await request.query(`
        INSERT licensing.license_assignments
          (source_id,module_key,module_name_snapshot,module_code_snapshot,target_type,client_key,domain_key,
           database_key,environment_id,status,active_legacy,created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
        VALUES (@sourceId,@moduleKey,@moduleName,@moduleCode,@targetType,@clientKey,@domainKey,@databaseKey,
          @environmentId,@status,@activeLegacy,@now,@actorId,@now,@actorId,@deletedAt,@deletedBy);
      `);
      const row = await readAssignment(transaction, sourceId);
      const record = assignmentFromRow(row!);
      await writeSqlAuditLog(transaction, {
        entityType: "licenseAssignment", entityId: sourceId, clientId: record.clientId, clientName: record.clientName,
        action: "license_assignment_created", performedBy: actor.id, performedByEmail: actor.email, after: record,
      });
      return record;
    });
  } catch (error) {
    return throwSanitizedLicenseConflict(error);
  }
}

export async function updateSqlLicenseAssignment(
  sourceId: string,
  patch: LicenseAssignmentMutationInput,
  actor: Actor,
): Promise<LicenseAssignmentRecord | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const currentRow = await readAssignment(transaction, sourceId, true);
      if (!currentRow || currentRow.status === "deleted") return null;
      const current = assignmentFromRow(currentRow);
      const merged = {
        moduleId: patch.moduleId ?? current.moduleId,
        targetType: patch.targetType ?? current.targetType ?? "client",
        clientId: patch.clientId ?? current.clientId!,
        domainId: patch.domainId ?? current.domainId,
        databaseId: patch.databaseId ?? current.databaseId,
        environment: patch.environment ?? current.environment ?? "all",
        status: patch.status ?? current.status ?? "active",
      };
      const target = await resolveAssignmentTarget(transaction, merged);
      const now = new Date();
      const request = new sql.Request(transaction);
      request.input("assignmentKey", sql.BigInt, currentRow.assignment_key);
      request.input("moduleKey", sql.BigInt, target.moduleKey);
      request.input("moduleName", sql.NVarChar(200), target.moduleName);
      request.input("moduleCode", sql.NVarChar(80), target.moduleCode);
      request.input("targetType", sql.VarChar(20), merged.targetType);
      request.input("clientKey", sql.BigInt, target.clientKey);
      request.input("domainKey", sql.BigInt, target.domainKey);
      request.input("databaseKey", sql.BigInt, target.databaseKey);
      request.input("environmentId", sql.VarChar(20), target.environmentId);
      request.input("status", sql.VarChar(20), merged.status);
      request.input("activeLegacy", sql.Bit, merged.status === "active");
      request.input("now", sql.DateTime2(3), now);
      request.input("actorId", sql.NVarChar(150), actor.id);
      request.input("deletedAt", sql.DateTime2(3), merged.status === "deleted" ? now : null);
      request.input("deletedBy", sql.NVarChar(150), merged.status === "deleted" ? actor.id : null);
      await request.query(`
        UPDATE licensing.license_assignments
        SET module_key=@moduleKey,module_name_snapshot=@moduleName,module_code_snapshot=@moduleCode,
          target_type=@targetType,client_key=@clientKey,domain_key=@domainKey,database_key=@databaseKey,
          environment_id=@environmentId,status=@status,active_legacy=@activeLegacy,updated_at=@now,updated_by=@actorId,
          deleted_at=@deletedAt,deleted_by=@deletedBy
        WHERE assignment_key=@assignmentKey;
      `);
      const updatedRow = await readAssignment(transaction, sourceId);
      const record = assignmentFromRow(updatedRow!);
      await writeSqlAuditLog(transaction, {
        entityType: "licenseAssignment", entityId: sourceId, clientId: record.clientId, clientName: record.clientName,
        action: "license_assignment_updated", performedBy: actor.id, performedByEmail: actor.email, before: current, after: record,
      });
      return record;
    });
  } catch (error) {
    return throwSanitizedLicenseConflict(error);
  }
}

export async function deleteSqlLicenseAssignment(sourceId: string, actor: Actor): Promise<boolean> {
  return runSqlTransaction(async (transaction) => {
    const currentRow = await readAssignment(transaction, sourceId, true);
    if (!currentRow || currentRow.status === "deleted") return false;
    const current = assignmentFromRow(currentRow);
    const now = new Date();
    const request = new sql.Request(transaction);
    request.input("assignmentKey", sql.BigInt, currentRow.assignment_key);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE licensing.license_assignments
      SET status='deleted',active_legacy=0,deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId
      WHERE assignment_key=@assignmentKey;
    `);
    await writeSqlAuditLog(transaction, {
      entityType: "licenseAssignment", entityId: sourceId, clientId: current.clientId, clientName: current.clientName,
      action: "license_assignment_deleted", performedBy: actor.id, performedByEmail: actor.email,
      before: current, after: { status: "deleted" },
    });
    return true;
  });
}
