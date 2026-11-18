import sql from "mssql";
import type { CatalogExecutionSnapshot } from "./catalogExecutionSqlRepository";
import {
  reconcileCatalogTaskOccurrence, type CatalogTaskFailure, type CatalogTaskObservation,
  type CatalogTaskOccurrenceTransition,
} from "./catalogTaskTargetPlanning";
import { runSqlTransaction } from "./sqlTransaction";

type ReconcileInput = Readonly<{
  snapshot: CatalogExecutionSnapshot;
  checkedAt: number;
  observations: readonly CatalogTaskObservation[];
}>;

type ReconcileResult = "updated" | "superseded" | "unchanged";
const rowVersion = /^[0-9a-f]{16}$/i;
const executionKey = /^[0-9a-f]{64}$/i;
const MAX_LINKS = 10_000;

function version(value: string): Buffer {
  if (!rowVersion.test(value)) throw new Error("catalog_reconciliation_version_invalid");
  return Buffer.from(value, "hex");
}

function instant(value: number): Date {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) throw new Error("catalog_reconciliation_date_invalid");
  return new Date(value);
}

/**
 * Internal write path for a trusted SQL snapshot and source observations. Never accepts
 * HTTP input directly. Preserve task/assignee/schedule rows and append only cutoff events.
 */
export async function persistCatalogTaskCutoffCheck(args: ReconcileInput): Promise<ReconcileResult> {
  const { snapshot, checkedAt, observations } = args;
  if (!executionKey.test(snapshot.executionKey) || snapshot.links.length > MAX_LINKS
    || snapshot.occurrence.links.length !== snapshot.links.length) throw new Error("catalog_reconciliation_invalid");
  const checkedAtDate = instant(checkedAt);
  const expectedVersion = version(snapshot.etag);
  const versions = new Map(snapshot.links.map(link => [link.linkId, version(link.etag).toString("hex")]));
  if (versions.size !== snapshot.links.length) throw new Error("catalog_reconciliation_invalid");
  const result = reconcileCatalogTaskOccurrence({ task: snapshot.occurrence, checkedAt, observations });
  if (result.task === snapshot.occurrence) return "unchanged";
  const atCutoff = result.task.cutoffEvaluatedAt !== undefined;
  const rows = result.task.links.map(link => {
    const expected = versions.get(link.linkId);
    if (!expected || !link.linkId.trim() || link.linkId.length > 260 || /\p{Cc}/u.test(link.linkId)) {
      throw new Error("catalog_reconciliation_invalid");
    }
    return { linkId: link.linkId, expected, state: link.state, reason: "reason" in link ? link.reason : null,
      evidenceAt: link.lastEvidenceAt === undefined ? null : instant(link.lastEvidenceAt).toISOString().slice(0, -1) };
  });
  const events: { type: CatalogTaskOccurrenceTransition["type"] | "cutoff_checked"; linkId: string | null; reason: CatalogTaskFailure | null }[]
    = result.transitions.map(item => ({ type: item.type, linkId: "linkId" in item ? item.linkId : null,
    reason: "reason" in item ? item.reason : null }));
  if (atCutoff) events.push({ type: "cutoff_checked", linkId: null, reason: null });

  return runSqlTransaction(async transaction => {
    const { recordset } = await new sql.Request(transaction)
      .input("executionKey", sql.VarBinary(32), Buffer.from(snapshot.executionKey, "hex"))
      .input("expectedExecutionVersion", sql.VarBinary(8), expectedVersion)
      .input("checkedAt", sql.DateTime2(3), checkedAtDate)
      .input("atCutoff", sql.Bit, atCutoff)
      .input("retired", sql.Bit, result.task.state === "retired")
      .input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows))
      .input("events", sql.NVarChar(sql.MAX), JSON.stringify(events))
      .query<{ status: "updated" | "superseded" }>(applyReconciliation);
    if (recordset.length !== 1 || !["updated", "superseded"].includes(recordset[0].status)) {
      throw new Error("catalog_reconciliation_write_failed");
    }
    return recordset[0].status;
  });
}

const applyReconciliation = `
  SET NOCOUNT ON;
  DECLARE @execution bigint;
  SELECT @execution=e.catalog_execution_key
  FROM workflow.catalog_task_executions AS e WITH (UPDLOCK,HOLDLOCK)
  JOIN workflow.update_tasks AS t WITH (UPDLOCK,HOLDLOCK)
    ON t.task_key=e.task_key AND t.target_type=e.execution_kind
  WHERE e.execution_key=@executionKey AND e.row_version=@expectedExecutionVersion
    AND e.retired_at IS NULL AND e.cutoff_evaluated_at IS NULL
    AND @checkedAt<=SYSUTCDATETIME()
    AND t.status NOT IN ('completed','cancelled')
    AND (e.last_checked_at IS NULL OR e.last_checked_at<=@checkedAt)
    AND ((@atCutoff=1 AND e.cutoff_at<=@checkedAt) OR (@atCutoff=0 AND e.cutoff_at>@checkedAt));
  IF @execution IS NULL
  BEGIN
    SELECT 'superseded' AS status;
    RETURN;
  END;

  DECLARE @desired TABLE (
    link_id nvarchar(260) COLLATE Latin1_General_100_BIN2 PRIMARY KEY,
    expected binary(8) NOT NULL, link_state varchar(12) NOT NULL,
    state_reason varchar(20) NULL, evidence_at datetime2(3) NULL
  );
  INSERT INTO @desired(link_id,expected,link_state,state_reason,evidence_at)
  SELECT linkId, CONVERT(binary(8),expected,2), [state], reason, CONVERT(datetime2(3),evidenceAt,126)
  FROM OPENJSON(@rows) WITH (
    linkId nvarchar(260), expected varchar(16), [state] varchar(12), reason varchar(20), evidenceAt varchar(23)
  );
  IF (SELECT COUNT_BIG(*) FROM @desired)<>
      (SELECT COUNT_BIG(*) FROM workflow.catalog_task_execution_links AS links WITH (UPDLOCK,HOLDLOCK)
       WHERE links.catalog_execution_key=@execution)
    OR EXISTS (
      SELECT 1 FROM @desired AS wanted
      LEFT JOIN workflow.catalog_task_execution_links AS links WITH (UPDLOCK,HOLDLOCK)
        ON links.catalog_execution_key=@execution AND links.link_id=wanted.link_id
      WHERE links.catalog_execution_link_key IS NULL OR links.row_version<>wanted.expected
        OR (links.link_state='retired' AND (wanted.link_state<>'retired' OR links.state_reason<>wanted.state_reason))
    )
  BEGIN
    SELECT 'superseded' AS status;
    RETURN;
  END;

  IF @retired=1 AND (@atCutoff=0 OR EXISTS (SELECT 1 FROM @desired WHERE link_state='active'))
    THROW 53211, N'Invalid catalog task retirement.', 1;
  IF @atCutoff=0 AND EXISTS (
    SELECT 1 FROM @desired AS wanted
    JOIN workflow.catalog_task_execution_links AS links
      ON links.catalog_execution_key=@execution AND links.link_id=wanted.link_id
    WHERE wanted.link_state='retired' AND links.link_state<>'retired'
  )
    THROW 53212, N'Invalid early catalog link retirement.', 1;

  UPDATE links
  SET link_state=wanted.link_state, state_reason=wanted.state_reason,
      last_evidence_at=wanted.evidence_at,
      retired_at=CASE WHEN wanted.link_state='retired' THEN @checkedAt ELSE NULL END
  FROM workflow.catalog_task_execution_links AS links
  JOIN @desired AS wanted ON wanted.link_id=links.link_id AND links.row_version=wanted.expected
  WHERE links.catalog_execution_key=@execution AND links.link_state<>'retired';

  UPDATE workflow.catalog_task_executions
  SET last_checked_at=@checkedAt,
      cutoff_evaluated_at=CASE WHEN @atCutoff=1 THEN @checkedAt ELSE NULL END,
      retired_at=CASE WHEN @retired=1 THEN @checkedAt ELSE NULL END
  WHERE catalog_execution_key=@execution AND row_version=@expectedExecutionVersion;
  IF @@ROWCOUNT<>1
    THROW 53213, N'Catalog task reconciliation conflict.', 1;

  INSERT INTO workflow.catalog_task_execution_events (
    catalog_execution_key,catalog_execution_link_key,event_token,event_kind,event_reason,occurred_at
  )
  SELECT @execution, links.catalog_execution_link_key,
    HASHBYTES('SHA2_256',CONCAT(CONVERT(varchar(64),@executionKey,2), ':',
      CONVERT(varchar(16),@expectedExecutionVersion,2), ':', eventRow.[type], ':',
      COALESCE(CONVERT(varchar(19),links.catalog_execution_link_key),'global'))),
    eventRow.[type],eventRow.reason,@checkedAt
  FROM OPENJSON(@events) WITH ([type] varchar(25),linkId nvarchar(260),reason varchar(20)) AS eventRow
  LEFT JOIN workflow.catalog_task_execution_links AS links ON links.catalog_execution_key=@execution
    AND links.link_id=eventRow.linkId COLLATE Latin1_General_100_BIN2;

  SELECT 'updated' AS status;
`;
