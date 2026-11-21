import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import sql from "mssql";
import { getSqlPool } from "./sql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

const statuses = ["pending_approval", "expired", "changed", "scheduled", "active", "held", "cancelled", "removed"] as const;
type ProposalStatus = typeof statuses[number];
export type CatalogCopyProposalSummary = { id: string; name: string; date: string; status: ProposalStatus };
const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/\p{C}/u.test(value);
const validId = (id: unknown): id is string => validText(id, 150) && !/[\/\\]/.test(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const catalogCopyProposalListSql = `
  DECLARE @now datetime2(3)=SYSUTCDATETIME(),@today date=CONVERT(date,DATEADD(hour,-5,SYSUTCDATETIME()));
  SELECT TOP (20) LOWER(CONVERT(char(36),p.proposal_id)) AS id,p.requested_name AS [name],
    CONVERT(char(10),p.requested_date,23) AS [date],
    CASE WHEN copy.deleted_at IS NOT NULL THEN 'removed'
      WHEN copy.completed_at IS NOT NULL THEN 'cancelled'
      WHEN i.intent_id IS NOT NULL AND (a.schedule_key IS NULL OR copy.catalog_activation_enabled<>1) THEN 'held'
      WHEN proof.activation_state='cancelled' THEN 'cancelled'
      WHEN i.intent_id IS NOT NULL AND copy.active<>1 THEN 'held'
      WHEN proof.activation_state='frozen' THEN 'active'
      WHEN i.intent_id IS NOT NULL AND p.requested_date>@today THEN 'scheduled'
      WHEN i.intent_id IS NOT NULL THEN 'held'
      WHEN p.requested_date<@today THEN 'expired'
      WHEN original.deleted_at IS NOT NULL OR original.active<>1 OR original.row_version<>p.original_definition_version THEN 'changed'
      ELSE 'pending_approval' END AS [status]
  FROM scheduling.catalog_schedule_copy_proposals p
  JOIN scheduling.update_schedules original ON original.schedule_key=p.original_schedule_key
  LEFT JOIN scheduling.catalog_schedule_copy_intents i ON i.intent_id=p.proposal_id AND i.portal_environment=p.portal_environment
    AND i.original_schedule_key=p.original_schedule_key AND i.original_definition_version=p.original_definition_version
    AND i.actor_source_id=p.requester_source_id AND i.operation_id=p.operation_id
  LEFT JOIN scheduling.update_schedules copy ON copy.schedule_key=i.copy_schedule_key
  LEFT JOIN scheduling.catalog_schedule_operation_approvals a ON a.schedule_key=copy.schedule_key AND a.schedule_version=copy.row_version
    AND a.portal_environment=p.portal_environment AND a.operation_id=p.operation_id AND a.retired_at IS NULL AND a.approved_at<=@now
  LEFT JOIN scheduling.catalog_schedule_activation_snapshots proof ON proof.schedule_key=copy.schedule_key
    AND proof.definition_version=copy.row_version AND proof.portal_environment=p.portal_environment AND proof.sealed_at IS NOT NULL
  WHERE p.portal_environment=@env COLLATE Latin1_General_100_BIN2 AND p.requester_source_id=@actor COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(p.requester_source_id)=DATALENGTH(@actor)
    AND original.source_id=@original COLLATE Latin1_General_100_BIN2 AND DATALENGTH(original.source_id)=DATALENGTH(@original)
  ORDER BY p.created_at DESC,p.proposal_id DESC;`;

export async function listOwnCatalogCopyProposals(actorId: string, scheduleId: string, environment: CatalogEnvironment) {
  if (!validId(actorId) || !validId(scheduleId) || !["qa", "production"].includes(environment)) throw new Error("copy_proposal_list_invalid");
  const { recordset } = await (await getSqlPool()).request().input("env", sql.VarChar(10), environment)
    .input("actor", sql.NVarChar(150), actorId).input("original", sql.NVarChar(150), scheduleId)
    .query(catalogCopyProposalListSql);
  return readCatalogProposalSummaries(recordset);
}

export function readCatalogProposalSummaries(rows: unknown): CatalogCopyProposalSummary[] {
  if (!Array.isArray(rows) || rows.length > 20) throw new Error("copy_proposal_list_invalid");
  const seen = new Set<string>();
  return rows.map(row => {
    if (!row || typeof row.id !== "string" || !uuid.test(row.id) || seen.has(row.id) || !validText(row.name, 200) ||
        typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !statuses.includes(row.status)) {
      throw new Error("copy_proposal_list_invalid");
    }
    seen.add(row.id);
    return { id: row.id, name: row.name, date: row.date, status: row.status };
  });
}

export function createCatalogCopyProposalListHttp(io: {
  authorize: (request: HttpRequest) => Promise<{ actorId: string } | { status: 401 | 403 }>;
  list: (actorId: string, originalId: string) => Promise<readonly CatalogCopyProposalSummary[]>;
}) {
  const reply = (status: number, jsonBody: unknown): HttpResponseInit =>
    ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
  return async (request: HttpRequest) => {
    try {
      const actor = await io.authorize(request);
      if ("status" in actor) return reply(actor.status, { error: "No tiene acceso a las solicitudes de copia." });
      if (!validId(request.params.id) || [...request.query.keys()].length) return reply(400, { error: "Indique una programación válida." });
      return reply(200, { items: readCatalogProposalSummaries(await io.list(actor.actorId, request.params.id)) });
    } catch { return reply(503, { error: "No se pudieron consultar sus solicitudes de copia." }); }
  };
}
