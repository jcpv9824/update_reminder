import { describe, expect, it } from "vitest";
import {
  formatHasSource,
  getFormatSourceIds,
  getFormatSourceNames,
  normalizeSourceIds,
  withFormatSources,
} from "../lib/printFormatSources";
import type { FormatoImpresionRecord } from "../types/models";

const legacyFormat = {
  id: "formato_1",
  nombre: "Formato legado",
  fuenteId: "fuente_1",
  fuenteNombre: "Factura",
} as FormatoImpresionRecord;

describe("printFormatSources", () => {
  it("mantiene compatibilidad con formatos históricos de una sola fuente", () => {
    expect(getFormatSourceIds(legacyFormat)).toEqual(["fuente_1"]);
    expect(getFormatSourceNames(legacyFormat)).toEqual(["Factura"]);
    expect(formatHasSource(legacyFormat, "fuente_1")).toBe(true);
  });

  it("normaliza, deduplica y conserva múltiples fuentes", () => {
    expect(normalizeSourceIds([" fuente_1 ", "fuente_2", "fuente_1", ""])).toEqual(["fuente_1", "fuente_2"]);
    const updated = withFormatSources(legacyFormat, [
      { id: "fuente_1", nombre: "Factura" },
      { id: "fuente_2", nombre: "Remisión" },
    ]);
    expect(updated).toMatchObject({
      fuenteId: "fuente_1",
      fuenteNombre: "Factura",
      fuenteIds: ["fuente_1", "fuente_2"],
      fuenteNombres: ["Factura", "Remisión"],
    });
    expect(formatHasSource(updated, "fuente_2")).toBe(true);
  });
});
