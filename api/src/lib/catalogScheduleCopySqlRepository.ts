import { createHash } from "node:crypto";
import sql from "mssql";
import type { UpdateSchedule } from "../types/models";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import type { CatalogTaskKind } from "./catalogTaskTargetPlanning";
import { insertSqlScheduleInTransaction } from "./schedulingSqlWriteRepository";

type SelectedLink = Readonly<{ linkId: string; kind: CatalogTaskKind; targetId: string }>;
type Intent = Readonly<{ intentId: string; portalEnvironment: CatalogEnvironment;
  originalScheduleId: string; originalDefinitionVersion: string; operationId: string; taskDate: string;
  links: readonly SelectedLink[] }>;
type Actor = { id: string; email: string };
type Result = { status: "created" | "replayed"; id: string };
type Finalize = (transaction: sql.Transaction, record: UpdateSchedule, intent: Intent, version: string, validUntil: Date) => Promise<void>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = () => Object.assign(new Error("catalog_schedule_copy_proof_changed"), { status: 409 });

/**
 * Writes only server-revalidated selections, with the original and day already
 * locked by withVerifiedCatalogCopySelection. Finalize is mandatory: it must
 * prove the new definition's operation entitlement and applicable activation
 * evidence, and throw on failure so the entire copy and audit roll back.
 */
export async function insertSqlCatalogRemainingCopyInTransaction(transaction: sql.Transaction, intent: Intent,
  record: UpdateSchedule, actor: Actor, finalize: Finalize,
  insert = insertSqlScheduleInTransaction): Promise<Result> {
  if (!uuid.test(intent.intentId) || !/^[a-f0-9]{16}$/.test(intent.originalDefinitionVersion) ||
      !["qa", "production"].includes(intent.portalEnvironment) || !Array.isArray(intent.links) ||
      !intent.links.length || intent.links.length > 5000 || typeof finalize !== "function" ||
      record.id !== `catalog-copy-${intent.intentId}` || record.id === intent.originalScheduleId || !record.active ||
      record.startDate !== intent.taskDate || record.timezone !== "America/Bogota" || record.selectionMode !== "manual" || record.origin !== "special" ||
      record.targetIds.length || record.scopeGroups?.length || record.licensingScope || record.completedAt || record.completedReason) throw fail();
  const links = [...intent.links].sort((a,b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);
  if (new Set(links.map(link => link.linkId)).size !== links.length || links.some(link =>
      !uuid.test(link.linkId) || !uuid.test(link.targetId) || (link.kind !== "domain" && link.kind !== "database"))) throw fail();
  // Only stable editable fields and exact verified mappings participate. SQL
  // creation timestamps are not part of retry identity.
  const digest = createHash("sha256").update(JSON.stringify([record.name, record.clientId, record.domainId ?? null,
    record.origin, record.targetType, record.manualTargetTypes ?? "domains_and_databases", record.frequencyType,
    record.startDate, record.endDate ?? null, record.manualEnvironment ?? null,
    record.everyNWeeks ?? null, record.intervalDays ?? null, record.dayOfMonth ?? null, record.weekdays ?? [],
    record.preferredWeekdays ?? [], record.assignedRole, record.assignedUserIds ?? [], record.domainAssignedRole ?? null,
    record.databaseAssignedRole ?? null, record.databaseAssignedUserIds ?? [], record.assignmentMode ?? null,
    record.databaseReminderRecipientsMode ?? null, record.notes ?? null, record.reminders ?? null,
    links.map(link => [link.linkId, link.kind, link.targetId])])).digest();
  const lookup = await transaction.request().input("intentId", sql.UniqueIdentifier, intent.intentId).query<{
    id: string; actorId: string; originalId: string; version: string; operationId: string; environment: string; digest: Buffer; deleted: boolean;
  }>(`
    SELECT copy.source_id AS id,i.actor_source_id AS actorId,original.source_id AS originalId,
      LOWER(CONVERT(char(16),i.original_definition_version,2)) AS version,i.operation_id AS operationId,
      i.portal_environment AS environment,i.selection_digest AS digest,CONVERT(bit,CASE WHEN copy.deleted_at IS NULL THEN 0 ELSE 1 END) AS deleted
    FROM scheduling.catalog_schedule_copy_intents i WITH (UPDLOCK,HOLDLOCK)
    JOIN scheduling.update_schedules copy ON copy.schedule_key=i.copy_schedule_key
    JOIN scheduling.update_schedules original ON original.schedule_key=i.original_schedule_key
    WHERE i.intent_id=@intentId;`);
  // A retry returns the exact same copy; it never overwrites or resurrects it.
  const prior = lookup.recordset[0];
  if (prior) {
    if (lookup.recordset.length !== 1 || prior.deleted || prior.id !== record.id || prior.actorId !== actor.id ||
        prior.originalId !== intent.originalScheduleId || prior.version !== intent.originalDefinitionVersion ||
        prior.operationId !== intent.operationId || prior.environment !== intent.portalEnvironment ||
        !Buffer.isBuffer(prior.digest) || !prior.digest.equals(digest)) throw fail();
    return { status: "replayed", id: prior.id };
  }
  const { key, record: created, version } = await insert(transaction, record, actor, { catalogLifecycle: true });
  if (!version || !/^[a-f0-9]{16}$/.test(version)) throw fail();
  const saved = await transaction.request().input("intentId", sql.UniqueIdentifier, intent.intentId)
    .input("copyKey", sql.BigInt, key).input("originalId", sql.NVarChar(150), intent.originalScheduleId)
    .input("version", sql.VarBinary(8), Buffer.from(intent.originalDefinitionVersion, "hex"))
    .input("environment", sql.VarChar(10), intent.portalEnvironment).input("actorId", sql.NVarChar(150), actor.id)
    .input("operationId", sql.NVarChar(200), intent.operationId).input("digest", sql.VarBinary(32), digest)
    .input("links", sql.NVarChar(sql.MAX), JSON.stringify(links)).query<{ count: number; validUntil: Date | null }>(`
    SET NOCOUNT ON;
    INSERT scheduling.catalog_schedule_copy_intents(intent_id,original_schedule_key,original_definition_version,
      copy_schedule_key,portal_environment,actor_source_id,operation_id,selection_digest)
    SELECT @intentId,s.schedule_key,s.row_version,@copyKey,@environment,@actorId,@operationId,@digest
    FROM scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
    JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK)
      ON a.schedule_key=s.schedule_key AND a.schedule_version=s.row_version AND a.portal_environment=@environment
      AND a.operation_id=@operationId AND a.retired_at IS NULL AND a.approved_at<=SYSUTCDATETIME()
    WHERE s.source_id=@originalId AND s.source_id COLLATE Latin1_General_100_BIN2=@originalId COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(s.source_id)=DATALENGTH(@originalId) AND s.row_version=@version AND s.active=1 AND s.deleted_at IS NULL;
    IF @@ROWCOUNT<>1 THROW 57201,N'La programación original cambió antes de guardar.',1;
    DECLARE @verified table(link_id uniqueidentifier PRIMARY KEY,target_kind varchar(8),target_id uniqueidentifier,valid_until datetime2(3));
    INSERT @verified(link_id,target_kind,target_id,valid_until)
    SELECT l.link_id,l.target_kind,t.target_id,p.valid_until
    FROM OPENJSON(@links) WITH (linkId uniqueidentifier,kind varchar(8),targetId uniqueidentifier) r
    JOIN core.catalog_operational_links l WITH (HOLDLOCK) ON l.link_id=r.linkId AND l.target_kind=r.kind
      AND l.portal_environment=@environment AND l.retired_at IS NULL
    JOIN core.catalog_physical_targets t WITH (HOLDLOCK) ON t.target_id=r.targetId AND t.target_kind=r.kind
      AND t.portal_environment=@environment
    JOIN core.catalog_physical_target_links p WITH (HOLDLOCK) ON p.physical_target_key=t.physical_target_key
      AND p.target_kind=l.target_kind AND p.portal_environment=l.portal_environment
      AND p.client_key=l.client_key AND p.domain_key=l.domain_key
      AND (p.database_key=l.database_key OR (p.database_key IS NULL AND l.database_key IS NULL))
      AND p.retired_at IS NULL AND p.verified_at<=SYSUTCDATETIME() AND p.valid_until>SYSUTCDATETIME();
    INSERT scheduling.catalog_schedule_copy_links(copy_schedule_key,link_id,target_kind,verified_target_id)
    SELECT @copyKey,link_id,target_kind,target_id FROM @verified;
    SELECT COUNT(*) AS [count],MIN(valid_until) AS validUntil FROM @verified;`);
  const proof = saved.recordset[0];
  if (proof?.count !== links.length || !(proof.validUntil instanceof Date) || !Number.isFinite(proof.validUntil.getTime())) throw fail();
  await finalize(transaction, created, intent, version, proof.validUntil);
  return { status: "created", id: created.id };
}
