import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import type { buildCatalogDraftScheduleDefinition } from "./catalogScheduleDraftProposal";
import { isCatalogScheduleOperationId } from "./catalogScheduleOperationApprovalSqlRepository";
import { insertSqlScheduleInTransaction } from "./schedulingSqlWriteRepository";

type BuiltDraft = NonNullable<ReturnType<typeof buildCatalogDraftScheduleDefinition>>;
type Approval = Readonly<{ approvedAt: Date; validUntil: Date; operationId: string }>;
type Receipt = Readonly<{ environment: CatalogEnvironment; proposalId: string; reviewId: string }>;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const versionPattern = /^[a-f0-9]{16}$/;
const unavailable = () => Object.assign(new Error("catalog_draft_materialization_unavailable"), { status: 409 });
const finiteInstant = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.valueOf());

/** This does not accept an operation or reviewer identity from the caller. */
export async function consumeSqlCatalogDraftReviewInTransaction(tx: sql.Transaction, input: Receipt & { version: string }): Promise<Approval> {
  if (!["qa","production"].includes(input.environment) || !guid.test(input.proposalId) ||
      !guid.test(input.reviewId) || !versionPattern.test(input.version)) throw unavailable();
  try {
    const { recordset } = await tx.request().input("environment", sql.VarChar(10), input.environment)
      .input("proposal", sql.UniqueIdentifier, input.proposalId).input("review", sql.UniqueIdentifier, input.reviewId)
      .input("version", sql.VarBinary(8), Buffer.from(input.version, "hex"))
      .execute<Approval>("settings.materialize_catalog_schedule_draft_review");
    const approval = recordset?.[0];
    if (recordset?.length !== 1 || !finiteInstant(approval.approvedAt) || !finiteInstant(approval.validUntil) ||
        approval.approvedAt >= approval.validUntil || !isCatalogScheduleOperationId(approval.operationId)) throw unavailable();
    return approval;
  } catch { throw unavailable(); }
}

/**
 * Internal stage under the day reservation transaction. Every failure must
 * propagate so commit cannot keep the definition, approval, audit, or pins alone.
 * Same-day work cannot commit without the exact start snapshot.
 */
export async function materializeReviewedCatalogDraftInTransaction(tx: sql.Transaction, draft: BuiltDraft,
  input: Receipt & { actor: { id: string; email: string }; catalogValidUntil: Date },
  callbacks: {
    tightenDeadline: (until: Date) => void;
    freezeSameDay: (tx: sql.Transaction, input: { draft: BuiltDraft; approval: Approval; version: string }) => Promise<boolean>;
  },
  io = { insert: insertSqlScheduleInTransaction, approve: consumeSqlCatalogDraftReviewInTransaction, now: () => new Date() }) {
  const { record, exactManualPins } = draft;
  if (!["qa","production"].includes(input.environment) || !guid.test(input.proposalId) || !guid.test(input.reviewId) ||
      record.id !== `catalog-draft-${input.proposalId}` || record.createdBy !== input.actor.id ||
      !record.active || record.timezone !== "America/Bogota" || record.targetIds.length || record.scopeGroups?.length ||
      (record.selectionMode === "manual" ? !exactManualPins?.length || record.licensingScope :
        record.selectionMode !== "licensing" || exactManualPins !== undefined || !record.licensingScope) ||
      !finiteInstant(input.catalogValidUntil) || input.catalogValidUntil <= io.now()) throw unavailable();
  callbacks.tightenDeadline(input.catalogValidUntil);
  const { version, record: saved } = await io.insert(tx, record, input.actor, { catalogLifecycle: true });
  if (!version || !versionPattern.test(version) || saved.id !== record.id) throw unavailable();
  const approval = await io.approve(tx, { environment: input.environment, proposalId: input.proposalId, reviewId: input.reviewId, version });
  if (approval.approvedAt >= input.catalogValidUntil) throw unavailable();
  callbacks.tightenDeadline(approval.validUntil);
  const approvedDay = new Date(approval.approvedAt.valueOf() - 5 * 3_600_000).toISOString().slice(0, 10);
  if (approvedDay > record.startDate || (approvedDay === record.startDate &&
      !await callbacks.freezeSameDay(tx, { draft: { ...draft, record: saved }, approval, version }))) throw unavailable();
  return { id: saved.id, status: "created" } as const;
}
