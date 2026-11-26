import { z } from "zod";

/** API-20…28 / RN-22,30,38,39. Transport schemas only; membership, permissions,
 * version state and concurrent SQL writes remain separate domain/repository checks. */
export const TemplateEntityIdSchema = z.string().uuid("El identificador debe ser un UUID.").transform((id) => id.toLowerCase());
export const TemplateRowVersionSchema = z.string().regex(/^[A-Za-z0-9+/]{11}=$/, "La versión no es válida.").refine((value) => {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 8 && decoded.toString("base64") === value;
}, "La versión no es válida.");
export const TemplateVersionNumberSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^[1-9][0-9]*$/, "El número de versión debe ser un entero positivo.").transform(Number),
]).refine((value) => Number.isSafeInteger(value) && value <= 2_147_483_647, "El número de versión no es válido.");

export const CreateTemplateSchema = z.object({
  name: z.string().trim().min(1, "Escriba el nombre de la plantilla.").max(150, "El nombre admite hasta 150 caracteres."),
}).strict();

export const TemplatePointInputSchema = z.object({
  id: TemplateEntityIdSchema.optional(),
  title: z.string().trim().min(1, "Escriba el título del punto.").max(200, "El título admite hasta 200 caracteres."),
  detail: z.string().max(1000, "El detalle admite hasta 1000 caracteres.").nullable().optional()
    .transform((value) => value == null || value.trim() === "" ? null : value),
}).strict();

export const SaveTemplateVersionSchema = z.object({
  requiresEnvironment: z.boolean(),
  points: z.array(TemplatePointInputSchema).max(100, "La versión admite hasta 100 puntos.").superRefine((points, ctx) => {
    const seen = new Set<string>();
    points.forEach((point, index) => {
      if (point.id && seen.has(point.id)) ctx.addIssue({ code: "custom", message: "Hay identificadores de punto repetidos.", path: [index, "id"] });
      if (point.id) seen.add(point.id);
    });
  }),
  rowVersion: TemplateRowVersionSchema,
}).strict();

export const TemplateIdParamsSchema = z.object({ id: TemplateEntityIdSchema }).strict();
export const TemplateVersionParamsSchema = z.object({ id: TemplateEntityIdSchema, number: TemplateVersionNumberSchema }).strict();
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;
export type TemplatePointInput = z.infer<typeof TemplatePointInputSchema>;
export type SaveTemplateVersionInput = z.infer<typeof SaveTemplateVersionSchema>;
