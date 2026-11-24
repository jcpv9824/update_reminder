import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PERMISSIONS } from "../lib/whatsNewModel";
import type { WhatsNewActor } from "../lib/whatsNewAccess";

const fake = vi.hoisted(() => ({
  db: {}, tx: {}, query: vi.fn(), provider: vi.fn(), store: vi.fn(), verify: vi.fn(), ensureContent: vi.fn(), audit: vi.fn(),
}));
vi.mock("../lib/sql", () => ({ getSqlPool: async () => fake.db }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (fn: (tx: object) => Promise<unknown>) => fn(fake.tx) }));
vi.mock("../lib/whatsNewSqlRepository", () => ({ query: fake.query }));
vi.mock("../lib/objectStorage", () => ({
  getObjectStorageProvider: fake.provider, isObjectStorageConfigured: () => true,
  storePrivateObject: fake.store, readPrivateSeaweedFSBuffer: fake.verify,
}));
vi.mock("../lib/contentFileSqlWriter", () => ({ ensureSqlContentFile: fake.ensureContent }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: fake.audit }));

import {
  assertCanUploadWhatsNewMedia, inspectWhatsNewMedia, parseWhatsNewMediaFields, readWhatsNewMedia, uploadWhatsNewMedia,
} from "../lib/whatsNewMedia";

const id = "4b7cd8ab-7391-4910-9860-b790a0884a33";
const uploader: WhatsNewActor = {
  id: "author", displayName: "Desarrollo", email: "author@example.invalid",
  permissions: new Set([PERMISSIONS.view, PERMISSIONS.author]), areas: new Set(["desarrollo"]),
};
const support: WhatsNewActor = {
  id: "other", displayName: "Soporte", email: "other@example.invalid",
  permissions: new Set([PERMISSIONS.view, PERMISSIONS.test]), areas: new Set(["soporte"]),
};
const draft = { entryKey: 42, status: "borrador" as const, type: "nuevo" as const, developerId: "author" };
const pdf = Buffer.from("%PDF-1.7 mocked bytes");
const pdfSha = createHash("sha256").update(pdf).digest();
const attachment = () => inspectWhatsNewMedia({ target: "reglas_negocio", kind: "documento" }, "condiciones.pdf", pdf);
const stored = { storageProvider: "s3", storageBucket: "test-private", storageObjectKey: "novedades/mock", storageObjectEtag: "etag" };
function officeMetadata(names: string[]) {
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const path = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, path); directory.push(central, path); offset += local.length + path.length;
  }
  const data = Buffer.concat(directory);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(data.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, data, end]);
}

describe("Novedades private media", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("WHATS_NEW_MEDIA_ENABLED", "true");
    fake.provider.mockReturnValue("seaweedfs");
    fake.store.mockResolvedValue(stored);
    fake.ensureContent.mockResolvedValue(1);
    fake.verify.mockResolvedValue(pdf);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed when the module media gate is not explicitly enabled", async () => {
    vi.stubEnv("WHATS_NEW_MEDIA_ENABLED", "");
    fake.query.mockImplementation(async (_db, sql: string) => sql.includes("e.entry_key entryKey") ? [draft] : []);
    await expect(uploadWhatsNewMedia(uploader, id, "no-flag-111", attachment())).rejects.toMatchObject({ status: 503 });
    expect(fake.store).not.toHaveBeenCalled();
  });

  it("allows only narrow target/kind combinations and verifies the file signature", () => {
    expect(() => parseWhatsNewMediaFields("imagen", "video")).toThrow();
    expect(() => parseWhatsNewMediaFields("imagen", "texto_cliente")).toThrow();
    expect(() => inspectWhatsNewMedia({ target: "que_cambio", kind: "imagen" }, "bad.svg", Buffer.from("<svg/>"))).toThrow();
    expect(() => inspectWhatsNewMedia({ target: "que_cambio", kind: "imagen" }, "bad.png", Buffer.from("<svg/>"))).toThrow();
    expect(() => inspectWhatsNewMedia({ target: "reglas_negocio", kind: "documento" }, "bad.pdf", Buffer.from("not PDF"))).toThrow();
    expect(attachment()).toMatchObject({ mime: "application/pdf", sha256: pdfSha.toString("hex") });
    expect(() => inspectWhatsNewMedia({ target: "que_cambio", kind: "imagen" }, "too-big.png", Buffer.alloc(5_000_001)))
      .toThrow(expect.objectContaining({ status: 413 }));
  });
  it("accepts only matching Word/Excel containers and rejects macro/traversal metadata", () => {
    const rules = { target: "reglas_negocio", kind: "documento" } as const;
    const names = ["[Content_Types].xml", "word/document.xml"];
    expect(inspectWhatsNewMedia(rules, "reglas.docx", officeMetadata(names)).mime).toContain("wordprocessingml");
    expect(inspectWhatsNewMedia(rules, "reglas.xlsx", officeMetadata(["[Content_Types].xml", "xl/workbook.xml"])).mime).toContain("spreadsheetml");
    expect(() => inspectWhatsNewMedia(rules, "reglas.xlsx", officeMetadata(names))).toThrow();
    expect(() => inspectWhatsNewMedia(rules, "reglas.docx", officeMetadata([...names, "word/vbaProject.bin"]))).toThrow();
    expect(() => inspectWhatsNewMedia(rules, "reglas.docx", officeMetadata([...names, "../bad.xml"]))).toThrow();
  });

  it("restricts uploads to editable states, own drafts, and the Nuevo list targets", () => {
    expect(() => assertCanUploadWhatsNewMedia(uploader, draft, "video")).not.toThrow();
    expect(() => assertCanUploadWhatsNewMedia(support, draft, "video")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => assertCanUploadWhatsNewMedia(uploader, { ...draft, type: "mejora" }, "video")).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => assertCanUploadWhatsNewMedia(uploader, { ...draft, status: "en_pruebas" }, "que_cambio")).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("registers verified bytes with the shared S3 registrar, private status and audit in one transaction", async () => {
    fake.query.mockImplementation(async (_db, sql: string) => sql.includes("e.entry_key entryKey") ? [draft]
      : sql.includes("COUNT_BIG") ? [{ total: 0 }] : []);
    const result = await uploadWhatsNewMedia(uploader, id, "same-key-111", attachment());
    expect(result).toEqual({ fileId: expect.any(String), name: "condiciones.pdf", mime: "application/pdf", bytes: pdf.length, replayed: false });
    expect(fake.store).toHaveBeenCalledWith(expect.objectContaining({ requiredProvider: "seaweedfs", bytes: pdf, sha256: pdfSha.toString("hex") }));
    expect(fake.ensureContent).toHaveBeenCalledWith(fake.tx, expect.objectContaining({ storageProvider: "s3" }), uploader.id);
    expect(fake.query.mock.calls.find(([, sql]) => sql.includes("INSERT whats_new.entry_files"))).toEqual([
      fake.tx, expect.stringContaining("'verificada'"), expect.objectContaining({ target: "reglas_negocio", idem: "same-key-111" }),
    ]);
    expect(fake.audit).toHaveBeenCalledWith(fake.tx, expect.objectContaining({ metadata: { kind: "documento", target: "reglas_negocio" } }));
  });

  it("never writes bytes if the upload cannot use SeaweedFS or is an exact idempotent replay", async () => {
    fake.query.mockImplementation(async (_db, sql: string) => sql.includes("e.entry_key entryKey") ? [draft] : []);
    fake.provider.mockReturnValue("azure_blob");
    await expect(uploadWhatsNewMedia(uploader, id, "same-key-111", attachment())).rejects.toMatchObject({ status: 503 });
    expect(fake.store).not.toHaveBeenCalled();
    fake.query.mockImplementation(async (_db, sql: string) => sql.includes("e.entry_key entryKey") ? [draft]
      : [{ fileId: id, entry_key: draft.entryKey, target: "reglas_negocio", kind: "documento", name: "condiciones.pdf",
        mime: "application/pdf", bytes: pdf.length, declared_sha256: pdfSha, status: "verificada" }]);
    expect(await uploadWhatsNewMedia(uploader, id, "same-key-111", attachment())).toMatchObject({ fileId: id, replayed: true });
    expect(fake.store).not.toHaveBeenCalled();
  });

  it("lets a permitted reader see only linked media; a verified upload is private to its uploader", async () => {
    const row = { status: "sin_probar", developerId: uploader.id, uploader: uploader.id, fileStatus: "verificada",
      kind: "documento", name: "condiciones.pdf", mime: "application/pdf", bytes: pdf.length, declared_sha256: pdfSha,
      bucket: stored.storageBucket, objectKey: stored.storageObjectKey, etag: stored.storageObjectEtag };
    fake.query.mockResolvedValue([row]);
    await expect(readWhatsNewMedia(support, id)).rejects.toMatchObject({ status: 404 });
    expect(fake.verify).not.toHaveBeenCalled();
    await expect(readWhatsNewMedia(uploader, id)).resolves.toEqual({ name: "condiciones.pdf", bytes: pdf, mime: "application/pdf", kind: "documento" });
    fake.query.mockResolvedValue([{ ...row, fileStatus: "en_entrada" }]);
    await expect(readWhatsNewMedia(support, id)).resolves.toMatchObject({ bytes: pdf });
    expect(fake.verify).toHaveBeenLastCalledWith({ ...stored }, pdf.length, pdfSha.toString("hex"));
  });
});
