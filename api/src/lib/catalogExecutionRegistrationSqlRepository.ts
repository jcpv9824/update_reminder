import { createHash } from "node:crypto";
import sql from "mssql";
import type { UpdateTask } from "../types/models";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { catalogAssignedUsers, catalogAssignmentIdentity, catalogTaskExecutionKey, type CatalogTaskAssignment, type CatalogTaskPlan } from "./catalogTaskTargetPlanning";
import { runSqlTransaction } from "./sqlTransaction";
import { rootScheduleId } from "./taskGenerator";
import { insertSqlGeneratedTaskInTransaction } from "./workflowTaskGenerationSqlRepository";
import { lockCatalogTaskDay } from "./catalogExecutionCoexistenceSql";
import { catalogDomainRouteFingerprintSql } from "./catalogPhysicalTargetIdentity";

type PlannedGroup = CatalogTaskPlan["tasks"][number];
type SqlKey = number | string;
type OriginKind = "normal" | "special" | "licensing";
type Link = { linkId: string; clientId: string; domainId: string; databaseId: string | null;
  catalogSourceId: string | null; recordId: string; environment: string };
type Attachment = { linkId: string; scheduleId: string };

/** Trusted input from the verified planner; never deserialize this contract from HTTP. */
export type CatalogExecutionRegistration = Readonly<{
  group: PlannedGroup;
  task: UpdateTask;
  cutoffAt: Date;
  portalEnvironment: CatalogEnvironment;
  /** Parent schedule ROWVERSIONs captured with their normalized scope and assignment. */
  scheduleVersions: ReadonlyMap<string, string>;
  /** An explicit null means local reconciliation. Missing entries are not local evidence. */
  catalogSourceIdsByLink: ReadonlyMap<string, string | null>;
}>;

type Conflict = "invalid-plan" | "cutoff-passed" | "legacy-task-collision" | "execution-conflict"
  | "source-set-changed" | "retired" | "catalog-reference-changed" | "workflow-assignment-required" | "coexistence-lock-unavailable";

export type CatalogExecutionRegistrationResult = { status: "registered" | "existing"; taskId: string }
  | { status: "conflict"; reason: Conflict };

class RegistrationConflict extends Error {
  constructor(readonly reason: Conflict) { super(reason); }
}
const conflict = (reason: Conflict): never => { throw new RegistrationConflict(reason); };
const safeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/\p{Cc}/u.test(value);
const sourceIdFormat = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;
const identity = (link: Link) => JSON.stringify([link.linkId, link.clientId, link.domainId, link.databaseId,
  link.recordId, link.environment, link.catalogSourceId?.toLowerCase() ?? null]);
const pair = (linkId: string, scheduleId: string) => JSON.stringify([linkId, scheduleId]);
const sameAssignment = (left: CatalogTaskAssignment, right: CatalogTaskAssignment) =>
  catalogAssignmentIdentity(left) === catalogAssignmentIdentity(right);

function assignmentMatches(assignment: CatalogTaskAssignment, role: string | null, users: readonly string[]): boolean {
  if (assignment.kind === "user" || assignment.kind === "users") {
    const expected = catalogAssignedUsers(assignment);
    return expected.length > 0 && expected.length === users.length && new Set(users).size === users.length
      && expected.every(user => users.includes(user));
  }
  if (assignment.kind === "role") return users.length === 0 && role === assignment.id;
  return assignment.kind === "unassigned" && users.length === 0 && !role;
}

function parseInput(input: CatalogExecutionRegistration) {
  const { group, task, cutoffAt, portalEnvironment } = input;
  // The legacy workflow schema requires a real assigned_role FK even for explicitly assigned users.
  if (group.assignment.kind === "unassigned") return conflict("workflow-assignment-required");
  if ((group.kind !== "domain" && group.kind !== "database") ||
      !safeText(group.occurrenceId, 200) || !sourceIdFormat.test(group.targetId) || !safeText(group.revisionId, 200) ||
      !safeText(group.operationId, 200) || group.executionKey !== catalogTaskExecutionKey(group.occurrenceId, group.kind, group.targetId) ||
      !(cutoffAt instanceof Date) || !Number.isFinite(cutoffAt.valueOf()) ||
      (portalEnvironment !== "production" && portalEnvironment !== "qa") || group.sources.length === 0 || group.sources.length > 512 ||
      !safeText(task.id, 260) || !safeText(task.clientId, 150) || !safeText(task.domainId, 150) || !safeText(task.targetId, 150) ||
      !safeText(task.taskBucket, 100) || !safeText(task.clientName, 200) || !safeText(task.domainName, 500) || !safeText(task.targetName, 240) ||
      !day.test(task.taskDate) || !Number.isFinite(Date.parse(task.taskDate)) || new Date(task.taskDate).toISOString().slice(0, 10) !== task.taskDate ||
      group.occurrenceId !== task.taskDate ||
      task.targetType !== group.kind || task.status !== "pending" || task.result != null || !!task.notes || task.completedAt != null ||
      !safeText(task.assignedRole, 80) || (group.assignment.kind === "role" ? !safeText(group.assignment.id, 80)
        : task.assignedUserIds.length > 100 || catalogAssignedUsers(group.assignment).some(user => !safeText(user, 150))) ||
      !assignmentMatches(group.assignment, task.assignedRole, task.assignedUserIds ?? [])) return conflict("invalid-plan");

  const root = rootScheduleId(task.rootScheduleId || task.scheduleId);
  if (!safeText(root, 150) || rootScheduleId(task.scheduleId) !== root) return conflict("invalid-plan");
  const links = new Map<string, Link>();
  const attachments = new Map<string, Attachment>();
  let representative = false;
  for (const source of group.sources) {
    const { link, operationId, assignment, scheduleId } = source;
    if (operationId !== group.operationId || !sameAssignment(group.assignment, assignment) ||
        !safeText(scheduleId, 150) || rootScheduleId(scheduleId) !== scheduleId || !safeText(link.linkId, 260) ||
        link.kind !== group.kind || link.state !== "active" || link.target.status !== "verified" || link.target.id !== group.targetId ||
        !safeText(link.customerId, 150) || !safeText(link.domainId, 150) || !safeText(link.catalogRecordId, 260) ||
        !["production", "test", "demo"].includes(link.environment) ||
        (link.kind === "database" ? !safeText(link.databaseId, 150) : link.databaseId !== undefined)) return conflict("invalid-plan");
    const catalogSourceId = input.catalogSourceIdsByLink.get(link.linkId);
    if (catalogSourceId !== null && (catalogSourceId === undefined || !sourceIdFormat.test(catalogSourceId))) return conflict("invalid-plan");
    const record: Link = { linkId: link.linkId, clientId: link.customerId, domainId: link.domainId,
      databaseId: link.databaseId ?? null, environment: link.environment, recordId: link.catalogRecordId, catalogSourceId };
    const previous = links.get(link.linkId);
    if (previous && identity(previous) !== identity(record)) return conflict("invalid-plan");
    links.set(link.linkId, record);
    attachments.set(pair(link.linkId, scheduleId), { linkId: link.linkId, scheduleId });
    if (root === scheduleId && task.clientId === link.customerId && task.domainId === link.domainId &&
        task.targetId === (link.databaseId ?? link.domainId)) representative = true;
  }
  if (!representative || links.size !== input.catalogSourceIdsByLink.size) return conflict("invalid-plan");
  const schedules = [...new Set([...attachments.values()].map(item => item.scheduleId))].sort();
  if (input.scheduleVersions.size !== schedules.length || schedules.some(id =>
    !/^[a-f0-9]{16}$/.test(input.scheduleVersions.get(id) ?? ""))) return conflict("invalid-plan");
  return { root, links, attachments, schedules,
    targetIds: [...new Set([...links.values()].map(item => item.databaseId ?? item.domainId))].sort() };
}

type ExecutionRow = { executionId: SqlKey; taskId: string; operationId: string; occurrenceId: string;
  targetId: string; kind: string; status: string; taskDate: string; cutoffAt: Date; retiredAt: Date | null;
  representativeTarget: string; representativeClient: string; representativeDomain: string; primaryScheduleId: string;
  assignedRole: string | null; usersJson: string };

async function lockExecution(transaction: sql.Transaction, executionKey: Buffer): Promise<ExecutionRow | undefined> {
  const rows = await new sql.Request(transaction).input("executionKey", sql.VarBinary(32), executionKey).query<ExecutionRow>(`
    SELECT e.catalog_execution_key AS executionId, t.source_id AS taskId, e.operation_id AS operationId,
      e.occurrence_id AS occurrenceId, e.verified_target_id AS targetId, e.execution_kind AS kind,
      CONVERT(char(10),t.task_date,23) AS taskDate, e.cutoff_at AS cutoffAt, e.retired_at AS retiredAt, t.status,
      t.target_source_id AS representativeTarget, t.client_source_id AS representativeClient,
      t.domain_source_id AS representativeDomain, t.primary_schedule_source_id AS primaryScheduleId,
      t.assigned_role AS assignedRole,
      (SELECT u.source_id AS id FROM workflow.task_assignees AS a JOIN security.users AS u ON u.user_key=a.user_key
       WHERE a.task_key=t.task_key ORDER BY u.source_id FOR JSON PATH) AS usersJson
    FROM workflow.catalog_task_executions AS e WITH (UPDLOCK,HOLDLOCK)
    JOIN workflow.update_tasks AS t WITH (UPDLOCK,HOLDLOCK) ON t.task_key=e.task_key
    WHERE e.execution_key=CONVERT(binary(32),@executionKey);`);
  return rows.recordset[0];
}

async function verifyReplay(transaction: sql.Transaction, input: CatalogExecutionRegistration, row: ExecutionRow,
  planned: ReturnType<typeof parseInput>): Promise<void> {
  const { group, task, cutoffAt } = input;
  if (row.retiredAt !== null || row.status === "cancelled") return conflict("retired");
  const users = JSON.parse(row.usersJson || "[]") as { id: string }[];
  if (row.taskId !== task.id || row.occurrenceId !== group.occurrenceId || row.operationId !== group.operationId ||
      row.targetId !== group.targetId || row.kind !== group.kind || row.taskDate !== task.taskDate || row.cutoffAt.valueOf() !== cutoffAt.valueOf() ||
      row.representativeTarget !== task.targetId || row.representativeClient !== task.clientId || row.representativeDomain !== task.domainId ||
      row.primaryScheduleId !== planned.root || row.assignedRole !== task.assignedRole ||
      !assignmentMatches(group.assignment, row.assignedRole, users.map(user => user.id))) {
    return conflict("execution-conflict");
  }
  const result = await new sql.Request(transaction).input("executionId", sql.BigInt, row.executionId)
    .query<Link & { scheduleId: string | null; detachedAt: Date | null; state: string }>(`
      SELECT l.link_id AS linkId, c.source_id AS clientId, d.source_id AS domainId, db.source_id AS databaseId,
        CONVERT(char(36),b.source_id) AS catalogSourceId, l.catalog_record_id AS recordId, l.link_environment AS environment,
        s.source_id AS scheduleId, ls.detached_at AS detachedAt, l.link_state AS state
      FROM workflow.catalog_task_execution_links AS l WITH (HOLDLOCK)
      JOIN core.clients AS c ON c.client_key=l.client_key
      JOIN core.domains AS d ON d.domain_key=l.domain_key
      LEFT JOIN core.databases AS db ON db.database_key=l.database_key
      LEFT JOIN settings.catalog_source_bindings AS b ON b.catalog_source_key=l.catalog_source_key
      LEFT JOIN workflow.catalog_task_execution_sources AS ls WITH (HOLDLOCK) ON ls.catalog_execution_link_key=l.catalog_execution_link_key
      LEFT JOIN scheduling.update_schedules AS s ON s.schedule_key=ls.schedule_key
      WHERE l.catalog_execution_key=@executionId;`);
  const seenLinks = new Set<string>();
  const seenAttachments = new Set<string>();
  for (const record of result.recordset) {
    const expected = planned.links.get(record.linkId);
    if (!expected || identity(record) !== identity(expected) || !record.scheduleId || record.detachedAt !== null || record.state === "retired") {
      return conflict("source-set-changed");
    }
    const key = pair(record.linkId, record.scheduleId);
    if (!planned.attachments.has(key)) return conflict("source-set-changed");
    seenLinks.add(record.linkId);
    seenAttachments.add(key);
  }
  if (seenLinks.size !== planned.links.size || seenAttachments.size !== planned.attachments.size) return conflict("source-set-changed");
}

/** One atomic registration; this never adopts legacy work, edits existing assignments or revives an occurrence. */
export async function registerSqlCatalogTaskExecution(input: CatalogExecutionRegistration): Promise<CatalogExecutionRegistrationResult> {
  try {
    const planned = parseInput(input);
    const { group, task, cutoffAt, portalEnvironment } = input;
    const executionKey = Buffer.from(group.executionKey, "hex");
    return await runSqlTransaction(async transaction => {
      if (!await lockCatalogTaskDay(transaction, task)) return conflict("coexistence-lock-unavailable");
      const existing = await lockExecution(transaction, executionKey);
      if (existing) {
        await verifyReplay(transaction, input, existing, planned);
        return { status: "existing", taskId: existing.taskId };
      }

      const collision = await new sql.Request(transaction)
        .input("taskId", sql.NVarChar(260), task.id).input("kind", sql.VarChar(20), group.kind)
        .input("physicalId", sql.NVarChar(150), group.targetId)
        .input("taskDate", sql.Date, task.taskDate).input("targetIds", sql.NVarChar(sql.MAX), JSON.stringify(planned.targetIds))
        .query<{ collision: boolean }>(`
          SELECT CONVERT(bit, CASE WHEN EXISTS (
            SELECT 1 FROM workflow.update_tasks WITH (UPDLOCK,HOLDLOCK) WHERE source_id=@taskId
          ) OR EXISTS (
            SELECT 1 FROM workflow.catalog_task_executions AS e WITH (UPDLOCK,HOLDLOCK)
            JOIN workflow.update_tasks AS t ON t.task_key=e.task_key
            WHERE e.execution_kind=@kind AND e.verified_target_id=@physicalId AND t.task_date=@taskDate
          ) OR EXISTS (
            SELECT 1 FROM workflow.task_source_aliases WITH (UPDLOCK,HOLDLOCK) WHERE alias_source_id=@taskId
          ) OR EXISTS (
            SELECT 1 FROM OPENJSON(@targetIds) WITH (target_id nvarchar(150) '$') AS ids
            JOIN workflow.update_tasks AS t WITH (UPDLOCK,HOLDLOCK)
              ON t.target_type=@kind AND t.target_source_id=ids.target_id AND t.task_date=@taskDate
          ) THEN 1 ELSE 0 END) AS collision;`);
      if (collision.recordset[0]?.collision !== false) return conflict("legacy-task-collision");

      const schedules = await new sql.Request(transaction)
        .input("workflowRole", sql.NVarChar(80), task.assignedRole)
        .input("assignmentKind", sql.VarChar(10), group.assignment.kind === "role" ? "role" : "user")
        .input("targetKind", sql.VarChar(20), group.kind)
        .input("schedules", sql.NVarChar(sql.MAX), JSON.stringify(planned.schedules.map(id =>
          ({ id, version: input.scheduleVersions.get(id) }))))
        .query<{ scheduleId: string; scheduleKey: SqlKey; origin: OriginKind }>(`
          SELECT s.source_id AS scheduleId, s.schedule_key AS scheduleKey,
            CASE WHEN s.origin='licensing' THEN 'licensing' WHEN s.origin='special' THEN 'special' ELSE 'normal' END AS origin
          FROM OPENJSON(@schedules) WITH (schedule_id nvarchar(150) '$.id', expected_version char(16) '$.version') AS ids
          JOIN scheduling.update_schedules AS s WITH (UPDLOCK,HOLDLOCK) ON s.source_id=ids.schedule_id
            AND s.row_version=TRY_CONVERT(binary(8),ids.expected_version,2)
          WHERE s.active=1 AND s.deleted_at IS NULL AND EXISTS (
            SELECT 1 FROM security.roles AS task_role WHERE task_role.role_id=@workflowRole
              AND task_role.role_id COLLATE Latin1_General_100_BIN2=@workflowRole COLLATE Latin1_General_100_BIN2 AND task_role.active=1
              AND (@assignmentKind='user' OR task_role.role_id=N'super_admin' OR (
                CASE WHEN @targetKind='database' THEN task_role.database_task_visibility ELSE task_role.domain_task_visibility END IN ('assigned','all')
                AND EXISTS (SELECT 1 FROM security.role_permissions grant_row
                  JOIN security.permissions permission ON permission.permission_key=grant_row.permission_key AND permission.active=1
                  WHERE grant_row.role_id=task_role.role_id AND grant_row.permission_key=N'updates.tasks.view')
              ))
          );`);
      const bySchedule = new Map(schedules.recordset.map(row => [row.scheduleId, row]));
      if (bySchedule.size !== planned.schedules.length || planned.schedules.some(id => !bySchedule.has(id))) return conflict("catalog-reference-changed");

      const now = await new sql.Request(transaction).input("cutoffAt", sql.DateTime2(3), cutoffAt)
        .query<{ now: Date }>("SELECT SYSUTCDATETIME() AS now WHERE SYSUTCDATETIME()<@cutoffAt;");
      if (!now.recordset[0]) return conflict("cutoff-passed");
      const createdAt = now.recordset[0].now.toISOString();
      // The legacy representative remains a core identity, not the verified physical ID.
      // Copy only the fields generation needs; never persist arbitrary caller notes/extra data.
      const representative: UpdateTask = {
        id: task.id, dedupeKey: `catalog:${group.executionKey}`, taskDate: task.taskDate, taskBucket: task.taskBucket,
        clientId: task.clientId, clientName: task.clientName, domainId: task.domainId, domainName: task.domainName,
        targetType: group.kind, targetId: task.targetId, targetName: task.targetName, scheduleId: planned.root,
        rootScheduleId: planned.root, sources: [{ scheduleId: planned.root, scheduleType: bySchedule.get(planned.root)!.origin, createdAt }],
        assignedRole: task.assignedRole, assignedUserIds: task.assignedUserIds, status: "pending", result: null, notes: "",
        createdAt, updatedAt: createdAt, createdBy: "system", updatedBy: "system", completedAt: null, completedBy: null,
      };
      const taskKey = await insertSqlGeneratedTaskInTransaction(transaction, representative);
      const inserted = await new sql.Request(transaction).input("taskKey", sql.BigInt, taskKey)
        .input("executionKey", sql.VarBinary(32), executionKey).input("occurrence", sql.NVarChar(200), group.occurrenceId)
        .input("kind", sql.VarChar(20), group.kind).input("target", sql.NVarChar(260), group.targetId)
        .input("operation", sql.NVarChar(200), group.operationId).input("revision", sql.NVarChar(200), group.revisionId)
        .input("cutoff", sql.DateTime2(3), cutoffAt).query<{ key: SqlKey }>(`
          INSERT workflow.catalog_task_executions
            (task_key,execution_key,occurrence_id,execution_kind,verified_target_id,operation_id,initial_catalog_revision_id,cutoff_at)
          OUTPUT inserted.catalog_execution_key AS [key]
          SELECT @taskKey,CONVERT(binary(32),@executionKey),@occurrence,@kind,@target,@operation,@revision,@cutoff
          WHERE SYSUTCDATETIME()<@cutoff;`);
      const executionId = inserted.recordset[0]?.key;
      if (executionId === undefined) return conflict("cutoff-passed");

      const writes = await new sql.Request(transaction).input("executionId", sql.BigInt, executionId)
        .input("kind", sql.VarChar(20), group.kind).input("portalEnvironment", sql.VarChar(10), portalEnvironment)
        .input("physicalId", sql.UniqueIdentifier, group.targetId)
        .input("links", sql.NVarChar(sql.MAX), JSON.stringify([...planned.links.values()]))
        .query<{ linkId: string; validUntil: Date }>(`
          DECLARE @registryNow datetime2(3)=SYSUTCDATETIME();
          DECLARE @accepted TABLE (
            linkId nvarchar(260) COLLATE Latin1_General_100_BIN2 PRIMARY KEY, catalogSourceKey bigint NULL,
            recordId nvarchar(260) NOT NULL, clientKey bigint NOT NULL, domainKey bigint NOT NULL,
            databaseKey bigint NULL, environment varchar(20) NOT NULL, validUntil datetime2(3) NOT NULL
          );
          INSERT @accepted
          SELECT r.linkId,b.catalog_source_key,r.recordId,c.client_key,d.domain_key,db.database_key,r.environment,
            CASE WHEN revision.verified_until<pt.valid_until THEN revision.verified_until ELSE pt.valid_until END
          FROM OPENJSON(@links) WITH (
            linkId nvarchar(260), clientId nvarchar(150), domainId nvarchar(150), databaseId nvarchar(150),
            catalogSourceId uniqueidentifier, recordId nvarchar(260), environment varchar(20)
          ) AS r
          JOIN core.clients AS c ON c.source_id=r.clientId AND c.status='active'
            AND c.source_id COLLATE Latin1_General_100_BIN2=r.clientId COLLATE Latin1_General_100_BIN2
          JOIN core.domains AS d ON d.source_id=r.domainId AND d.client_key=c.client_key AND d.status='active'
            AND d.source_id COLLATE Latin1_General_100_BIN2=r.domainId COLLATE Latin1_General_100_BIN2
          LEFT JOIN core.databases AS db ON @kind='database' AND db.source_id=r.databaseId
            AND db.client_key=c.client_key AND db.domain_key=d.domain_key AND db.status='active'
            AND db.source_id COLLATE Latin1_General_100_BIN2=r.databaseId COLLATE Latin1_General_100_BIN2
          LEFT JOIN core.database_access_profiles AS ap ON ap.access_profile_key=db.access_profile_key AND ap.active=1
          JOIN core.catalog_physical_target_links AS pt WITH (UPDLOCK,HOLDLOCK)
            ON pt.portal_environment=@portalEnvironment AND pt.target_kind=@kind
            AND pt.client_key=c.client_key AND pt.domain_key=d.domain_key AND pt.retired_at IS NULL
            AND pt.verified_at<=@registryNow AND pt.valid_until>@registryNow
            AND ((@kind='domain' AND pt.database_key IS NULL AND d.environment_id=r.environment
                AND pt.domain_route_fingerprint=${catalogDomainRouteFingerprintSql})
              OR (@kind='database' AND pt.database_key=db.database_key AND db.environment_id=r.environment
                AND pt.access_profile_key=ap.access_profile_key AND pt.access_profile_version=ap.row_version))
          JOIN core.catalog_physical_targets AS target WITH (HOLDLOCK)
            ON target.physical_target_key=pt.physical_target_key AND target.target_id=@physicalId
            AND target.portal_environment=@portalEnvironment AND target.target_kind=@kind
            AND (@kind='domain' OR target.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),ap.initial_catalog)))
          LEFT JOIN settings.catalog_source_bindings AS b WITH (HOLDLOCK) ON b.source_id=r.catalogSourceId
            AND b.portal_environment=@portalEnvironment AND b.source_state='active' AND b.validated_at IS NOT NULL
          LEFT JOIN settings.external_database_connections AS p WITH (HOLDLOCK) ON p.external_database_connection_key=b.external_database_connection_key
            AND p.status='active' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
            AND b.validated_profile_version=p.row_version
          LEFT JOIN settings.catalog_customer_revision_heads AS h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
            AND h.attempt_status='succeeded' AND h.attempted_at<=@registryNow
          LEFT JOIN core.catalog_customer_source_revisions AS revision ON revision.revision_key=h.revision_key
            AND revision.catalog_source_key=b.catalog_source_key AND revision.source_role=b.source_role
            AND revision.binding_version=b.row_version AND revision.profile_version=p.row_version
            AND revision.sealed_at<=@registryNow AND revision.observed_at<=@registryNow AND revision.verified_until>@registryNow
          LEFT JOIN core.catalog_customer_revision_rows AS evidence ON evidence.revision_key=revision.revision_key
            AND evidence.source_record_id=TRY_CONVERT(int,r.recordId)
            AND CONVERT(nvarchar(11),evidence.source_record_id) COLLATE Latin1_General_100_BIN2=r.recordId COLLATE Latin1_General_100_BIN2
            AND DATALENGTH(CONVERT(nvarchar(11),evidence.source_record_id))=DATALENGTH(r.recordId)
          WHERE (@kind='domain' OR db.database_key IS NOT NULL)
            AND (r.catalogSourceId IS NULL OR (b.validated_at<=@registryNow AND evidence.source_record_id IS NOT NULL
              AND (b.source_role<>'erp-customers' OR evidence.active_code='S')));
          IF EXISTS(SELECT 1 FROM @accepted WHERE validUntil<=SYSUTCDATETIME())
          BEGIN
            SELECT linkId,validUntil FROM @accepted WHERE 1=0;
            RETURN;
          END;
          INSERT workflow.catalog_task_execution_links
            (catalog_execution_key,execution_kind,link_id,catalog_source_key,catalog_record_id,client_key,domain_key,database_key,link_environment)
          SELECT @executionId,@kind,linkId,catalogSourceKey,recordId,clientKey,domainKey,databaseKey,environment
          FROM @accepted;
          SELECT linkId,validUntil FROM @accepted;`);
      if (writes.recordset.length !== planned.links.size || writes.recordset.some(link => !planned.links.has(link.linkId))) {
        return conflict("catalog-reference-changed");
      }
      const deadlines = writes.recordset.map(link => link.validUntil instanceof Date ? link.validUntil.valueOf() : NaN);
      if (deadlines.some(value => !Number.isFinite(value))) return conflict("catalog-reference-changed");
      const evidenceValidUntil = new Date(Math.min(...deadlines));

      const attached = await new sql.Request(transaction).input("executionId", sql.BigInt, executionId)
        .input("attachments", sql.NVarChar(sql.MAX), JSON.stringify([...planned.attachments.values()]))
        .query<{ count: number }>(`
          INSERT workflow.catalog_task_execution_sources(catalog_execution_link_key,schedule_key)
          SELECT l.catalog_execution_link_key,s.schedule_key
          FROM OPENJSON(@attachments) WITH (linkId nvarchar(260), scheduleId nvarchar(150)) AS r
          JOIN workflow.catalog_task_execution_links AS l ON l.catalog_execution_key=@executionId
            AND l.link_id=r.linkId COLLATE Latin1_General_100_BIN2
          JOIN scheduling.update_schedules AS s ON s.source_id=r.scheduleId AND s.active=1 AND s.deleted_at IS NULL;
          SELECT @@ROWCOUNT AS [count];`);
      if (attached.recordset[0]?.count !== planned.attachments.size) return conflict("catalog-reference-changed");

      const origins = schedules.recordset.filter(row => row.scheduleId !== planned.root)
        .map(row => ({ key: String(row.scheduleKey), origin: row.origin }));
      if (origins.length) {
        const recorded = await new sql.Request(transaction).input("taskKey", sql.BigInt, taskKey)
          .input("createdAt", sql.DateTime2(3), now.recordset[0].now)
          .input("origins", sql.NVarChar(sql.MAX), JSON.stringify(origins)).query<{ count: number }>(`
            INSERT workflow.task_sources(task_key,schedule_source_id,schedule_key,schedule_type,reason,created_at,is_primary)
            SELECT @taskKey,s.source_id,s.schedule_key,r.origin,N'generated',@createdAt,0
            FROM OPENJSON(@origins) WITH ([key] bigint, origin nvarchar(80)) AS r
            JOIN scheduling.update_schedules AS s ON s.schedule_key=r.[key] AND s.active=1 AND s.deleted_at IS NULL;
            SELECT @@ROWCOUNT AS [count];`);
        if (recorded.recordset[0]?.count !== origins.length) return conflict("catalog-reference-changed");
      }

      const eventToken = createHash("sha256").update(`catalog-task-registered-v1:${group.executionKey}`, "utf8").digest();
      const event = await new sql.Request(transaction).input("executionId", sql.BigInt, executionId)
        .input("cutoffAt", sql.DateTime2(3), cutoffAt).input("validUntil", sql.DateTime2(3), evidenceValidUntil)
        .input("token", sql.VarBinary(32), eventToken).query<{ result: string }>(`
          INSERT workflow.catalog_task_execution_events(catalog_execution_key,event_token,event_kind)
          VALUES(@executionId,CONVERT(binary(32),@token),'registered');
          DECLARE @finalNow datetime2(3)=SYSUTCDATETIME();
          SELECT CASE WHEN @finalNow>=@cutoffAt THEN 'cutoff-passed'
            WHEN @finalNow>=@validUntil THEN 'catalog-reference-changed' ELSE 'registered' END AS result;`);
      const result = event.recordset[0]?.result;
      if (result === "cutoff-passed") return conflict("cutoff-passed");
      if (result !== "registered") return conflict("catalog-reference-changed");
      return { status: "registered", taskId: task.id };
    });
  } catch (error) {
    // Only the known business guard is translated; SQL uniqueness/errors roll back and remain failures.
    if (error instanceof RegistrationConflict) return { status: "conflict", reason: error.reason };
    throw error;
  }
}
