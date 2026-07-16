import type { FormatoImpresionRecord } from "../types/models";

type SourceIdentity = { id: string; nombre: string };

export function normalizeSourceIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
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
  const uniqueSources = sources.filter((source, index) => sources.findIndex((item) => item.id === source.id) === index);
  if (uniqueSources.length === 0) throw new Error("El formato debe tener al menos un tipo de fuente.");
  return {
    ...format,
    fuenteId: uniqueSources[0].id,
    fuenteNombre: uniqueSources[0].nombre,
    fuenteIds: uniqueSources.map((source) => source.id),
    fuenteNombres: uniqueSources.map((source) => source.nombre),
  };
}
