import { createHash } from "node:crypto";
import { z } from "zod";
import { LIMITS, VIA_CODES, VIA_LABELS, WhatsNewError, normalizeForCompare, type ViaCode } from "./whatsNewModel";

/* Rutas escritas a mano (decisión del propietario, segunda ronda, punto 9):
   - nivel 1 fijo: Barra de navegación o Barra lateral;
   - de 1 a 3 submenús escritos a mano;
   - la opción, escrita a mano, siempre es el último nivel;
   - de 3 a 5 niveles; máximo 10 rutas; sin rutas repetidas (sin mayúsculas ni tildes).
   No existe menú de referencia ni sugerencias. */

const FORBIDDEN_SEGMENT = /[›<>\u0000-\u001f\u007f]/;

const Segment = z.string().max(LIMITS.segment, `Cada nivel admite hasta ${LIMITS.segment} caracteres.`)
  .refine((value) => !FORBIDDEN_SEGMENT.test(value), "El nivel contiene caracteres no permitidos.");

export const RouteInputSchema = z.object({
  via: z.enum(VIA_CODES),
  submenus: z.array(Segment).max(LIMITS.submenusMax, `Se admiten hasta ${LIMITS.submenusMax} submenús.`),
  option: Segment,
}).strict();

export type RouteInput = z.infer<typeof RouteInputSchema>;

export type NormalizedRoute = {
  routeNo: number;
  via: ViaCode;
  submenus: string[];
  option: string;
  levelCount: number;
  displayText: string;
  routeHash: Buffer;
  complete: boolean;
};

function clean(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function routeDisplayText(route: Pick<NormalizedRoute, "via" | "submenus" | "option">): string {
  return [VIA_LABELS[route.via], ...route.submenus, route.option].filter((part) => part.length > 0).join(" › ");
}

export function routeHash(route: Pick<NormalizedRoute, "via" | "submenus" | "option">): Buffer {
  const key = [route.via, ...route.submenus.map(normalizeForCompare), normalizeForCompare(route.option)].join("\u001f");
  return createHash("sha256").update(key, "utf8").digest();
}

/**
 * Normaliza y valida rutas.
 * - `draft`: acepta niveles todavía vacíos (autoguardado), pero nunca rutas repetidas ni más de 10.
 * - `publish`: exige de 1 a 3 submenús no vacíos y la opción no vacía, y al menos una ruta.
 */
export function normalizeRoutes(input: RouteInput[], mode: "draft" | "publish"): NormalizedRoute[] {
  if (input.length > LIMITS.routes) {
    throw new WhatsNewError(400, "solicitud_invalida", `Se admiten hasta ${LIMITS.routes} rutas.`);
  }
  if (mode === "publish" && input.length === 0) {
    throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", { fields: ["routes"] });
  }
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const parsed = RouteInputSchema.parse(raw);
    const submenus = parsed.submenus.map(clean);
    const option = clean(parsed.option);
    const complete = submenus.length >= LIMITS.submenusMin && submenus.every((part) => part.length > 0) && option.length > 0;
    if (mode === "publish" && !complete) {
      throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", {
        fields: [`routes[${index}]`],
      });
    }
    const route = { via: parsed.via, submenus, option };
    const hash = routeHash(route);
    const hex = hash.toString("hex");
    if (seen.has(hex)) {
      throw new WhatsNewError(409, "ruta_duplicada", "Hay dos rutas iguales.", { routeNo: index + 1 });
    }
    seen.add(hex);
    return {
      routeNo: index + 1,
      ...route,
      levelCount: 1 + submenus.length + 1,
      displayText: routeDisplayText(route),
      routeHash: hash,
      complete,
    };
  });
}

export function routeSearchText(routes: NormalizedRoute[]): string | null {
  if (routes.length === 0) return null;
  const text = routes.map((route) => normalizeForCompare(route.displayText)).join(" | ");
  return text.length > 4000 ? text.slice(0, 4000) : text;
}
