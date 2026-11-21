import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import sql from "mssql";
import { readCatalogProposalSummaries, type CatalogCopyProposalSummary } from "./catalogScheduleCopyProposalList";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSqlPool } from "./sql";

type Actor = { actorId: string; allowedKinds: readonly ("domain" | "database")[]; allowLicensing: boolean };
export const draftProposalListSql = `
  DECLARE @now datetime2(3)=SYSUTCDATETIME(),@today date=CONVERT(date,DATEADD(hour,-5,SYSUTCDATETIME()));
  SELECT TOP (20) LOWER(CONVERT(char(36),p.proposal_id)) AS id,p.name,
    CONVERT(char(10),p.requested_date,23) AS [date],
    CASE WHEN s.deleted_at IS NOT NULL THEN 'removed'
      WHEN s.completed_at IS NOT NULL THEN 'cancelled'
      WHEN d.schedule_key IS NOT NULL AND (a.schedule_key IS NULL OR s.catalog_activation_enabled<>1) THEN 'held'
      WHEN proof.activation_state='cancelled' THEN 'cancelled'
      WHEN d.schedule_key IS NOT NULL AND s.active<>1 THEN 'held'
      WHEN proof.activation_state='frozen' THEN 'active'
      WHEN d.schedule_key IS NOT NULL AND p.requested_date>@today THEN 'scheduled'
      WHEN d.schedule_key IS NOT NULL THEN 'held'
      WHEN p.requested_date<@today THEN 'expired' ELSE 'pending_approval' END AS [status]
  FROM scheduling.catalog_schedule_draft_proposals p
  LEFT JOIN scheduling.v_catalog_schedule_draft_approval d ON d.proposal_id=p.proposal_id AND d.portal_environment=p.portal_environment
  LEFT JOIN scheduling.update_schedules s ON s.schedule_key=d.schedule_key
  LEFT JOIN scheduling.catalog_schedule_operation_approvals a ON a.schedule_key=s.schedule_key AND a.schedule_version=s.row_version
    AND a.schedule_version=d.schedule_version AND a.portal_environment=d.portal_environment AND a.operation_id=d.operation_id
    AND a.approved_at=d.approved_at AND a.retired_at IS NULL AND a.approved_at<=@now
  LEFT JOIN scheduling.catalog_schedule_activation_snapshots proof ON proof.schedule_key=s.schedule_key
    AND proof.definition_version=s.row_version AND proof.portal_environment=d.portal_environment AND proof.sealed_at IS NOT NULL
  WHERE p.portal_environment=@env COLLATE Latin1_General_100_BIN2 AND p.requester_source_id=@actor COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(p.requester_source_id)=DATALENGTH(@actor) AND (p.selection_mode='manual' OR @withLicensing=1)
    AND (p.target_type='database' OR @withDomains=1) AND (p.target_type='domain' OR @withDatabases=1)
  ORDER BY p.created_at DESC,p.proposal_id DESC;`;

export async function listOwnCatalogDraftProposals(actor: Actor, environment: CatalogEnvironment) {
  if (!actor.actorId || actor.actorId.length > 150 || actor.actorId.trim() !== actor.actorId ||
      /\p{C}/u.test(actor.actorId) || !["qa","production"].includes(environment)) throw new Error("catalog_draft_list_invalid");
  const { recordset } = await (await getSqlPool()).request()
    .input("env", sql.VarChar(10), environment).input("actor", sql.NVarChar(150), actor.actorId)
    .input("withLicensing", sql.Bit, actor.allowLicensing)
    .input("withDomains", sql.Bit, actor.allowedKinds.includes("domain"))
    .input("withDatabases", sql.Bit, actor.allowedKinds.includes("database")).query(draftProposalListSql);
  return readCatalogProposalSummaries(recordset);
}

export function createCatalogDraftProposalListHttp(io: {
  authorize(request: HttpRequest): Promise<Actor | { status: 401 | 403 }>;
  list(actor: Actor): Promise<readonly CatalogCopyProposalSummary[]>;
}) {
  const reply = (status: number, jsonBody: unknown): HttpResponseInit => ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
  return async (request: HttpRequest) => {
    try {
      const actor = await io.authorize(request);
      if ("status" in actor) return reply(actor.status, { error: "No tiene acceso a las solicitudes." });
      if ([...request.query.keys()].length) return reply(400, { error: "La lista no admite filtros externos." });
      return reply(200, { items: readCatalogProposalSummaries(await io.list(actor)) });
    } catch { return reply(503, { error: "No se pudieron consultar sus solicitudes." }); }
  };
}
