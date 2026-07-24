import { afterEach, describe, expect, it } from "vitest";
import {
  buildObjectContentDisposition,
  getObjectStorageProvider,
  isObjectStorageConfigured,
} from "../lib/objectStorage";

const names = [
  "OBJECT_STORAGE_PROVIDER",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_PREFIX",
  "OBJECT_STORAGE_FORCE_PATH_STYLE",
  "OBJECT_STORAGE_SIGNED_URL_SECONDS",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "AZURE_BLOB_STORAGE_ACCOUNT_URL",
  "AZURE_BLOB_STORAGE_CONTAINER",
  "PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL",
  "PUBLIC_DOWNLOADS_STORAGE_CONTAINER",
] as const;

const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
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
    process.env.OBJECT_STORAGE_PROVIDER = "s3";
    process.env.OBJECT_STORAGE_ENDPOINT = "http://minio.internal:9000/path";
    process.env.OBJECT_STORAGE_BUCKET = "portal-sag-content";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
    expect(() => isObjectStorageConfigured()).toThrow(/HTTPS raíz/);
  });

  it("accepts provider-managed MinIO settings without exposing credentials", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "s3";
    process.env.OBJECT_STORAGE_ENDPOINT = "https://minio.example.com";
    process.env.OBJECT_STORAGE_BUCKET = "portal-sag-content";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
    process.env.OBJECT_STORAGE_FORCE_PATH_STYLE = "true";
    expect(isObjectStorageConfigured()).toBe(true);
    expect(getObjectStorageProvider()).toBe("s3");
  });

  it("requires the write provider switch when provider settings exist", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_ENDPOINT = "https://minio.example.com";
    expect(() => isObjectStorageConfigured()).toThrow(/OBJECT_STORAGE_PROVIDER/);
  });

  it("selects Azure Blob with managed identity while retaining optional S3 settings", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_PROVIDER = "azure_blob";
    process.env.AZURE_BLOB_STORAGE_ACCOUNT_URL = "https://portalsagcontent.blob.core.windows.net";
    process.env.AZURE_BLOB_STORAGE_CONTAINER = "portal-sag-content";
    process.env.OBJECT_STORAGE_ENDPOINT = "https://minio.example.com";
    process.env.OBJECT_STORAGE_BUCKET = "portal-sag-content";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
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

  it("keeps forced downloads and inline public files as distinct response contracts", () => {
    expect(buildObjectContentDisposition("attachment", "video demo.mp4"))
      .toBe("attachment; filename*=UTF-8''video%20demo.mp4");
    expect(buildObjectContentDisposition("inline", "video demo.mp4"))
      .toBe("inline; filename*=UTF-8''video%20demo.mp4");
  });
});
