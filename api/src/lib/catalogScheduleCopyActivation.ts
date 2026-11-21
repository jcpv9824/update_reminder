import sql from "mssql";
import type { UpdateSchedule } from "../types/models";
import type { CatalogScheduleDay, CatalogScheduleRule } from "./catalogScheduleDay";
import type { ScheduleConflictCandidate } from "./catalogScheduleConflictSelection";
import { catalogAssignedUsers, type CatalogTaskKind } from "./catalogTaskTargetPlanning";
import { writeCatalogScheduleActivationInTransaction } from "./catalogScheduleActivationSqlRepository";
import { readSqlCatalogScheduleOperationApprovalsInTransaction } from "./catalogScheduleOperationApprovalSqlRepository";

type VerifiedCopy = Readonly<{
  record: UpdateSchedule;
  definitionVersion: string;
  intentId: string;
  /** Must be read inside the same transaction, after the preview proofs. */
  certifiedAt: Date;
  proofValidUntil: Date;
  day: CatalogScheduleDay;
  expectedOperationId: string;
  selected: readonly ScheduleConflictCandidate[];
}>;
type ActivationReader = Parameters<typeof writeCatalogScheduleActivationInTransaction>[2];
const fail = (): never => { throw Object.assign(new Error("catalog_copy_activation_proof_unavailable"), { status: 409 }); };
const instant = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());

/** Finalize only a same-day copy with its own independent 044 operation approval. */
export async function activateApprovedSameDayCatalogCopyInTransaction(transaction: sql.Transaction, input: VerifiedCopy,
  io = { approve: readSqlCatalogScheduleOperationApprovalsInTransaction, write: writeCatalogScheduleActivationInTransaction }): Promise<void> {
  const { record, certifiedAt, proofValidUntil, day, selected, intentId } = input;
  const born = new Date(record.createdAt);
  const bogota = (at: Date) => new Date(at.valueOf() - 5 * 3_600_000).toISOString().slice(0, 10);
  if (!instant(certifiedAt) || !instant(born) || !instant(day.cutoffAt) || !instant(proofValidUntil) ||
      born < certifiedAt || born >= day.cutoffAt || born >= proofValidUntil ||
      bogota(born) !== day.date || record.startDate !== day.date || record.id !== `catalog-copy-${intentId}` ||
      !day.revision.complete || !selected.length || selected.length > 5000) return fail();
  const row = await transaction.request().input("id", sql.NVarChar(150), record.id)
    .input("intent", sql.UniqueIdentifier, intentId).input("environment", sql.VarChar(10), day.portalEnvironment)
    .input("date", sql.Date, day.date).input("operation", sql.NVarChar(200), input.expectedOperationId)
    .query<{ version: string; createdAt: Date; approvedAt: Date }>(`
      SELECT LOWER(CONVERT(char(16),CONVERT(binary(8),s.row_version),2)) AS version,s.created_at AS createdAt,
        approval.approved_at AS approvedAt
      FROM scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
      JOIN scheduling.catalog_schedule_copy_intents i WITH (HOLDLOCK) ON i.copy_schedule_key=s.schedule_key
      JOIN scheduling.catalog_schedule_operation_approvals approval WITH (HOLDLOCK)
        ON approval.schedule_key=s.schedule_key AND approval.schedule_version=s.row_version
        AND approval.operation_id=i.operation_id AND approval.portal_environment=i.portal_environment
      AND approval.retired_at IS NULL AND approval.approved_at BETWEEN i.created_at AND SYSUTCDATETIME()
      WHERE s.source_id=@id AND i.intent_id=@intent AND i.portal_environment=@environment
        AND i.operation_id=@operation
        AND s.active=1 AND s.deleted_at IS NULL AND s.catalog_activation_enabled=1
        AND s.start_date=@date AND s.timezone=N'America/Bogota';`);
  const current = row.recordset[0];
  if (row.recordset.length !== 1 || !current || !/^[0-9a-f]{16}$/.test(current.version) || current.version !== input.definitionVersion ||
      !instant(current.createdAt) || current.createdAt.getTime() !== born.getTime() || !instant(current.approvedAt) ||
      current.approvedAt < born || current.approvedAt >= proofValidUntil || current.approvedAt >= day.cutoffAt ||
      bogota(current.approvedAt) !== day.date) return fail();
  const approvals = await io.approve(transaction, day.portalEnvironment, [{ scheduleId: record.id, scheduleVersion: current.version }]);
  const approved = approvals.get(record.id);
  if (approved?.operationId !== input.expectedOperationId || approved.scheduleVersion !== current.version) return fail();
  const priorRules = new Map<CatalogTaskKind, CatalogScheduleRule>();
  for (const rule of day.rules) {
    if (priorRules.has(rule.scope.kind) || rule.operationId !== input.expectedOperationId) return fail();
    priorRules.set(rule.scope.kind, rule);
  }
  const inventory = new Map(day.inventory.map(item => [item.link.linkId, item]));
  const labels = new Map<string, Awaited<ReturnType<ActivationReader>>["labelsByLink"] extends ReadonlyMap<string, infer T> ? T : never>();
  let deadline = Math.min(day.cutoffAt.valueOf(), proofValidUntil.valueOf());
  const kinds = new Set<CatalogTaskKind>();
  for (const chosen of selected) {
    const found = inventory.get(chosen.linkId);
    const rule = priorRules.get(chosen.kind);
    if (!found || !rule || !chosen.targetId || chosen.state !== "ready" || labels.has(chosen.linkId) ||
        found.link.kind !== chosen.kind || found.link.state !== "active" || !found.sourceEvidence) return fail();
    const expiry = Date.parse(found.sourceEvidence.verifiedUntil);
    if (!Number.isFinite(expiry) || expiry <= current.approvedAt.valueOf()) return fail();
    deadline = Math.min(deadline, expiry);
    kinds.add(chosen.kind);
    labels.set(chosen.linkId, { linkId: chosen.linkId, clientId: found.link.customerId, domainId: found.link.domainId,
      targetId: found.link.databaseId ?? found.link.domainId, targetName: found.targetName, clientName: found.clientName,
      domainName: found.domainName, verifiedTargetId: chosen.targetId, kind: chosen.kind, environment: found.link.environment });
  }
  const responsibles: Awaited<ReturnType<ActivationReader>>["responsibles"][number][] = [];
  const roleChecks: { kind: CatalogTaskKind; role: string; roleAssigned: boolean }[] = [];
  for (const kind of kinds) {
    const rule = priorRules.get(kind)!;
    const persistedUsers = kind === "database" ? record.databaseAssignedUserIds ?? [] : record.assignedUserIds ?? [];
    const persistedRole = kind === "database" ? record.databaseAssignedRole : record.domainAssignedRole;
    const assigned = catalogAssignedUsers(rule.assignment);
    if (persistedRole !== rule.workflowRole || (rule.assignment.kind === "role" && rule.assignment.id !== persistedRole) ||
        (rule.assignment.kind === "unassigned") || new Set(persistedUsers).size !== persistedUsers.length ||
        assigned.length !== persistedUsers.length || assigned.some(id => !persistedUsers.includes(id))) return fail();
    if (rule.assignment.kind === "role") responsibles.push({ targetKind: kind, principalKind: "role", principalId: rule.assignment.id });
    else for (const id of assigned) responsibles.push({ targetKind: kind, principalKind: "user", principalId: id });
    roleChecks.push({ kind, role: rule.workflowRole, roleAssigned: rule.assignment.kind === "role" });
  }
  const roles = await transaction.request().input("roles", sql.NVarChar(sql.MAX), JSON.stringify(roleChecks))
    .query<{ count: number }>(`
      SELECT COUNT(*) AS [count]
      FROM OPENJSON(@roles) WITH (kind varchar(8),role nvarchar(80),roleAssigned bit) wanted
      JOIN security.roles task_role WITH (HOLDLOCK) ON task_role.role_id=wanted.role AND task_role.active=1
        AND task_role.role_id COLLATE Latin1_General_100_BIN2=wanted.role COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(task_role.role_id)=DATALENGTH(wanted.role)
      WHERE wanted.roleAssigned=0 OR task_role.role_id=N'super_admin' OR (
        CASE WHEN wanted.kind='database' THEN task_role.database_task_visibility ELSE task_role.domain_task_visibility END IN ('assigned','all')
        AND EXISTS(SELECT 1 FROM security.role_permissions rp WITH (HOLDLOCK)
          JOIN security.permissions p WITH (HOLDLOCK) ON p.permission_key=rp.permission_key AND p.active=1
          WHERE rp.role_id=task_role.role_id AND rp.permission_key=N'updates.tasks.view'));`);
  if (roles.recordset[0]?.count !== roleChecks.length) return fail();
  const status = await io.write(transaction, { scheduleId: record.id, definitionVersion: current.version, environment: day.portalEnvironment,
    sameDayCopyApproval: { intentId, operationId: input.expectedOperationId } },
    async ({ asOf, sqlNow }) => {
      if (asOf.getTime() !== current.approvedAt.getTime() || sqlNow.getTime() >= deadline) return fail();
      return { previousMembers: [], labelsByLink: labels, responsibles, evidence: { complete: true,
        observedAt: asOf.getTime(), validUntil: deadline,
        targets: selected.map(chosen => ({ linkId: chosen.linkId, state: "eligible" as const })) } };
    });
  if (status !== "frozen") return fail();
}
