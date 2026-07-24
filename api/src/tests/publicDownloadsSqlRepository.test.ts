import { describe, expect, it } from "vitest";
import {
  mapSqlPublicDownload,
} from "../lib/publicDownloadsSqlRepository";

const created = new Date("2026-07-21T12:00:00.000Z");

describe("Public Downloads SQL mapping", () => {
  it("maps private S3 metadata without materializing file bytes", () => {
    const record = mapSqlPublicDownload({
      source_id: "asset-1", title: "Video", slug: "video", description: null,
      asset_kind: "video", active: true, status: "active", storage_provider: "s3",
      storage_bucket: "portal-sag-content", object_key: "opaque/video.mp4", object_etag: "etag-1",
      original_name: "video.mp4", mime_type: "video/mp4", byte_count: 1024,
      content_sha256: Buffer.alloc(32, 1), created_at: created, created_by: "migration",
      updated_at: created, updated_by: "migration", deleted_at: null, deleted_by: null,
    });
    expect(record).toMatchObject({
      type: "document", id: "asset-1", assetKind: "video", archivoBytes: 1024,
      archivoStorageProvider: "s3", archivoStorageBucket: "portal-sag-content",
      archivoObjectKey: "opaque/video.mp4", archivoObjectEtag: "etag-1",
    });
    expect(record.archivoBase64).toBeUndefined();
    expect(record.archivoSha256).toHaveLength(64);
  });

  it("rejects SQL assets without a current file version", () => {
    expect(() => mapSqlPublicDownload({
      source_id: "asset-1", title: "Missing", slug: "missing", description: null,
      asset_kind: "document", active: true, status: "active", storage_provider: null,
      storage_bucket: null, object_key: null, object_etag: null, original_name: null, mime_type: null,
      byte_count: null, content_sha256: null, created_at: created, created_by: "migration",
      updated_at: created, updated_by: "migration", deleted_at: null, deleted_by: null,
    })).toThrow(/versión de archivo vigente/);
  });
});
