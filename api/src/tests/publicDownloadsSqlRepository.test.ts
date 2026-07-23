import { describe, expect, it } from "vitest";
import {
  mapSqlPublicDownloadDocument,
  mapSqlPublicDownloadSection,
} from "../lib/publicDownloadsSqlRepository";

const created = new Date("2026-07-21T12:00:00.000Z");

describe("Public Downloads SQL mapping", () => {
  it("maps normalized SQL sections to the existing API contract", () => {
    expect(mapSqlPublicDownloadSection({
      source_id: "section-1", name: "Manuales", slug: "manuales", description: null,
      active: true, status: "active", created_at: created, created_by: "migration",
      updated_at: created, updated_by: "migration", deleted_at: null, deleted_by: null,
    })).toMatchObject({
      type: "section", id: "section-1", nombre: "Manuales", slug: "manuales", activa: true,
      createdAt: "2026-07-21T12:00:00.000Z",
    });
  });

  it("maps private Blob metadata without materializing file bytes", () => {
    const record = mapSqlPublicDownloadDocument({
      source_id: "asset-1", section_source_id: "section-1", section_name: "Manuales",
      section_slug: "manuales", title: "Video", slug: "video", description: null,
      asset_kind: "video", active: true, status: "active", storage_provider: "azure_blob",
      storage_container: "portal-sag-content", blob_name: "opaque/video.mp4",
      original_name: "video.mp4", mime_type: "video/mp4", byte_count: 1024,
      content_sha256: Buffer.alloc(32, 1), created_at: created, created_by: "migration",
      updated_at: created, updated_by: "migration", deleted_at: null, deleted_by: null,
    });
    expect(record).toMatchObject({
      type: "document", id: "asset-1", assetKind: "video", archivoBytes: 1024,
      archivoBlobContainer: "portal-sag-content", archivoBlobName: "opaque/video.mp4",
    });
    expect(record.archivoBase64).toBeUndefined();
    expect(record.archivoSha256).toHaveLength(64);
  });

  it("rejects SQL assets without a current file version", () => {
    expect(() => mapSqlPublicDownloadDocument({
      source_id: "asset-1", section_source_id: "section-1", section_name: "Manuales",
      section_slug: "manuales", title: "Missing", slug: "missing", description: null,
      asset_kind: "document", active: true, status: "active", storage_provider: null,
      storage_container: null, blob_name: null, original_name: null, mime_type: null,
      byte_count: null, content_sha256: null, created_at: created, created_by: "migration",
      updated_at: created, updated_by: "migration", deleted_at: null, deleted_by: null,
    })).toThrow(/versión de archivo vigente/);
  });
});
