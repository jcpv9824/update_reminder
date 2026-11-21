import sql from "mssql";
import type { UpdateSchedule } from "../types/models";
import { withFreshCatalogCopyPreview, withVerifiedCatalogCopySelection } from "./catalogScheduleCopyPreview";
import { matchStoredCatalogCopySelection, readStoredCatalogCopyProposalInTransaction } from "./catalogScheduleCopyProposal";
import { insertSqlCatalogRemainingCopyInTransaction } from "./catalogScheduleCopySqlRepository";
import { activateApprovedSameDayCatalogCopyInTransaction } from "./catalogScheduleCopyActivation";
import { catalogAssignedUsers } from "./catalogTaskTargetPlanning";
import { readSqlCatalogScheduleOperationApprovalsInTransaction } from "./catalogScheduleOperationApprovalSqlRepository";
import { confirmReviewedCatalogCopyReplayInTransaction, consumeSqlCatalogCopyReviewInTransaction } from "./catalogScheduleCopyReviewSqlRepository";

type VerifiedSelection = Parameters<Parameters<typeof withVerifiedCatalogCopySelection>[1]>[1];
type SelectionRequest = Parameters<typeof withVerifiedCatalogCopySelection>[0];
type ApprovalAuthority = (transaction: sql.Transaction, approval: Readonly<{
  environment: SelectionRequest["portalEnvironment"]; copyId: string; originalId: string;
  originalVersion: string; operationId: string; approverId?: string;
  proposalId?: string; copyVersion?: string;
}>) => Promise<void | Date>;
const change = () => Object.assign(new Error("catalog_copy_definition_changed"), { status: 409 });
const dependencies = { verify: withVerifiedCatalogCopySelection, insert: insertSqlCatalogRemainingCopyInTransaction,
  activate: activateApprovedSameDayCatalogCopyInTransaction, readApproval: readSqlCatalogScheduleOperationApprovalsInTransaction };

/** Copies the selected one-time update, never its tasks, completion, notices or credentials. */
export function buildCatalogCopyDefinition(selection: VerifiedSelection, name: string, actorId: string, createdAt: Date): UpdateSchedule {
  const chosenKinds = new Set(selection.selected.map(link => link.kind));
  const rules = selection.day.rules.filter(rule => chosenKinds.has(rule.scope.kind));
  const targetIds = new Set(selection.selected.map(link => link.linkId));
  const representative = selection.day.inventory.find(item => targetIds.has(item.link.linkId));
  if (!representative || rules.length !== chosenKinds.size || !rules.length || name.trim() !== name || !name.length || name.length > 200 ||
      /\p{C}/u.test(name) || !Number.isFinite(createdAt.getTime())) throw change();
  const kinds = new Set(rules.map(rule => rule.assignment.kind === "role" ? "role" : "users"));
  if (kinds.size !== 1 || rules.some(rule => rule.assignment.kind === "unassigned")) throw change();
  const domain = rules.find(rule => rule.scope.kind === "domain");
  const database = rules.find(rule => rule.scope.kind === "database");
  const clock = createdAt.toISOString();
  return { id: `catalog-copy-${selection.intentId}`, name, clientId: representative.link.customerId, clientName: representative.clientName,
    targetType: domain ? "domain" : "database", targetIds: [], frequencyType: "once", startDate: selection.day.date,
    endDate: null, timezone: "America/Bogota", assignedRole: (domain ?? database)!.workflowRole,
    ...(domain ? { domainAssignedRole: domain.workflowRole, assignedUserIds: catalogAssignedUsers(domain.assignment) } : { assignedUserIds: [] }),
    ...(database ? { databaseAssignedRole: database.workflowRole, databaseAssignedUserIds: catalogAssignedUsers(database.assignment) } : {}),
    assignmentMode: kinds.has("role") ? "role" : "users", selectionMode: "manual",
    manualTargetTypes: domain && database ? "domains_and_databases" : domain ? "domains_only" : "databases_only",
    origin: "special", active: true, createdAt: clock, createdBy: actorId, updatedAt: clock, updatedBy: actorId };
}

/** Must be invoked by a separately authorized approval channel, never directly from HTTP. */
export function saveApprovedSameDayCatalogCopy(request: SelectionRequest & { name: string }, actor: { id: string; email: string },
  authorizeOperation: ApprovalAuthority) {
  return saveApprovedCatalogCopy(request, actor, authorizeOperation, true);
}

/** Future copies retain their exact intent but freeze only when the historical worker reaches their start. */
export function saveApprovedCatalogCopy(request: SelectionRequest & { name: string }, actor: { id: string; email: string },
  authorizeOperation: ApprovalAuthority, sameDayOnly = false, io = dependencies) {
  if (request.actorId !== actor.id) throw change();
  return io.verify(request, (tx, selection) => materializeVerifiedCatalogCopy(tx, selection, request.name, actor,
    actor.id, authorizeOperation, sameDayOnly, io));
}

/** Internal entry point for an independent approval channel, not an HTTP handler. */
export function materializeApprovedCatalogCopyProposal(
  request: Parameters<typeof withFreshCatalogCopyPreview>[0] & { proposalId: string },
  requester: { id: string; email: string }, verifiedApproverId: string, authorizeOperation: ApprovalAuthority,
  io = { ...dependencies, fresh: withFreshCatalogCopyPreview, readProposal: readStoredCatalogCopyProposalInTransaction },
) {
  if (request.actorId !== requester.id || !verifiedApproverId || verifiedApproverId === requester.id) throw change();
  return materializeStoredProposal(request, requester, verifiedApproverId, authorizeOperation, io);
}

/** Requester can consume a protected receipt; reviewer identity is obtained only from its SQL record. */
export function materializeReviewedCatalogCopyProposal(
  request: Parameters<typeof withFreshCatalogCopyPreview>[0] & { proposalId: string; reviewId: string },
  requester: { id: string; email: string },
  io = { ...dependencies, fresh: withFreshCatalogCopyPreview, readProposal: readStoredCatalogCopyProposalInTransaction,
    consume: consumeSqlCatalogCopyReviewInTransaction },
) {
  if (request.actorId !== requester.id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.reviewId)) throw change();
  return materializeStoredProposal(request, requester, undefined, async (tx, bound) => {
    if (bound.proposalId !== request.proposalId || !bound.copyVersion) throw change();
    return io.consume(tx, { environment: bound.environment, proposalId: bound.proposalId,
      reviewId: request.reviewId, copyVersion: bound.copyVersion });
  }, io);
}

function materializeStoredProposal(
  request: Parameters<typeof withFreshCatalogCopyPreview>[0] & { proposalId: string },
  requester: { id: string; email: string }, verifiedApproverId: string | undefined, authorizeOperation: ApprovalAuthority,
  io: typeof dependencies & { fresh: typeof withFreshCatalogCopyPreview; readProposal: typeof readStoredCatalogCopyProposalInTransaction },
) {
  return io.fresh(request, async (tx, prepared, preview, proofValidUntil, tightenDeadline) => {
    const proposal = await io.readProposal(tx, request.proposalId, request.portalEnvironment);
    const origin = prepared.day.previewOrigin;
    if (!proposal || proposal.proposalId !== request.proposalId || proposal.environment !== request.portalEnvironment ||
        proposal.requesterId !== requester.id || proposal.scheduleId !== origin.scheduleId ||
        proposal.scheduleVersion !== origin.scheduleVersion || proposal.operationId !== origin.operationId ||
        proposal.date !== prepared.day.date) throw change();
    const selected = matchStoredCatalogCopySelection(proposal, preview.candidates);
    if (!selected) throw change();
    return materializeVerifiedCatalogCopy(tx, { ...prepared, intentId: proposal.proposalId, selected, proofValidUntil, tightenDeadline },
      proposal.name, requester, verifiedApproverId, authorizeOperation, false, io, proposal.proposalId);
  });
}

async function materializeVerifiedCatalogCopy(tx: sql.Transaction, selection: VerifiedSelection, name: string,
  actor: { id: string; email: string }, approverId: string | undefined, authorizeOperation: ApprovalAuthority,
  sameDayOnly: boolean, io: Omit<typeof dependencies, "verify">, proposalId?: string) {
    const { recordset } = await tx.request().query<{ now: Date }>("SELECT SYSUTCDATETIME() AS now;");
    const now = recordset[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now >= selection.proofValidUntil) throw change();
    const today = new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
    if (selection.day.date < today || (sameDayOnly && selection.day.date !== today)) throw change();
    const record = buildCatalogCopyDefinition(selection, name.trim(), actor.id, now);
    const origin = selection.day.previewOrigin;
    const links = selection.selected.map(link => {
      if (!link.targetId || link.state !== "ready") throw change();
      return { linkId: link.linkId, kind: link.kind, targetId: link.targetId };
    });
    const environment = selection.day.portalEnvironment;
    const saved = await io.insert(tx, { intentId: selection.intentId, portalEnvironment: environment,
      originalScheduleId: origin.scheduleId, originalDefinitionVersion: origin.scheduleVersion, operationId: origin.operationId,
      taskDate: selection.day.date, links }, record, actor, async (transaction, copy, _intent, definitionVersion, physicalValidUntil) => {
      let proofValidUntil = new Date(Math.min(selection.proofValidUntil.getTime(), physicalValidUntil.getTime(),
        ...selection.selected.map(chosen => Date.parse(selection.day.inventory.find(item => item.link.linkId === chosen.linkId)
          ?.sourceEvidence?.verifiedUntil ?? ""))));
      if (!Number.isFinite(proofValidUntil.getTime()) || now >= proofValidUntil) throw change();
      selection.tightenDeadline(proofValidUntil);
      // The callback is trusted server code. The independent approval row is checked again below.
      const reviewDeadline = await authorizeOperation(transaction, { environment, copyId: copy.id, originalId: origin.scheduleId,
        originalVersion: origin.scheduleVersion, operationId: origin.operationId, ...(approverId && { approverId }),
        ...(proposalId && { proposalId, copyVersion: definitionVersion }) });
      if (reviewDeadline) {
        if (!(reviewDeadline instanceof Date) || !Number.isFinite(reviewDeadline.getTime()) || reviewDeadline <= now) throw change();
        proofValidUntil = new Date(Math.min(proofValidUntil.valueOf(), reviewDeadline.valueOf()));
        selection.tightenDeadline(proofValidUntil);
      }
      if (today !== selection.day.date) {
        const approvals = await io.readApproval(transaction, environment,
          [{ scheduleId: copy.id, scheduleVersion: definitionVersion }]);
        if (approvals.get(copy.id)?.operationId !== origin.operationId) throw change();
        return;
      }
      await io.activate(transaction, { record: copy, definitionVersion, intentId: selection.intentId,
        day: selection.day, selected: selection.selected, expectedOperationId: origin.operationId,
        certifiedAt: now, proofValidUntil });
    });
    if (proposalId && saved.status === "replayed" && !await confirmReviewedCatalogCopyReplayInTransaction(tx, {
      environment, proposalId, copyId: saved.id,
    })) throw change();
    return saved;
}
