import { describe, expect, it, vi } from "vitest";
import {
  buildCompanyLogoSql,
  checkCompanyLogoStorage,
  CompanyLogoConnectionSchema,
  CompanyLogoError,
  CompanyLogoUploadSchema,
  companyLogoFolder,
  decodeCompanyLogo,
  storageErrorMessage,
  uploadCompanyLogo,
  type S3Sender,
} from "../lib/companyLogo";
import { buildAuditLogEntry } from "../lib/audit";
import { PERMISSION_CATALOG } from "../lib/permissionModel";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const SECRET = "SuperSecretKey-1234567890";
const ACCESS = "AccessKeyExample";

const connection = {
  bucket: "  demo.sagerp.cloud.buk ",
  accessKey: ` ${ACCESS} `,
  secretKey: ` ${SECRET}\t`,
  databaseName: " SAGWebDemoPYA ",
};

function fakeClient(existing: Array<{ Key: string; Size: number; LastModified: Date }>, options: { fail?: unknown } = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client: S3Sender = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (options.fail) throw options.fail;
      if (command.constructor.name === "ListObjectsV2Command") return { Contents: existing };
      if (command.constructor.name === "HeadObjectCommand") {
        const put = sent.find((item) => item.name === "PutObjectCommand");
        return { ContentLength: (put?.input.Body as Buffer).length };
      }
      return {};
    }) as unknown as S3Sender["send"],
    destroy: vi.fn(),
  };
  return { client, sent };
}

describe("company logo input validation", () => {
  it("trims every field", () => {
    const parsed = CompanyLogoConnectionSchema.parse(connection);
    expect(parsed).toEqual({
      bucket: "demo.sagerp.cloud.buk",
      accessKey: ACCESS,
      secretKey: SECRET,
      databaseName: "SAGWebDemoPYA",
    });
  });

  it.each([
    [{ bucket: "Demo_Bucket" }, "bucket"],
    [{ bucket: "ab" }, "bucket"],
    [{ databaseName: "../otra" }, "base de datos"],
    [{ databaseName: "Mi Base" }, "base de datos"],
    [{ accessKey: "" }, "llave de acceso"],
    [{ secretKey: "abc def ghi" }, "llave secreta"],
  ])("rejects %o with an actionable message", (override, label) => {
    const result = CompanyLogoConnectionSchema.safeParse({ ...connection, ...override });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message.toLowerCase()).toContain(label);
  });

  it("rejects extra fields such as a custom endpoint (no proxy to other hosts)", () => {
    const result = CompanyLogoConnectionSchema.safeParse({ ...connection, endpoint: "evil.example.com" });
    expect(result.success).toBe(false);
  });

  it("accepts only PNG/JPG whose content matches the extension", () => {
    expect(decodeCompanyLogo(PNG.toString("base64"), "logo.png").mimeType).toBe("image/png");
    expect(decodeCompanyLogo(`data:image/jpeg;base64,${JPG.toString("base64")}`, "Logo.JPEG").extension).toBe("jpg");
    expect(() => decodeCompanyLogo(PNG.toString("base64"), "logo.jpg")).toThrow(CompanyLogoError);
    expect(() => decodeCompanyLogo(Buffer.from("<svg/>").toString("base64"), "logo.svg")).toThrow(/PNG o JPG/);
    expect(() => decodeCompanyLogo("%%%", "logo.png")).toThrow(/completa/);
  });

  it("rejects an oversized payload before decoding it", () => {
    const result = CompanyLogoUploadSchema.safeParse({ ...connection, imageBase64: "A".repeat(3_000_001), imageName: "logo.png" });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toContain("2 MB");
  });

  it("rejects images over 2 MB", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect(() => decodeCompanyLogo(big.toString("base64"), "logo.png")).toThrow(/2 MB/);
  });
});

describe("company logo storage", () => {
  it("lists the dedicated logo folder and reports existing logos, newest first", async () => {
    const { client, sent } = fakeClient([
      { Key: "SAGWebDemoPYA/Archivos/Imagenes/LogoEmpresa/a.jpg", Size: 10, LastModified: new Date("2026-09-01") },
      { Key: "SAGWebDemoPYA/Archivos/Imagenes/LogoEmpresa/b.png", Size: 20, LastModified: new Date("2026-11-01") },
    ]);
    const result = await checkCompanyLogoStorage(CompanyLogoConnectionSchema.parse(connection), () => client);
    expect(sent[0].input).toMatchObject({ Bucket: "demo.sagerp.cloud.buk", Prefix: "SAGWebDemoPYA/Archivos/Imagenes/LogoEmpresa/" });
    expect(result.existing.map((item) => item.name)).toEqual(["b.png", "a.jpg"]);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("refuses to upload over an existing logo without confirmation", async () => {
    const { client, sent } = fakeClient([{ Key: `${companyLogoFolder("SAGWebDemoPYA")}a.jpg`, Size: 1, LastModified: new Date() }]);
    const input = CompanyLogoUploadSchema.parse({ ...connection, imageBase64: PNG.toString("base64"), imageName: "logo.png" });
    await expect(uploadCompanyLogo(input, () => client)).rejects.toMatchObject({ status: 409 });
    expect(sent.some((item) => item.name === "PutObjectCommand")).toBe(false);
  });

  it("uploads a new UUID file when confirmed, keeps old logos and returns the SQL", async () => {
    const { client, sent } = fakeClient([{ Key: `${companyLogoFolder("SAGWebDemoPYA")}a.jpg`, Size: 1, LastModified: new Date() }]);
    const input = CompanyLogoUploadSchema.parse({
      ...connection, imageBase64: PNG.toString("base64"), imageName: " logo.png ", replaceConfirmed: true,
    });
    const result = await uploadCompanyLogo(input, () => client, new Date("2026-11-13T21:00:00Z"));
    const put = sent.find((item) => item.name === "PutObjectCommand")!;
    expect(put.input.Key).toMatch(/^SAGWebDemoPYA\/Archivos\/Imagenes\/LogoEmpresa\/[0-9a-f-]{36}\.png$/);
    expect(put.input.ContentType).toBe("image/png");
    expect(sent.some((item) => item.name === "DeleteObjectCommand")).toBe(false);
    expect(result.replacedCount).toBe(1);
    expect(result.url).toBe(`https://storcube.sagweb.co:8333/demo.sagerp.cloud.buk/${put.input.Key}`);
    expect(result.sql).toContain(`UPDATE parametros_web SET LogoEmpresa = N'${result.url}';`);
    expect(result.sqlFileName).toBe("logo_SAGWebDemoPYA.sql");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(ACCESS);
  });

  it("uploads without confirmation when the folder is empty", async () => {
    const { client } = fakeClient([]);
    const input = CompanyLogoUploadSchema.parse({ ...connection, imageBase64: JPG.toString("base64"), imageName: "logo.jpg" });
    const result = await uploadCompanyLogo(input, () => client);
    expect(result.replacedCount).toBe(0);
    expect(result.fileName).toMatch(/\.jpg$/);
  });

  it("maps provider errors to controlled messages without technical details", async () => {
    const providerError = Object.assign(new Error(`SignatureDoesNotMatch for ${ACCESS}`), {
      name: "SignatureDoesNotMatch", $metadata: { httpStatusCode: 403 },
    });
    const { client } = fakeClient([], { fail: providerError });
    const error = await checkCompanyLogoStorage(CompanyLogoConnectionSchema.parse(connection), () => client).catch((e) => e);
    expect(error).toBeInstanceOf(CompanyLogoError);
    expect(error.message).toContain("rechazó las llaves");
    expect(error.message).not.toContain(ACCESS);
    expect(storageErrorMessage({ name: "NoSuchBucket" }).message).toContain("bucket no existe");
    expect(storageErrorMessage(new Error("ECONNREFUSED 10.0.0.1")).message).not.toContain("10.0.0.1");
  });
});

describe("company logo SQL, audit and permissions", () => {
  it("escapes quotes in the generated SQL", () => {
    expect(buildCompanyLogoSql("https://x/a'b.png")).toContain("N'https://x/a''b.png'");
  });

  it("audit keeps only allowlisted metadata", () => {
    const entry = buildAuditLogEntry({
      entityType: "companyLogo",
      entityId: "file.png",
      action: "company_logo_uploaded",
      performedBy: "user_1",
      performedByEmail: "u@example.com",
      metadata: { assetKind: "png", bytes: 10, previousLogoCount: 1, bucket: "demo", secretKey: SECRET, databaseName: "X" },
    });
    expect(entry.metadata).toEqual({ assetKind: "png", bytes: 10, previousLogoCount: 1 });
  });

  it("declares the Implementación option with view and upload actions", () => {
    const implementation = PERMISSION_CATALOG.find((module) => module.id === "implementation")!;
    const logo = implementation.options.find((option) => option.id === "company_logo")!;
    expect(logo.label).toBe("Agregar logo a la compañía");
    expect(logo.actions.map((action) => `${logo.permissionPrefix}.${action.id}`)).toEqual([
      "implementation.company_logo.view",
      "implementation.company_logo.upload",
    ]);
  });
});
