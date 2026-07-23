import { describe, expect, it } from "vitest";
import { mapSqlPrintFormatRows, mapSqlPrintFormatSource } from "../lib/printFormatsSqlRepository";

const at = new Date("2026-07-21T12:00:00.000Z");
const base = {
  source_id: "format-1", name: "Factura", description: "Formato", format_size: "carta" as const,
  custom_format_size: null, requires_license: false, module_source_id: null, module_name: null,
  module_code: null, active: true, status: "active" as const, created_at: at, created_by: "migration",
  updated_at: at, updated_by: "migration", deleted_at: null, deleted_by: null,
  storage_provider: "azure_blob" as const, storage_container: "portal-sag-content",
  blob_name: "opaque/factura.pdf", original_name: "factura.pdf", mime_type: "application/pdf",
  byte_count: 500, content_sha256: Buffer.alloc(32, 2),
};

describe("Print Formats SQL mapping", () => {
  it("maps a source without the removed description", () => {
    expect(mapSqlPrintFormatSource({
      source_id: "source-1", name: "Contabilidad", active: true, status: "active",
      created_at: at, created_by: "migration", updated_at: at, updated_by: "migration",
      deleted_at: null, deleted_by: null,
    })).toMatchObject({ id: "source-1", nombre: "Contabilidad", activa: true });
  });

  it("reconstructs ordered many-to-many sources and private PDF metadata", () => {
    const record = mapSqlPrintFormatRows([
      { ...base, source_type_id: "source-2", source_type_name: "Ventas", display_order: 1, is_primary: false },
      { ...base, source_type_id: "source-1", source_type_name: "Contabilidad", display_order: 0, is_primary: true },
    ]);
    expect(record).toMatchObject({
      fuenteId: "source-1", fuenteIds: ["source-1", "source-2"],
      fuenteNombres: ["Contabilidad", "Ventas"], pdfBytes: 500,
      pdfBlobContainer: "portal-sag-content", pdfBlobName: "opaque/factura.pdf",
    });
    expect(record.pdfBase64).toBeUndefined();
  });
});
