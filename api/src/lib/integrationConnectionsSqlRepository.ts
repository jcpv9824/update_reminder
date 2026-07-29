import sql from "mssql";
import type {
  ConnectionTestStatus,
  ExternalDatabaseConnection,
  SeaweedFSConnection,
} from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";

type Actor = { id: string; email: string };

type SeaweedRow = {
  source_id: string;
  provider: "seaweedfs";
  display_name: string;
  endpoint_url: string;
  signing_region: string;
  bucket_name: string;
  force_path_style: boolean;
  access_key_secret_name: string | null;
  secret_key_secret_name: string | null;
  credentials_configured: boolean;
  active: boolean;
  last_test_succeeded: boolean | null;
  last_tested_at: Date | null;
  last_tested_by: string | null;
  last_test_message: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  row_version: Buffer;
};

type ExternalDatabaseRow = {
  source_id: string;
  display_name: string;
  purpose: string | null;
  server_host: string;
  server_port: number;
  database_name: string;
  login_name: string;
  password_secret_name: string | null;
  password_configured: boolean;
  encrypt_connection: boolean;
  active: boolean;
  status: "active" | "inactive" | "deleted";
  last_test_succeeded: boolean | null;
  last_tested_at: Date | null;
  last_tested_by: string | null;
  last_test_message: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  row_version: Buffer;
};

export type StoredSeaweedFSConnection = SeaweedFSConnection & {
  accessKeySecretName: string | null;
  secretKeySecretName: string | null;
};

export type StoredExternalDatabaseConnection = ExternalDatabaseConnection & {
  passwordSecretName: string | null;
};

function testStatus(row: {
  last_test_succeeded: boolean | null;
  last_tested_at: Date | null;
  last_tested_by: string | null;
  last_test_message: string | null;
}): ConnectionTestStatus | null {
  if (
    row.last_test_succeeded === null
    || !row.last_tested_at
    || !row.last_tested_by
    || !row.last_test_message
  ) return null;
  return {
    succeeded: Boolean(row.last_test_succeeded),
    testedAt: row.last_tested_at.toISOString(),
    testedBy: row.last_tested_by,
    message: row.last_test_message,
  };
}

function mapSeaweed(row: SeaweedRow): StoredSeaweedFSConnection {
  return {
    id: row.source_id,
    etag: row.row_version.toString("hex"),
    provider: "seaweedfs",
    displayName: row.display_name,
    endpoint: row.endpoint_url,
    region: row.signing_region,
    bucket: row.bucket_name,
    forcePathStyle: Boolean(row.force_path_style),
    credentialsConfigured: Boolean(row.credentials_configured),
    active: Boolean(row.active),
    lastTest: testStatus(row),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    accessKeySecretName: row.access_key_secret_name,
    secretKeySecretName: row.secret_key_secret_name,
  };
}

function mapExternalDatabase(row: ExternalDatabaseRow): StoredExternalDatabaseConnection {
  return {
    id: row.source_id,
    etag: row.row_version.toString("hex"),
    displayName: row.display_name,
    purpose: row.purpose ?? undefined,
    serverHost: row.server_host,
    serverPort: Number(row.server_port),
    databaseName: row.database_name,
    username: row.login_name,
    passwordConfigured: Boolean(row.password_configured),
    encrypt: true,
    active: Boolean(row.active),
    status: row.status === "inactive" ? "inactive" : "active",
    lastTest: testStatus(row),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    passwordSecretName: row.password_secret_name,
  };
}

const SEAWEED_PROJECTION = `
  source_id,provider,display_name,endpoint_url,signing_region,bucket_name,
  force_path_style,access_key_secret_name,secret_key_secret_name,
  credentials_configured,active,last_test_succeeded,last_tested_at,last_tested_by,
  last_test_message,created_at,created_by,updated_at,updated_by,row_version`;

const EXTERNAL_DATABASE_PROJECTION = `
  source_id,display_name,purpose,server_host,server_port,database_name,login_name,
  password_secret_name,password_configured,encrypt_connection,active,status,
  last_test_succeeded,last_tested_at,last_tested_by,last_test_message,
  created_at,created_by,updated_at,updated_by,row_version`;

function etagBytes(value: string): Buffer {
  if (!/^[0-9a-f]{16}$/i.test(value)) {
    throw Object.assign(new Error("La versión de la configuración no es válida."), { status: 400 });
  }
  return Buffer.from(value, "hex");
}

function publicSeaweed(record: StoredSeaweedFSConnection): SeaweedFSConnection {
  const { accessKeySecretName, secretKeySecretName, ...safe } = record;
  return safe;
}

function publicExternal(record: StoredExternalDatabaseConnection): ExternalDatabaseConnection {
  const { passwordSecretName, ...safe } = record;
  return safe;
}

export async function readStoredSeaweedFSConnection(): Promise<StoredSeaweedFSConnection | null> {
  const pool = await getSqlPool();
  const result = await pool.request().query<SeaweedRow>(`
    SELECT ${SEAWEED_PROJECTION}
    FROM settings.object_storage_connections
    WHERE provider='seaweedfs';
  `);
  return result.recordset[0] ? mapSeaweed(result.recordset[0]) : null;
}

export async function readStoredExternalDatabaseConnections(): Promise<StoredExternalDatabaseConnection[]> {
  const pool = await getSqlPool();
  const result = await pool.request().query<ExternalDatabaseRow>(`
    SELECT ${EXTERNAL_DATABASE_PROJECTION}
    FROM settings.external_database_connections
    WHERE status<>'deleted'
    ORDER BY display_name,source_id;
  `);
  return result.recordset.map(mapExternalDatabase);
}

export async function readStoredExternalDatabaseConnection(
  id: string,
): Promise<StoredExternalDatabaseConnection | null> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sourceId", sql.NVarChar(150), id);
  const result = await request.query<ExternalDatabaseRow>(`
    SELECT ${EXTERNAL_DATABASE_PROJECTION}
    FROM settings.external_database_connections
    WHERE source_id=@sourceId AND status<>'deleted';
  `);
  return result.recordset[0] ? mapExternalDatabase(result.recordset[0]) : null;
}

export async function saveSqlSeaweedFSConnection(
  input: Omit<StoredSeaweedFSConnection, "etag" | "createdAt" | "createdBy" | "updatedAt" | "updatedBy" | "lastTest">,
  actor: Actor,
  expectedEtag?: string,
): Promise<StoredSeaweedFSConnection> {
  return runSqlTransaction(async (transaction) => {
    const beforeRequest = new sql.Request(transaction);
    const beforeResult = await beforeRequest.query<SeaweedRow>(`
      SELECT ${SEAWEED_PROJECTION}
      FROM settings.object_storage_connections WITH (UPDLOCK,HOLDLOCK)
      WHERE provider='seaweedfs';
    `);
    const before = beforeResult.recordset[0] ? mapSeaweed(beforeResult.recordset[0]) : null;
    const now = new Date();
    if (before) {
      if (!expectedEtag) throw Object.assign(new Error("Debe enviar la versión vigente de la configuración."), { status: 409 });
      const request = new sql.Request(transaction);
      request.input("expectedEtag", sql.VarBinary(8), etagBytes(expectedEtag));
      request.input("displayName", sql.NVarChar(160), input.displayName);
      request.input("endpoint", sql.NVarChar(500), input.endpoint);
      request.input("region", sql.NVarChar(100), input.region);
      request.input("bucket", sql.NVarChar(255), input.bucket);
      request.input("pathStyle", sql.Bit, input.forcePathStyle);
      request.input("accessSecret", sql.NVarChar(127), input.accessKeySecretName);
      request.input("secretSecret", sql.NVarChar(127), input.secretKeySecretName);
      request.input("configured", sql.Bit, input.credentialsConfigured);
      request.input("active", sql.Bit, input.active);
      request.input("now", sql.DateTime2(3), now);
      request.input("actor", sql.NVarChar(150), actor.id);
      const result = await request.query<{ changed: number }>(`
        UPDATE settings.object_storage_connections
        SET display_name=@displayName,endpoint_url=@endpoint,signing_region=@region,
          bucket_name=@bucket,force_path_style=@pathStyle,
          access_key_secret_name=@accessSecret,secret_key_secret_name=@secretSecret,
          credentials_configured=@configured,active=@active,
          last_test_succeeded=NULL,last_tested_at=NULL,last_tested_by=NULL,last_test_message=NULL,
          updated_at=@now,updated_by=@actor
        WHERE provider='seaweedfs' AND row_version=@expectedEtag;
        SELECT @@ROWCOUNT AS changed;
      `);
      if (Number(result.recordset[0]?.changed ?? 0) !== 1) {
        throw Object.assign(new Error("La configuración cambió; recargue antes de guardar."), { status: 409 });
      }
    } else {
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), input.id);
      request.input("displayName", sql.NVarChar(160), input.displayName);
      request.input("endpoint", sql.NVarChar(500), input.endpoint);
      request.input("region", sql.NVarChar(100), input.region);
      request.input("bucket", sql.NVarChar(255), input.bucket);
      request.input("pathStyle", sql.Bit, input.forcePathStyle);
      request.input("accessSecret", sql.NVarChar(127), input.accessKeySecretName);
      request.input("secretSecret", sql.NVarChar(127), input.secretKeySecretName);
      request.input("configured", sql.Bit, input.credentialsConfigured);
      request.input("active", sql.Bit, input.active);
      request.input("now", sql.DateTime2(3), now);
      request.input("actor", sql.NVarChar(150), actor.id);
      await request.query(`
        INSERT settings.object_storage_connections
          (source_id,provider,display_name,endpoint_url,signing_region,bucket_name,
           force_path_style,access_key_secret_name,secret_key_secret_name,
           credentials_configured,active,created_at,created_by,updated_at,updated_by)
        VALUES
          (@sourceId,'seaweedfs',@displayName,@endpoint,@region,@bucket,@pathStyle,
           @accessSecret,@secretSecret,@configured,@active,@now,@actor,@now,@actor);
      `);
    }
    const afterRequest = new sql.Request(transaction);
    const afterResult = await afterRequest.query<SeaweedRow>(`
      SELECT ${SEAWEED_PROJECTION}
      FROM settings.object_storage_connections
      WHERE provider='seaweedfs';
    `);
    const after = mapSeaweed(afterResult.recordset[0]);
    await writeSqlAuditLog(transaction, {
      entityType: "integration_connection",
      entityId: after.id,
      action: before ? "object_storage_connection_updated" : "object_storage_connection_created",
      performedBy: actor.id,
      performedByEmail: actor.email,
      before: before ? publicSeaweed(before) : undefined,
      after: publicSeaweed(after),
    });
    return after;
  });
}

export async function saveSqlExternalDatabaseConnection(
  input: Omit<StoredExternalDatabaseConnection, "etag" | "createdAt" | "createdBy" | "updatedAt" | "updatedBy" | "lastTest">,
  actor: Actor,
  expectedEtag?: string,
): Promise<StoredExternalDatabaseConnection> {
  return runSqlTransaction(async (transaction) => {
    const lock = new sql.Request(transaction);
    lock.input("sourceId", sql.NVarChar(150), input.id);
    const beforeResult = await lock.query<ExternalDatabaseRow>(`
      SELECT ${EXTERNAL_DATABASE_PROJECTION}
      FROM settings.external_database_connections WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId AND status<>'deleted';
    `);
    const before = beforeResult.recordset[0] ? mapExternalDatabase(beforeResult.recordset[0]) : null;
    const now = new Date();
    if (before) {
      if (!expectedEtag) throw Object.assign(new Error("Debe enviar la versión vigente de la conexión."), { status: 409 });
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), input.id);
      request.input("expectedEtag", sql.VarBinary(8), etagBytes(expectedEtag));
      request.input("displayName", sql.NVarChar(160), input.displayName);
      request.input("purpose", sql.NVarChar(500), input.purpose ?? null);
      request.input("host", sql.NVarChar(255), input.serverHost);
      request.input("port", sql.Int, input.serverPort);
      request.input("database", sql.NVarChar(128), input.databaseName);
      request.input("username", sql.NVarChar(128), input.username);
      request.input("passwordSecret", sql.NVarChar(127), input.passwordSecretName);
      request.input("passwordConfigured", sql.Bit, input.passwordConfigured);
      request.input("active", sql.Bit, input.active);
      request.input("status", sql.VarChar(20), input.active ? "active" : "inactive");
      request.input("now", sql.DateTime2(3), now);
      request.input("actor", sql.NVarChar(150), actor.id);
      const result = await request.query<{ changed: number }>(`
        UPDATE settings.external_database_connections
        SET display_name=@displayName,purpose=@purpose,server_host=@host,server_port=@port,
          database_name=@database,login_name=@username,password_secret_name=@passwordSecret,
          password_configured=@passwordConfigured,encrypt_connection=1,active=@active,status=@status,
          last_test_succeeded=NULL,last_tested_at=NULL,last_tested_by=NULL,last_test_message=NULL,
          updated_at=@now,updated_by=@actor
        WHERE source_id=@sourceId AND status<>'deleted' AND row_version=@expectedEtag;
        SELECT @@ROWCOUNT AS changed;
      `);
      if (Number(result.recordset[0]?.changed ?? 0) !== 1) {
        throw Object.assign(new Error("La conexión cambió; recargue antes de guardar."), { status: 409 });
      }
    } else {
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), input.id);
      request.input("displayName", sql.NVarChar(160), input.displayName);
      request.input("purpose", sql.NVarChar(500), input.purpose ?? null);
      request.input("host", sql.NVarChar(255), input.serverHost);
      request.input("port", sql.Int, input.serverPort);
      request.input("database", sql.NVarChar(128), input.databaseName);
      request.input("username", sql.NVarChar(128), input.username);
      request.input("passwordSecret", sql.NVarChar(127), input.passwordSecretName);
      request.input("passwordConfigured", sql.Bit, input.passwordConfigured);
      request.input("active", sql.Bit, input.active);
      request.input("status", sql.VarChar(20), input.active ? "active" : "inactive");
      request.input("now", sql.DateTime2(3), now);
      request.input("actor", sql.NVarChar(150), actor.id);
      await request.query(`
        INSERT settings.external_database_connections
          (source_id,display_name,purpose,server_host,server_port,database_name,login_name,
           password_secret_name,password_configured,encrypt_connection,active,status,
           created_at,created_by,updated_at,updated_by)
        VALUES
          (@sourceId,@displayName,@purpose,@host,@port,@database,@username,@passwordSecret,
           @passwordConfigured,1,@active,@status,@now,@actor,@now,@actor);
      `);
    }
    const afterRequest = new sql.Request(transaction);
    afterRequest.input("sourceId", sql.NVarChar(150), input.id);
    const afterResult = await afterRequest.query<ExternalDatabaseRow>(`
      SELECT ${EXTERNAL_DATABASE_PROJECTION}
      FROM settings.external_database_connections
      WHERE source_id=@sourceId AND status<>'deleted';
    `);
    const after = mapExternalDatabase(afterResult.recordset[0]);
    await writeSqlAuditLog(transaction, {
      entityType: "integration_connection",
      entityId: after.id,
      action: before ? "external_database_connection_updated" : "external_database_connection_created",
      performedBy: actor.id,
      performedByEmail: actor.email,
      before: before ? publicExternal(before) : undefined,
      after: publicExternal(after),
    });
    return after;
  });
}

export async function recordSeaweedFSConnectionTest(
  status: ConnectionTestStatus,
  actor: Actor,
): Promise<StoredSeaweedFSConnection | null> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("succeeded", sql.Bit, status.succeeded);
    request.input("testedAt", sql.DateTime2(3), new Date(status.testedAt));
    request.input("testedBy", sql.NVarChar(150), actor.id);
    request.input("message", sql.NVarChar(300), status.message);
    await request.query(`
      UPDATE settings.object_storage_connections
      SET last_test_succeeded=@succeeded,last_tested_at=@testedAt,last_tested_by=@testedBy,
        last_test_message=@message,updated_at=@testedAt,updated_by=@testedBy
      WHERE provider='seaweedfs';
    `);
    const read = new sql.Request(transaction);
    const result = await read.query<SeaweedRow>(`
      SELECT ${SEAWEED_PROJECTION}
      FROM settings.object_storage_connections
      WHERE provider='seaweedfs';
    `);
    const after = result.recordset[0] ? mapSeaweed(result.recordset[0]) : null;
    await writeSqlAuditLog(transaction, {
      entityType: "integration_connection",
      entityId: after?.id ?? "seaweedfs-primary",
      action: status.succeeded ? "object_storage_connection_test_succeeded" : "object_storage_connection_test_failed",
      performedBy: actor.id,
      performedByEmail: actor.email,
      metadata: { provider: "seaweedfs", succeeded: status.succeeded },
    });
    return after;
  });
}

export async function recordExternalDatabaseConnectionTest(
  id: string,
  status: ConnectionTestStatus,
  actor: Actor,
): Promise<StoredExternalDatabaseConnection | null> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), id);
    request.input("succeeded", sql.Bit, status.succeeded);
    request.input("testedAt", sql.DateTime2(3), new Date(status.testedAt));
    request.input("testedBy", sql.NVarChar(150), actor.id);
    request.input("message", sql.NVarChar(300), status.message);
    await request.query(`
      UPDATE settings.external_database_connections
      SET last_test_succeeded=@succeeded,last_tested_at=@testedAt,last_tested_by=@testedBy,
        last_test_message=@message,updated_at=@testedAt,updated_by=@testedBy
      WHERE source_id=@sourceId AND status<>'deleted';
    `);
    const read = new sql.Request(transaction);
    read.input("sourceId", sql.NVarChar(150), id);
    const result = await read.query<ExternalDatabaseRow>(`
      SELECT ${EXTERNAL_DATABASE_PROJECTION}
      FROM settings.external_database_connections
      WHERE source_id=@sourceId AND status<>'deleted';
    `);
    const after = result.recordset[0] ? mapExternalDatabase(result.recordset[0]) : null;
    await writeSqlAuditLog(transaction, {
      entityType: "integration_connection",
      entityId: id,
      action: status.succeeded ? "external_database_connection_test_succeeded" : "external_database_connection_test_failed",
      performedBy: actor.id,
      performedByEmail: actor.email,
      metadata: { succeeded: status.succeeded },
    });
    return after;
  });
}

export async function deleteSqlExternalDatabaseConnection(
  id: string,
  expectedEtag: string,
  actor: Actor,
): Promise<StoredExternalDatabaseConnection | null> {
  return runSqlTransaction(async (transaction) => {
    const lock = new sql.Request(transaction);
    lock.input("sourceId", sql.NVarChar(150), id);
    const beforeResult = await lock.query<ExternalDatabaseRow>(`
      SELECT ${EXTERNAL_DATABASE_PROJECTION}
      FROM settings.external_database_connections WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId AND status<>'deleted';
    `);
    if (!beforeResult.recordset[0]) return null;
    const before = mapExternalDatabase(beforeResult.recordset[0]);
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), id);
    request.input("expectedEtag", sql.VarBinary(8), etagBytes(expectedEtag));
    request.input("now", sql.DateTime2(3), new Date());
    request.input("actor", sql.NVarChar(150), actor.id);
    const result = await request.query<{ changed: number }>(`
      UPDATE settings.external_database_connections
      SET active=0,status='deleted',deleted_at=@now,deleted_by=@actor,
        updated_at=@now,updated_by=@actor
      WHERE source_id=@sourceId AND status<>'deleted' AND row_version=@expectedEtag;
      SELECT @@ROWCOUNT AS changed;
    `);
    if (Number(result.recordset[0]?.changed ?? 0) !== 1) {
      throw Object.assign(new Error("La conexión cambió; recargue antes de eliminar."), { status: 409 });
    }
    await writeSqlAuditLog(transaction, {
      entityType: "integration_connection",
      entityId: id,
      action: "external_database_connection_deleted",
      performedBy: actor.id,
      performedByEmail: actor.email,
      before: publicExternal(before),
    });
    return before;
  });
}
