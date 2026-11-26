import sql from "mssql";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { ChecklistError, checklistProgress, mayWriteChecklist } from "./checklistDomain";

export type ChecklistActor = { id: string; email: string; canView: boolean; canCreate: boolean; isSuperAdmin: boolean };
type RequestSource = Pick<sql.ConnectionPool, "request"> | Pick<sql.Transaction, "request">;
type ChecklistRow = {
  id: string; clientId: string; clientName: string; templateId: string; templateName: string; versionNumber: number;
  environment: "testing" | "production" | "demo" | null; status: "in_progress" | "completed";
  ownerId: string; ownerName: string; createdAt: Date; completedAt: Date | null;
  checkedCount: number; pointCount: number; rowVersion: Buffer;
};
type PointRow = { id: string; position: number; title: string; detail: string | null; checked: boolean; notesJson: string | null };
type EvidenceRow = {
  id: string; pointId: string; kind: "image" | "video" | "file" | "link" | "text"; status: "saved";
  url: string | null; text: string | null; fileName: string | null; contentType: string | null; sizeBytes: number | string | null;
};
type CurrentTemplate = { id: string; name: string; number: number; requiresEnvironment: boolean };
export type ChecklistQuery = { status?: "in_progress" | "completed"; q?: string; page: number };

export function requireChecklistView(actor: ChecklistActor) {
  if (!actor.canView && !actor.isSuperAdmin) throw new ChecklistError(403, "forbidden", "No tiene permiso para ver checklists.");
}

const from = `FROM implementation.implementation_checklists c
  JOIN implementation.checklist_templates t ON t.id=c.template_id
  JOIN implementation.checklist_template_versions v ON v.id=c.version_id AND v.template_id=c.template_id
  JOIN security.users u ON u.user_key=c.owner_user_id`;
const progress = `OUTER APPLY (
  SELECT COUNT(*) AS pointCount, COALESCE(SUM(CONVERT(int,p.checked)),0) AS checkedCount
  FROM implementation.implementation_checklist_points p WHERE p.checklist_id=c.id
) AS a`;
const summary = `c.id, c.client_id AS clientId, c.client_name_snapshot AS clientName, c.template_id AS templateId,
  t.name AS templateName, v.number AS versionNumber, c.environment, c.status, u.source_id AS ownerId, u.display_name AS ownerName,
  c.created_at AS createdAt, c.completed_at AS completedAt, a.pointCount, a.checkedCount, c.row_version AS rowVersion`;

export function projectChecklistSummary(row: ChecklistRow, actor: ChecklistActor) {
  const owner = mayWriteChecklist(actor, row.ownerId);
  return {
    id: row.id.toLowerCase(), clientId: row.clientId.toLowerCase(), clientName: row.clientName, templateId: row.templateId.toLowerCase(),
    templateName: row.templateName, versionNumber: row.versionNumber, environment: row.environment, status: row.status,
    ownerId: row.ownerId, ownerName: row.ownerName, progress: checklistProgress(row.checkedCount, row.pointCount),
    createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
    canEdit: owner && row.status === "in_progress", canDelete: owner,
  };
}

/** API-01: counts are filtered by name, independent of the current tab. */
export async function listChecklists(actor: ChecklistActor, filters: ChecklistQuery, source?: RequestSource) {
  requireChecklistView(actor);
  const db = source ?? await getSqlPool();
  const pageSize = 25;
  const result = await db.request()
    .input("query", sql.NVarChar(403), filters.q ? `%${filters.q.replace(/[~%_\[]/g, "~$&")}%` : null)
    .input("status", sql.VarChar(12), filters.status ?? null)
    .input("offset", sql.Int, (filters.page - 1) * pageSize)
    .input("pageSize", sql.Int, pageSize)
    .input("canCreate", sql.Bit, actor.canCreate || actor.isSuperAdmin)
    .query(`
      SET NOCOUNT ON;
      DECLARE @scope table(id uniqueidentifier PRIMARY KEY, status varchar(12), created_at datetime2(3));
      INSERT @scope SELECT c.id,c.status,c.created_at FROM implementation.implementation_checklists c
        JOIN implementation.checklist_templates t ON t.id=c.template_id
        WHERE c.deleted_at IS NULL AND (@query IS NULL
          OR c.client_name_snapshot COLLATE Latin1_General_100_CI_AI LIKE @query ESCAPE N'~'
          OR t.name COLLATE Latin1_General_100_CI_AI LIKE @query ESCAPE N'~');
      SELECT COUNT(*) AS [all],
        COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END),0) AS inProgress,
        COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed FROM @scope;
      ;WITH page_ids AS (SELECT id FROM @scope WHERE @status IS NULL OR status=@status ORDER BY created_at DESC,id
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY)
      SELECT ${summary} ${from} JOIN page_ids pg ON pg.id=c.id ${progress}
      WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC,c.id;
      SELECT t.id,t.name,v.number,v.requires_environment AS requiresEnvironment
      FROM implementation.checklist_templates t JOIN implementation.checklist_template_versions v ON v.template_id=t.id
      WHERE @canCreate=1 AND t.deleted_at IS NULL AND v.deleted_at IS NULL AND v.status='current' ORDER BY t.name,t.id;
    `);
  if (result.recordsets.length !== 3) throw new Error("Unexpected checklist list result shape.");
  const [countRows, rows, templates] = result.recordsets as unknown as [
    { all: number; inProgress: number; completed: number }[], ChecklistRow[], CurrentTemplate[],
  ];
  const counts = countRows[0];
  return {
    items: rows.map((row) => projectChecklistSummary(row, actor)), counts,
    total: filters.status === "in_progress" ? counts.inProgress : filters.status === "completed" ? counts.completed : counts.all,
    page: filters.page, pageSize,
    ...(actor.canCreate || actor.isSuperAdmin ? { availableTemplates: templates } : {}),
  };
}

/** API-04: read the pinned version, never the template's current pointer. Pending uploads are session-local. */
export async function readChecklist(actor: ChecklistActor, id: string, source?: RequestSource): Promise<Awaited<ReturnType<typeof readChecklistDetail>>> {
  requireChecklistView(actor);
  if (source) return readChecklistDetail(actor, id, source);
  const pool = await getSqlPool();
  const lookup = await pool.request().input("id", sql.UniqueIdentifier, id).query<{ templateId: string }>(
    "SELECT template_id AS templateId FROM implementation.implementation_checklists WHERE id=@id AND deleted_at IS NULL;",
  );
  const templateId = lookup.recordset[0]?.templateId;
  if (!templateId) throw new ChecklistError(404, "not_found", "No se encontró el checklist.");
  return runSqlTransaction(async (tx) => {
    // Same lock order as writes; template_id is immutable once the checklist exists.
    await tx.request().input("templateId", sql.UniqueIdentifier, templateId).query(
      "SELECT id FROM implementation.checklist_templates WITH(HOLDLOCK) WHERE id=@templateId;",
    );
    await tx.request().input("id", sql.UniqueIdentifier, id).query(
      "SELECT id FROM implementation.implementation_checklists WITH(HOLDLOCK) WHERE id=@id;",
    );
    return readChecklistDetail(actor, id, tx);
  });
}

async function readChecklistDetail(actor: ChecklistActor, id: string, db: RequestSource) {
  const result = await db.request().input("id", sql.UniqueIdentifier, id).query(`
    SELECT ${summary} ${from} ${progress} WHERE c.id=@id AND c.deleted_at IS NULL;
    SELECT tp.id,p.position,tp.title,tp.detail,p.checked,p.notes_json AS notesJson
    FROM implementation.implementation_checklist_points p
    JOIN implementation.implementation_checklists c ON c.id=p.checklist_id AND c.deleted_at IS NULL
    JOIN implementation.checklist_template_points tp ON tp.id=p.template_point_id AND tp.version_id=p.version_id
    WHERE p.checklist_id=@id ORDER BY p.position;
    SELECT e.id,e.template_point_id AS pointId,e.kind,e.status,e.url,e.[text],e.file_name AS fileName,
      e.content_type AS contentType,e.size_bytes AS sizeBytes
    FROM implementation.implementation_checklist_evidence e
    JOIN implementation.implementation_checklists c ON c.id=e.checklist_id AND c.deleted_at IS NULL
    WHERE e.checklist_id=@id AND e.deleted_at IS NULL AND e.status='saved' ORDER BY e.created_at,e.id;
  `);
  if (result.recordsets.length !== 3) throw new Error("Unexpected checklist detail result shape.");
  const [heads, points, evidence] = result.recordsets as unknown as [ChecklistRow[], PointRow[], EvidenceRow[]];
  const head = heads[0];
  if (!head) throw new ChecklistError(404, "not_found", "No se encontró el checklist.");
  return {
    ...projectChecklistSummary(head, actor), rowVersion: head.rowVersion.toString("base64"),
    canReopen: head.status === "completed" && mayWriteChecklist(actor, head.ownerId),
    points: points.map(({ notesJson, ...point }) => ({
      ...point, id: point.id.toLowerCase(), notes: notesJson === null ? null : JSON.parse(notesJson),
      evidence: evidence.filter(({ pointId }) => pointId.toLowerCase() === point.id.toLowerCase()).map((item) => ({
        ...item, id: item.id.toLowerCase(), pointId: item.pointId.toLowerCase(),
        sizeBytes: item.sizeBytes === null ? null : Number(item.sizeBytes),
      })),
    })),
  };
}
