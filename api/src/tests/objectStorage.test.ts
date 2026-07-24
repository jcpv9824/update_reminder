import { afterEach, describe, expect, it } from "vitest";
import {
  buildObjectContentDisposition,
  isObjectStorageConfigured,
} from "../lib/objectStorage";

const names = [
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_PREFIX",
  "OBJECT_STORAGE_FORCE_PATH_STYLE",
  "OBJECT_STORAGE_SIGNED_URL_SECONDS",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
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

describe("S3/MinIO object storage configuration", () => {
  it("reports an entirely absent configuration without contacting a provider", () => {
    clearConfig();
    expect(isObjectStorageConfigured()).toBe(false);
  });

  it("requires a root HTTPS endpoint", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_ENDPOINT = "http://minio.internal:9000/path";
    process.env.OBJECT_STORAGE_BUCKET = "portal-sag-content";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
    expect(() => isObjectStorageConfigured()).toThrow(/HTTPS raíz/);
  });

  it("accepts provider-managed MinIO settings without exposing credentials", () => {
    clearConfig();
    process.env.OBJECT_STORAGE_ENDPOINT = "https://minio.example.com";
    process.env.OBJECT_STORAGE_BUCKET = "portal-sag-content";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
    process.env.OBJECT_STORAGE_FORCE_PATH_STYLE = "true";
    expect(isObjectStorageConfigured()).toBe(true);
  });

  it("keeps forced downloads and inline public files as distinct response contracts", () => {
    expect(buildObjectContentDisposition("attachment", "video demo.mp4"))
      .toBe("attachment; filename*=UTF-8''video%20demo.mp4");
    expect(buildObjectContentDisposition("inline", "video demo.mp4"))
      .toBe("inline; filename*=UTF-8''video%20demo.mp4");
  });
});
