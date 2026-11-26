import sql from "mssql";
import type { StoredTemplate, StoredTemplateSummary } from "./checklistTemplateService";

export type ChecklistTemplateDb = sql.Transaction | sql.ConnectionPool;
export type ChecklistTemplateSqlParams = Record<string, string | number | boolean | Date | Buffer | null>;
export async function checklistTemplateQuery<T = Record<string, any>>(db: ChecklistTemplateDb, statement: string, values: ChecklistTemplateSqlParams = {}): Promise<T[]> {
  const request = db instanceof sql.Transaction ? new sql.Request(db) : new sql.Request(db);
  for (const [name, value] of Object.entries(values)) {
    const type = Buffer.isBuffer(value) ? sql.VarBinary(8) : value instanceof Date ? sql.DateTime2(3) : typeof value === "boolean" ? sql.Bit : typeof value === "number" ? sql.Int : sql.NVarChar(sql.MAX);
    request.input(name, type, value);
  }
  return (await request.query<T>(statement)).recordset ?? [];
}

/** API-20: one summary query, not one complete aggregate per list item. */
export async function listSqlChecklistTemplates(db: ChecklistTemplateDb, execute: typeof checklistTemplateQuery = checklistTemplateQuery): Promise<StoredTemplateSummary[]> {
  const rows = await execute(db, `SELECT t.id,t.name,t.created_at,
    (SELECT v.number FROM implementation.checklist_template_versions v WHERE v.template_id=t.id AND v.deleted_at IS NULL AND v.status='current') current_version,
    (SELECT COUNT_BIG(*) FROM implementation.implementation_checklists c WHERE c.template_id=t.id AND c.deleted_at IS NULL) uses
    FROM implementation.checklist_templates t WHERE t.deleted_at IS NULL ORDER BY t.name,t.id;`);
  return rows.map((r) => ({ id: String(r.id).toLowerCase(), name: r.name, currentVersion: r.current_version === null ? null : Number(r.current_version), uses: Number(r.uses), createdAt: r.created_at.toISOString() }));
}

/** API-22/25: three normalized reads. All mutation callers lock the template
 * before loading versions/uses/points, using their owning SQL transaction. */
export async function readSqlChecklistTemplate(db: ChecklistTemplateDb, id: string, lock = false, execute: typeof checklistTemplateQuery = checklistTemplateQuery): Promise<StoredTemplate | null> {
  const [header] = await execute(db, `SELECT t.id,t.name,t.created_at FROM implementation.checklist_templates t ${lock ? "WITH (UPDLOCK,HOLDLOCK)" : ""}
    WHERE t.id=@id AND t.deleted_at IS NULL;`, { id });
  if (!header) return null;
  const versions = await execute(db, `SELECT v.id,v.number,v.status,v.requires_environment,v.deleted_at,v.row_version,
    (SELECT COUNT_BIG(*) FROM implementation.implementation_checklists c WHERE c.template_id=v.template_id AND c.version_id=v.id AND c.deleted_at IS NULL) uses
    FROM implementation.checklist_template_versions v WHERE v.template_id=@id ORDER BY v.number,v.created_at,v.id;`, { id });
  const points = await execute(db, `SELECT p.id,p.version_id,p.position,p.title,p.detail
    FROM implementation.checklist_template_points p JOIN implementation.checklist_template_versions v ON v.id=p.version_id
    WHERE v.template_id=@id AND v.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY v.number,p.position,p.id;`, { id });
  return { id: String(header.id).toLowerCase(), name: header.name, createdAt: header.created_at.toISOString(), deleted: false,
    versions: versions.map((v) => ({ id: String(v.id).toLowerCase(), number: Number(v.number), status: v.status, requiresEnvironment: !!v.requires_environment,
      uses: Number(v.uses), deleted: v.deleted_at !== null, rowVersion: Buffer.from(v.row_version).toString("base64"),
      points: points.filter((p) => String(p.version_id).toLowerCase() === String(v.id).toLowerCase())
        .map((p) => ({ id: String(p.id).toLowerCase(), position: Number(p.position), title: p.title, detail: p.detail ?? null })) })) };
}
