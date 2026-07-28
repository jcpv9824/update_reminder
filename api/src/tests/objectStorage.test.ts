import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const awsMocks = vi.hoisted(() => ({
  clientConfigs: [] as Array<Record<string, unknown>>,
  send: vi.fn(),
  signedUrl: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      constructor(config: Record<string, unknown>) {
        awsMocks.clientConfigs.push(config);
      }

      send(command: unknown) {
        return awsMocks.send(command);
      }

      destroy() {}
    },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: awsMocks.signedUrl,
}));

import {
  buildObjectContentDisposition,
  createPrivateObjectUpload,
  getObjectStorageProvider,
  isObjectStorageConfigured,
  statPrivateObject,
} from "../lib/objectStorage";

const names = [
  "OBJECT_STORAGE_PROVIDER",
  "OBJECT_STORAGE_PREFIX",
  "OBJECT_STORAGE_SIGNED_URL_SECONDS",
  "SEAWEEDFS_ENDPOINT",
  "SEAWEEDFS_REGION",
  "SEAWEEDFS_BUCKET",
  "SEAWEEDFS_FORCE_PATH_STYLE",
  "SEAWEEDFS_ACCESS_KEY_ID",
  "SEAWEEDFS_SECRET_ACCESS_KEY",
  "AZURE_BLOB_STORAGE_ACCOUNT_URL",
  "AZURE_BLOB_STORAGE_CONTAINER",
  "PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL",
  "PUBLIC_DOWNLOADS_STORAGE_CONTAINER",
] as const;

const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  awsMocks.clientConfigs.length = 0;
  awsMocks.send.mockReset();
  awsMocks.signedUrl.mockReset();
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function clearConfig() {
  for (const name of names) delete process.env[name];
}

describe("selectable private object storage configuration", () => {
  it("reports an entirely absent configuration without contacting a provider", () => {
    clearConfig();
    expect(isObjectStorageConfigured()).toBe(false);
  });

  it("requires a root HTTPS endpoint", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "seaweedfs";
    process.env.SEAWEEDFS_ENDPOINT = "http://seaweedfs.internal:8333/path";
    process.env.SEAWEEDFS_BUCKET = "portal-sag-content";
    process.env.SEAWEEDFS_ACCESS_KEY_ID = "access";
    process.env.SEAWEEDFS_SECRET_ACCESS_KEY = "secret";
    expect(() => isObjectStorageConfigured()).toThrow(/HTTPS raíz/);
  });

  it("accepts SeaweedFS S3 gateway settings without exposing credentials", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "seaweedfs";
    process.env.SEAWEEDFS_ENDPOINT = "https://seaweedfs.example.com";
    process.env.SEAWEEDFS_BUCKET = "portal-sag-content";
    process.env.SEAWEEDFS_ACCESS_KEY_ID = "access";
    process.env.SEAWEEDFS_SECRET_ACCESS_KEY = "secret";
    process.env.SEAWEEDFS_FORCE_PATH_STYLE = "true";
    expect(isObjectStorageConfigured()).toBe(true);
    expect(getObjectStorageProvider()).toBe("seaweedfs");
  });

  it("rejects the retired s3 write-provider value", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "s3";
    process.env.SEAWEEDFS_ENDPOINT = "https://seaweedfs.example.com";
    process.env.SEAWEEDFS_BUCKET = "portal-sag-content";
    process.env.SEAWEEDFS_ACCESS_KEY_ID = "access";
    process.env.SEAWEEDFS_SECRET_ACCESS_KEY = "secret";
    expect(() => isObjectStorageConfigured()).toThrow(/seaweedfs o azure_blob/);
  });

  it("requires the write provider switch when provider settings exist", () => {
    clearConfig();
    process.env.SEAWEEDFS_ENDPOINT = "https://seaweedfs.example.com";
    expect(() => isObjectStorageConfigured()).toThrow(/OBJECT_STORAGE_PROVIDER/);
  });

  it("selects Azure Blob with managed identity while retaining optional SeaweedFS settings", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "azure_blob";
    process.env.AZURE_BLOB_STORAGE_ACCOUNT_URL = "https://portalsagcontent.blob.core.windows.net";
    process.env.AZURE_BLOB_STORAGE_CONTAINER = "portal-sag-content";
    process.env.SEAWEEDFS_ENDPOINT = "https://seaweedfs.example.com";
    process.env.SEAWEEDFS_BUCKET = "portal-sag-content";
    process.env.SEAWEEDFS_ACCESS_KEY_ID = "access";
    process.env.SEAWEEDFS_SECRET_ACCESS_KEY = "secret";
    expect(isObjectStorageConfigured()).toBe(true);
    expect(getObjectStorageProvider()).toBe("azure_blob");
  });

  it("rejects a non-Azure HTTPS endpoint in Azure Blob mode", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "azure_blob";
    process.env.AZURE_BLOB_STORAGE_ACCOUNT_URL = "https://storage.example.com";
    process.env.AZURE_BLOB_STORAGE_CONTAINER = "portal-sag-content";
    expect(() => isObjectStorageConfigured()).toThrow(/Azure Blob Storage/);
  });

  it("accepts the previous Azure Blob setting names during a controlled upgrade", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "azure_blob";
    process.env.PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL = "https://portalsagcontent.blob.core.windows.net";
    process.env.PUBLIC_DOWNLOADS_STORAGE_CONTAINER = "portal-sag-content";
    expect(isObjectStorageConfigured()).toBe(true);
  });

  it("fails closed when new and legacy Azure settings disagree", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "azure_blob";
    process.env.AZURE_BLOB_STORAGE_ACCOUNT_URL = "https://portalsagcontent.blob.core.windows.net";
    process.env.PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL = "https://otheraccount.blob.core.windows.net";
    process.env.AZURE_BLOB_STORAGE_CONTAINER = "portal-sag-content";
    expect(() => isObjectStorageConfigured()).toThrow(/no pueden tener valores diferentes/);
  });

  it("selects SeaweedFS for new writes while preserving the s3 locator contract", async () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "seaweedfs";
    process.env.SEAWEEDFS_ENDPOINT = "https://seaweedfs.example.com";
    process.env.SEAWEEDFS_BUCKET = "portal-sag-content";
    process.env.SEAWEEDFS_ACCESS_KEY_ID = "access";
    process.env.SEAWEEDFS_SECRET_ACCESS_KEY = "do-not-expose-this-secret";
    awsMocks.signedUrl.mockResolvedValue("https://seaweedfs.example.com/signed-upload");

    const upload = await createPrivateObjectUpload({
      objectId: "guide_upload_1234",
      extension: ".mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
    });

    expect(upload.locator).toMatchObject({
      storageProvider: "s3",
      storageBucket: "portal-sag-content",
    });
    expect(upload.url).not.toContain("do-not-expose-this-secret");
    expect(awsMocks.clientConfigs[0]).toMatchObject({
      endpoint: "https://seaweedfs.example.com",
      forcePathStyle: true,
    });
  });

  it("reads historical s3 locators through the configured SeaweedFS gateway", async () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "azure_blob";
    process.env.AZURE_BLOB_STORAGE_ACCOUNT_URL = "https://portalsagcontent.blob.core.windows.net";
    process.env.AZURE_BLOB_STORAGE_CONTAINER = "portal-sag-content";
    process.env.SEAWEEDFS_ENDPOINT = "https://legacy-seaweedfs.example.com";
    process.env.SEAWEEDFS_BUCKET = "portal-sag-content";
    process.env.SEAWEEDFS_ACCESS_KEY_ID = "access";
    process.env.SEAWEEDFS_SECRET_ACCESS_KEY = "secret";
    awsMocks.send.mockResolvedValue({
      ContentLength: 512,
      ContentType: "application/pdf",
      ETag: "\"legacy-etag\"",
    });

    await expect(statPrivateObject({
      storageProvider: "s3",
      storageBucket: "portal-sag-content",
      storageObjectKey: "legacy/document.pdf",
    })).resolves.toEqual({
      byteCount: 512,
      mimeType: "application/pdf",
      etag: "legacy-etag",
    });
    expect(awsMocks.clientConfigs[0]).toMatchObject({
      endpoint: "https://legacy-seaweedfs.example.com",
    });
  });

  it("does not require unsupported conditional PutObject behavior from SeaweedFS", () => {
    const source = readFileSync(
      new URL("../lib/objectStorage.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("async function storeSeaweedFSObject");
    const end = source.indexOf("async function storeAzureBlob", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toContain("IfNoneMatch");
    expect(source.slice(start, end)).toContain("HeadObjectCommand");
    expect(source.slice(start, end)).toContain("Metadata?.sha256");
  });

  it("keeps forced downloads and inline public files as distinct response contracts", () => {
    expect(buildObjectContentDisposition("attachment", "video demo.mp4"))
      .toBe("attachment; filename*=UTF-8''video%20demo.mp4");
    expect(buildObjectContentDisposition("inline", "video demo.mp4"))
      .toBe("inline; filename*=UTF-8''video%20demo.mp4");
  });
});
