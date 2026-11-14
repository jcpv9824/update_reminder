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

  it("accepts common web image formats by content, whatever the file name", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(16)]);
    const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBPVP8 ", "ascii"), Buffer.alloc(16)]);
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/></svg>\n');
    expect(decodeCompanyLogo(PNG.toString("base64"), "logo.png").mimeType).toBe("image/png");
    expect(decodeCompanyLogo(`data:image/jpeg;base64,${JPG.toString("base64")}`, "Logo.JPEG").extension).toBe("jpg");
    expect(decodeCompanyLogo(PNG.toString("base64"), "logo.jpeg").extension).toBe("png");
    expect(decodeCompanyLogo(gif.toString("base64"), "logo.gif").mimeType).toBe("image/gif");
    expect(decodeCompanyLogo(webp.toString("base64"), "logo.webp").mimeType).toBe("image/webp");
    expect(decodeCompanyLogo(svg.toString("base64"), "logo.svg").mimeType).toBe("image/svg+xml");
    expect(() => decodeCompanyLogo("%%%", "logo.png")).toThrow(/completa/);
  });

  it("rejects camera RAW and other files SAG Web cannot display", () => {
    const cr2 = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.from("CR", "ascii"), Buffer.alloc(32)]);
    expect(() => decodeCompanyLogo(cr2.toString("base64"), "foto.CR2")).toThrow(/no es una imagen que SAG Web pueda mostrar/);
    expect(() => decodeCompanyLogo(Buffer.from("hola").toString("base64"), "logo.txt")).toThrow(CompanyLogoError);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/a.css);</style></svg>',
  ])("rejects an SVG with code or external references: %s", (svg) => {
    expect(() => decodeCompanyLogo(Buffer.from(svg).toString("base64"), "logo.svg")).toThrow(CompanyLogoError);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="x()"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#9;script:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>alert(1)</SCRIPT></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" to="javascript:alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onload" to="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/s.svg#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><use x:href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/p)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[rect{background:url(//evil.example/a)}]]></style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/p)"/></svg>',
  ])("rejects tricks that a text filter misses: %s", (svg) => {
    expect(() => decodeCompanyLogo(Buffer.from(svg).toString("base64"), "logo.svg")).toThrow(/código o enlaces externos/);
  });

  it("rejects a malformed SVG as an image SAG Web cannot display", () => {
    expect(() => decodeCompanyLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>').toString("base64"), "logo.svg"))
      .toThrow(/no es una imagen que SAG Web pueda mostrar/);
  });

  it("uploads a rebuilt SVG, never the original bytes", () => {
    const original = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<!-- Generator: Editor 1.0 -->",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
      '  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1.3" viewBox="0 0 20 10" width="200">',
      '  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>',
      "  <defs><style>.cls-1{fill:#1c3664}.a > .b{fill:url(#g)}</style>",
      '    <linearGradient id="g"><stop offset="0" stop-color="#bba461"/></linearGradient></defs>',
      '  <a href="#logo"><path class="cls-1" d="M0 0h10v10H0z" data-name="Capa 1" inkscape:label="x"/></a>',
      '  <use xlink:href="#logo"/>',
      '  <image width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/>',
      "  <text x=\"1\" y=\"9\">P&amp;A &lt;SAG&gt;</text>",
      "</svg>",
    ].join("\n");
    const decoded = decodeCompanyLogo(Buffer.from(original).toString("base64"), "logo.svg");
    const out = decoded.bytes.toString("utf8");
    expect(decoded.extension).toBe("svg");
    expect(out).not.toBe(original);
    expect(out).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(out).not.toMatch(/inkscape|metadata|rdf|Generator|data-name|<a[\s>]/);
    expect(out).toContain('viewBox="0 0 20 10"');
    expect(out).toContain('<path class="cls-1" d="M0 0h10v10H0z"/>');
    expect(out).toContain('xlink:href="#logo"');
    expect(out).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(out).toContain(".a &gt; .b{fill:url(#g)}");
    expect(out).toContain("P&amp;A &lt;SAG&gt;");
    // El resultado es XML válido y se vuelve a limpiar igual (idempotente).
    const again = decodeCompanyLogo(decoded.bytes.toString("base64"), "logo.svg").bytes.toString("utf8");
    expect(again).toBe(out);
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
      companyName: "SAGWebDemoPYA",
      metadata: { assetKind: "png", bytes: 10, previousLogoCount: 1, bucket: "demo", secretKey: SECRET, databaseName: "X" },
    });
    expect(entry.metadata).toEqual({ assetKind: "png", bytes: 10, previousLogoCount: 1 });
    expect(entry.companyName).toBe("SAGWebDemoPYA");
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
