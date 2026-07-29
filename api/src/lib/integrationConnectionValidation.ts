import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import sql from "mssql";
import type { ConnectionTestStatus } from "../types/models";

export type SeaweedFSValidationInput = {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKey: string;
  secretKey: string;
};

export type ExternalSqlValidationInput = {
  serverHost: string;
  serverPort: number;
  databaseName: string;
  username: string;
  password: string;
};

function status(succeeded: boolean, testedBy: string, message: string): ConnectionTestStatus {
  return {
    succeeded,
    testedAt: new Date().toISOString(),
    testedBy,
    message,
  };
}

function isMissingObject(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound"
    || candidate.name === "NoSuchKey"
    || candidate.$metadata?.httpStatusCode === 404;
}

export async function validateSeaweedFSConnection(
  input: SeaweedFSValidationInput,
  testedBy: string,
): Promise<ConnectionTestStatus> {
  const client = new S3Client({
    endpoint: input.endpoint,
    region: input.region,
    forcePathStyle: input.forcePathStyle,
    credentials: {
      accessKeyId: input.accessKey,
      secretAccessKey: input.secretKey,
    },
    maxAttempts: 2,
  });
  const body = randomBytes(48);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const key = `portal-sag/runtime/connection-tests/${randomUUID()}.probe`;
  let uploaded = false;
  try {
    await client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: "application/octet-stream",
      Metadata: { sha256 },
    }), { abortSignal: AbortSignal.timeout(20_000) });
    uploaded = true;
    const head = await client.send(
      new HeadObjectCommand({ Bucket: input.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(20_000) },
    );
    if (Number(head.ContentLength) !== body.length || head.Metadata?.sha256 !== sha256) {
      return status(false, testedBy, "SeaweedFS respondió, pero no conservó el tamaño o SHA-256 esperado.");
    }
    const read = await client.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(20_000) },
    );
    if (!read.Body) {
      return status(false, testedBy, "SeaweedFS no devolvió el objeto de validación.");
    }
    const downloaded = Buffer.from(await read.Body.transformToByteArray());
    if (createHash("sha256").update(downloaded).digest("hex") !== sha256) {
      return status(false, testedBy, "SeaweedFS devolvió un contenido distinto al escrito.");
    }
    await client.send(
      new DeleteObjectCommand({ Bucket: input.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(20_000) },
    );
    uploaded = false;
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: input.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(20_000) },
      );
      return status(false, testedBy, "SeaweedFS no confirmó la eliminación del objeto de validación.");
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    return status(
      true,
      testedBy,
      "Conexión SeaweedFS validada con escritura, metadatos, lectura SHA-256 y eliminación.",
    );
  } catch {
    return status(
      false,
      testedBy,
      "No fue posible validar SeaweedFS. Revise endpoint S3, TLS, red, bucket y permisos de lectura/escritura/eliminación.",
    );
  } finally {
    if (uploaded) {
      await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    client.destroy();
  }
}

export async function validateExternalSqlConnection(
  input: ExternalSqlValidationInput,
  testedBy: string,
): Promise<ConnectionTestStatus> {
  const pool = new sql.ConnectionPool({
    server: input.serverHost,
    port: input.serverPort,
    database: input.databaseName,
    user: input.username,
    password: input.password,
    connectionTimeout: 15_000,
    requestTimeout: 10_000,
    pool: { min: 0, max: 1, idleTimeoutMillis: 5_000 },
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
      appName: "PortalSAGWeb-ConnectionValidation",
    },
  });
  try {
    await pool.connect();
    const result = await pool.request().query<{ database_name: string }>(
      "SELECT DB_NAME() AS database_name;",
    );
    if (result.recordset[0]?.database_name.toLocaleLowerCase() !== input.databaseName.toLocaleLowerCase()) {
      return status(false, testedBy, "SQL Server respondió con una base distinta a la solicitada.");
    }
    return status(true, testedBy, "Conexión SQL Server validada con TLS y consulta de lectura.");
  } catch {
    return status(
      false,
      testedBy,
      "No fue posible validar SQL Server. Revise host, puerto, base, credenciales, TLS y reglas de red.",
    );
  } finally {
    await pool.close().catch(() => undefined);
  }
}
