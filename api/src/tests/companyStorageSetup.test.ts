import { describe, expect, it, vi } from "vitest";
import { CompanyLogoError, type S3Sender } from "../lib/companyLogo";
import {
  CompanyDatabaseSchema,
  configurationFingerprint,
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
import { legacyCheck, LegacyUploadSchema, legacyUpload } from "../lib/companyLogoLegacy";

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

/**
 * Sesión simulada que se comporta como la real: write() compara la huella
 * esperada con la configuración del momento (dentro de la «transacción»).
 * `changeBeforeWrite` simula que otra persona cambió la configuración.
 */
function fakeSession(
  initial: Partial<ParametrosWebValues> = {},
  options: { rows?: number; failWrite?: unknown; changeBeforeWrite?: Partial<ParametrosWebValues> } = {},
) {
  let row: ParametrosWebValues = { ...emptyRow(), ...initial };
  const writes: StorageWrite[] = [];
  const session: CompanyDatabaseSession & { closed: boolean } = {
    closed: false,
    inspect: vi.fn(async () => ({ rows: options.rows ?? 1, current: { ...row }, fingerprint: configurationFingerprint(row) })),
    write: vi.fn(async (values: StorageWrite, expected: string) => {
      if (options.failWrite) throw options.failWrite;
      if (options.changeBeforeWrite) row = { ...row, ...options.changeBeforeWrite };
      if (configurationFingerprint(row) !== expected) {
        throw new CompanyLogoError("La configuración de la compañía cambió mientras se revisaba. No se cambió nada: revise de nuevo y confirme.", 409, { stale: true });
      }
      writes.push(values);
      row = { ...row, ...values } as ParametrosWebValues;
    }),
    close: vi.fn(async () => { session.closed = true; }),
  };
  return { session, writes, opener: vi.fn(async () => session) };
}

function fakeS3(existing: string[] = [], options: { corruptReads?: boolean } = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const objects = new Map<string, Buffer>();
  const client: S3Sender = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      sent.push({ name, input: command.input });
      if (name === "ListObjectsV2Command") {
        return { Contents: existing.map((file) => ({ Key: `SAGWebDemo/Archivos/Imagenes/LogoEmpresa/${file}`, Size: 5, LastModified: new Date() })) };
      }
      if (name === "PutObjectCommand") { objects.set(key, command.input.Body as Buffer); return {}; }
      if (name === "HeadObjectCommand") return { ContentLength: objects.get(key)?.length };
      if (name === "GetObjectCommand") {
        const body = options.corruptReads ? Buffer.from("otro contenido") : objects.get(key) ?? Buffer.alloc(0);
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (name === "DeleteObjectCommand") { objects.delete(key); return {}; }
      return {};
    }) as unknown as S3Sender["send"],
    destroy: vi.fn(),
  };
  return { client, sent, objects };
}

function input(extra: Record<string, unknown> = {}) {
  return ApplyCompanyStorageSchema.parse({ storage, database, ...extra });
}

const deps = (opener: ReturnType<typeof fakeSession>["opener"], client: S3Sender) => ({ openDatabase: opener, s3Factory: () => client, resolver: publicDns });
const logoInput = { imageBase64: PNG.toString("base64"), imageName: "logo.png" };
const uploadedLogos = (sent: Array<{ name: string; input: Record<string, unknown> }>) =>
  sent.filter((item) => item.name === "PutObjectCommand" && String(item.input.Key).includes("/LogoEmpresa/"));

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
    expect(parseServer("servidor.ejemplo.co")).toEqual({ host: "servidor.ejemplo.co", port: 1433 });
    expect(() => parseServer("SRV01\\SQLEXPRESS")).toThrow();
    expect(CompanyDatabaseSchema.safeParse({ ...database, server: "SRV01\\SQLEXPRESS" }).success).toBe(false);
  });

  it("refuses a database server that resolves to the internal network, before sending credentials", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.10", "169.254.169.254", "::1", "fd00::1"]) {
      const open = createCompanyDatabaseOpener(async () => [address]);
      await expect(open(CompanyDatabaseSchema.parse(database))).rejects.toThrow(/red interna/);
    }
  });

  it("blocks the real connection when the name changes to an internal address after the check", async () => {
    let calls = 0;
    const rebinding = async () => (calls++ === 0 ? ["20.30.40.50"] : ["127.0.0.1"]);
    const open = createCompanyDatabaseOpener(rebinding);
    const error = await open(CompanyDatabaseSchema.parse(database)).catch((e) => e);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(error.message).toContain("red interna");
    expect(error.message).not.toContain(SQL_PASSWORD);
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
  it("returns the current non-secret configuration, says only whether there is a logo, and closes", async () => {
    const signed = "https://x/l.png?X-Amz-Signature=abcdef0123456789";
    const { session, opener } = fakeSession({ MinioBucketName: "viejo", MinioAccessKey: "A", MinioSecretKey: "S", LogoEmpresa: signed });
    const result = await checkCompanyDatabase(CompanyDatabaseSchema.parse(database), opener);
    expect(result.current).toMatchObject({ bucket: "viejo", keysConfigured: true, hasLogo: true });
    expect(JSON.stringify(result)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(result)).not.toContain("l.png");
    expect(JSON.stringify(result)).not.toMatch(/"A"|"S"/);
    expect(session.closed).toBe(true);
  });

  it("refuses to configure when parametros_web has more than one row, and writes nothing", async () => {
    const { opener, session, writes } = fakeSession({}, { rows: 2 });
    const { client } = fakeS3();
    const error = await applyCompanyStorage(input(), deps(opener, client)).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.message).toContain("2 filas");
    expect(error.details).toMatchObject({ databaseChanged: false, stage: "database" });
    expect(writes).toEqual([]);
    expect(session.closed).toBe(true);
  });

  it("rejects a database whose parametros_web has no rows", async () => {
    const { opener, session } = fakeSession({}, { rows: 0 });
    await expect(checkCompanyDatabase(CompanyDatabaseSchema.parse(database), opener)).rejects.toThrow(/no tiene registros/);
    expect(session.closed).toBe(true);
  });
});

describe("apply storage configuration", () => {
  it("proves write, read and delete on the storage, then configures a clean company", async () => {
    const { session, writes, opener } = fakeSession();
    const { client, sent, objects } = fakeS3();
    const result = await applyCompanyStorage(input(), deps(opener, client));
    const probe = sent.find((item) => item.name === "PutObjectCommand")!;
    expect(String(probe.input.Key)).toMatch(/^SAGWebDemo\/Archivos\/\.portal-sag-web\/prueba-[0-9a-f-]{36}\.txt$/);
    expect(sent.map((item) => item.name)).toEqual(expect.arrayContaining(["GetObjectCommand", "DeleteObjectCommand"]));
    expect(objects.size).toBe(0); // el archivo de prueba se borró
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
    expect(uploadedLogos(sent)).toHaveLength(0);
    expect(result).toMatchObject({ storageConfigured: true, databaseChanged: true, logoUpdated: false, logoUrl: null, changes: [] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SQL_PASSWORD);
    expect(session.closed).toBe(true);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("does not save keys that cannot read back what they write", async () => {
    const { writes, opener } = fakeSession();
    const { client } = fakeS3([], { corruptReads: true });
    const error = await applyCompanyStorage(input(), deps(opener, client)).catch((e) => e);
    expect(error.message).toContain("contenido distinto");
    expect(error.details).toMatchObject({ databaseChanged: false, stage: "storage" });
    expect(writes).toEqual([]);
  });

  it("uploads the logo and writes storage and LogoEmpresa together", async () => {
    const { writes, opener } = fakeSession();
    const { client, sent } = fakeS3();
    const result = await applyCompanyStorage(input({ logo: logoInput }), deps(opener, client));
    const put = uploadedLogos(sent)[0];
    expect(put.input.Key).toMatch(/^SAGWebDemo\/Archivos\/Imagenes\/LogoEmpresa\/[0-9a-f-]{36}\.png$/);
    expect(result.logoUrl).toBe(`https://storcube.sagweb.co:8333/demo.sagerp.cloud.buk/${put.input.Key}`);
    expect(writes[0].LogoEmpresa).toBe(result.logoUrl);
    expect(result.logoUpdated).toBe(true);
  });

  it("asks for confirmation with a fingerprint, without returning the stored logo URL, and writes nothing", async () => {
    const stored = "https://storcube.sagweb.co:8333/otro/SAGWebDemo/Archivos/Imagenes/LogoEmpresa/old.png?X-Amz-Signature=zz";
    const { writes, opener } = fakeSession({
      LogoEmpresa: stored, MinioBucketName: "otro", MinioAccessKey: "OLD", MinioSecretKey: "OLDSECRET", MinioPort: "8333",
    });
    const { client, sent } = fakeS3(["old.png"]);
    const error = await applyCompanyStorage(input({ logo: logoInput }), deps(opener, client)).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({
      requiresConfirmation: true, stale: false, keysChanged: true, existingLogoCount: 1, replacesLogo: true, hasLogo: true,
      databaseChanged: false, stage: "confirmation",
    });
    expect(error.details.confirmationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(error.details.changes).toEqual([{ field: "MinioBucketName", label: "Bucket", before: "otro", after: "demo.sagerp.cloud.buk" }]);
    const serialized = JSON.stringify(error.details);
    expect(serialized).not.toMatch(/OLDSECRET|"OLD"|X-Amz-Signature|old\.png/);
    expect(writes).toEqual([]);
    expect(uploadedLogos(sent)).toHaveLength(0);
  });

  it("writes only with the fingerprint of the configuration that was reviewed", async () => {
    const initial = { LogoEmpresa: "https://x/old.png", MinioBucketName: "otro" };
    const first = fakeSession(initial);
    const conflict = await applyCompanyStorage(input({ logo: logoInput }), deps(first.opener, fakeS3(["old.png"]).client)).catch((e) => e);
    const token = conflict.details.confirmationToken;

    const second = fakeSession(initial);
    const { client, sent } = fakeS3(["old.png"]);
    const result = await applyCompanyStorage(input({ confirmationToken: token, logo: logoInput }), deps(second.opener, client));
    expect(second.writes).toHaveLength(1);
    expect(sent.filter((item) => item.name === "DeleteObjectCommand" && String(item.input.Key).includes("/LogoEmpresa/"))).toHaveLength(0);
    expect(result.previousLogoCount).toBe(1);
  });

  it("refuses a confirmation that does not match the current configuration (changed after it was reviewed)", async () => {
    const reviewed = fakeSession({ MinioBucketName: "otro" });
    const token = (await applyCompanyStorage(input(), deps(reviewed.opener, fakeS3().client)).catch((e) => e)).details.confirmationToken;

    const changed = fakeSession({ MinioBucketName: "otro-mas-nuevo" });
    const { client, sent } = fakeS3();
    const error = await applyCompanyStorage(input({ confirmationToken: token }), deps(changed.opener, client)).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ requiresConfirmation: true, stale: true, databaseChanged: false });
    expect(error.details.changes[0]).toMatchObject({ before: "otro-mas-nuevo" });
    expect(changed.writes).toEqual([]);
    expect(uploadedLogos(sent)).toHaveLength(0);
  });

  it("refuses to write when the configuration changes between the confirmation and the transaction, and removes the uploaded logo", async () => {
    const initial = { MinioBucketName: "otro" };
    const token = (await applyCompanyStorage(input(), deps(fakeSession(initial).opener, fakeS3().client)).catch((e) => e)).details.confirmationToken;
    const racing = fakeSession(initial, { changeBeforeWrite: { MinioBucketName: "cambiado-por-otra-persona" } });
    const { client, sent, objects } = fakeS3();
    const error = await applyCompanyStorage(input({ confirmationToken: token, logo: logoInput }), deps(racing.opener, client)).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ stale: true, databaseChanged: false, stage: "database", uploadedLogoRemoved: true });
    expect(racing.writes).toEqual([]);
    expect(uploadedLogos(sent)).toHaveLength(1);
    expect(objects.size).toBe(0); // el logo recién subido se borró
  });

  it("does not ask again when the same configuration is applied twice", async () => {
    const { opener } = fakeSession({
      MinioNameEnterprise: "SAGWebDemo", MinioBucketName: "demo.sagerp.cloud.buk", MinioAccessKey: ACCESS, MinioSecretKey: SECRET,
      MinioEndpoint: "storcube.sagweb.co", MinioPort: "8333.0", MinioUseSSL: "S", MinioBasePath: "Archivos/",
    });
    await expect(applyCompanyStorage(input(), deps(opener, fakeS3().client))).resolves.toMatchObject({ changes: [] });
  });

  it("fails cleanly when the database rejects the write, removes the uploaded logo and closes everything", async () => {
    const { session, opener } = fakeSession({}, { failWrite: { number: 229, message: "UPDATE permission denied on object parametros_web" } });
    const { client, objects } = fakeS3();
    const error = await applyCompanyStorage(input({ logo: logoInput }), deps(opener, client)).catch((e) => e);
    expect(error.message).toContain("no tiene permiso");
    expect(error.details).toMatchObject({ databaseChanged: false, stage: "database", uploadedLogoRemoved: true });
    expect(objects.size).toBe(0);
    expect(session.closed).toBe(true);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("validates the image before touching the database", async () => {
    const { opener } = fakeSession();
    const error = await applyCompanyStorage(
      input({ logo: { imageBase64: Buffer.from("hola").toString("base64"), imageName: "x.txt" } }),
      deps(opener, fakeS3().client),
    ).catch((e) => e);
    expect(error.message).toMatch(/no es una imagen/);
    expect(error.details).toMatchObject({ databaseChanged: false, stage: "validation" });
    expect(opener).not.toHaveBeenCalled();
  });

  it("uses the edited additional parameters", async () => {
    const { writes, opener } = fakeSession();
    await applyCompanyStorage(
      ApplyCompanyStorageSchema.parse({
        storage: { ...storage, options: { endpoint: "s3.sagweb.co", port: 9000, basePath: "Datos/", region: "us-east-1" } },
        database,
      }),
      deps(opener, fakeS3().client),
    );
    expect(writes[0]).toMatchObject({ MinioEndpoint: "s3.sagweb.co", MinioPort: "9000", MinioUseSSL: "S", MinioBasePath: "Datos/" });
  });

  it("the fingerprint changes with any value, including the keys, and does not contain them", () => {
    const base = { ...emptyRow(), MinioAccessKey: ACCESS, MinioSecretKey: SECRET, MinioBucketName: "b" };
    const fingerprint = configurationFingerprint(base);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain(SECRET);
    expect(configurationFingerprint({ ...base, MinioSecretKey: "Otra-Llave-123" })).not.toBe(fingerprint);
    expect(configurationFingerprint({ ...base, LogoEmpresa: "x" })).not.toBe(fingerprint);
  });
});

describe("temporary compatibility with the previous frontend (/check and /upload)", () => {
  const legacy = { bucket: "demo.sagerp.cloud.buk", accessKey: ACCESS, secretKey: SECRET, databaseName: "SAGWebDemo" };

  it("keeps the previous /check contract", async () => {
    const { client } = fakeS3(["old.png"]);
    await expect(legacyCheck(legacy, () => client)).resolves.toMatchObject({
      folder: "SAGWebDemo/Archivos/Imagenes/LogoEmpresa/",
      existing: [{ name: "old.png" }],
    });
  });

  it("keeps the previous /upload contract: 409 without confirmation, then upload and SQL without keys", async () => {
    const { client } = fakeS3(["old.png"]);
    const parsed = LegacyUploadSchema.parse({ ...legacy, imageBase64: PNG.toString("base64"), imageName: "logo.png" });
    await expect(legacyUpload(parsed, () => client)).rejects.toMatchObject({ status: 409 });
    const result = await legacyUpload({ ...parsed, replaceConfirmed: true }, () => client);
    expect(result).toMatchObject({ replacedCount: 1, sqlFileName: "logo_SAGWebDemo.sql" });
    expect(result.sql).toContain(`UPDATE parametros_web SET LogoEmpresa = N'${result.url}';`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
