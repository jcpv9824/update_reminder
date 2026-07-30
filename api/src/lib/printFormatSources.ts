import type { FormatoImpresionRecord } from "../types/models";

type SourceIdentity = { id: string; nombre: string };

export function normalizeSourceIds(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids
    .map((id) => id.trim())
    .filter((id) => {
      if (!id) return false;
      const comparisonKey = id.toLocaleLowerCase("es-CO");
      if (seen.has(comparisonKey)) return false;
      seen.add(comparisonKey);
      return true;
    });
}

export function getFormatSourceIds(format: Pick<FormatoImpresionRecord, "fuenteId" | "fuenteIds">): string[] {
  const ids = normalizeSourceIds(format.fuenteIds ?? []);
  return ids.length > 0 ? ids : normalizeSourceIds([format.fuenteId]);
}

export function getFormatSourceNames(format: Pick<FormatoImpresionRecord, "fuenteNombre" | "fuenteNombres">): string[] {
  const names = [...new Set((format.fuenteNombres ?? []).map((name) => name.trim()).filter(Boolean))];
  return names.length > 0 ? names : [format.fuenteNombre].filter(Boolean);
}

export function formatHasSource(
  format: Pick<FormatoImpresionRecord, "fuenteId" | "fuenteIds">,
  sourceId: string
): boolean {
  return getFormatSourceIds(format).includes(sourceId);
}

export function withFormatSources<T extends Pick<FormatoImpresionRecord, "fuenteId" | "fuenteNombre">>(
  format: T,
  sources: SourceIdentity[]
): T & Pick<FormatoImpresionRecord, "fuenteId" | "fuenteNombre" | "fuenteIds" | "fuenteNombres"> {
  const seen = new Set<string>();
  const uniqueSources = sources.filter((source) => {
    const comparisonKey = source.id.trim().toLocaleLowerCase("es-CO");
    if (!comparisonKey || seen.has(comparisonKey)) return false;
    seen.add(comparisonKey);
    return true;
  });
  if (uniqueSources.length === 0) throw new Error("El formato debe tener al menos un tipo de fuente.");
  return {
    ...format,
    fuenteId: uniqueSources[0].id,
    fuenteNombre: uniqueSources[0].nombre,
    fuenteIds: uniqueSources.map((source) => source.id),
    fuenteNombres: uniqueSources.map((source) => source.nombre),
  };
}
