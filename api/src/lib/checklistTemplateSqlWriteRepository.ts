import { randomUUID } from "node:crypto";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { checklistTemplateQuery, listSqlChecklistTemplates, readSqlChecklistTemplate, type ChecklistTemplateSqlParams } from "./checklistTemplateSqlRepository";
import { ChecklistTemplateError, createTemplate, createTemplateVersion, deleteTemplate, publishTemplateVersion, removeTemplateVersion, saveTemplateVersion, type TemplateContext, type TemplateState, type TemplateVersionState } from "./checklistTemplateDomain";
import { CreateTemplateSchema, SaveTemplateVersionSchema, TemplateIdParamsSchema, TemplateVersionNumberSchema } from "./checklistTemplateSchemas";
import type { ChecklistTemplateStore, StoredTemplate } from "./checklistTemplateService";

export type ChecklistTemplateSqlDependencies = {
  transaction: typeof runSqlTransaction; query: typeof checklistTemplateQuery; read: typeof readSqlChecklistTemplate;
  audit: typeof writeSqlAuditLog; getDb: typeof getSqlPool; now(): Date; newId(): string;
};
const defaults: ChecklistTemplateSqlDependencies = { transaction: runSqlTransaction, query: checklistTemplateQuery, read: readSqlChecklistTemplate,
  audit: writeSqlAuditLog, getDb: getSqlPool, now: () => new Date(), newId: randomUUID };
const actorKey = "(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1)";

export function createChecklistTemplateSqlStore(overrides: Partial<ChecklistTemplateSqlDependencies> = {}): ChecklistTemplateStore {
  const deps = { ...defaults, ...overrides };
  return {
    async list() { return listSqlChecklistTemplates(await deps.getDb(), deps.query); },
    // Keep version ROWVERSION and its point set from the same committed state.
    async read(id) { return deps.transaction((db) => deps.read(db, id, true, deps.query)); },
    async execute(actor, operation, args) {
      if (operation === "remove" ? !actor.isSuperAdmin : !actor.isSuperAdmin && !actor.canManageTemplates) throw new ChecklistTemplateError(403, "forbidden", "No tiene permiso para esta acción.");
      const id = operation === "create" ? null : TemplateIdParamsSchema.parse({ id: args.id }).id;
      const number = operation === "saveVersion" || operation === "publishVersion" || operation === "removeVersion" ? TemplateVersionNumberSchema.parse(args.number) : null;
      const parsed = operation === "create" ? CreateTemplateSchema.parse(args.input) : operation === "saveVersion" ? SaveTemplateVersionSchema.parse(args.input) : null;
      try {
        return await deps.transaction(async (db) => {
          const now = deps.now();
          const ctx: TemplateContext = { canManageTemplates: actor.canManageTemplates, isSuperAdmin: actor.isSuperAdmin, newId: deps.newId };
          const base: ChecklistTemplateSqlParams = { actor: actor.id, now };
          const run = (statement: string, params: ChecklistTemplateSqlParams = {}) => deps.query(db, statement, { ...base, ...params });
          let before: StoredTemplate | null = null;
          let after: TemplateState;
          let auditAction: string;
          let changedVersion: TemplateVersionState | undefined;
          if (operation === "create") {
            const input = parsed as ReturnType<typeof CreateTemplateSchema.parse>;
            // Lock the unique name range. The database CI_AI unique index is
            // authoritative for concurrent name creation and collation equality.
            const duplicates = await run(`SELECT id,name FROM implementation.checklist_templates WITH (UPDLOCK,HOLDLOCK) WHERE name=@name AND deleted_at IS NULL;`, { name: input.name });
            if (duplicates.length) throw new ChecklistTemplateError(409, "name_taken", "Ya existe una plantilla con ese nombre.");
            after = createTemplate(ctx, input, []);
            await run(`INSERT implementation.checklist_templates(id,name,created_by,created_at,updated_at) VALUES(@id,@name,${actorKey},@now,@now);`, { id: after.id, name: after.name });
            changedVersion = after.versions[0]; auditAction = "checklist_template_created";
          } else {
            // First aggregate read is the lock owner: every version operation
            // and future checklist creation uses this same template-first order.
            before = await deps.read(db, id!, true, deps.query);
            if (!before || before.deleted) throw new ChecklistTemplateError(404, "not_found", "No se encontró la plantilla.");
            switch (operation) {
              case "remove": after = deleteTemplate(ctx, before); auditAction = "checklist_template_deleted"; break;
              case "createVersion": after = createTemplateVersion(ctx, before); auditAction = "checklist_version_created"; changedVersion = after.versions.find((v) => !before!.versions.some((old) => old.id === v.id)); break;
              case "saveVersion": after = saveTemplateVersion(ctx, before, number!, parsed); auditAction = "checklist_version_saved"; break;
              case "publishVersion": after = publishTemplateVersion(ctx, before, number!); auditAction = "checklist_version_published"; break;
              case "removeVersion": {
                after = removeTemplateVersion(ctx, before, number!);
                auditAction = before.versions.find((v) => !v.deleted && v.number === number)!.status === "editing" ? "checklist_version_discarded" : "checklist_version_deleted";
                break;
              }
            }
          }
          if (changedVersion) {
            await run(`INSERT implementation.checklist_template_versions(id,template_id,number,status,requires_environment,created_by,created_at,updated_at)
              VALUES(@version,@template,@number,'editing',@environment,${actorKey},@now,@now);`,
              { version: changedVersion.id, template: after.id, number: changedVersion.number, environment: changedVersion.requiresEnvironment });
            for (const point of changedVersion.points) await run(`INSERT implementation.checklist_template_points(id,version_id,position,title,detail,created_at,updated_at)
              VALUES(@point,@version,@position,@title,@detail,@now,@now);`, { point: point.id, version: changedVersion.id, position: point.position, title: point.title, detail: point.detail });
          }
          if (operation === "saveVersion") {
            const current = before!.versions.find((v) => !v.deleted && v.number === number)!;
            const target = after.versions.find((v) => !v.deleted && v.number === number)!;
            const updated = await run(`UPDATE implementation.checklist_template_versions SET requires_environment=@environment,updated_at=@now OUTPUT inserted.id
              WHERE id=@version AND template_id=@template AND status='editing' AND deleted_at IS NULL AND row_version=@rowVersion;`,
              { environment: target.requiresEnvironment, version: target.id, template: after.id, rowVersion: Buffer.from(current.rowVersion!, "base64") });
            if (!updated.length) throw new ChecklistTemplateError(409, "stale", "Alguien cambió esta versión mientras usted la editaba. Copie lo que necesite y recargue.");
            // Free the filtered position index temporarily; revive only points
            // that belonged to this active editing version before this operation.
            await run(`UPDATE implementation.checklist_template_points SET deleted_at=@now,deleted_by=${actorKey},updated_at=@now WHERE version_id=@version AND deleted_at IS NULL;`, { version: target.id });
            const existing = new Set(current.points.map((p) => p.id));
            for (const p of target.points) {
              if (existing.has(p.id)) await run(`UPDATE implementation.checklist_template_points SET position=@position,title=@title,detail=@detail,deleted_at=NULL,deleted_by=NULL,updated_at=@now WHERE id=@point AND version_id=@version;`,
                { point: p.id, version: target.id, position: p.position, title: p.title, detail: p.detail });
              else await run(`INSERT implementation.checklist_template_points(id,version_id,position,title,detail,created_at,updated_at) VALUES(@point,@version,@position,@title,@detail,@now,@now);`,
                { point: p.id, version: target.id, position: p.position, title: p.title, detail: p.detail });
            }
          } else if (operation === "publishVersion") {
            const target = after.versions.find((v) => !v.deleted && v.number === number)!;
            await run(`UPDATE implementation.checklist_template_versions SET status='frozen',updated_at=@now WHERE template_id=@template AND deleted_at IS NULL AND status='current';`, { template: after.id });
            await run(`UPDATE implementation.checklist_template_versions SET status='current',published_at=@now,published_by=${actorKey},updated_at=@now WHERE id=@version AND template_id=@template AND deleted_at IS NULL AND status='editing';`, { version: target.id, template: after.id });
          } else if (operation === "removeVersion") {
            const target = before!.versions.find((v) => !v.deleted && v.number === number)!;
            await run(`UPDATE implementation.checklist_template_versions SET deleted_at=@now,deleted_by=${actorKey},updated_at=@now WHERE id=@version AND template_id=@template AND deleted_at IS NULL;`, { version: target.id, template: after.id });
            const previous = after.versions.find((v) => !v.deleted && v.status === "current");
            if (target.status === "current" && previous) await run(`UPDATE implementation.checklist_template_versions SET status='current',updated_at=@now WHERE id=@version AND template_id=@template AND status='frozen' AND deleted_at IS NULL;`, { version: previous.id, template: after.id });
          }
          await run(operation === "remove" ? `UPDATE implementation.checklist_templates SET deleted_at=@now,deleted_by=${actorKey},updated_at=@now WHERE id=@template AND deleted_at IS NULL;`
            : "UPDATE implementation.checklist_templates SET updated_at=@now WHERE id=@template AND deleted_at IS NULL;", { template: after.id });
          await deps.audit(db, { entityType: "checklist_template", entityId: after.id, action: auditAction, performedBy: actor.id, performedByEmail: actor.email,
            metadata: { templateId: after.id, ...(number !== null ? { versionNumber: number } : {}), ...(changedVersion ? { versionId: changedVersion.id, versionNumber: changedVersion.number } : {}) } });
          if (operation === "remove") return { ...after, createdAt: before!.createdAt };
          const persisted = await deps.read(db, after.id, false, deps.query);
          if (!persisted) throw new Error("The persisted template was not returned.");
          return persisted;
        });
      } catch (error) {
        const sqlError = error as { number?: number; message?: string };
        if (operation === "create" && (sqlError.number === 2601 || sqlError.number === 2627) && sqlError.message?.includes("UX_checklist_templates_active_name")) {
          throw new ChecklistTemplateError(409, "name_taken", "Ya existe una plantilla con ese nombre.");
        }
        throw error;
      }
    },
  };
}
