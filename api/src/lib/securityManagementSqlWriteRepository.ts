import sql from "mssql";
import type { AuthSessionRecord, CurrentUser, UserRecord } from "../types/models";
import type { RoleDefinitionRecord } from "./roleDefinitions";
import type { RoleUsage } from "./roleLifecycle";
import { normalizeEmail } from "./password";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";
import { mapSqlCredentialUser, type SqlCredentialUserRow } from "./securityAuthSqlRepository";
import { enqueuePasswordResetNotificationSql } from "./notificationOutboxSqlRepository";

type Actor = Pick<CurrentUser, "id" | "email">;

const USER_PROJECTION = `
  users.source_id,users.display_name,users.email,users.active,users.password_hash,
  users.password_updated_at,users.password_expires_at,users.must_change_password,
  users.token_version,users.last_login_at,users.password_reset_token_hash,
  users.password_reset_expires_at,users.password_reset_used_at,
  users.created_at,users.created_by,users.updated_at,users.updated_by,
  COALESCE((SELECT user_role.role_id AS value FROM security.user_roles user_role
    WHERE user_role.user_key=users.user_key ORDER BY user_role.role_id FOR JSON PATH),N'[]') AS roles_json`;

const ROLE_PROJECTION = `
  role.role_id,role.name,role.active,role.system_role,role.protected_role,
  role.domain_task_visibility,role.database_task_visibility,
  role.created_at,role.created_by,role.updated_at,role.updated_by,
  COALESCE((SELECT role_permission.permission_key AS value
    FROM security.role_permissions role_permission
    WHERE role_permission.role_id=role.role_id
    ORDER BY role_permission.permission_key FOR JSON PATH),N'[]') AS permissions_json`;

type RoleRow = {
  role_id: string;
  name: string;
  active: boolean;
  system_role: boolean;
  protected_role: boolean;
  domain_task_visibility: "none" | "assigned" | "all";
  database_task_visibility: "none" | "assigned" | "all";
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  permissions_json: string | null;
};

export type SqlUserCreateInput = {
  id: string;
  displayName: string;
  email: string;
  roles: string[];
  active: boolean;
  passwordHash: string;
  mustChangePassword: boolean;
};

export type SqlUserUpdateInput = {
  displayName?: string;
  roles?: string[];
  active?: boolean;
};

function roleFromRow(row: RoleRow): RoleDefinitionRecord {
  let permissions: string[] = [];
  try {
    permissions = (JSON.parse(row.permissions_json ?? "[]") as Array<{ value?: unknown }>)
      .map((entry) => entry.value)
      .filter((value): value is string => typeof value === "string");
  } catch { /* invalid JSON is treated as no grants and exposed by reconciliation */ }
  return {
    id: row.role_id,
    name: row.name,
    active: row.active,
    system: row.system_role,
    protected: row.protected_role,
    permissions,
    taskVisibility: {
      domain: row.domain_task_visibility,
      database: row.database_task_visibility,
    },
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

async function readLockedUser(transaction: sql.Transaction, sourceId: string): Promise<UserRecord | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), sourceId);
  const result = await request.query<SqlCredentialUserRow>(`
    SELECT ${USER_PROJECTION}
    FROM security.users users WITH (UPDLOCK,HOLDLOCK)
    WHERE users.source_id=@sourceId;
  `);
  return result.recordset[0] ? mapSqlCredentialUser(result.recordset[0]) : null;
}

async function readLockedRole(transaction: sql.Transaction, roleId: string): Promise<RoleDefinitionRecord | null> {
  const request = new sql.Request(transaction);
  request.input("roleId", sql.NVarChar(80), roleId);
  const result = await request.query<RoleRow>(`
    SELECT ${ROLE_PROJECTION}
    FROM security.roles role WITH (UPDLOCK,HOLDLOCK)
    WHERE role.role_id=@roleId;
  `);
  return result.recordset[0] ? roleFromRow(result.recordset[0]) : null;
}

async function assertAssignableRoles(transaction: sql.Transaction, roleIds: string[]): Promise<void> {
  const unique = [...new Set(roleIds)];
  for (const roleId of unique) {
    const request = new sql.Request(transaction);
    request.input("roleId", sql.NVarChar(80), roleId);
    const result = await request.query<{ active: boolean }>(`
      SELECT active FROM security.roles WITH (UPDLOCK,HOLDLOCK) WHERE role_id=@roleId;
    `);
    if (!result.recordset[0]) throw Object.assign(new Error(`El rol ${roleId} no existe.`), { status: 400 });
    if (!result.recordset[0].active) throw Object.assign(new Error(`El rol ${roleId} está inactivo y no se puede asignar.`), { status: 400 });
  }
}

async function replaceUserRoles(
  transaction: sql.Transaction,
  userId: string,
  roleIds: string[],
  actorId: string,
  assignedAt: Date,
): Promise<void> {
  await assertAssignableRoles(transaction, roleIds);
  const remove = new sql.Request(transaction);
  remove.input("userId", sql.NVarChar(150), userId);
  await remove.query(`
    DELETE user_role FROM security.user_roles user_role
    JOIN security.users users ON users.user_key=user_role.user_key
    WHERE users.source_id=@userId;
  `);
  for (const roleId of [...new Set(roleIds)]) {
    const insert = new sql.Request(transaction);
    insert.input("userId", sql.NVarChar(150), userId);
    insert.input("roleId", sql.NVarChar(80), roleId);
    insert.input("assignedAt", sql.DateTime2(3), assignedAt);
    insert.input("assignedBy", sql.NVarChar(150), actorId);
    await insert.query(`
      INSERT security.user_roles(user_key,role_id,assigned_at,assigned_by)
      SELECT users.user_key,@roleId,@assignedAt,@assignedBy
      FROM security.users users WHERE users.source_id=@userId;
    `);
  }
}

async function revokeUserSessions(
  transaction: sql.Transaction,
  userId: string,
  reason: string,
  revokedAt: Date,
): Promise<void> {
  const request = new sql.Request(transaction);
  request.input("userId", sql.NVarChar(150), userId);
  request.input("reason", sql.NVarChar(300), reason);
  request.input("revokedAt", sql.DateTime2(3), revokedAt);
  await request.query(`
    UPDATE sessions SET revoked_at=@revokedAt,revoked_reason=@reason,last_used_at=COALESCE(last_used_at,@revokedAt)
    FROM security.auth_sessions sessions
    JOIN security.users users ON users.user_key=sessions.user_key
    WHERE users.source_id=@userId AND sessions.revoked_at IS NULL;
  `);
}

export async function createSqlUser(input: SqlUserCreateInput, actor: Actor): Promise<UserRecord> {
  return runSqlTransaction(async (transaction) => {
    const now = new Date();
    const email = input.email.trim();
    const normalized = normalizeEmail(email);
    await assertAssignableRoles(transaction, input.roles);
    const insert = new sql.Request(transaction);
    insert.input("sourceId", sql.NVarChar(150), input.id);
    insert.input("displayName", sql.NVarChar(160), input.displayName.trim());
    insert.input("email", sql.NVarChar(254), email);
    insert.input("emailNormalized", sql.NVarChar(254), normalized);
    insert.input("active", sql.Bit, input.active);
    insert.input("passwordHash", sql.NVarChar(500), input.passwordHash);
    insert.input("mustChangePassword", sql.Bit, input.mustChangePassword);
    insert.input("now", sql.DateTime2(3), now);
    insert.input("actorId", sql.NVarChar(150), actor.id);
    await insert.query(`
      INSERT security.users
      (source_id,display_name,email,email_normalized,active,password_hash,password_updated_at,
       password_expires_at,must_change_password,token_version,last_login_at,created_at,created_by,updated_at,updated_by)
      VALUES
      (@sourceId,@displayName,@email,@emailNormalized,@active,@passwordHash,@now,
       NULL,@mustChangePassword,0,NULL,@now,@actorId,@now,@actorId);
    `);
    await replaceUserRoles(transaction, input.id, input.roles, actor.id, now);
    const created = await readLockedUser(transaction, input.id);
    if (!created) throw new Error("No se pudo recuperar el usuario SQL creado.");
    await writeSqlAuditLog(transaction, {
      entityType: "user", entityId: created.id, action: "user_created",
      performedBy: actor.id, performedByEmail: actor.email, after: created,
    });
    return created;
  });
}

export async function updateSqlUser(id: string, input: SqlUserUpdateInput, actor: Actor): Promise<UserRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const before = await readLockedUser(transaction, id);
    if (!before) return null;
    const now = new Date();
    const roles = input.roles ?? before.roles;
    const active = input.active ?? before.active;
    const rolesChanged = JSON.stringify([...roles].sort()) !== JSON.stringify([...(before.roles ?? [])].sort());
    const deactivated = before.active !== false && active === false;
    await assertAssignableRoles(transaction, roles);
    const update = new sql.Request(transaction);
    update.input("sourceId", sql.NVarChar(150), id);
    update.input("displayName", sql.NVarChar(160), input.displayName?.trim() ?? before.displayName);
    update.input("active", sql.Bit, active);
    update.input("incrementTokenVersion", sql.Bit, deactivated || rolesChanged);
    update.input("updatedAt", sql.DateTime2(3), now);
    update.input("updatedBy", sql.NVarChar(150), actor.id);
    await update.query(`
      UPDATE security.users SET display_name=@displayName,active=@active,
        token_version=token_version+CASE WHEN @incrementTokenVersion=1 THEN 1 ELSE 0 END,
        updated_at=@updatedAt,updated_by=@updatedBy
      WHERE source_id=@sourceId;
    `);
    if (input.roles) await replaceUserRoles(transaction, id, roles, actor.id, now);
    if (deactivated || rolesChanged) {
      await revokeUserSessions(transaction, id, deactivated ? "user_deactivated" : "user_roles_changed", now);
    }
    const after = await readLockedUser(transaction, id);
    if (!after) throw new Error("El usuario SQL desapareció durante la actualización.");
    await writeSqlAuditLog(transaction, {
      entityType: "user", entityId: id, action: rolesChanged ? "roles_updated" : "user_updated",
      performedBy: actor.id, performedByEmail: actor.email, before, after,
    });
    return after;
  });
}

export async function setSqlUserPassword(
  id: string,
  passwordHash: string,
  actor: Actor,
  action: "user_password_reset" | "user_credentials_resent" | "mandatory_password_changed" | "password_reset_completed",
  options: { mustChangePassword: boolean; expiresAt?: Date | null; resetUsedAt?: Date | null; updatedBy?: string } = { mustChangePassword: true },
): Promise<UserRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const before = await readLockedUser(transaction, id);
    if (!before) return null;
    const now = new Date();
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), id);
    request.input("passwordHash", sql.NVarChar(500), passwordHash);
    request.input("now", sql.DateTime2(3), now);
    request.input("expiresAt", sql.DateTime2(3), options.expiresAt ?? null);
    request.input("mustChange", sql.Bit, options.mustChangePassword);
    request.input("resetUsedAt", sql.DateTime2(3), options.resetUsedAt ?? null);
    request.input("updatedBy", sql.NVarChar(150), options.updatedBy ?? actor.id);
    await request.query(`
      UPDATE security.users SET password_hash=@passwordHash,password_updated_at=@now,
        password_expires_at=@expiresAt,must_change_password=@mustChange,token_version=token_version+1,
        password_reset_token_hash=NULL,password_reset_expires_at=NULL,password_reset_used_at=@resetUsedAt,
        updated_at=@now,updated_by=@updatedBy
      WHERE source_id=@sourceId;
    `);
    await revokeUserSessions(transaction, id, action, now);
    const after = await readLockedUser(transaction, id);
    if (!after) throw new Error("El usuario SQL desapareció durante el cambio de contraseña.");
    await writeSqlAuditLog(transaction, {
      entityType: "user", entityId: id, action,
      performedBy: actor.id, performedByEmail: actor.email,
    });
    return after;
  });
}

export async function findSqlUserByEmail(email: string): Promise<UserRecord | null> {
  const normalized = normalizeEmail(email);
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("email", sql.NVarChar(254), normalized);
    const result = await request.query<SqlCredentialUserRow>(`
      SELECT ${USER_PROJECTION} FROM security.users users WHERE users.email_normalized=@email;
    `);
    return result.recordset[0] ? mapSqlCredentialUser(result.recordset[0]) : null;
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function findSqlUserById(id: string): Promise<UserRecord | null> {
  return runSqlTransaction((transaction) => readLockedUser(transaction, id), sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function completeSqlLogin(userId: string, session: AuthSessionRecord): Promise<UserRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const user = await readLockedUser(transaction, userId);
    if (!user || !user.active || (user.tokenVersion ?? 0) !== session.tokenVersion) return null;
    const now = new Date();
    const login = new sql.Request(transaction);
    login.input("sourceId", sql.NVarChar(150), userId);
    login.input("lastLoginAt", sql.DateTime2(3), now);
    await login.query("UPDATE security.users SET last_login_at=@lastLoginAt WHERE source_id=@sourceId;");

    const insert = new sql.Request(transaction);
    insert.input("sourceId", sql.NVarChar(150), session.id);
    insert.input("userSourceId", sql.NVarChar(150), userId);
    insert.input("tokenHash", sql.VarBinary(32), Buffer.from(session.refreshTokenHash, "hex"));
    insert.input("tokenVersion", sql.Int, session.tokenVersion);
    insert.input("createdAt", sql.DateTime2(3), new Date(session.createdAt));
    insert.input("lastUsedAt", sql.DateTime2(3), new Date(session.lastUsedAt));
    insert.input("expiresAt", sql.DateTime2(3), new Date(session.expiresAt));
    const result = await insert.query(`
      INSERT security.auth_sessions
        (source_id,user_key,refresh_token_hash,token_version,created_at,last_used_at,expires_at)
      SELECT @sourceId,users.user_key,@tokenHash,@tokenVersion,@createdAt,@lastUsedAt,@expiresAt
      FROM security.users users WHERE users.source_id=@userSourceId;
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) throw new Error("No se pudo crear la sesión SQL.");
    await writeSqlAuditLog(transaction, {
      entityType: "user", entityId: userId, action: "user_logged_in",
      performedBy: userId, performedByEmail: user.email,
    });
    return { ...user, lastLoginAt: now.toISOString() };
  });
}

export async function requestSqlPasswordReset(
  user: UserRecord,
  actor: Actor = { id: user.id, email: user.email },
): Promise<{ notificationId: string; created: boolean }> {
  return runSqlTransaction(async (transaction) => {
    const locked = await readLockedUser(transaction, user.id);
    if (!locked || !locked.active) return { notificationId: "", created: false };
    const queued = await enqueuePasswordResetNotificationSql(transaction, {
      userId: locked.id,
      email: locked.email,
      displayName: locked.displayName,
      requestedBy: actor.id,
    });
    await writeSqlAuditLog(transaction, {
      entityType: "user", entityId: locked.id, action: "password_reset_requested",
      performedBy: actor.id, performedByEmail: actor.email,
      metadata: { expiresAt: null },
    });
    return queued;
  });
}

export async function setSqlPasswordResetToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<UserRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const before = await readLockedUser(transaction, userId);
    if (!before || !before.active) return null;
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), userId);
    request.input("tokenHash", sql.NVarChar(500), tokenHash);
    request.input("expiresAt", sql.DateTime2(3), expiresAt);
    request.input("now", sql.DateTime2(3), new Date());
    await request.query(`
      UPDATE security.users SET password_reset_token_hash=@tokenHash,
        password_reset_expires_at=@expiresAt,password_reset_used_at=NULL,
        updated_at=@now,updated_by=N'email-outbox'
      WHERE source_id=@sourceId AND active=1;
    `);
    return readLockedUser(transaction, userId);
  });
}

export async function findSqlUserByResetTokenHash(tokenHash: string): Promise<UserRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("tokenHash", sql.NVarChar(500), tokenHash);
    const result = await request.query<SqlCredentialUserRow>(`
      SELECT ${USER_PROJECTION} FROM security.users users WHERE users.password_reset_token_hash=@tokenHash;
    `);
    return result.recordset[0] ? mapSqlCredentialUser(result.recordset[0]) : null;
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function resetSqlPasswordByToken(
  tokenHash: string,
  passwordHash: string,
  passwordExpiresAt: Date,
): Promise<UserRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const lookup = new sql.Request(transaction);
    lookup.input("tokenHash", sql.NVarChar(500), tokenHash);
    const result = await lookup.query<SqlCredentialUserRow>(`
      SELECT ${USER_PROJECTION}
      FROM security.users users WITH (UPDLOCK,HOLDLOCK)
      WHERE users.password_reset_token_hash=@tokenHash;
    `);
    const before = result.recordset[0] ? mapSqlCredentialUser(result.recordset[0]) : null;
    const now = new Date();
    if (!before || !before.active || before.passwordResetUsedAt || !before.passwordResetExpiresAt
      || Date.parse(before.passwordResetExpiresAt) <= now.getTime()) return null;
    const update = new sql.Request(transaction);
    update.input("sourceId", sql.NVarChar(150), before.id);
    update.input("passwordHash", sql.NVarChar(500), passwordHash);
    update.input("now", sql.DateTime2(3), now);
    update.input("expiresAt", sql.DateTime2(3), passwordExpiresAt);
    await update.query(`
      UPDATE security.users SET password_hash=@passwordHash,password_updated_at=@now,
        password_expires_at=@expiresAt,must_change_password=0,token_version=token_version+1,
        password_reset_used_at=@now,password_reset_token_hash=NULL,password_reset_expires_at=NULL,
        updated_at=@now,updated_by=N'system'
      WHERE source_id=@sourceId;
    `);
    await revokeUserSessions(transaction, before.id, "password_reset_completed", now);
    await writeSqlAuditLog(transaction, {
      entityType: "user", entityId: before.id, action: "password_reset_completed",
      performedBy: before.id, performedByEmail: before.email,
    });
    return readLockedUser(transaction, before.id);
  });
}

export async function createSqlRole(record: RoleDefinitionRecord, actor: Actor): Promise<RoleDefinitionRecord> {
  return runSqlTransaction(async (transaction) => {
    if (await readLockedRole(transaction, record.id)) {
      throw Object.assign(new Error("Ya existe un rol con ese ID."), { status: 409 });
    }
    const now = new Date(record.createdAt);
    const insert = new sql.Request(transaction);
    insert.input("roleId", sql.NVarChar(80), record.id);
    insert.input("name", sql.NVarChar(160), record.name);
    insert.input("active", sql.Bit, record.active);
    insert.input("domainVisibility", sql.VarChar(10), record.taskVisibility.domain);
    insert.input("databaseVisibility", sql.VarChar(10), record.taskVisibility.database);
    insert.input("now", sql.DateTime2(3), now);
    insert.input("actorId", sql.NVarChar(150), actor.id);
    await insert.query(`
      INSERT security.roles
      (role_id,name,active,system_role,protected_role,domain_task_visibility,database_task_visibility,
       created_at,created_by,updated_at,updated_by)
      VALUES(@roleId,@name,@active,0,0,@domainVisibility,@databaseVisibility,@now,@actorId,@now,@actorId);
    `);
    await replaceRolePermissions(transaction, record.id, record.permissions, actor.id, now);
    const created = await readLockedRole(transaction, record.id);
    if (!created) throw new Error("No se pudo recuperar el rol SQL creado.");
    await writeSqlAuditLog(transaction, {
      entityType: "role", entityId: created.id, action: "role_created",
      performedBy: actor.id, performedByEmail: actor.email, after: created,
    });
    return created;
  });
}

async function replaceRolePermissions(
  transaction: sql.Transaction,
  roleId: string,
  permissions: string[],
  actorId: string,
  grantedAt: Date,
): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("roleId", sql.NVarChar(80), roleId);
  await remove.query("DELETE security.role_permissions WHERE role_id=@roleId;");
  for (const permission of [...new Set(permissions)]) {
    const insert = new sql.Request(transaction);
    insert.input("roleId", sql.NVarChar(80), roleId);
    insert.input("permission", sql.NVarChar(160), permission);
    insert.input("grantedAt", sql.DateTime2(3), grantedAt);
    insert.input("grantedBy", sql.NVarChar(150), actorId);
    const result = await insert.query(`
      INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
      SELECT @roleId,permission_key,@grantedAt,@grantedBy
      FROM security.permissions WHERE permission_key=@permission AND active=1;
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) {
      throw Object.assign(new Error(`Permiso no reconocido: ${permission}`), { status: 400 });
    }
  }
}

export async function getSqlRoleUsage(roleId: string): Promise<RoleUsage> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("roleId", sql.NVarChar(80), roleId);
    const result = await request.query<{ users: number; active_schedules: number; open_tasks: number }>(`
      SELECT
        (SELECT COUNT_BIG(*) FROM security.user_roles WHERE role_id=@roleId) AS users,
        (SELECT COUNT_BIG(*) FROM scheduling.update_schedules
          WHERE active=1 AND deleted_at IS NULL AND @roleId IN (assigned_role,domain_assigned_role,database_assigned_role)) AS active_schedules,
        (SELECT COUNT_BIG(*) FROM workflow.update_tasks
          WHERE assigned_role=@roleId AND status NOT IN ('completed','cancelled')) AS open_tasks;
    `);
    const row = result.recordset[0];
    const usage = { users: Number(row?.users ?? 0), activeSchedules: Number(row?.active_schedules ?? 0), openTasks: Number(row?.open_tasks ?? 0) };
    return { ...usage, hasReferences: usage.users + usage.activeSchedules + usage.openTasks > 0 };
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function updateSqlRole(record: RoleDefinitionRecord, actor: Actor): Promise<RoleDefinitionRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const before = await readLockedRole(transaction, record.id);
    if (!before) return null;
    if (before.id === "super_admin" && (!record.active || !record.system || !record.protected)) {
      throw Object.assign(new Error("El rol super_admin no puede desactivarse ni desprotegerse."), { status: 400 });
    }
    const now = new Date(record.updatedAt);
    const request = new sql.Request(transaction);
    request.input("roleId", sql.NVarChar(80), record.id);
    request.input("name", sql.NVarChar(160), record.name);
    request.input("active", sql.Bit, record.active);
    request.input("domainVisibility", sql.VarChar(10), record.taskVisibility.domain);
    request.input("databaseVisibility", sql.VarChar(10), record.taskVisibility.database);
    request.input("updatedAt", sql.DateTime2(3), now);
    request.input("updatedBy", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE security.roles SET name=@name,active=@active,
        domain_task_visibility=@domainVisibility,database_task_visibility=@databaseVisibility,
        updated_at=@updatedAt,updated_by=@updatedBy
      WHERE role_id=@roleId;
    `);
    await replaceRolePermissions(transaction, record.id, record.permissions, actor.id, now);
    const after = await readLockedRole(transaction, record.id);
    if (!after) throw new Error("El rol SQL desapareció durante la actualización.");
    await writeSqlAuditLog(transaction, {
      entityType: "role", entityId: record.id, action: "role_updated",
      performedBy: actor.id, performedByEmail: actor.email, before, after,
    });
    return after;
  });
}

export async function deleteSqlRole(roleId: string, actor: Actor): Promise<RoleDefinitionRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const before = await readLockedRole(transaction, roleId);
    if (!before) return null;
    if (before.system || before.protected) {
      throw Object.assign(new Error("Los roles predeterminados no se pueden eliminar."), { status: 400 });
    }
    const usageRequest = new sql.Request(transaction);
    usageRequest.input("roleId", sql.NVarChar(80), roleId);
    const usageResult = await usageRequest.query<{ users: number; active_schedules: number; open_tasks: number }>(`
      SELECT
        (SELECT COUNT_BIG(*) FROM security.user_roles WITH (UPDLOCK,HOLDLOCK) WHERE role_id=@roleId) AS users,
        (SELECT COUNT_BIG(*) FROM scheduling.update_schedules WITH (UPDLOCK,HOLDLOCK)
          WHERE active=1 AND deleted_at IS NULL AND @roleId IN (assigned_role,domain_assigned_role,database_assigned_role)) AS active_schedules,
        (SELECT COUNT_BIG(*) FROM workflow.update_tasks WITH (UPDLOCK,HOLDLOCK)
          WHERE assigned_role=@roleId AND status NOT IN ('completed','cancelled')) AS open_tasks;
    `);
    const row = usageResult.recordset[0];
    const usage = { users: Number(row?.users ?? 0), activeSchedules: Number(row?.active_schedules ?? 0), openTasks: Number(row?.open_tasks ?? 0) };
    if (usage.users + usage.activeSchedules + usage.openTasks > 0) {
      throw Object.assign(new Error("El rol todavía tiene referencias activas."), { status: 409, usage: { ...usage, hasReferences: true } });
    }
    const remove = new sql.Request(transaction);
    remove.input("roleId", sql.NVarChar(80), roleId);
    await remove.query("DELETE security.role_permissions WHERE role_id=@roleId; DELETE security.roles WHERE role_id=@roleId;");
    await writeSqlAuditLog(transaction, {
      entityType: "role", entityId: roleId, action: "role_deleted",
      performedBy: actor.id, performedByEmail: actor.email, before,
    });
    return before;
  });
}
