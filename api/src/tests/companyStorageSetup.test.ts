import { describe, expect, it, vi } from "vitest";
import type { S3Sender } from "../lib/companyLogo";
import {
  CompanyDatabaseSchema,
  createCompanyDatabaseOpener,
  databaseErrorMessage,
  parseServer,
  STORAGE_COLUMNS,
  type CompanyDatabaseSession,
  type ParametrosWebValues,
  type StorageWrite,
} from "../lib/companyDatabase";
import {
  applyCompanyStorage,
  ApplyCompanyStorageSchema,
  checkCompanyDatabase,
} from "../lib/companyStorageSetup";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const SECRET = "SuperSecretKey-1234567890";
const ACCESS = "AccessKeyExample";
const publicDns = async () => ["20.30.40.50"];
const SQL_PASSWORD = "Clave SQL con espacios 123";

const database = {
  server: " data14.sagerp.co,54103 ",
  databaseName: " SAGWebDemo ",
  username: " usuario_sql ",
  password: `  ${SQL_PASSWORD} `,
};
const storage = { bucket: " demo.sagerp.cloud.buk ", accessKey: ` ${ACCESS} `, secretKey: ` ${SECRET} ` };

function emptyRow(): ParametrosWebValues {
  return Object.fromEntries(STORAGE_COLUMNS.map((column) => [column, ""])) as ParametrosWebValues;
}

function fakeSession(initial: Partial<ParametrosWebValues> = {}, options: { rows?: number; failWrite?: unknown } = {}) {
  let row: ParametrosWebValues = { ...emptyRow(), ...initial };
  const writes: StorageWrite[] = [];
  const session: CompanyDatabaseSession & { closed: boolean } = {
    closed: false,
    inspect: vi.fn(async () => ({ rows: options.rows ?? 1, current: { ...row } })),
    write: vi.fn(async (values: StorageWrite) => {
      if (options.failWrite) throw options.failWrite;
      writes.push(values);
      row = { ...row, ...values } as ParametrosWebValues;
    }),
    close: vi.fn(async () => { session.closed = true; }),
  };
  return { session, writes, opener: vi.fn(async () => session) };
}

function fakeS3(existing: string[] = []) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client: S3Sender = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: existing.map((name) => ({ Key: `SAGWebDemo/Archivos/Imagenes/LogoEmpresa/${name}`, Size: 5, LastModified: new Date() })) };
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

function input(extra: Record<string, unknown> = {}) {
  return ApplyCompanyStorageSchema.parse({ storage, database, ...extra });
}

describe("database section validation", () => {
  it("trims every field; the password keeps its inner spaces", () => {
    expect(CompanyDatabaseSchema.parse(database)).toEqual({
      server: "data14.sagerp.co,54103",
      databaseName: "SAGWebDemo",
      username: "usuario_sql",
      password: SQL_PASSWORD,
    });
  });

  it.each([
    [{ server: "data14.sagerp.co, 54103" }, "espacios"],
    [{ server: "data14.sagerp.co:54103" }, "servidor,puerto"],
    [{ server: "srv,99999" }, "servidor,puerto"],
    [{ databaseName: "Mi Base" }, "espacios"],
    [{ databaseName: "base;drop" }, "solo admite"],
    [{ username: "usuario sql" }, "espacios"],
    [{ password: "   " }, "obligatoria"],
  ])("rejects %o with an actionable message", (override, text) => {
    const result = CompanyDatabaseSchema.safeParse({ ...database, ...override });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message.toLowerCase()).toContain(text.toLowerCase());
  });

  it("parses server, instance and port like SSMS", () => {
    expect(parseServer("data14.sagerp.co,54103")).toEqual({ host: "data14.sagerp.co", port: 54103 });
    expect(parseServer("10.0.0.5")).toEqual({ host: "10.0.0.5" });
    expect(parseServer("SRV01\\SQLEXPRESS")).toEqual({ host: "SRV01", instanceName: "SQLEXPRESS" });
  });

  it("refuses a database server that resolves to the internal network, before sending credentials", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.10", "169.254.169.254", "::1", "fd00::1"]) {
      const open = createCompanyDatabaseOpener(async () => [address]);
      await expect(open(CompanyDatabaseSchema.parse(database))).rejects.toThrow(/red interna/);
    }
  });

  it("explains an invalid server certificate without exposing details", () => {
    const error = databaseErrorMessage({ code: "ESOCKET", message: "Hostname/IP does not match certificate's altnames: IP: 10.0.0.5 is not in the cert's list" });
    expect(error.message).toContain("certificado válido");
    expect(error.message).not.toContain("10.0.0.5");
    expect(databaseErrorMessage({ code: "ESOCKET", message: "self-signed certificate" }).message).toContain("certificado");
  });

  it("maps SQL Server errors to controlled messages without details", () => {
    expect(databaseErrorMessage({ code: "ELOGIN", message: `Login failed for user 'usuario_sql'` }).message).toContain("usuario o la contraseña");
    expect(databaseErrorMessage({ number: 4060 }).message).toContain("base de datos no existe");
    expect(databaseErrorMessage({ code: "ESOCKET", message: "connect ECONNREFUSED 10.1.1.1:1433" }).message).not.toContain("10.1.1.1");
    expect(databaseErrorMessage({ code: "ETIMEOUT" }).status).toBe(504);
  });
});

describe("check database", () => {
  it("returns the current non-secret configuration and closes the connection", async () => {
    const { session, opener } = fakeSession({ MinioBucketName: "viejo", MinioAccessKey: "A", MinioSecretKey: "S", LogoEmpresa: "https://x/l.png" });
    const result = await checkCompanyDatabase(CompanyDatabaseSchema.parse(database), opener);
    expect(result.current).toMatchObject({ bucket: "viejo", keysConfigured: true, logoUrl: "https://x/l.png" });
    expect(JSON.stringify(result)).not.toMatch(/"A"|"S"/);
    expect(session.closed).toBe(true);
  });

  it("rejects a database whose parametros_web has no rows", async () => {
    const { opener, session } = fakeSession({}, { rows: 0 });
    await expect(checkCompanyDatabase(CompanyDatabaseSchema.parse(database), opener)).rejects.toThrow(/no tiene registros/);
    expect(session.closed).toBe(true);
  });
});

describe("apply storage configuration", () => {
  it("configures the storage on a clean company without asking for confirmation", async () => {
    const { session, writes, opener } = fakeSession();
    const { client, sent } = fakeS3();
    const result = await applyCompanyStorage(input(), { openDatabase: opener, s3Factory: () => client, resolver: publicDns });
    expect(writes).toEqual([{
      MinioNameEnterprise: "SAGWebDemo",
      MinioBucketName: "demo.sagerp.cloud.buk",
      MinioAccessKey: ACCESS,
      MinioSecretKey: SECRET,
      MinioEndpoint: "storcube.sagweb.co",
      MinioPort: "8333",
      MinioUseSSL: "S",
      MinioBasePath: "Archivos/",
    }]);
    expect(sent.some((item) => item.name === "PutObjectCommand")).toBe(false);
    expect(result).toMatchObject({ storageConfigured: true, logoUpdated: false, logoUrl: null, changes: [] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SQL_PASSWORD);
    expect(session.closed).toBe(true);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("uploads the logo and writes storage and LogoEmpresa together", async () => {
    const { writes, opener } = fakeSession();
    const { client, sent } = fakeS3();
    const result = await applyCompanyStorage(
      input({ logo: { imageBase64: PNG.toString("base64"), imageName: "logo.png" } }),
      { openDatabase: opener, s3Factory: () => client, resolver: publicDns },
    );
    const put = sent.find((item) => item.name === "PutObjectCommand")!;
    expect(put.input.Key).toMatch(/^SAGWebDemo\/Archivos\/Imagenes\/LogoEmpresa\/[0-9a-f-]{36}\.png$/);
    expect(result.logoUrl).toBe(`https://storcube.sagweb.co:8333/demo.sagerp.cloud.buk/${put.input.Key}`);
    expect(writes[0].LogoEmpresa).toBe(result.logoUrl);
    expect(writes[0].MinioBucketName).toBe("demo.sagerp.cloud.buk");
    expect(result.logoUpdated).toBe(true);
  });

  it("asks for confirmation before replacing a logo or other storage values, and writes nothing", async () => {
    const { writes, opener } = fakeSession({
      LogoEmpresa: "https://storcube.sagweb.co:8333/otro/SAGWebDemo/Archivos/Imagenes/LogoEmpresa/old.png",
      MinioBucketName: "otro", MinioAccessKey: "OLD", MinioSecretKey: "OLDSECRET", MinioPort: "8333",
    });
    const { client, sent } = fakeS3(["old.png"]);
    const error = await applyCompanyStorage(
      input({ logo: { imageBase64: PNG.toString("base64"), imageName: "logo.png" } }),
      { openDatabase: opener, s3Factory: () => client, resolver: publicDns },
    ).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ requiresConfirmation: true, keysChanged: true, existingLogoCount: 1, replacesLogo: true });
    expect(error.details.changes).toEqual([{ field: "MinioBucketName", label: "Bucket", before: "otro", after: "demo.sagerp.cloud.buk" }]);
    expect(JSON.stringify(error.details)).not.toMatch(/OLDSECRET|"OLD"/);
    expect(writes).toEqual([]);
    expect(sent.some((item) => item.name === "PutObjectCommand")).toBe(false);
  });

  it("does not ask again when the same configuration is applied twice", async () => {
    const { opener } = fakeSession({
      MinioNameEnterprise: "SAGWebDemo", MinioBucketName: "demo.sagerp.cloud.buk", MinioAccessKey: ACCESS, MinioSecretKey: SECRET,
      MinioEndpoint: "storcube.sagweb.co", MinioPort: "8333.0", MinioUseSSL: "S", MinioBasePath: "Archivos/",
    });
    const { client } = fakeS3();
    await expect(applyCompanyStorage(input(), { openDatabase: opener, s3Factory: () => client, resolver: publicDns })).resolves.toMatchObject({ changes: [] });
  });

  it("writes after confirmation and keeps the old images", async () => {
    const { writes, opener } = fakeSession({ LogoEmpresa: "https://x/old.png", MinioBucketName: "otro" });
    const { client, sent } = fakeS3(["old.png"]);
    const result = await applyCompanyStorage(
      input({ confirmed: true, logo: { imageBase64: PNG.toString("base64"), imageName: "logo.png" } }),
      { openDatabase: opener, s3Factory: () => client, resolver: publicDns },
    );
    expect(writes).toHaveLength(1);
    expect(sent.some((item) => item.name === "DeleteObjectCommand")).toBe(false);
    expect(result.previousLogoCount).toBe(1);
  });

  it("fails cleanly when the database rejects the write, and closes everything", async () => {
    const { session, opener } = fakeSession({}, { failWrite: { number: 229, message: "UPDATE permission denied on object parametros_web" } });
    const { client } = fakeS3();
    const error = await applyCompanyStorage(input(), { openDatabase: opener, s3Factory: () => client, resolver: publicDns }).catch((e) => e);
    expect(error.message).toContain("no tiene permiso");
    expect(session.closed).toBe(true);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("validates the image before touching the database", async () => {
    const { opener } = fakeSession();
    await expect(applyCompanyStorage(
      input({ logo: { imageBase64: Buffer.from("hola").toString("base64"), imageName: "x.txt" } }),
      { openDatabase: opener, s3Factory: () => fakeS3().client, resolver: publicDns },
    )).rejects.toThrow(/no es una imagen/);
    expect(opener).not.toHaveBeenCalled();
  });

  it("uses the edited additional parameters", async () => {
    const { writes, opener } = fakeSession();
    const { client } = fakeS3();
    await applyCompanyStorage(
      ApplyCompanyStorageSchema.parse({
        storage: { ...storage, options: { endpoint: "s3.sagweb.co", port: 9000, basePath: "Datos/", region: "us-east-1" } },
        database,
      }),
      { openDatabase: opener, s3Factory: () => client, resolver: publicDns },
    );
    expect(writes[0]).toMatchObject({ MinioEndpoint: "s3.sagweb.co", MinioPort: "9000", MinioUseSSL: "S", MinioBasePath: "Datos/" });
  });
});
