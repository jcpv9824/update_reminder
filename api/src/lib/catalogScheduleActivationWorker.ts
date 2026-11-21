import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { activateCatalogScheduleFromHistoryInTransaction, type AuthoritativeCandidateSet } from "./catalogScheduleActivationSqlRepository";
import { readCatalogScheduleHistoricalLinkProofInTransaction, readCatalogScheduleHistoricalPopulationInTransaction } from "./catalogScheduleHistoricalLinkProofSqlRepository";
import { readSqlCatalogScheduleCopyOriginInTransaction } from "./schedulingSqlRepository";
import { compileExactCopyProposal, resolveCatalogScheduleAssignment } from "./catalogScheduleScopes";
import { resolveCatalogScheduleDynamicCutoff } from "./catalogScheduleDynamicCutoff";
import { isCatalogScheduleOperationId } from "./catalogScheduleOperationApprovalSqlRepository";
import type { UpdateSchedule } from "../types/models";
import { catalogAssignedUsers } from "./catalogTaskTargetPlanning";
import { runSqlTransaction } from "./sqlTransaction";
import { getSqlPool } from "./sql";
import { lockCatalogTaskDay } from "./catalogExecutionCoexistenceSql";
import { loadCatalogSagTargetProofKey } from "./catalogSagTargetProofKey";

type Candidate = Readonly<{ scheduleId: string; version: string; key: string; date: string; hasDatabase: boolean }>;
const batchSize = 30;
const lastKey = new Map<CatalogEnvironment, string>();
const empty = (): AuthoritativeCandidateSet => ({ previousMembers: [], labelsByLink: new Map(), responsibles: [] });
const validKey = (key: unknown): key is string => typeof key === "string" && /^[1-9][0-9]{0,18}$/.test(key) && BigInt(key) <= 9223372036854775807n;
const validDate = (date: unknown): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export function hasConclusiveHistoricalCopyScope(
  requested: readonly { linkId: string; kind: string; targetId: string }[],
  evidence: readonly { linkId: string; kind: string; state: string; verifiedTargetId: string | null }[] | null,
) {
  if (!evidence || !requested.length || evidence.length !== requested.length) return false;
  const pins = new Map(requested.map(link => [link.linkId, link]));
  return pins.size === requested.length && new Set(evidence.map(link => link.linkId)).size === pins.size && evidence.every(item => {
    const pinned = pins.get(item.linkId);
    return pinned?.kind === item.kind && ((item.state === "absent" && item.verifiedTargetId === null) ||
      (item.state === "eligible" && item.verifiedTargetId === pinned.targetId));
  });
}

async function readCandidates(environment: CatalogEnvironment, after: string): Promise<readonly Candidate[]> {
  const { recordset } = await (await getSqlPool()).request().input("env", sql.VarChar(10), environment)
    .input("afterKey", sql.VarChar(20), after).input("take", sql.Int, batchSize).query<Candidate>(`
      SELECT TOP (@take) s.source_id AS scheduleId,LOWER(CONVERT(char(16),CONVERT(binary(8),s.row_version),2)) AS version,
        CONVERT(varchar(20),s.schedule_key) AS [key],CONVERT(char(10),s.start_date,23) AS [date],
        CONVERT(bit,CASE WHEN EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_links l
          WHERE l.copy_schedule_key=s.schedule_key AND l.target_kind='database') OR
          EXISTS(SELECT 1 FROM scheduling.v_catalog_schedule_draft_pins l
            WHERE l.schedule_key=s.schedule_key AND l.target_kind='database') OR
          (NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents i WHERE i.copy_schedule_key=s.schedule_key)
            AND NOT EXISTS(SELECT 1 FROM scheduling.v_catalog_schedule_draft_approval d WHERE d.schedule_key=s.schedule_key AND d.manual_selection=1)
            AND ((s.selection_mode='licensing' AND EXISTS(SELECT 1 FROM scheduling.licensing_scope ls
              WHERE ls.schedule_key=s.schedule_key AND ls.target_types IN ('databases_only','domains_and_databases')))
              OR (ISNULL(s.selection_mode,'manual')='manual' AND
                (s.target_type='database' OR EXISTS(SELECT 1 FROM scheduling.scope_groups g
                  WHERE g.schedule_key=s.schedule_key AND ISNULL(s.manual_target_types,'domains_and_databases') IN ('databases_only','domains_and_databases'))))))
          THEN 1 ELSE 0 END) AS hasDatabase
      FROM scheduling.update_schedules s
      WHERE s.schedule_key>CONVERT(bigint,@afterKey) AND s.active=1 AND s.deleted_at IS NULL AND s.catalog_activation_enabled=1
        AND s.timezone=N'America/Bogota' AND s.start_date<=CONVERT(date,DATEADD(hour,-5,SYSUTCDATETIME()))
        AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_snapshots x
          WHERE x.schedule_key=s.schedule_key AND x.sealed_at IS NOT NULL)
        AND (EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents i
            WHERE i.copy_schedule_key=s.schedule_key AND i.portal_environment=@env)
          OR (NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents i WHERE i.copy_schedule_key=s.schedule_key)
            AND EXISTS(SELECT 1 FROM scheduling.catalog_schedule_operation_approvals a
              WHERE a.schedule_key=s.schedule_key AND a.portal_environment=@env AND a.retired_at IS NULL
                AND a.schedule_version=s.row_version)))
      ORDER BY s.schedule_key;`);
  return recordset;
}

type RoleCheck = { kind: "domain" | "database"; role: string; roleAssigned: boolean };
async function historicalRolesAreValid(tx: sql.Transaction, roleChecks: readonly RoleCheck[], asOf: Date) {
  if (!roleChecks.length || roleChecks.some(role => !role.role || role.role.length > 80)) return false;
  const roles = await tx.request().input("roles", sql.NVarChar(sql.MAX), JSON.stringify(roleChecks))
    .input("boundary", sql.DateTime2(3), asOf).query<{ count: number }>(`
      SELECT COUNT(*) AS [count]
      FROM OPENJSON(@roles) WITH (kind varchar(8),role nvarchar(80),roleAssigned bit) wanted
      JOIN security.roles task_role WITH (HOLDLOCK) ON task_role.role_id=wanted.role AND task_role.active=1
        AND task_role.role_id COLLATE Latin1_General_100_BIN2=wanted.role COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(task_role.role_id)=DATALENGTH(wanted.role) AND task_role.updated_at<=@boundary
      WHERE wanted.roleAssigned=0 OR task_role.role_id=N'super_admin' OR (
        CASE WHEN wanted.kind='database' THEN task_role.database_task_visibility ELSE task_role.domain_task_visibility END IN ('assigned','all')
        AND EXISTS(SELECT 1 FROM security.role_permissions rp WITH (HOLDLOCK)
          JOIN security.permissions p WITH (HOLDLOCK) ON p.permission_key=rp.permission_key AND p.active=1
          WHERE rp.role_id=task_role.role_id AND rp.permission_key=N'updates.tasks.view' AND rp.granted_at<=@boundary));`);
  return roles.recordset.length === 1 && roles.recordset[0].count === roleChecks.length;
}

async function readHistoricalScheduleLicenseIds(tx: sql.Transaction, scheduleKey: string, asOf: Date) {
  const { recordset } = await tx.request().input("scheduleKey", sql.VarChar(20), scheduleKey)
    .input("asOf", sql.DateTime2(3), asOf).query<{ id: string }>(`
      SELECT TOP (26) m.source_id AS id
      FROM scheduling.licensing_scope_modules j WITH (HOLDLOCK)
      JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=j.module_key
      WHERE j.schedule_key=CONVERT(bigint,@scheduleKey) AND m.created_at<=@asOf AND m.updated_at<=@asOf
        AND m.status='active' AND m.deleted_at IS NULL ORDER BY m.module_key;`);
  if (recordset.length > 25 || recordset.some(row => typeof row.id !== "string" || !row.id.trim() ||
      row.id.length > 150 || /\p{C}/u.test(row.id))) return new Set<string>();
  return new Set(recordset.map(row => row.id));
}

async function readHistoricalManualRetirements(tx: sql.Transaction, schedule: UpdateSchedule, environment: CatalogEnvironment,
  born: Date, asOf: Date, limit: number): Promise<string[] | null> {
  const owners = [...new Set(schedule.scopeGroups?.length ? schedule.scopeGroups.map(group => group.clientId) : [schedule.clientId])];
  if (owners.length > 5000 || owners.some(id => !id || id.length > 150 || /\p{C}/u.test(id))) return null;
  const { recordset } = await tx.request().input("environment", sql.VarChar(10), environment)
    .input("owners", sql.NVarChar(sql.MAX), JSON.stringify(owners))
    .input("born", sql.DateTime2(3), born).input("asOf", sql.DateTime2(3), asOf).input("take", sql.Int, limit + 1)
    .query<{ linkId: string }>(`
      SELECT TOP (@take) LOWER(CONVERT(char(36),l.link_id)) AS linkId
      FROM OPENJSON(@owners) j
      JOIN core.clients c WITH (HOLDLOCK) ON c.source_id=CONVERT(nvarchar(150),j.value) COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(c.source_id)=DATALENGTH(j.value)
      JOIN core.catalog_operational_owners o WITH (HOLDLOCK) ON o.client_key=c.client_key
        AND o.portal_environment=@environment AND o.registered_at<=@asOf
      JOIN core.catalog_operational_links l WITH (HOLDLOCK) ON l.owner_key=o.owner_key AND l.client_key=o.client_key
        AND l.portal_environment=o.portal_environment AND l.registered_at<=@asOf
      WHERE (l.retired_at BETWEEN @born AND @asOf OR o.retired_at BETWEEN @born AND @asOf)
      ORDER BY l.link_key;`);
  if (recordset.length > limit || new Set(recordset.map(row => row.linkId)).size !== recordset.length) return null;
  return recordset.map(row => row.linkId);
}

async function activateCandidate(environment: CatalogEnvironment, matchKeyVersion: number, candidate: Candidate, matchKey: Buffer | null) {
  return runSqlTransaction(async tx => {
    for (const targetType of ["database", "domain"] as const) {
      if (!await lockCatalogTaskDay(tx, { taskDate: candidate.date, targetType })) return "held" as const;
    }
    return activateCandidateWithHeldDayLocks(tx, environment, matchKeyVersion, candidate, matchKey);
  });
}

type DraftBoundary = { proposalId: string; operationId: string; approvedAt: Date;
  expected: readonly { linkId: string; kind: "domain" | "database"; physicalId: string; include: boolean }[] };

export function hasExactSameDayDraftCohort(result: AuthoritativeCandidateSet, expected: DraftBoundary["expected"]) {
  const wanted = expected.filter(pin => pin.include);
  const found = result.evidence?.targets;
  if (!found || !result.evidence?.complete || !wanted.length || found.length !== wanted.length ||
      new Set(found.map(item => item.linkId)).size !== found.length) return false;
  const byLink = new Map(wanted.map(pin => [pin.linkId, pin]));
  return byLink.size === wanted.length && found.every(item => {
    const pin = byLink.get(item.linkId), label = result.labelsByLink.get(item.linkId);
    return item.state === "eligible" && !!pin && label?.kind === pin.kind && label.verifiedTargetId === pin.physicalId;
  });
}

/** Caller already holds both target-kind locks; never start a nested transaction. */
export function activateCandidateWithHeldDayLocks(tx: sql.Transaction, environment: CatalogEnvironment, matchKeyVersion: number,
  candidate: Omit<Candidate,"key"|"hasDatabase"> & { key?: string }, matchKey: Buffer | null, draft?: DraftBoundary) {
    return activateCatalogScheduleFromHistoryInTransaction(tx, { scheduleId: candidate.scheduleId,
      definitionVersion: candidate.version, environment, matchKeyVersion,
      ...(draft && { sameDayDraftApproval: { proposalId: draft.proposalId, operationId: draft.operationId } }) }, async (boundary, sources) => {
      if ((candidate.key !== undefined && boundary.scheduleKey !== candidate.key) ||
          (draft && boundary.asOf.valueOf() !== draft.approvedAt.valueOf())) return empty();
      const row = await readSqlCatalogScheduleCopyOriginInTransaction(tx, candidate.scheduleId, candidate.date);
      if (!row || row.version !== candidate.version || row.schedule.startDate !== candidate.date) return empty();
      if (row.draftOrigin && (row.copyLinks || row.draftOrigin.version !== candidate.version || row.draftOrigin.environment !== environment ||
          row.draftOrigin.manual !== Boolean(row.draftLinks))) return empty();
      // Check this definition's approval, never that of a copy's parent.
      // A later approval cannot be backdated to a historical cut.
      const copy = Boolean(row.copyLinks?.length);
      const { recordset } = await tx.request().input("scheduleKey", sql.VarChar(20), boundary.scheduleKey)
        .input("version", sql.VarBinary(8), Buffer.from(candidate.version, "hex"))
        .input("environment", sql.VarChar(10), environment).input("boundary", sql.DateTime2(3), boundary.asOf)
        .input("copy", sql.Bit, copy)
        .query<{ operationId: string }>(`
          SELECT a.operation_id AS operationId
          FROM scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK)
          WHERE a.schedule_key=CONVERT(bigint,@scheduleKey) AND a.portal_environment=@environment
            AND a.schedule_version=@version AND a.approved_at<=@boundary AND a.retired_at IS NULL
            AND ((@copy=1 AND EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents i WITH (HOLDLOCK)
              WHERE i.copy_schedule_key=a.schedule_key AND i.portal_environment=a.portal_environment AND i.operation_id=a.operation_id))
              OR (@copy=0 AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents i WITH (HOLDLOCK)
                WHERE i.copy_schedule_key=a.schedule_key))); `);
      if (recordset.length !== 1 || !isCatalogScheduleOperationId(recordset[0].operationId)) return empty();
      if (row.draftOrigin && row.draftOrigin.operationId !== recordset[0].operationId) return empty();
      if (draft && (!row.draftOrigin || draft.operationId !== recordset[0].operationId)) return empty();
      const exactLinks = row.copyLinks ?? row.draftLinks;
      if (!exactLinks) {
        const isLicensing = row.schedule.selectionMode === "licensing";
        const activeLicenseIds = isLicensing ? await readHistoricalScheduleLicenseIds(tx, boundary.scheduleKey, boundary.asOf) : new Set<string>();
        const born = new Date(row.schedule.createdAt);
        if (!Number.isFinite(born.valueOf()) || born > boundary.asOf) return empty();
        const retired = isLicensing ? [] : await readHistoricalManualRetirements(tx, row.schedule, environment,
          born, boundary.asOf, 5000 - sources.linkIds.length);
        if (!retired) return empty();
        const links = await readCatalogScheduleHistoricalPopulationInTransaction(tx, {
          environment, asOf: boundary.asOf, heads: sources.heads, includeLicenses: isLicensing,
          ...(matchKey && { matchKey, matchKeyVersion, scheduleKey: boundary.scheduleKey }),
        }, [...sources.linkIds, ...retired]);
        if (!links) return empty();
        const ownerStates = new Map<string, "eligible">();
        for (const link of links) if (link.state === "eligible") ownerStates.set(link.clientId, "eligible");
        const result = resolveCatalogScheduleDynamicCutoff(row.schedule, { links, linkIds: sources.linkIds,
          asOf: boundary.asOf, validUntil: sources.validUntil, ownerStates, activeLicenseIds }, draft?.approvedAt);
        if (!result.evidence || (draft && !hasExactSameDayDraftCohort(result, draft.expected))) return empty();
        const scoped = Boolean(isLicensing || row.schedule.scopeGroups?.length);
        const checks: RoleCheck[] = [];
        for (const kind of new Set(result.responsibles.map(r => r.targetKind))) {
          const responsible = resolveCatalogScheduleAssignment(row.schedule, kind, scoped);
          if (!responsible) return empty();
          checks.push({ kind, role: responsible.workflowRole, roleAssigned: responsible.assignment.kind === "role" });
        }
        return await historicalRolesAreValid(tx, checks, boundary.asOf) ? result : empty();
      }
      const scope = compileExactCopyProposal(row, candidate.date, recordset[0].operationId);
      if (scope.status !== "ready") return empty();
      // Preserve the assignment that existed at the cutoff. A current permission
      // check is an additional execution gate, not evidence of historic access.
      const roleChecks = scope.rules.map(rule => ({ kind: rule.scope.kind, role: rule.workflowRole, roleAssigned: rule.assignment.kind === "role" }));
      if (!await historicalRolesAreValid(tx, roleChecks, boundary.asOf)) return empty();
      const evidence = await readCatalogScheduleHistoricalLinkProofInTransaction(tx, {
        environment, asOf: boundary.asOf, heads: sources.heads, links: exactLinks,
        ...(matchKey && { matchKey, matchKeyVersion, scheduleKey: boundary.scheduleKey }),
      });
      // A terminal snapshot has no path to admit an unknown member later. Only
      // explicit absence, not a technical gap, may shrink the frozen scope.
      if (!evidence || !hasConclusiveHistoricalCopyScope(exactLinks, evidence)) return empty();
      // Assignment definitions are immutable after the cutoff. Snapshot the
      // exact role or explicit users; generation still checks live access.
      const responsibles: AuthoritativeCandidateSet["responsibles"][number][] = [];
      for (const { scope: { kind }, assignment } of scope.rules) {
        if (assignment.kind === "unassigned") return empty();
        if (assignment.kind === "role") responsibles.push({ targetKind: kind, principalKind: "role", principalId: assignment.id });
        else for (const id of catalogAssignedUsers(assignment)) responsibles.push({ targetKind: kind, principalKind: "user", principalId: id });
      }
      const result = { previousMembers: exactLinks.map(({ linkId }) => ({ linkId, state: "unverifiable" as const })),
        labelsByLink: new Map(evidence.map(item => [item.linkId, item])), responsibles,
        evidence: { observedAt: boundary.asOf.getTime(), complete: true, validUntil: sources.validUntil.getTime(),
          targets: evidence.map(({ linkId, state }) => ({ linkId, state })) } };
      return !draft || hasExactSameDayDraftCohort(result, draft.expected) ? result : empty();
    });
}

export type CatalogActivationSweepSummary = { checked: number; frozen: number; cancelled: number; held: number; failed: number };
const defaultWorker = { read: readCandidates, activate: activateCandidate, cursors: lastKey,
  loadKey: async (environment: CatalogEnvironment, version: number) => process.env.PORTAL_CATALOG_SAG_V2_ENABLED?.trim() === "true"
    ? loadCatalogSagTargetProofKey(environment, version) : null };
/** Only opted-in definitions with separately approved operations can activate. */
export async function runCatalogScheduleActivationSweep(environment: CatalogEnvironment, matchKeyVersion: number,
  io: Omit<typeof defaultWorker, "loadKey"> & Partial<Pick<typeof defaultWorker, "loadKey">> = defaultWorker): Promise<CatalogActivationSweepSummary> {
  if ((environment !== "qa" && environment !== "production") || !Number.isInteger(matchKeyVersion) ||
      matchKeyVersion < 1 || matchKeyVersion > 32767) throw new Error("catalog_activation_worker_unconfigured");
  const summary = { checked: 0, frozen: 0, cancelled: 0, held: 0, failed: 0 };
  const after = io.cursors.get(environment) ?? "0";
  const candidates = await io.read(environment, after);
  if (!Array.isArray(candidates) || candidates.length > batchSize || candidates.some((row, i) => !row ||
      !validKey(row.key) || BigInt(row.key) <= BigInt(i === 0 ? after : candidates[i - 1].key) || !validDate(row.date) ||
      typeof row.scheduleId !== "string" || !row.scheduleId.length || row.scheduleId.length > 150 || /\p{C}/u.test(row.scheduleId) ||
      !/^[a-f0-9]{16}$/.test(row.version) || typeof row.hasDatabase !== "boolean")) throw new Error("catalog_activation_worker_invalid_batch");
  let matchKey: Buffer | null = null;
  if (io.loadKey && candidates.some(candidate => candidate.hasDatabase)) {
    try { matchKey = await io.loadKey(environment, matchKeyVersion); } catch { /* Keep unavailable database proof held. */ }
  }
  try {
    for (const candidate of candidates) {
      summary.checked++;
      try {
        const status = await io.activate(environment, matchKeyVersion, candidate, candidate.hasDatabase ? matchKey : null);
        if (status === "frozen" || status === "cancelled" || status === "held") summary[status]++;
      } catch { summary.failed++; }
    }
  } finally {
    matchKey?.fill(0);
  }
  // Rotate through held candidates within a running host instead of blocking
  // newer work behind the first transiently unavailable source.
  if (candidates.length < batchSize) io.cursors.delete(environment);
  else io.cursors.set(environment, candidates[candidates.length - 1].key);
  return summary;
}
