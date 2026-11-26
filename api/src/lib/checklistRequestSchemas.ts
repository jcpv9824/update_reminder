import { z } from "zod";
import { TemplateEntityIdSchema, TemplateRowVersionSchema } from "./checklistTemplateSchemas";

export const ChecklistEnvironmentSchema = z.enum(["testing", "production", "demo"]);
export const FindChecklistClientsSchema = z.object({
  q: z.string().trim().max(100).refine((query) => (query.match(/\p{L}/gu)?.length ?? 0) >= 3, "Escriba al menos 3 letras"),
}).strict();

export const CreateChecklistSchema = z.object({
  clientId: TemplateEntityIdSchema,
  templateId: TemplateEntityIdSchema,
  environment: ChecklistEnvironmentSchema.optional(),
  confirmDuplicate: z.boolean().optional(),
}).strict();

// The transport accepts only a TipTap document root; the rich-text boundary
// must still reconstruct the allowed tree and resolve evidence against SQL.
const NotesRootSchema = z.object({
  type: z.literal("doc"),
  content: z.array(z.unknown()).optional(),
}).strict().nullable();
const ChecklistPointInputSchema = z.object({
  pointId: TemplateEntityIdSchema,
  checked: z.boolean(),
  notes: NotesRootSchema,
}).strict();
const EvidenceChangesSchema = z.object({
  add: z.array(TemplateEntityIdSchema).max(2000),
  remove: z.array(TemplateEntityIdSchema).max(2000),
}).strict().refine(({ add, remove }) => new Set([...add, ...remove]).size === add.length + remove.length,
  "La misma evidencia no se puede registrar en dos operaciones.");

export const SaveChecklistSchema = z.object({
  points: z.array(ChecklistPointInputSchema).max(100).refine((points) =>
    new Set(points.map(({ pointId }) => pointId)).size === points.length, "Hay puntos repetidos."),
  evidence: EvidenceChangesSchema,
  rowVersion: TemplateRowVersionSchema,
}).strict();

export type CreateChecklistInput = z.infer<typeof CreateChecklistSchema>;
export type SaveChecklistInput = z.infer<typeof SaveChecklistSchema>;
