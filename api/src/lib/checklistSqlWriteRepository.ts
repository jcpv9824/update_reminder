import sql from "mssql";
import { randomUUID } from "node:crypto";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { resolveChecklistErpClient } from "./checklistErpClients";
import { ChecklistError, checkCombination, decideEnvironment, mayWriteChecklist, preparePointSave, type ChecklistDuplicate } from "./checklistDomain";
import { readChecklist, requireChecklistView, type ChecklistActor } from "./checklistSqlRepository";
import type { CreateChecklistInput, SaveChecklistInput } from "./checklistRequestSchemas";
import { validateRichDoc, RICH_LIMITS } from "./whatsNewRichText";

type Header = { templateId: string; clientId: string; environment: ChecklistDuplicate["environment"];
  status: ChecklistDuplicate["status"]; ownerId: string; rowVersion: Buffer };

const missing = () => new ChecklistError(404, "not_found", "No se encontró el checklist.");
const forbidden = () => new ChecklistError(403, "forbidden", "Solo el responsable o un superadministrador puede modificar el checklist.");
const stateConflict = () => new ChecklistError(409, "checklist_locked", "El checklist no está en el estado requerido.");
const stale = () => new ChecklistError(409, "stale", "Alguien guardó este checklist mientras usted lo editaba. Copie lo que necesite y recargue.");

// Same template-first serialization as version publishing/withdrawal. Creation
// and reopening serialize the absence check as well as the eventual change.
async function lockTemplate(tx: sql.Transaction, templateId: string) {
  await tx.request().input("id", sql.UniqueIdentifier, templateId).query(
    "SELECT id FROM implementation.checklist_templates WITH(UPDLOCK,HOLDLOCK) WHERE id=@id;");
}

async function header(tx: sql.Transaction, id: string, lock: boolean): Promise<Header> {
  const result = await tx.request().input("id", sql.UniqueIdentifier, id).query<Header>(`
    SELECT c.template_id AS templateId,c.client_id AS clientId,c.environment,c.status,
      u.source_id AS ownerId,c.row_version AS rowVersion
    FROM implementation.implementation_checklists c ${lock ? "WITH(UPDLOCK,HOLDLOCK)" : ""}
    JOIN security.users u ON u.user_key=c.owner_user_id WHERE c.id=@id AND c.deleted_at IS NULL;`);
  if (!result.recordset[0]) throw missing();
  return result.recordset[0];
}

async function duplicates(tx: sql.Transaction, clientId: string, templateId: string, environment: ChecklistDuplicate["environment"]) {
  const { recordset } = await tx.request().input("clientId", sql.UniqueIdentifier, clientId)
    .input("templateId", sql.UniqueIdentifier, templateId).input("environment", sql.VarChar(12), environment).query<{
      id: string; status: ChecklistDuplicate["status"]; ownerName: string; createdAt: Date; completedAt: Date | null;
    }>(`
      SELECT TOP (2) c.id,c.status,u.display_name AS ownerName,c.created_at AS createdAt,c.completed_at AS completedAt
      FROM implementation.implementation_checklists c WITH(UPDLOCK,HOLDLOCK)
      JOIN security.users u ON u.user_key=c.owner_user_id
      WHERE c.deleted_at IS NULL AND c.client_id=@clientId AND c.template_id=@templateId
        AND c.environment_key=ISNULL(@environment,'')
      ORDER BY CASE WHEN c.status='in_progress' THEN 0 ELSE 1 END,c.completed_at DESC,c.id;`);
  return recordset.map((row) => ({ ...row, id: row.id.toLowerCase(), clientId, templateId, environment, deleted: false,
    createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null }));
}

async function audit(tx: sql.Transaction, actor: ChecklistActor, id: string, action: string, metadata?: Record<string, unknown>) {
  await writeSqlAuditLog(tx, { entityType: "implementation_checklist", entityId: id, action,
    performedBy: actor.id, performedByEmail: actor.email, metadata });
}

export async function createChecklist(actor: ChecklistActor, input: CreateChecklistInput) {
  if (!actor.canCreate && !actor.isSuperAdmin) throw forbidden();
  const outcome = await runSqlTransaction(async (tx) => {
    const client = await resolveChecklistErpClient({ ...actor, canCreate: actor.canCreate || actor.isSuperAdmin }, input.clientId, tx);
    await lockTemplate(tx, input.templateId);
    const { recordset } = await tx.request().input("templateId", sql.UniqueIdentifier, input.templateId).query<{
      versionId: string; requiresEnvironment: boolean;
    }>(`
      SELECT v.id AS versionId,v.requires_environment AS requiresEnvironment
      FROM implementation.checklist_template_versions v
      JOIN implementation.checklist_templates t ON t.id=v.template_id AND t.deleted_at IS NULL
      WHERE v.template_id=@templateId AND v.status='current' AND v.deleted_at IS NULL;`);
    const version = recordset[0];
    if (!version) throw new ChecklistError(400, "template_not_current", "Seleccione una plantilla con versión vigente");
    const environment = decideEnvironment(version.requiresEnvironment, input.environment);
    const target = { clientId: client.id, templateId: input.templateId, environment };
    const matching = await duplicates(tx, client.id, input.templateId, environment);
    checkCombination(target, matching, { confirmDuplicate: input.confirmDuplicate });
    const id = randomUUID();
    await tx.request().input("id", sql.UniqueIdentifier, id).input("clientId", sql.UniqueIdentifier, client.id)
      .input("clientName", sql.NVarChar(200), client.name).input("templateId", sql.UniqueIdentifier, input.templateId)
      .input("versionId", sql.UniqueIdentifier, version.versionId).input("requiresEnvironment", sql.Bit, version.requiresEnvironment)
      .input("environment", sql.VarChar(12), environment).input("actor", sql.NVarChar(150), actor.id).query(`
        DECLARE @owner bigint=(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1);
        IF @owner IS NULL THROW 53579,N'Inactive checklist actor.',1;
        INSERT implementation.implementation_checklists(id,client_id,client_name_snapshot,template_id,version_id,requires_environment,environment,owner_user_id,created_by)
          VALUES(@id,@clientId,@clientName,@templateId,@versionId,@requiresEnvironment,@environment,@owner,@owner);
        INSERT implementation.implementation_checklist_points(checklist_id,template_point_id,version_id,position)
          SELECT @id,id,@versionId,position FROM implementation.checklist_template_points
          WHERE version_id=@versionId AND deleted_at IS NULL;
        IF @@ROWCOUNT=0 THROW 53580,N'Published checklist version has no points.',1;
      `);
    await audit(tx, actor, id, "checklist_created", { templateId: input.templateId, clientId: client.id, versionId: version.versionId });
    if (input.confirmDuplicate && matching.some(({ status }) => status === "completed")) await audit(tx, actor, id, "checklist_duplicate_confirmed");
    // The actor receives their own create result per API-03, even when a role
    // was granted only create; this does not grant subsequent read access.
    return readChecklist({ ...actor, canView: true }, id, tx);
  });
  return outcome;
}

export async function saveChecklist(actor: ChecklistActor, id: string, input: SaveChecklistInput, complete: boolean) {
  requireChecklistView(actor);
  const templateId = await lookupChecklistTemplate(id);
  return runSqlTransaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const current = await header(tx, id, true);
    if (!mayWriteChecklist(actor, current.ownerId)) throw forbidden();
    if (current.rowVersion.toString("base64") !== input.rowVersion) throw stale();
    if (current.status !== "in_progress") throw stateConflict();
    const points = (await tx.request().input("id", sql.UniqueIdentifier, id).query<{ pointId: string }>(
      "SELECT template_point_id AS pointId FROM implementation.implementation_checklist_points WHERE checklist_id=@id ORDER BY position;",
    )).recordset;
    const ordered = preparePointSave(points.map(({ pointId }) => pointId.toLowerCase()), input.points, complete);
    const evidence = (await tx.request().input("id", sql.UniqueIdentifier, id).query<{
      id: string; pointId: string; status: "saved" | "pending"; kind: string; createdBy: string; verifiedAt: Date | null;
    }>(`
      SELECT e.id,e.template_point_id AS pointId,e.status,e.kind,u.source_id AS createdBy,e.verified_at AS verifiedAt
      FROM implementation.implementation_checklist_evidence e WITH(UPDLOCK,HOLDLOCK)
      JOIN security.users u ON u.user_key=e.created_by WHERE e.checklist_id=@id AND e.deleted_at IS NULL;
    `)).recordset;
    const promote = new Set(input.evidence.add);
    const remove = new Set(input.evidence.remove);
    const evidenceById = new Map(evidence.map((row) => [row.id.toLowerCase(), row]));
    for (const evidenceId of [...promote, ...remove]) {
      const row = evidenceById.get(evidenceId);
      if (!row || (promote.has(evidenceId) && (row.status !== "pending" ||
          (!["text", "link"].includes(row.kind) && !row.verifiedAt))) ||
          (row.status === "pending" && !actor.isSuperAdmin && row.createdBy !== actor.id)) {
        throw new ChecklistError(400, "invalid_evidence", "La evidencia no corresponde a este checklist.");
      }
    }
    const savedCounts = new Map<string, number>();
    for (const [evidenceId, row] of evidenceById) {
      if (!remove.has(evidenceId) && (row.status === "saved" || promote.has(evidenceId))) {
        const key = row.pointId.toLowerCase();
        savedCounts.set(key, (savedCounts.get(key) ?? 0) + 1);
      }
    }
    if ([...savedCounts.values()].some((count) => count > 20)) {
      throw new ChecklistError(400, "evidence_limit", "Cada punto admite hasta 20 evidencias.");
    }
    const persisted = ordered.map(({ notes, ...point }) => {
      if (notes === null) return { ...point, notesJson: null };
      try {
        const rich = validateRichDoc(notes, "medio", RICH_LIMITS.jsonChars.nota);
        if (rich.plainText.length > RICH_LIMITS.plainText.compacto) throw new Error("Notes text exceeds the limit");
        if (rich.mentionUserIds.length || rich.attachmentFileIds.length) throw new Error("Unsupported node");
        for (const fileId of rich.imageFileIds) {
          const key = fileId.toLowerCase();
          const row = evidenceById.get(key);
          if (!row || row.kind !== "image" || row.pointId.toLowerCase() !== point.pointId ||
              remove.has(key) || (row.status !== "saved" && !promote.has(key))) throw new Error("Conflicting image");
        }
        return { ...point, notesJson: rich.isEmpty ? null : JSON.stringify(rich.doc) };
      } catch {
        throw new ChecklistError(400, "invalid_notes", "El contenido o las imágenes de las notas no son válidos.");
      }
    });
    await tx.request().input("id", sql.UniqueIdentifier, id).input("actor", sql.NVarChar(150), actor.id)
      .input("complete", sql.Bit, complete).input("points", sql.NVarChar(sql.MAX), JSON.stringify(persisted))
      .input("promote", sql.NVarChar(sql.MAX), JSON.stringify([...promote])).input("remove", sql.NVarChar(sql.MAX), JSON.stringify([...remove]))
      .query(`
        DECLARE @who bigint=(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1),@now datetime2(3)=SYSUTCDATETIME();
        IF @who IS NULL THROW 53579,N'Inactive checklist actor.',1;
        UPDATE p SET checked=j.checked,notes_json=j.notesJson,updated_at=@now,
          checked_at=CASE WHEN p.checked<>j.checked THEN @now ELSE p.checked_at END,
          checked_by=CASE WHEN p.checked<>j.checked THEN @who ELSE p.checked_by END
        FROM implementation.implementation_checklist_points p
        JOIN OPENJSON(@points) WITH(pointId uniqueidentifier, checked bit, notesJson nvarchar(max)) j ON j.pointId=p.template_point_id
        WHERE p.checklist_id=@id;
        UPDATE e SET status='saved',updated_at=@now FROM implementation.implementation_checklist_evidence e
          JOIN OPENJSON(@promote) j ON CONVERT(uniqueidentifier,j.value)=e.id WHERE e.checklist_id=@id AND e.deleted_at IS NULL;
        UPDATE e SET deleted_at=@now,deleted_by=@who,updated_at=@now FROM implementation.implementation_checklist_evidence e
          JOIN OPENJSON(@remove) j ON CONVERT(uniqueidentifier,j.value)=e.id WHERE e.checklist_id=@id AND e.deleted_at IS NULL;
        UPDATE implementation.implementation_checklists SET updated_at=@now,
          status=CASE WHEN @complete=1 THEN 'completed' ELSE status END,
          completed_at=CASE WHEN @complete=1 THEN @now ELSE completed_at END,
          completed_by=CASE WHEN @complete=1 THEN @who ELSE completed_by END WHERE id=@id;
      `);
    await audit(tx, actor, id, complete ? "checklist_completed" : "checklist_saved");
    if (promote.size) await audit(tx, actor, id, "checklist_evidence_added", { evidenceIds: [...promote] });
    if (remove.size) await audit(tx, actor, id, "checklist_evidence_removed", { evidenceIds: [...remove] });
    return readChecklist(actor, id, tx);
  });
}

export async function changeChecklistStatus(actor: ChecklistActor, id: string, operation: "reopen" | "delete") {
  requireChecklistView(actor);
  // Read only the immutable template key before acquiring the transaction.
  // The active row, owner and status are rechecked under the locks.
  const templateId = await lookupChecklistTemplate(id);
  return runSqlTransaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const current = await header(tx, id, true);
    if (!mayWriteChecklist(actor, current.ownerId)) throw forbidden();
    if (operation === "reopen") {
      if (current.status !== "completed") throw stateConflict();
      checkCombination(current, await duplicates(tx, current.clientId, current.templateId, current.environment), { reopeningId: id });
    }
    await tx.request().input("id", sql.UniqueIdentifier, id).input("actor", sql.NVarChar(150), actor.id)
      .input("reopen", sql.Bit, operation === "reopen").query(`
        DECLARE @who bigint=(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1),@now datetime2(3)=SYSUTCDATETIME();
        IF @who IS NULL THROW 53579,N'Inactive checklist actor.',1;
        IF @reopen=1 UPDATE implementation.implementation_checklists SET status='in_progress',completed_at=NULL,completed_by=NULL,updated_at=@now WHERE id=@id;
        ELSE UPDATE implementation.implementation_checklists SET deleted_at=@now,deleted_by=@who,updated_at=@now WHERE id=@id;
      `);
    await audit(tx, actor, id, operation === "reopen" ? "checklist_reopened" : "checklist_deleted");
    return operation === "reopen" ? await readChecklist(actor, id, tx) : undefined;
  });
}

async function lookupChecklistTemplate(id: string) {
  const { getSqlPool } = await import("./sql");
  const row = (await (await getSqlPool()).request().input("id", sql.UniqueIdentifier, id).query<{ templateId: string }>(
    "SELECT template_id AS templateId FROM implementation.implementation_checklists WHERE id=@id AND deleted_at IS NULL;",
  )).recordset[0];
  if (!row) throw missing();
  return row.templateId;
}
