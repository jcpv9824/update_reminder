import sql from "mssql";
import { getSqlPool } from "./sql";
import type { CatalogTaskFailure, CatalogTaskKind, CatalogTaskOccurrence, CatalogTaskOccurrenceLink } from "./catalogTaskTargetPlanning";
import type { Environment, UpdateTask } from "../types/models";

type CatalogExecutionLookup = { executionKey: string } | { taskId: string };
type CatalogExecutionEventKind = "registered" | "cutoff_checked" | "occurrence_retired" |
  "hidden" | "restored" | "link_retired";

export type CatalogExecutionSource = {
  scheduleId: string;
  attachedAt: number;
  detachedAt: number | null;
};

export type CatalogExecutionLink = {
  linkId: string;
  clientId: string;
  domainId: string;
  databaseId: string | null;
  catalogSourceId: string | null;
  catalogRecordId: string;
  environment: Environment;
  state: CatalogTaskOccurrenceLink["state"];
  reason: CatalogTaskFailure | null;
  lastEvidenceAt: number | null;
  retiredAt: number | null;
  schedules: CatalogExecutionSource[];
  etag: string;
};

export type CatalogExecutionSnapshot = {
  executionKey: string;
  taskId: string;
  workflowStatus: UpdateTask["status"];
  kind: CatalogTaskKind;
  operationId: string;
  initialCatalogRevisionId: string;
  occurrence: CatalogTaskOccurrence;
  links: CatalogExecutionLink[];
  etag: string;
};

type ExecutionRow = {
  execution_key_hex: string;
  task_id: string;
  workflow_status: UpdateTask["status"];
  execution_kind: CatalogTaskKind;
  operation_id: string;
  initial_catalog_revision_id: string;
  occurrence_id: string;
  verified_target_id: string;
  cutoff_ms: number | string;
  last_checked_ms: number | string | null;
  cutoff_evaluated_ms: number | string | null;
  retired_ms: number | string | null;
  etag: string;
  links_json: string;
};

type HistoryRow = {
  event_key: string;
  link_id: string | null;
  event_kind: CatalogExecutionEventKind;
  event_reason: CatalogTaskFailure | null;
  occurred_ms: number | string;
};

const EPOCH = "CONVERT(datetime2(3), '1970-01-01T00:00:00.000', 126)";

function executionKeyParameter(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("La clave de ejecución del catálogo es inválida.");
  return Buffer.from(value, "hex");
}

function taskIdParameter(value: string): string {
  if (!value || value.length > 260 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("El identificador de tarea de catálogo es inválido.");
  }
  return value;
}

function epochMilliseconds(value: number | string): number {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Hora de ejecución del catálogo inválida.");
  return milliseconds;
}

function mapOccurrenceLink(link: CatalogExecutionLink): CatalogTaskOccurrenceLink {
  const base = {
    linkId: link.linkId,
    ...(link.lastEvidenceAt === null ? {} : { lastEvidenceAt: epochMilliseconds(link.lastEvidenceAt) }),
  };
  if (link.state === "active") return { ...base, state: "active" };
  if ((link.state !== "hidden" && link.state !== "retired") ||
    (link.reason !== "not_found" && link.reason !== "unverifiable")) {
    throw new Error("Estado de vínculo de ejecución del catálogo inválido.");
  }
  return { ...base, state: link.state, reason: link.reason };
}

/**
 * Internal metadata read. Do not expose all links via a public task endpoint:
 * per-client, per-role, and per-link visibility must first be enforced by callers.
 * These row versions are only observations, not a permission or an atomic update.
 */
export async function readCatalogTaskExecution(lookup: CatalogExecutionLookup): Promise<CatalogExecutionSnapshot | null> {
  const byKey = "executionKey" in lookup;
  const key = byKey ? executionKeyParameter(lookup.executionKey) : taskIdParameter(lookup.taskId);
  const pool = await getSqlPool();
  const request = pool.request();
  if (byKey) request.input("executionKey", sql.VarBinary(32), key);
  else request.input("taskId", sql.NVarChar(260), key);
  const where = byKey ? "e.execution_key=CONVERT(binary(32),@executionKey)" : "task.source_id=@taskId";
  const { recordset } = await request.query<ExecutionRow>(`
    SELECT LOWER(CONVERT(varchar(64),e.execution_key,2)) AS execution_key_hex,
      task.source_id AS task_id, task.status AS workflow_status, e.execution_kind, e.operation_id,
      e.initial_catalog_revision_id, e.occurrence_id, e.verified_target_id,
      DATEDIFF_BIG(MILLISECOND,${EPOCH},e.cutoff_at) AS cutoff_ms,
      DATEDIFF_BIG(MILLISECOND,${EPOCH},e.last_checked_at) AS last_checked_ms,
      DATEDIFF_BIG(MILLISECOND,${EPOCH},e.cutoff_evaluated_at) AS cutoff_evaluated_ms,
      DATEDIFF_BIG(MILLISECOND,${EPOCH},e.retired_at) AS retired_ms,
      LOWER(CONVERT(varchar(16),e.row_version,2)) AS etag,
      (SELECT link.link_id AS linkId,
          client.source_id AS clientId, domain_row.source_id AS domainId, db.source_id AS databaseId,
          CONVERT(varchar(36),source.source_id) AS catalogSourceId, link.catalog_record_id AS catalogRecordId,
          link.link_environment AS environment, link.link_state AS state, link.state_reason AS reason,
          DATEDIFF_BIG(MILLISECOND,${EPOCH},link.last_evidence_at) AS lastEvidenceAt,
          DATEDIFF_BIG(MILLISECOND,${EPOCH},link.retired_at) AS retiredAt,
          LOWER(CONVERT(varchar(16),link.row_version,2)) AS etag,
          JSON_QUERY((SELECT schedule.source_id AS scheduleId,
              DATEDIFF_BIG(MILLISECOND,${EPOCH},provenance.attached_at) AS attachedAt,
              DATEDIFF_BIG(MILLISECOND,${EPOCH},provenance.detached_at) AS detachedAt
            FROM workflow.catalog_task_execution_sources provenance
            INNER JOIN scheduling.update_schedules schedule ON schedule.schedule_key=provenance.schedule_key
            WHERE provenance.catalog_execution_link_key=link.catalog_execution_link_key
            ORDER BY provenance.schedule_key
            FOR JSON PATH, INCLUDE_NULL_VALUES)) AS schedules
        FROM workflow.catalog_task_execution_links link
        INNER JOIN core.clients client ON client.client_key=link.client_key
        INNER JOIN core.domains domain_row ON domain_row.domain_key=link.domain_key AND domain_row.client_key=link.client_key
        LEFT JOIN core.databases db ON db.database_key=link.database_key AND db.domain_key=link.domain_key
          AND db.client_key=link.client_key
        LEFT JOIN settings.catalog_source_bindings source ON source.catalog_source_key=link.catalog_source_key
        WHERE link.catalog_execution_key=e.catalog_execution_key
        ORDER BY link.catalog_execution_link_key
        FOR JSON PATH, INCLUDE_NULL_VALUES) AS links_json
    FROM workflow.catalog_task_executions e
    INNER JOIN workflow.update_tasks task ON task.task_key=e.task_key AND task.target_type=e.execution_kind
    WHERE ${where};
  `);
  const row = recordset[0];
  if (!row) return null;
  const links: CatalogExecutionLink[] = JSON.parse(row.links_json);
  if (!Array.isArray(links)) throw new Error("Vínculos de ejecución del catálogo inválidos.");
  const state = row.workflow_status === "completed" ? "completed"
    : row.retired_ms !== null || row.workflow_status === "cancelled" ? "retired" : "open";
  return {
    executionKey: row.execution_key_hex, taskId: row.task_id, workflowStatus: row.workflow_status,
    kind: row.execution_kind, operationId: row.operation_id, initialCatalogRevisionId: row.initial_catalog_revision_id,
    occurrence: {
      occurrenceId: row.occurrence_id,
      targetId: row.verified_target_id,
      state,
      cutoffAt: epochMilliseconds(row.cutoff_ms),
      ...(row.last_checked_ms === null ? {} : { lastCheckedAt: epochMilliseconds(row.last_checked_ms) }),
      ...(row.cutoff_evaluated_ms === null ? {} : { cutoffEvaluatedAt: epochMilliseconds(row.cutoff_evaluated_ms) }),
      links: links.map(mapOccurrenceLink),
    },
    links,
    etag: row.etag,
  };
}

function cursorParameter(value: string | undefined): string {
  if (value === undefined) return "0";
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new Error("El cursor de historial del catálogo es inválido.");
  }
  return value;
}

/** Internal append-only history projection, with a bounded increasing key cursor. */
export async function readCatalogTaskExecutionHistory(input: {
  executionKey: string;
  afterEventKey?: string;
  limit?: number;
}): Promise<{
  events: { eventKey: string; linkId: string | null; kind: CatalogExecutionEventKind; reason: CatalogTaskFailure | null;
    occurredAt: number }[];
  nextEventKey: string | null;
}> {
  const key = executionKeyParameter(input.executionKey);
  const afterEventKey = cursorParameter(input.afterEventKey);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("El límite de historial del catálogo es inválido.");
  const pool = await getSqlPool();
  const { recordset } = await pool.request()
    .input("executionKey", sql.VarBinary(32), key)
    // Pass decimal text to avoid precision loss in JavaScript/driver bigint encoding.
    .input("afterEventKey", sql.VarChar(19), afterEventKey)
    .input("take", sql.Int, limit + 1)
    .query<HistoryRow>(`
      SELECT TOP (@take) CONVERT(varchar(19),event.catalog_execution_event_key) AS event_key,
        link.link_id, event.event_kind, event.event_reason,
        DATEDIFF_BIG(MILLISECOND,${EPOCH},event.occurred_at) AS occurred_ms
      FROM workflow.catalog_task_executions e
      INNER JOIN workflow.catalog_task_execution_events event ON event.catalog_execution_key=e.catalog_execution_key
      LEFT JOIN workflow.catalog_task_execution_links link ON link.catalog_execution_key=event.catalog_execution_key
        AND link.catalog_execution_link_key=event.catalog_execution_link_key
      WHERE e.execution_key=CONVERT(binary(32),@executionKey)
        AND event.catalog_execution_event_key>CONVERT(bigint,@afterEventKey)
      ORDER BY event.catalog_execution_event_key;
    `);
  const events = recordset.slice(0, limit).map(row => ({
    eventKey: row.event_key, linkId: row.link_id, kind: row.event_kind, reason: row.event_reason,
    occurredAt: epochMilliseconds(row.occurred_ms),
  }));
  return { events, nextEventKey: recordset.length > limit ? events.at(-1)!.eventKey : null };
}
