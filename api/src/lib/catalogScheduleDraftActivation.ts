import type { CatalogCopyRequester } from "./catalogScheduleCopyActivateHttp";
import { activateCandidateWithHeldDayLocks } from "./catalogScheduleActivationWorker";
import { findApprovedDraftModuleCode, type DraftCatalogRequest } from "./catalogScheduleDraftPreview";
import { readVerifiedCatalogDraft, withCatalogDraftDefinitionForApproval } from "./catalogScheduleDraftProposal";
import { materializeReviewedCatalogDraftInTransaction } from "./catalogScheduleDraftMaterializationSqlRepository";
import { loadCatalogSagTargetProofKey } from "./catalogSagTargetProofKey";
import { runSqlTransaction } from "./sqlTransaction";
import { isCatalogScheduleChoiceModule } from "./catalogScheduleChoices";

type Input = CatalogCopyRequester & Pick<DraftCatalogRequest, "checkedAt" | "portalEnvironment" | "matchKeyVersion"> &
  { proposalId: string; reviewId: string };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const dependencies = { transaction: runSqlTransaction, read: readVerifiedCatalogDraft, moduleCode: findApprovedDraftModuleCode,
  approve: withCatalogDraftDefinitionForApproval, persist: materializeReviewedCatalogDraftInTransaction,
  historical: activateCandidateWithHeldDayLocks,
  locationKey: async (env: Input["portalEnvironment"], version: number) =>
    process.env.PORTAL_CATALOG_SAG_V2_ENABLED?.trim() === "true" ? loadCatalogSagTargetProofKey(env, version) : null };

/** Separate requester and reviewer. Locks, approval, pins, audit and any due snapshot commit together. */
export async function activateReviewedCatalogDraft(input: Input, io = dependencies) {
  const { actorId, portalEnvironment, proposalId, reviewId, matchKeyVersion, checkedAt } = input;
  if (!uuid.test(proposalId) || !uuid.test(reviewId) || !Number.isFinite(checkedAt.valueOf())) return null;
  const draft = await io.transaction(tx => io.read(tx, { id: proposalId, actorId, portalEnvironment }));
  if (!draft || draft.id !== proposalId || draft.actorId !== actorId || draft.environment !== portalEnvironment) return null;
  const today = new Date(checkedAt.valueOf() - 5 * 3_600_000).toISOString().slice(0, 10);
  if (draft.scope.date < today || Date.parse(draft.scope.date) - Date.parse(today) > 7 * 24 * 3_600_000) return null;
  const kinds = draft.scope.target === "both" ? ["domain","database"] as const : [draft.scope.target];
  if (kinds.some(kind => !input.allowedKinds.includes(kind)) || (draft.scope.mode === "licensing" && !input.allowLicensing)) return null;
  let scope: DraftCatalogRequest["scope"];
  if (draft.scope.mode === "manual") scope = draft.scope;
  else {
    const moduleCode = draft.moduleId && await io.moduleCode(portalEnvironment, matchKeyVersion, draft.moduleId);
    if (!isCatalogScheduleChoiceModule(moduleCode)) return null;
    scope = { ...draft.scope, moduleCode };
  }
  let key: Buffer | null = null;
  if (scope.date === today && draft.pins.some(pin => pin.kind === "database" && pin.include)) {
    try { key = await io.locationKey(portalEnvironment, matchKeyVersion); } catch { /* The historical proof still must pass. */ }
  }
  try {
    return await io.approve({ actorId, allowedKinds: input.allowedKinds, allowLicensing: input.allowLicensing,
      checkedAt, portalEnvironment, matchKeyVersion, scope }, draft, (tx, built, proof) =>
      io.persist(tx, built, { environment: portalEnvironment, proposalId: proof.proposalId, reviewId,
        actor: { id: actorId, email: input.actorEmail }, catalogValidUntil: proof.validUntil }, {
        tightenDeadline: proof.tightenDeadline,
        freezeSameDay: async (sameTx, { draft: saved, approval, version }) => {
          const status = await io.historical(sameTx, portalEnvironment, matchKeyVersion,
            { scheduleId: saved.record.id, version, date: saved.record.startDate }, key,
            { proposalId, operationId: approval.operationId, approvedAt: approval.approvedAt, expected: draft.pins });
          return status === "frozen";
        },
      }));
  } finally { key?.fill(0); }
}
