import { describe, expect, it } from "vitest";
import { mapSqlPublicFile } from "../lib/publicFilesSqlRepository";

const created = new Date("2026-07-24T12:00:00.000Z");

describe("Public Files SQL mapping", () => {
  it("maps inline media metadata without exposing its object locator", () => {
    const record = mapSqlPublicFile({
      source_id: "public-file-1", title: "Captura", slug: "captura", description: null,
      asset_kind: "image", active: true, status: "active", storage_provider: "s3",
      storage_container: null, blob_name: null,
      storage_bucket: "portal-sag-content", object_key: "opaque/captura.png", object_etag: "etag-1",
      original_name: "captura.png", mime_type: "image/png", byte_count: 1024,
      content_sha256: Buffer.alloc(32, 2), created_at: created, created_by: "admin",
      updated_at: created, updated_by: "admin", deleted_at: null, deleted_by: null,
    });
    expect(record).toMatchObject({
      id: "public-file-1", assetKind: "image", archivoNombreOriginal: "captura.png",
      archivoStorageProvider: "s3", archivoStorageBucket: "portal-sag-content",
      archivoObjectKey: "opaque/captura.png",
    });
    expect(record.archivoSha256).toHaveLength(64);
  });

  it("maps Azure Blob inline media locators", () => {
    const record = mapSqlPublicFile({
      source_id: "public-file-2", title: "Video", slug: "video", description: null,
      asset_kind: "video", active: true, status: "active", storage_provider: "azure_blob",
      storage_container: "portal-sag-content", blob_name: "opaque/video.mp4",
      storage_bucket: null, object_key: null, object_etag: "etag-azure",
      original_name: "video.mp4", mime_type: "video/mp4", byte_count: 4096,
      content_sha256: Buffer.alloc(32, 4), created_at: created, created_by: "admin",
      updated_at: created, updated_by: "admin", deleted_at: null, deleted_by: null,
    });
    expect(record).toMatchObject({
      archivoStorageProvider: "azure_blob",
      archivoStorageContainer: "portal-sag-content",
      archivoBlobName: "opaque/video.mp4",
    });
    expect(record.archivoObjectKey).toBeUndefined();
  });
});
