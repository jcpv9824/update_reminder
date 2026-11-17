import { z } from "zod";

/*
  Zod 4 aplica los valores por defecto incluso dentro de .partial(): en una
  actualización parcial, un campo omitido con .default(true) llegaba como true
  y sobrescribía el valor guardado (p. ej. reactivaba un registro). Zod 3 no lo
  hacía. Este helper quita los valores por defecto antes de volver opcional
  cada campo, para que lo omitido siga llegando como undefined.
*/

function withoutDefault(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) {
    return withoutDefault(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodOptional) return withoutDefault(schema.unwrap() as z.ZodType);
  return schema;
}

/** Igual que schema.partial(), pero sin aplicar valores por defecto a los campos omitidos. */
export function partialUpdate<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>,
): ReturnType<z.ZodObject<Shape, Config>["partial"]> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) shape[key] = withoutDefault(field as z.ZodType);
  return schema.extend(shape).partial() as unknown as ReturnType<z.ZodObject<Shape, Config>["partial"]>;
}
