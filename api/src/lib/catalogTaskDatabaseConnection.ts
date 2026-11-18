import sql from "mssql";
import type { CurrentUser } from "../types/models";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";
import { getSecret } from "./keyVault";

export type TaskConnectionPart = "serverHostPort" | "initialCatalog" | "userId" | "password";
type RequestAction = { kind: "view" | "reveal" } | { kind: "copy"; part: TaskConnectionPart };
type GrantInput = { databaseId: string; taskId: string; actor: CurrentUser; environment: CatalogEnvironment; action: RequestAction };
type Grant = { serverHostPort: string; initialCatalog: string; userId: string; secretName: string | null;
  databaseId: string; taskId: string; linkId: string | null; profileVersion: string; linkVersion: string | null;
  executionVersion: string | null; catalogSourceId: string | null; catalogRevisionId: string | null;
  catalogBindingVersion: string | null; catalogProfileVersion: string | null; catalogVerifiedUntil: Date | null; };
const permission = (action: RequestAction) => action.kind === "view" ? "updates.tasks.view_database_connection"
  : action.kind === "reveal" || (action.kind === "copy" && action.part === "password") ? "updates.tasks.reveal_database_password"
  : "updates.tasks.copy_database_connection_part";

const grantQuery = `
DECLARE @now datetime2(3)=SYSUTCDATETIME();
WITH actor AS (
  SELECT user_key FROM security.users
  WHERE source_id=@actor AND source_id COLLATE Latin1_General_100_BIN2=@actor COLLATE Latin1_General_100_BIN2 AND active=1
), roles AS (
  SELECT r.role_id,r.database_task_visibility FROM actor a
  JOIN security.user_roles ur ON ur.user_key=a.user_key
  JOIN security.roles r ON r.role_id=ur.role_id AND r.active=1
), grants AS (
  SELECT permission.permission_key FROM roles r JOIN security.role_permissions rp ON rp.role_id=r.role_id
  JOIN security.permissions permission ON permission.permission_key=rp.permission_key AND permission.active=1
)
SELECT TOP(2) p.server_host_port AS serverHostPort,p.initial_catalog AS initialCatalog,p.sql_user_id AS userId,
  p.password_secret_name AS secretName,db.source_id AS databaseId,task.source_id AS taskId,l.link_id AS linkId,
  CONVERT(varchar(16),CONVERT(binary(8),p.row_version),2) AS profileVersion,
  CONVERT(varchar(16),CONVERT(binary(8),l.row_version),2) AS linkVersion,
  CONVERT(varchar(16),CONVERT(binary(8),e.row_version),2) AS executionVersion,
  LOWER(CONVERT(char(36),approved.catalog_source_id)) AS catalogSourceId,
  CONVERT(varchar(20),approved.revision_key) AS catalogRevisionId,
  CONVERT(varchar(16),CONVERT(binary(8),approved.binding_version),2) AS catalogBindingVersion,
  CONVERT(varchar(16),CONVERT(binary(8),approved.profile_version),2) AS catalogProfileVersion,
  approved.verified_until AS catalogVerifiedUntil
FROM actor a
JOIN workflow.update_tasks task ON task.source_id=@task AND task.source_id COLLATE Latin1_General_100_BIN2=@task COLLATE Latin1_General_100_BIN2
JOIN core.databases db ON db.source_id=@db AND db.source_id COLLATE Latin1_General_100_BIN2=@db COLLATE Latin1_General_100_BIN2
JOIN core.domains d ON d.domain_key=db.domain_key AND d.client_key=db.client_key AND d.status='active'
JOIN core.clients c ON c.client_key=db.client_key AND c.status='active'
JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key AND p.active=1
LEFT JOIN workflow.catalog_task_executions e ON e.task_key=task.task_key
LEFT JOIN workflow.catalog_task_execution_links l ON l.catalog_execution_key=e.catalog_execution_key
  AND l.database_key=db.database_key AND l.domain_key=db.domain_key AND l.client_key=db.client_key
  AND l.link_environment=db.environment_id AND l.link_state='active' AND l.retired_at IS NULL
OUTER APPLY (
  SELECT bridge.catalog_source_id,bridge.revision_key,bridge.binding_version,bridge.profile_version,bridge.verified_until
  FROM core.catalog_operational_link_evidence AS bridge
  WHERE l.catalog_source_key IS NOT NULL
    AND bridge.link_id=TRY_CONVERT(uniqueidentifier,l.link_id) AND DATALENGTH(l.link_id)=72
    AND bridge.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(bridge.portal_environment)=DATALENGTH(@environment)
    AND bridge.client_key=l.client_key AND bridge.domain_key=l.domain_key AND bridge.database_key=l.database_key
    AND bridge.target_kind='database'
    AND bridge.link_environment COLLATE Latin1_General_100_BIN2=l.link_environment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(bridge.link_environment)=DATALENGTH(l.link_environment)
    AND bridge.catalog_source_key=l.catalog_source_key
    AND bridge.source_record_id=TRY_CONVERT(int,l.catalog_record_id)
    AND CONVERT(nvarchar(11),bridge.source_record_id) COLLATE Latin1_General_100_BIN2=l.catalog_record_id COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(CONVERT(nvarchar(11),bridge.source_record_id))=DATALENGTH(l.catalog_record_id)
    AND bridge.retired_at IS NULL AND bridge.owner_retired_at IS NULL
    AND bridge.evidence_state='verified' AND bridge.verified_until>@now
) AS approved
WHERE task.target_type='database' AND task.status IN ('pending','in_progress','failed','blocked','reopened') AND db.status='active'
  AND (EXISTS(SELECT 1 FROM workflow.task_assignees WHERE task_key=task.task_key AND user_key=a.user_key)
    OR (NOT EXISTS(SELECT 1 FROM workflow.task_assignees WHERE task_key=task.task_key)
      AND EXISTS(SELECT 1 FROM roles WHERE role_id=task.assigned_role)))
  AND (EXISTS(SELECT 1 FROM roles WHERE role_id=N'super_admin') OR (
    EXISTS(SELECT 1 FROM roles WHERE database_task_visibility IN ('assigned','all'))
    AND EXISTS(SELECT 1 FROM grants WHERE permission_key=N'updates.tasks.view')
    AND EXISTS(SELECT 1 FROM grants WHERE permission_key=@permission)))
  AND ((e.catalog_execution_key IS NULL AND task.database_key=db.database_key AND task.domain_key=db.domain_key AND task.client_key=db.client_key)
    OR (e.retired_at IS NULL AND l.catalog_execution_link_key IS NOT NULL AND (e.cutoff_at>@now OR e.cutoff_evaluated_at IS NOT NULL)
      AND l.catalog_execution_link_key=(SELECT TOP(1) visible_link.catalog_execution_link_key
        FROM workflow.catalog_task_execution_links AS visible_link
        WHERE visible_link.catalog_execution_key=e.catalog_execution_key AND visible_link.link_state='active' AND visible_link.retired_at IS NULL
        ORDER BY CASE WHEN visible_link.database_key=task.database_key AND visible_link.client_key=task.client_key
          AND visible_link.domain_key=task.domain_key THEN 0 ELSE 1 END,visible_link.catalog_execution_link_key)
      AND ((l.catalog_source_key IS NULL AND NOT EXISTS (
        SELECT 1 FROM core.catalog_operational_links AS knownExternal
        WHERE knownExternal.link_id=TRY_CONVERT(uniqueidentifier,l.link_id)
      )) OR (approved.revision_key IS NOT NULL AND EXISTS(SELECT 1 FROM settings.catalog_source_bindings b
        JOIN settings.external_database_connections bp ON bp.external_database_connection_key=b.external_database_connection_key
        JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key AND h.attempt_status='succeeded'
        JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
        JOIN core.catalog_customer_revision_rows evidence ON evidence.revision_key=r.revision_key
          AND evidence.source_record_id=TRY_CONVERT(int,l.catalog_record_id)
          AND CONVERT(nvarchar(11),evidence.source_record_id) COLLATE Latin1_General_100_BIN2=l.catalog_record_id
          AND DATALENGTH(CONVERT(nvarchar(11),evidence.source_record_id))=DATALENGTH(l.catalog_record_id)
        WHERE b.catalog_source_key=l.catalog_source_key AND b.portal_environment=@environment AND b.source_state='active'
          AND b.validated_at<=@now AND b.validated_profile_version=bp.row_version
          AND r.binding_version=b.row_version AND r.profile_version=bp.row_version AND r.source_role=b.source_role
          AND h.attempted_at<=@now AND r.sealed_at<=@now AND r.observed_at<=@now AND r.verified_until>@now
          AND (b.source_role<>'erp-customers' OR evidence.active_code='S')
          AND bp.active=1 AND bp.status='active' AND bp.encrypt_connection=1 AND bp.password_configured=1)))
      AND EXISTS(SELECT 1 FROM core.catalog_physical_target_links tlink
        JOIN core.catalog_physical_targets t ON t.physical_target_key=tlink.physical_target_key
          AND t.portal_environment=@environment AND t.target_kind='database' AND t.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id)
        WHERE tlink.portal_environment=@environment AND tlink.target_kind='database' AND tlink.client_key=db.client_key
          AND tlink.domain_key=db.domain_key AND tlink.database_key=db.database_key AND tlink.retired_at IS NULL
          AND tlink.verified_at<=@now AND tlink.valid_until>@now
          AND tlink.access_profile_key=p.access_profile_key AND tlink.access_profile_version=p.row_version
          AND t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.initial_catalog)))));
`;

async function readGrant(transaction: sql.Transaction, input: GrantInput): Promise<Grant | null> {
  const rows = await transaction.request().input("task", sql.NVarChar(260), input.taskId)
    .input("db", sql.NVarChar(150), input.databaseId).input("actor", sql.NVarChar(150), input.actor.id)
    .input("environment", sql.VarChar(10), input.environment).input("permission", sql.NVarChar(160), permission(input.action))
    .query<Grant>(grantQuery);
  return rows.recordset.length === 1 ? rows.recordset[0] : null;
}

const defaultIo = { transaction: runSqlTransaction, read: readGrant, audit: writeSqlAuditLog, secret: getSecret };
const stamp = (grant: Grant) => JSON.stringify([grant.databaseId, grant.taskId, grant.linkId, grant.profileVersion,
  grant.linkVersion, grant.executionVersion, grant.secretName, grant.catalogSourceId, grant.catalogRevisionId,
  grant.catalogBindingVersion, grant.catalogProfileVersion, grant.catalogVerifiedUntil]);

// Thrown inside the transaction so a revoked/expired grant also rolls back its
// staged disclosure audit. Only this private sentinel becomes a denied result.
class GrantInvalidatedDuringAudit extends Error {}

export async function readAuditedTaskDatabaseConnection(input: GrantInput, io = defaultIo) {
  const { action } = input;
  const needsPassword = action.kind === "reveal" || (action.kind === "copy" && action.part === "password");
  const before = needsPassword ? await io.transaction(tx => io.read(tx, input)) : null;
  if (needsPassword && !before?.secretName) return null;
  const value = before?.secretName ? await io.secret(before.secretName, AbortSignal.timeout(5_000)) : null;
  if (needsPassword && !value) return null;
  return io.transaction(async tx => {
    const row = await io.read(tx, input);
    if (!row || (before && stamp(before) !== stamp(row))) return null;
    await io.audit(tx, { entityType: "task", entityId: row.taskId,
      performedBy: input.actor.id, performedByEmail: input.actor.email,
      action: action.kind === "view" ? "task_database_connection_opened" : action.kind === "reveal"
        ? "task_database_password_revealed" : "task_database_connection_copied",
      metadata: { databaseId: row.databaseId, ...(row.linkId ? { linkId: row.linkId } : {}),
        ...(action.kind === "copy" ? { part: action.part } : {}) } });
    // Auditing can await SQL locks/I/O long enough for time-based evidence to expire.
    // Re-run the server-clock grant check before disclosure, in the same transaction.
    const final = await io.read(tx, input);
    if (!final || stamp(final) !== stamp(row)) throw new GrantInvalidatedDuringAudit();
    if (needsPassword) return { kind: "password" as const, value: value! };
    if (action.kind === "copy") {
      const part = action.part;
      if (part === "password") return null;
      return { kind: "part" as const, part, value: row[part] };
    }
    return { kind: "info" as const, info: { server: row.serverHostPort, databaseName: row.initialCatalog,
      user: row.userId, hasPassword: !!row.secretName } };
  }).catch(error => {
    if (error instanceof GrantInvalidatedDuringAudit) return null;
    throw error;
  });
}
