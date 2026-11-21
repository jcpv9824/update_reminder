import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import sql from "mssql";
import { z } from "zod";
import { withVerifiedCatalogCopySelection } from "./catalogScheduleCopyPreview";

type Request = Parameters<typeof withVerifiedCatalogCopySelection>[0];
type ActorScope = Pick<Request, "actorId" | "allowedKinds" | "allowLicensing">;
type Proposal = Readonly<{ proposalId: string; status: "pending_approval" }>;
type ProposalLink = Readonly<{ linkId: string; kind: "domain" | "database"; physicalId: string }>;
export type StoredCatalogCopyProposal = Readonly<{
  proposalId: string; requesterId: string; environment: Request["portalEnvironment"]; scheduleId: string;
  scheduleVersion: string; operationId: string; date: string; name: string; links: readonly ProposalLink[];
}>;
const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const hour = 3_600_000;
const changed = () => Object.assign(new Error("catalog_copy_proposal_changed"), { status: 409 });
const bodySchema = z.strictObject({
  name: z.string().trim().min(1).max(200).refine(name => !/\p{C}/u.test(name)),
  date: z.string().regex(datePattern).refine(date => Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date),
  previewId: z.string().min(1).max(140),
  linkIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(5000)
    .refine(links => new Set(links).size === links.length),
});

function proposalDigest(proposal: StoredCatalogCopyProposal) {
  const links = [...proposal.links].sort((a,b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0)
    .map(({ linkId, kind, physicalId }) => ({ linkId, kind, physicalId }));
  return createHash("sha256").update(JSON.stringify(["portal-sag:copy-proposal:v1", proposal.proposalId,
    proposal.requesterId, proposal.environment, proposal.scheduleId, proposal.scheduleVersion, proposal.operationId,
    proposal.date, proposal.name, links])).digest();
}

/** Load the normalized proposal in the approval transaction; never trust a client-supplied definition. */
export async function readStoredCatalogCopyProposalInTransaction(transaction: sql.Transaction,
  proposalId: string, environment: Request["portalEnvironment"]): Promise<StoredCatalogCopyProposal | null> {
  if (!id.test(proposalId) || (environment !== "qa" && environment !== "production")) return null;
  const { recordsets } = await transaction.request().input("proposal", sql.UniqueIdentifier, proposalId)
    .input("environment", sql.VarChar(10), environment).query(`
      SELECT s.source_id AS scheduleId,LOWER(CONVERT(char(16),p.original_definition_version,2)) AS scheduleVersion,
        p.requester_source_id AS requesterId,p.operation_id AS operationId,CONVERT(char(10),p.requested_date,23) AS [date],
        p.requested_name AS [name],p.request_sha256 AS digest
      FROM scheduling.catalog_schedule_copy_proposals p WITH (UPDLOCK,HOLDLOCK)
      JOIN scheduling.update_schedules s WITH (HOLDLOCK) ON s.schedule_key=p.original_schedule_key
      WHERE p.proposal_id=@proposal AND p.portal_environment=@environment;
      SELECT TOP (5001) LOWER(CONVERT(char(36),link_id)) AS linkId,kind,
        LOWER(CONVERT(char(36),physical_target_id)) AS physicalId
      FROM scheduling.catalog_schedule_copy_proposal_links WITH (HOLDLOCK)
      WHERE proposal_id=@proposal ORDER BY link_id;`);
  if (!Array.isArray(recordsets) || recordsets.length !== 2 || recordsets[0].length !== 1 ||
      !recordsets[1].length || recordsets[1].length > 5000) return null;
  const [meta] = recordsets[0];
  const links = recordsets[1] as ProposalLink[];
  if (!meta || !/^[a-f0-9]{16}$/.test(meta.scheduleVersion ?? "") || !datePattern.test(meta.date ?? "") ||
      !Buffer.isBuffer(meta.digest) || meta.digest.length !== 32 ||
      ![meta.scheduleId, meta.requesterId, meta.operationId, meta.name].every(value =>
        typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200 && !/\p{C}/u.test(value)) ||
      new Set(links.map(link => link.linkId)).size !== links.length || links.some(link => !id.test(link.linkId) ||
        !id.test(link.physicalId) || (link.kind !== "domain" && link.kind !== "database"))) return null;
  const data: StoredCatalogCopyProposal = { proposalId, environment, requesterId: meta.requesterId,
    scheduleId: meta.scheduleId, scheduleVersion: meta.scheduleVersion, operationId: meta.operationId,
    date: meta.date, name: meta.name, links };
  return meta.digest.equals(proposalDigest(data)) ? data : null;
}

/** Match all the stored logical/physical pins against one freshly recomputed preview. */
export function matchStoredCatalogCopySelection(proposal: StoredCatalogCopyProposal,
  preview: readonly import("./catalogScheduleConflictSelection").ScheduleConflictCandidate[]) {
  if (!proposal.links.length || new Set(preview.map(row => row.linkId)).size !== preview.length) return null;
  const blocked = new Set(preview.filter(row => row.state === "conflict")
    .map(row => JSON.stringify([row.kind, row.targetId])));
  const byId = new Map(preview.map(row => [row.linkId, row]));
  const selected = proposal.links.map(pin => {
    const row = byId.get(pin.linkId);
    return row && row.state === "ready" && row.kind === pin.kind && row.targetId === pin.physicalId &&
      !blocked.has(JSON.stringify([row.kind, row.targetId])) ? row : null;
  });
  return selected.every(row => row !== null) ? selected : null;
}

/** A proposal is deliberately not a scheduling aggregate and cannot trigger work. */
export function requestCatalogScheduleCopyProposal(input: Request & { name: string },
  verify = withVerifiedCatalogCopySelection): Promise<Proposal | null> {
  return verify(input, async (tx, selection) => {
    const proposalId = selection.intentId;
    const { previewOrigin: origin, portalEnvironment, date } = selection.day;
    if (!id.test(proposalId) || input.name !== input.name.trim() || !input.name || input.name.length > 200 ||
        /\p{C}/u.test(input.name) || date !== input.date) throw changed();
    const links = selection.selected.map(link => {
      if (link.state !== "ready" || !id.test(link.linkId) || !link.targetId || !id.test(link.targetId) ||
          (link.kind !== "domain" && link.kind !== "database")) throw changed();
      return { linkId: link.linkId, kind: link.kind, physicalId: link.targetId };
    }).sort((a,b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);
    if (!links.length || links.length > 5000 || new Set(links.map(link => link.linkId)).size !== links.length) throw changed();
    const digest = proposalDigest({ proposalId, requesterId: input.actorId, environment: portalEnvironment,
      scheduleId: origin.scheduleId, scheduleVersion: origin.scheduleVersion, operationId: origin.operationId,
      date, name: input.name, links });
    const { recordset } = await tx.request().input("proposal", sql.UniqueIdentifier, proposalId)
      .input("actor", sql.NVarChar(150), input.actorId).input("environment", sql.VarChar(10), portalEnvironment)
      .input("original", sql.NVarChar(150), origin.scheduleId).input("version", sql.VarBinary(8), Buffer.from(origin.scheduleVersion, "hex"))
      .input("operation", sql.NVarChar(200), origin.operationId).input("date", sql.VarChar(10), date)
      .input("name", sql.NVarChar(200), input.name).input("digest", sql.VarBinary(32), digest)
      .input("proofUntil", sql.DateTime2(3), selection.proofValidUntil)
      .input("links", sql.NVarChar(sql.MAX), JSON.stringify(links)).query<{ persisted: boolean }>(`
        SET NOCOUNT ON;
        DECLARE @now datetime2(3)=SYSUTCDATETIME(),@targetDate date=CONVERT(date,@date,23);
        IF @proofUntil<=@now OR @targetDate<CONVERT(date,DATEADD(hour,-5,@now)) RETURN;
        DECLARE @prior binary(32);
        SELECT @prior=p.request_sha256 FROM scheduling.catalog_schedule_copy_proposals p WITH (UPDLOCK,HOLDLOCK)
        WHERE p.proposal_id=@proposal;
        IF @prior IS NOT NULL
        BEGIN
          IF @prior=@digest AND EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_proposals p
            WHERE p.proposal_id=@proposal AND p.requester_source_id=@actor AND p.portal_environment=@environment)
            SELECT CONVERT(bit,1) AS persisted;
          RETURN;
        END;
        INSERT scheduling.catalog_schedule_copy_proposals(proposal_id,original_schedule_key,original_definition_version,
          portal_environment,requester_source_id,operation_id,requested_date,requested_name,request_sha256)
        SELECT @proposal,s.schedule_key,s.row_version,@environment,@actor,@operation,@targetDate,@name,@digest
        FROM scheduling.update_schedules s WITH (HOLDLOCK)
        JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK)
          ON a.schedule_key=s.schedule_key AND a.schedule_version=s.row_version AND a.portal_environment=@environment
          AND a.operation_id=@operation AND a.approved_at<=@now AND a.retired_at IS NULL
        WHERE s.source_id=@original AND s.source_id COLLATE Latin1_General_100_BIN2=@original COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(s.source_id)=DATALENGTH(@original) AND s.active=1 AND s.deleted_at IS NULL AND s.row_version=@version;
        IF @@ROWCOUNT<>1 THROW 57506,N'The schedule proposal origin changed.',1;
        INSERT scheduling.catalog_schedule_copy_proposal_links(proposal_id,link_id,kind,physical_target_id)
        SELECT @proposal,linkId,kind,physicalId FROM OPENJSON(@links)
          WITH (linkId uniqueidentifier,kind varchar(8),physicalId uniqueidentifier);
        SELECT CONVERT(bit,1) AS persisted;
      `);
    if (recordset?.length !== 1 || recordset[0].persisted !== true) throw changed();
    return { proposalId, status: "pending_approval" } as const;
  });
}

export function createCatalogScheduleCopyProposalHttp(io: {
  authorize: (req: HttpRequest) => Promise<ActorScope | { status: 401 | 403 }>;
  submit: (input: Omit<Request, "portalEnvironment" | "matchKeyVersion"> & { name: string }) => Promise<Proposal | null>;
  now?: () => Date;
}) {
  const reply = (status: number, jsonBody: unknown): HttpResponseInit => ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
  const stale = () => reply(409, { error: "No se pudo verificar la selección. Actualice la vista previa." });
  return async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const actor = await io.authorize(req);
      if ("status" in actor) return reply(actor.status, { error: "No tiene acceso a la solicitud de copia." });
      const scheduleId = req.params.id;
      const declared = req.headers.get("content-length");
      if (declared && (!/^\d{1,7}$/.test(declared) || Number(declared) > 400_000)) {
        return reply(413, { error: "La solicitud es demasiado grande." });
      }
      let raw: string;
      try { raw = await req.text(); } catch { return reply(400, { error: "Solicitud inválida." }); }
      if (Buffer.byteLength(raw) > 400_000) return reply(413, { error: "La solicitud es demasiado grande." });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return reply(400, { error: "Solicitud inválida." }); }
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success || !scheduleId || scheduleId.length > 150 || scheduleId !== scheduleId.trim() || /[\p{C}/\\]/u.test(scheduleId)) {
        return reply(400, { error: "Indique una programación, fecha y selección válidas." });
      }
      const checkedAt = io.now?.() ?? new Date();
      const today = new Date(checkedAt.getTime() - 5 * hour).toISOString().slice(0, 10);
      if (parsed.data.date < today || Date.parse(parsed.data.date) - Date.parse(today) > 7 * 24 * hour) return stale();
      const submission = await io.submit({ ...actor, scheduleId, checkedAt, ...parsed.data });
      return submission ? reply(202, submission) : stale();
    } catch (error) {
      if ((error as { status?: number; number?: number } | null)?.status === 409 ||
          (error as { number?: number } | null)?.number === 57506) return stale();
      return reply(503, { error: "No fue posible guardar la solicitud de copia." });
    }
  };
}
