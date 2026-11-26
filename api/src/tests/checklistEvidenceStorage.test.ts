import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ send: vi.fn(), signed: vi.fn(), upload: vi.fn(), properties: vi.fn(), download: vi.fn(), remove: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (original) => ({ ...await original<typeof import("@aws-sdk/client-s3")>(), S3Client: class { middlewareStack = { addRelativeTo() {} }; send = fake.send; destroy() {} } }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: fake.signed }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/storage-blob", async (original) => ({ ...await original<typeof import("@azure/storage-blob")>(), BlobServiceClient: class {
  getContainerClient() { const blob = { uploadData: fake.upload, getProperties: fake.properties, download: fake.download, deleteIfExists: fake.remove }; return { getBlockBlobClient: () => blob, getBlobClient: () => blob }; }
} }));
import { prepareChecklistPrivateObject, storeChecklistPrivateObject, readChecklistPrivateObjectBuffer, deleteChecklistPrivateObject } from "../lib/objectStorage";
const id = "11111111-1111-4111-8111-111111111111", bytes = Buffer.from("test bytes"), hash = createHash("sha256").update(bytes).digest("hex");
const s3 = { storageProvider: "s3" as const, storageBucket: "private-fixture", storageObjectKey: `checklists/${id}/payload.bin` };
const azure = { storageProvider: "azure_blob" as const, storageContainer: "private-fixture", storageBlobName: `checklists/${id}/payload.bin` };
describe("Checklists provider adapter · SDKs simulados, sin red ni credenciales reales", () => {
  beforeEach(() => {
    Object.values(fake).forEach((fn) => fn.mockReset());
    vi.stubEnv("OBJECT_STORAGE_PROVIDER", "seaweedfs"); vi.stubEnv("OBJECT_STORAGE_PREFIX", "fixture");
    vi.stubEnv("SEAWEEDFS_ENDPOINT", "https://storage.example.invalid"); vi.stubEnv("SEAWEEDFS_BUCKET", "private-fixture");
    vi.stubEnv("SEAWEEDFS_ACCESS_KEY_ID", "fixture"); vi.stubEnv("SEAWEEDFS_SECRET_ACCESS_KEY", "fixture"); vi.stubEnv("SEAWEEDFS_REGION", "us-east-1");
    vi.stubEnv("SEAWEEDFS_FORCE_PATH_STYLE", "true"); vi.stubEnv("OBJECT_STORAGE_SIGNED_URL_SECONDS", "300");
    vi.stubEnv("AZURE_BLOB_STORAGE_ACCOUNT_URL", "https://fixtureaccount.blob.core.windows.net"); vi.stubEnv("AZURE_BLOB_STORAGE_CONTAINER", "private-fixture");
    vi.stubEnv("PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL", ""); vi.stubEnv("PUBLIC_DOWNLOADS_STORAGE_CONTAINER", "");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("prepara un namespace cerrado por UUID/sufijo, sin nombre de usuario ni URL firmada", () => {
    expect(prepareChecklistPrivateObject(id, ".bin")).toEqual(s3); expect(fake.signed).not.toHaveBeenCalled();
    expect(() => prepareChecklistPrivateObject("../../other", ".bin")).toThrow();
    expect(() => prepareChecklistPrivateObject(id, ".html")).toThrow();
  });
  it("escribe una vez con IfNoneMatch y verifica HEAD tamaño/hash antes de confirmar", async () => {
    fake.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: bytes.length, ContentType: "application/octet-stream", Metadata: { sha256: hash } });
    await storeChecklistPrivateObject(s3, bytes, hash, "application/octet-stream");
    expect(fake.send.mock.calls[0][0].input).toMatchObject({ Key: s3.storageObjectKey, Body: bytes, IfNoneMatch: "*" });
    expect(fake.send).toHaveBeenCalledTimes(2); expect(fake.signed).not.toHaveBeenCalled();
  });
  it("rechaza metadatos remotos distintos y un cambio de proveedor entre reservar y escribir", async () => {
    fake.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: bytes.length + 1 });
    await expect(storeChecklistPrivateObject(s3, bytes, hash, "application/octet-stream")).rejects.toThrow("verification");
    fake.send.mockClear(); vi.stubEnv("OBJECT_STORAGE_PROVIDER", "azure_blob");
    await expect(storeChecklistPrivateObject(s3, bytes, hash, "application/octet-stream")).rejects.toThrow("provider changed");
    expect(fake.send).not.toHaveBeenCalled();
  });
  it("lee un localizador S3 histórico aunque el destino nuevo sea Azure; valida longitud y hash", async () => {
    vi.stubEnv("OBJECT_STORAGE_PROVIDER", "azure_blob");
    fake.send.mockResolvedValueOnce({ ContentLength: bytes.length, ETag: '"v1"' }).mockResolvedValueOnce({ Body: Readable.from([bytes]) });
    expect(await readChecklistPrivateObjectBuffer(s3, bytes.length, hash)).toEqual(bytes);
    expect(fake.send.mock.calls[1][0].input.IfMatch).toBe('"v1"'); expect(fake.signed).not.toHaveBeenCalled();
  });
  it("lee Azure por el proveedor guardado aunque el destino nuevo sea SeaweedFS", async () => {
    fake.properties.mockResolvedValue({ contentLength: bytes.length, etag: '"v1"' }); fake.download.mockResolvedValue({ readableStreamBody: Readable.from([bytes]) });
    expect(await readChecklistPrivateObjectBuffer(azure, bytes.length, hash)).toEqual(bytes); expect(fake.send).not.toHaveBeenCalled();
  });
  it("rechaza hash remoto incorrecto y ubicaciones que no pertenecen a Checklists", async () => {
    fake.send.mockResolvedValueOnce({ ContentLength: bytes.length }).mockResolvedValueOnce({ Body: Readable.from([bytes]) });
    await expect(readChecklistPrivateObjectBuffer(s3, bytes.length, "0".repeat(64))).rejects.toThrow("integrity");
    fake.send.mockClear();
    await expect(deleteChecklistPrivateObject({ ...s3, storageObjectKey: "content/saved-object" })).rejects.toThrow(); expect(fake.send).not.toHaveBeenCalled();
  });
  it("el borrado de un tombstone es idempotente ante 404, sin firmar/enumerar objetos", async () => {
    fake.send.mockRejectedValue({ statusCode: 404 }); expect(await deleteChecklistPrivateObject(s3)).toBe(true);
    expect(fake.send).toHaveBeenCalledTimes(1); expect(fake.signed).not.toHaveBeenCalled();
  });
});
