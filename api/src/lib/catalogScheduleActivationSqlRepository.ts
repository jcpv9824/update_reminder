import sql from "mssql";
import { reconcileScheduleActivation, scheduleActivationAt, type ScheduleActivationEvidence,
  type ScheduledTargetEvidence } from "./catalogScheduleActivation";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { readCatalogScheduleActivationSourceWindowInTransaction } from "./catalogScheduleActivationSourceSql";

type Target = Readonly<{
  linkId: string; clientId: string; clientName: string; domainId: string; domainName: string;
  targetId: string; targetName: string; verifiedTargetId: string | null;
  kind: "domain" | "database"; environment: "production" | "test" | "demo";
}>;
type Responsible = Readonly<{
  targetKind: "domain" | "database"; principalKind: "user" | "role"; principalId: string;
}>;
export type AuthoritativeCandidateSet = Readonly<{
  previousMembers: readonly ScheduledTargetEvidence[];
  evidence?: ScheduleActivationEvidence;
  labelsByLink: ReadonlyMap<string, Target>;
  responsibles: readonly Responsible[];
}>;
type BoundaryRow = { scheduleKey: string; startDate: string; createdAt: Date; sqlNow: Date; priorPhase: string | null;
  copyApprovedAt?: Date | null; draftApprovedAt?: Date | null };
type Scope = Readonly<{ scheduleId: string; definitionVersion: string; environment: CatalogEnvironment;
  sameDayCopyApproval?: Readonly<{ intentId: string; operationId: string }>;
  sameDayDraftApproval?: Readonly<{ proposalId: string; operationId: string }> }>;
type Boundary = Readonly<{ scheduleKey: string; asOf: Date; sqlNow: Date }>;
type SourceWindow = NonNullable<Awaited<ReturnType<typeof readCatalogScheduleActivationSourceWindowInTransaction>>>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const safeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/\p{C}/u.test(value);
const fail = (): never => { throw new Error("catalog_schedule_activation_snapshot_invalid"); };
const kind = (value: string) => value === "domain" || value === "database";

/**
 * Internal write primitive. The caller must retain evidence/roster locks inside
 * the same transaction and supply a fully scoped, as-of reader. Never pass an
 * HTTP payload as readBoundedProof, or run this over the observation-only inventory.
 */
export async function writeCatalogScheduleActivationInTransaction(transaction: sql.Transaction,
  scope: Scope,
  readBoundedProof: (boundary: Boundary) => Promise<AuthoritativeCandidateSet>,
): Promise<"waiting" | "superseded" | "existing" | "frozen" | "held" | "cancelled"> {
  if (!safeText(scope.scheduleId, 150) || !/^[a-f0-9]{16}$/.test(scope.definitionVersion) ||
      !["qa", "production"].includes(scope.environment)) return fail();
  const copy = scope.sameDayCopyApproval;
  const draft = scope.sameDayDraftApproval;
  if (copy && (!uuid.test(copy.intentId) || !safeText(copy.operationId, 200))) return fail();
  if (draft && (copy || !uuid.test(draft.proposalId) || scope.scheduleId !== `catalog-draft-${draft.proposalId}` ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(draft.operationId))) return fail();
  const req = transaction.request().input("scheduleId", sql.NVarChar(150), scope.scheduleId)
    .input("environment", sql.VarChar(10), scope.environment)
    .input("copyIntent", sql.UniqueIdentifier, copy?.intentId ?? null)
    .input("operation", sql.NVarChar(200), copy?.operationId ?? draft?.operationId ?? null);
  if (draft) req.input("draftProposal", sql.UniqueIdentifier, draft.proposalId);
  const observation = await req
    .input("version", sql.VarBinary(8), Buffer.from(scope.definitionVersion, "hex")).query<BoundaryRow>(`
      SELECT CONVERT(varchar(20),s.schedule_key) AS scheduleKey,CONVERT(char(10),s.start_date,23) AS startDate,
        s.created_at AS createdAt,SYSUTCDATETIME() AS sqlNow,
        CASE WHEN a.schedule_key IS NOT NULL AND a.sealed_at IS NULL THEN 'unsealed' ELSE a.activation_state END AS priorPhase,
        witnessed.approved_at AS copyApprovedAt${draft ? ",draft_witness.approved_at AS draftApprovedAt" : ""}
      FROM scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
      LEFT JOIN scheduling.catalog_schedule_activation_snapshots a WITH (UPDLOCK,HOLDLOCK) ON a.schedule_key=s.schedule_key
      OUTER APPLY (SELECT approval.approved_at
        FROM scheduling.catalog_schedule_copy_intents i WITH (HOLDLOCK)
        JOIN scheduling.catalog_schedule_operation_approvals approval WITH (HOLDLOCK)
          ON approval.schedule_key=s.schedule_key AND approval.schedule_version=s.row_version
          AND approval.portal_environment=i.portal_environment AND approval.operation_id=i.operation_id
          AND approval.retired_at IS NULL
        WHERE i.copy_schedule_key=s.schedule_key AND i.intent_id=@copyIntent AND i.portal_environment=@environment
          AND i.operation_id=@operation AND i.created_at<=approval.approved_at) witnessed
      ${draft ? `OUTER APPLY (SELECT approval.approved_at
        FROM scheduling.v_catalog_schedule_draft_approval d WITH (HOLDLOCK)
        JOIN scheduling.catalog_schedule_operation_approvals approval WITH (HOLDLOCK)
          ON approval.schedule_key=s.schedule_key AND approval.schedule_version=s.row_version
          AND approval.portal_environment=d.portal_environment AND approval.operation_id=d.operation_id
          AND approval.approved_at=d.approved_at AND approval.retired_at IS NULL
        WHERE d.schedule_key=s.schedule_key AND d.schedule_version=s.row_version AND d.proposal_id=@draftProposal
          AND d.portal_environment=@environment AND d.operation_id=@operation AND d.approved_at>=s.created_at
          AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents i WITH (HOLDLOCK)
            WHERE i.copy_schedule_key=d.schedule_key)) draft_witness` : ""}
      WHERE s.source_id=@scheduleId AND s.row_version=@version AND s.deleted_at IS NULL AND s.active=1
        AND s.catalog_activation_enabled=1
        AND s.timezone=N'America/Bogota';
    `);
  if (!observation.recordset.length) return "superseded";
  if (observation.recordset.length !== 1) return fail();
  const row = observation.recordset[0];
  if (!/^[1-9][0-9]{0,18}$/.test(row.scheduleKey) || !(row.createdAt instanceof Date) || !(row.sqlNow instanceof Date)) return fail();
  if (row.priorPhase === "unsealed") return "held";
  if (row.priorPhase !== null) return "existing";
  const born = row.createdAt.valueOf();
  const scheduledCut = scheduleActivationAt(row.startDate, born);
  const approval = draft ? row.draftApprovedAt : row.copyApprovedAt;
  const approvedAt = approval?.valueOf();
  if ((copy || draft) && (!(approval instanceof Date) || !Number.isSafeInteger(approvedAt) || approvedAt! < scheduledCut ||
      new Date(approvedAt! - 5 * 3_600_000).toISOString().slice(0, 10) !== row.startDate)) return fail();
  if (draft && new Date(born - 5 * 3_600_000).toISOString().slice(0, 10) !== row.startDate) return fail();
  const asOf = copy || draft ? approvedAt! : scheduledCut;
  const checkedAt = row.sqlNow.valueOf();
  if (!Number.isSafeInteger(checkedAt)) return fail();
  if (checkedAt < asOf) return "waiting";
  const proof = await readBoundedProof({ scheduleKey: row.scheduleKey, asOf: new Date(asOf), sqlNow: row.sqlNow });
  const result = reconcileScheduleActivation({ startDate: row.startDate, createdAt: copy || draft ? asOf : born,
    members: proof.previousMembers }, checkedAt, proof.evidence);
  const phase = result.phase;
  // A retry can recover historical evidence for this exact cutoff; never latch a transient failure.
  if (phase === "held") return "held";
  if ((phase !== "frozen" && phase !== "cancelled") || result.frozenAt !== asOf ||
      !Array.isArray(proof.responsibles) || proof.responsibles.length > 200) return fail();
  const members = result.members.map(member => {
    const label = proof.labelsByLink.get(member.linkId);
    if (!label || label.linkId !== member.linkId || !uuid.test(label.linkId) || !kind(label.kind) ||
        !["production", "test", "demo"].includes(label.environment) ||
        ![label.clientId, label.domainId, label.targetId].every(id => safeText(id, 150)) ||
        ![label.clientName, label.domainName, label.targetName].every(name => safeText(name, 512)) ||
        (label.verifiedTargetId !== null && !uuid.test(label.verifiedTargetId)) ||
        (member.state === "eligible" && !label.verifiedTargetId)) return fail();
    return { ...label, state: member.state };
  });
  const principals = new Set<string>();
  for (const owner of proof.responsibles) {
    const id = JSON.stringify([owner.targetKind, owner.principalKind, owner.principalId]);
    if (!kind(owner.targetKind) || !["role", "user"].includes(owner.principalKind) ||
        !safeText(owner.principalId, 150) || principals.has(id)) return fail();
    principals.add(id);
  }
  if (members.some(m => m.state === "eligible" && !proof.responsibles.some(r => r.targetKind === m.kind))) return fail();
  await transaction.request().input("scheduleKey", sql.VarChar(20), row.scheduleKey)
    .input("version", sql.VarBinary(8), Buffer.from(scope.definitionVersion, "hex"))
    .input("environment", sql.VarChar(10), scope.environment).input("asOf", sql.DateTime2(3), new Date(asOf))
    .input("evidenceAt", sql.DateTime2(3), result.observedAt === undefined ? null : new Date(result.observedAt))
    .input("phase", sql.VarChar(10), phase)
    .input("members", sql.NVarChar(sql.MAX), JSON.stringify(members))
    .input("responsibles", sql.NVarChar(sql.MAX), JSON.stringify(proof.responsibles)).query(`
      DECLARE @key bigint=CONVERT(bigint,@scheduleKey);
      IF NOT EXISTS (SELECT 1 FROM scheduling.update_schedules
        WHERE schedule_key=@key AND row_version=@version AND active=1 AND deleted_at IS NULL)
        THROW 57111,N'The schedule changed before activation.',1;
      INSERT scheduling.catalog_schedule_activation_snapshots
        (schedule_key,definition_version,portal_environment,activation_at,evidence_at,activation_state)
      VALUES (@key,@version,@environment,@asOf,@evidenceAt,@phase);
      INSERT scheduling.catalog_schedule_activation_targets
        (schedule_key,link_id,client_source_id,client_name_snapshot,domain_source_id,domain_name_snapshot,
          target_source_id,target_name_snapshot,verified_target_id,target_kind,target_environment,evidence_state)
      SELECT @key,linkId,clientId,clientName,domainId,domainName,targetId,targetName,verifiedTargetId,kind,environment,state
      FROM OPENJSON(@members) WITH (linkId uniqueidentifier,clientId nvarchar(150),clientName nvarchar(512),
        domainId nvarchar(150),domainName nvarchar(512),targetId nvarchar(150),targetName nvarchar(512),
        verifiedTargetId uniqueidentifier,kind varchar(8),environment varchar(10),state varchar(12));
      INSERT scheduling.catalog_schedule_activation_responsibles (schedule_key,target_kind,principal_kind,principal_source_id)
      SELECT @key,targetKind,principalKind,principalId FROM OPENJSON(@responsibles)
        WITH (targetKind varchar(8),principalKind varchar(4),principalId nvarchar(150));
      UPDATE scheduling.catalog_schedule_activation_snapshots SET sealed_at=SYSUTCDATETIME()
      WHERE schedule_key=@key AND definition_version=@version AND sealed_at IS NULL;
      IF NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_snapshots
        WHERE schedule_key=@key AND definition_version=@version AND sealed_at IS NOT NULL)
        THROW 58209,N'The activation could not be sealed.',1;
    `);
  return phase;
}

/**
 * Activation entry point for a certified historical resolver. A current inventory
 * is not a substitute for these revision heads. The resolver still has to prove
 * exact scope, topology, operations, licenses and assignments as of the cutoff.
 */
export function activateCatalogScheduleFromHistoryInTransaction(transaction: sql.Transaction, scope: Scope & { matchKeyVersion: number },
  resolveHistoricalScope: (boundary: Boundary, sources: SourceWindow) => Promise<AuthoritativeCandidateSet>,
) {
  const unavailable = (): AuthoritativeCandidateSet => ({ previousMembers: [], labelsByLink: new Map(), responsibles: [] });
  return writeCatalogScheduleActivationInTransaction(transaction, scope, async boundary => {
    const sources = await readCatalogScheduleActivationSourceWindowInTransaction(transaction, {
      environment: scope.environment, asOf: boundary.asOf, matchKeyVersion: scope.matchKeyVersion,
    });
    if (!sources) return unavailable();
    const result = await resolveHistoricalScope(boundary, sources);
    if (!result.evidence) return result;
    const authorizedLinks = new Set(sources.linkIds);
    if (result.evidence.observedAt !== boundary.asOf.valueOf() ||
        result.evidence.targets.some(target => target.state === "eligible" && !authorizedLinks.has(target.linkId))) return unavailable();
    return { ...result, evidence: { ...result.evidence,
      validUntil: Math.min(result.evidence.validUntil ?? Infinity, sources.validUntil.valueOf()) } };
  });
}
