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
    expect(normalizeSourceIds([" fuente_1 ", "fuente_2", "FUENTE_1", ""])).toEqual(["fuente_1", "fuente_2"]);
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

  it("deduplica alias de fuente sin distinguir mayúsculas al construir el agregado", () => {
    const updated = withFormatSources(legacyFormat, [
      { id: "fuente_1", nombre: "Factura" },
      { id: "FUENTE_1", nombre: "Factura duplicada" },
      { id: "fuente_2", nombre: "Remisión" },
    ]);
    expect(updated.fuenteIds).toEqual(["fuente_1", "fuente_2"]);
    expect(updated.fuenteNombres).toEqual(["Factura", "Remisión"]);
  });

  it("usa la fuente primaria heredada cuando el arreglo moderno está vacío", () => {
    expect(getFormatSourceIds({ ...legacyFormat, fuenteIds: [" ", ""] })).toEqual(["fuente_1"]);
  });

  it("rechaza un formato sin ninguna fuente válida", () => {
    expect(() => withFormatSources(legacyFormat, [])).toThrow(/al menos un tipo de fuente/i);
  });

  it("permite que formatos diferentes compartan el mismo tipo de fuente", () => {
    const first = withFormatSources(legacyFormat, [{ id: "fuente_1", nombre: "Factura" }]);
    const second = withFormatSources({
      ...legacyFormat,
      id: "formato_2",
      nombre: "Formato alternativo",
    }, [{ id: "fuente_1", nombre: "Factura" }]);

    expect(formatHasSource(first, "fuente_1")).toBe(true);
    expect(formatHasSource(second, "fuente_1")).toBe(true);
    expect(first.id).not.toBe(second.id);
  });
});
