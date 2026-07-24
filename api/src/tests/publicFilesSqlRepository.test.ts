import { describe, expect, it } from "vitest";
import { mapSqlPublicFile } from "../lib/publicFilesSqlRepository";

const created = new Date("2026-07-24T12:00:00.000Z");

describe("Public Files SQL mapping", () => {
  it("maps inline media metadata without exposing its object locator", () => {
    const record = mapSqlPublicFile({
      source_id: "public-file-1", title: "Captura", slug: "captura", description: null,
      asset_kind: "image", active: true, status: "active", storage_provider: "s3",
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
});
