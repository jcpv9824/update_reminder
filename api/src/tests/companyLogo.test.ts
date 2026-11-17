import { describe, expect, it, vi } from "vitest";
import {
  checkCompanyStorage,
  CompanyLogoError,
  companyLogoFolder,
  COMPANY_STORAGE_DEFAULTS,
  decodeCompanyLogo,
  LogoImageSchema,
  StorageSchema,
  storageBaseUrl,
  storageErrorMessage,
  type S3Sender,
} from "../lib/companyLogo";
import { buildAuditLogEntry } from "../lib/audit";
import { PERMISSION_CATALOG } from "../lib/permissionModel";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const SECRET = "SuperSecretKey-1234567890";
const ACCESS = "AccessKeyExample";

const publicDns = async () => ["20.30.40.50"];

const storageInput = {
  bucket: "  demo.sagerp.cloud.buk ",
  accessKey: ` ${ACCESS} `,
  secretKey: ` ${SECRET}\t`,
};

function fakeS3(existing: Array<{ Key: string; Size: number; LastModified: Date }>, options: { fail?: unknown } = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client: S3Sender = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (options.fail) throw options.fail;
      if (command.constructor.name === "ListObjectsV2Command") return { Contents: existing };
      if (command.constructor.name === "GetObjectCommand") {
        const put = [...sent].reverse().find((item) => item.name === "PutObjectCommand" && item.input.Key === command.input.Key);
        const body = (put?.input.Body as Buffer) ?? Buffer.alloc(0);
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
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

describe("storage section validation", () => {
  it("trims every field and fills the additional parameters with the defaults", () => {
    expect(StorageSchema.parse(storageInput)).toEqual({
      bucket: "demo.sagerp.cloud.buk",
      accessKey: ACCESS,
      secretKey: SECRET,
      options: { ...COMPANY_STORAGE_DEFAULTS },
    });
  });

  it.each([
    [{ bucket: "Demo_Bucket" }, "bucket"],
    [{ bucket: "ab" }, "bucket"],
    [{ bucket: "demo bucket" }, "espacios"],
    [{ accessKey: "" }, "access key"],
    [{ accessKey: "abc def" }, "espacios"],
    [{ secretKey: "abc def ghi" }, "espacios"],
    [{ secretKey: "short" }, "incompleto"],
  ])("rejects %o with an actionable message", (override, text) => {
    const result = StorageSchema.safeParse({ ...storageInput, ...override });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message.toLowerCase()).toContain(text);
  });

  it("accepts edited additional parameters and trims them", () => {
    const parsed = StorageSchema.parse({
      ...storageInput,
      options: { endpoint: " s3.sagweb.co ", port: 9000, basePath: " Datos/Web/ ", region: " us-west-2 " },
    });
    expect(parsed.options).toEqual({ endpoint: "s3.sagweb.co", port: 9000, basePath: "Datos/Web/", region: "us-west-2" });
  });

  it.each([
    [{ endpoint: "https://storcube.sagweb.co" }, "sin https"],
    [{ endpoint: "localhost" }, "no está aprobado"],
    [{ endpoint: "169.254.169.254" }, "no está aprobado"],
    [{ endpoint: "s3.amazonaws.com" }, "no está aprobado"],
    [{ endpoint: "sagweb.co.evil.com" }, "no está aprobado"],
    [{ port: 70000 }, "65535"],
    [{ basePath: "Archivos" }, "terminada en /"],
    [{ basePath: "../x/" }, "ruta base"],
  ])("rejects additional parameter %o", (override, text) => {
    const result = StorageSchema.safeParse({ ...storageInput, options: { ...COMPANY_STORAGE_DEFAULTS, ...override } });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message.toLowerCase()).toContain(text.toLowerCase());
  });

  it("uses the approved storage hosts from the API settings", () => {
    const previous = process.env.COMPANY_STORAGE_ALLOWED_HOSTS;
    process.env.COMPANY_STORAGE_ALLOWED_HOSTS = "s3.aprobado.co";
    try {
      expect(StorageSchema.safeParse({ ...storageInput, options: { ...COMPANY_STORAGE_DEFAULTS, endpoint: "s3.aprobado.co" } }).success).toBe(true);
      expect(StorageSchema.safeParse({ ...storageInput, options: { ...COMPANY_STORAGE_DEFAULTS, endpoint: "storcube.sagweb.co" } }).success).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.COMPANY_STORAGE_ALLOWED_HOSTS;
      else process.env.COMPANY_STORAGE_ALLOWED_HOSTS = previous;
    }
  });

  it("always uses HTTPS and does not accept an option to turn it off", () => {
    expect(storageBaseUrl(StorageSchema.parse(storageInput).options)).toBe("https://storcube.sagweb.co:8333");
    expect(StorageSchema.safeParse({ ...storageInput, options: { ...COMPANY_STORAGE_DEFAULTS, useSsl: false } }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(StorageSchema.safeParse({ ...storageInput, databaseName: "X" }).success).toBe(false);
  });
});

describe("company logo images", () => {
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
    const result = LogoImageSchema.safeParse({ imageBase64: "A".repeat(3_000_001), imageName: "logo.png" });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toContain("2 MB");
  });

  it("rejects images over 2 MB", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect(() => decodeCompanyLogo(big.toString("base64"), "logo.png")).toThrow(/2 MB/);
  });
});


describe("storage check", () => {
  it("lists the dedicated logo folder and reports existing logos, newest first", async () => {
    const { client, sent } = fakeS3([
      { Key: "SAGWebDemoPYA/Archivos/Imagenes/LogoEmpresa/a.jpg", Size: 10, LastModified: new Date("2026-09-01") },
      { Key: "SAGWebDemoPYA/Archivos/Imagenes/LogoEmpresa/b.png", Size: 20, LastModified: new Date("2026-11-01") },
    ]);
    const result = await checkCompanyStorage(StorageSchema.parse(storageInput), "SAGWebDemoPYA", () => client, publicDns);
    expect(sent[0].input).toMatchObject({ Bucket: "demo.sagerp.cloud.buk", Prefix: "SAGWebDemoPYA/Archivos/Imagenes/LogoEmpresa/" });
    expect(result.existing.map((item) => item.name)).toEqual(["b.png", "a.jpg"]);
    // Con el nombre de la base, además escribe, lee y borra un archivo de prueba.
    expect(sent.map((item) => item.name)).toEqual(["ListObjectsV2Command", "PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("only validates the keys when the database name is not known yet", async () => {
    const { client, sent } = fakeS3([]);
    const result = await checkCompanyStorage(StorageSchema.parse(storageInput), null, () => client, publicDns);
    expect(result).toEqual({ folder: null, existing: [] });
    expect(sent[0].input).toEqual({ Bucket: "demo.sagerp.cloud.buk", MaxKeys: 1 });
  });

  it("uses the edited base path for the folder", () => {
    const storage = StorageSchema.parse({ ...storageInput, options: { ...COMPANY_STORAGE_DEFAULTS, basePath: "Datos/" } });
    expect(companyLogoFolder("Base1", storage.options)).toBe("Base1/Datos/Imagenes/LogoEmpresa/");
  });

  it("refuses a storage host that resolves to the internal network, before connecting", async () => {
    const { client, sent } = fakeS3([]);
    const error = await checkCompanyStorage(StorageSchema.parse(storageInput), null, () => client, async () => ["10.0.0.4"]).catch((e) => e);
    expect(error.message).toContain("red interna");
    expect(sent).toHaveLength(0);
  });

  it("maps provider errors to controlled messages without technical details", async () => {
    const providerError = Object.assign(new Error(`SignatureDoesNotMatch for ${ACCESS}`), {
      name: "SignatureDoesNotMatch", $metadata: { httpStatusCode: 403 },
    });
    const { client } = fakeS3([], { fail: providerError });
    const error = await checkCompanyStorage(StorageSchema.parse(storageInput), "X", () => client, publicDns).catch((e) => e);
    expect(error).toBeInstanceOf(CompanyLogoError);
    expect(error.message).toContain("rechazó las llaves");
    expect(error.message).not.toContain(ACCESS);
    expect(storageErrorMessage({ name: "NoSuchBucket" }).message).toContain("bucket no existe");
    expect(storageErrorMessage(new Error("ECONNREFUSED 10.0.0.1")).message).not.toContain("10.0.0.1");
  });
});

describe("audit and permissions", () => {
  it("audit keeps only allowlisted metadata", () => {
    const entry = buildAuditLogEntry({
      entityType: "companyStorage",
      entityId: "SAGWebDemoPYA",
      action: "company_storage_configured",
      performedBy: "user_1",
      performedByEmail: "u@example.com",
      companyName: "SAGWebDemoPYA",
      metadata: {
        logoUpdated: true, assetKind: "png", bytes: 10, previousLogoCount: 1, changedFieldCount: 2, keysChanged: false,
        bucket: "demo", secretKey: SECRET, server: "srv,1433", password: "x",
      },
    });
    expect(entry.metadata).toEqual({
      logoUpdated: true, assetKind: "png", bytes: 10, previousLogoCount: 1, changedFieldCount: 2, keysChanged: false,
    });
    expect(entry.companyName).toBe("SAGWebDemoPYA");
  });

  it("declares the Implementación option with view and configure actions", () => {
    const implementation = PERMISSION_CATALOG.find((module) => module.id === "implementation")!;
    const logo = implementation.options.find((option) => option.id === "company_logo")!;
    expect(logo.label).toBe("Almacenamiento de archivos y logo");
    expect(logo.actions.map((action) => `${logo.permissionPrefix}.${action.id}`)).toEqual([
      "implementation.company_logo.view",
      "implementation.company_logo.upload",
    ]);
    expect(logo.actions[1].label).toBe("Configurar Almacenamiento y Subir Logo");
  });
});

void JPG;
