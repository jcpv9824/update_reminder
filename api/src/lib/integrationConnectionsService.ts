import { randomUUID } from "node:crypto";
import type {
  ConnectionTestStatus,
  ExternalDatabaseConnection,
  SeaweedFSConnection,
} from "../types/models";
import * as keyVault from "./keyVault";
import { toKeyVaultSecretName } from "./keyVaultNames";
import {
  deleteSqlExternalDatabaseConnection,
  readStoredExternalDatabaseConnection,
  readStoredExternalDatabaseConnections,
  readStoredSeaweedFSConnection,
  recordExternalDatabaseConnectionTest,
  recordSeaweedFSConnectionTest,
  saveSqlExternalDatabaseConnection,
  saveSqlSeaweedFSConnection,
  type StoredExternalDatabaseConnection,
  type StoredSeaweedFSConnection,
} from "./integrationConnectionsSqlRepository";
import {
  validateExternalSqlConnection,
  validateSeaweedFSConnection,
  type ExternalSqlValidationInput,
  type SeaweedFSValidationInput,
} from "./integrationConnectionValidation";

type Actor = { id: string; email: string };

export type SeaweedFSSaveInput = {
  etag?: string;
  displayName: string;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKey?: string;
  secretKey?: string;
  active: boolean;
};

export type ExternalDatabaseSaveInput = {
  id?: string;
  etag?: string;
  displayName: string;
  purpose?: string;
  serverHost: string;
  serverPort: number;
  databaseName: string;
  username: string;
  password?: string;
  active: boolean;
};

function safeSeaweed(record: StoredSeaweedFSConnection): SeaweedFSConnection {
  const { accessKeySecretName, secretKeySecretName, ...safe } = record;
  return safe;
}

function safeExternal(record: StoredExternalDatabaseConnection): ExternalDatabaseConnection {
  const { passwordSecretName, ...safe } = record;
  return safe;
}

async function priorSecret(name: string): Promise<string | null> {
  try {
    return await keyVault.getSecret(name);
  } catch {
    return null;
  }
}

async function readRequiredSecret(name: string, label: string): Promise<string> {
  try {
    return await keyVault.getSecret(name);
  } catch {
    throw Object.assign(new Error(`No fue posible recuperar ${label} desde Key Vault.`), { status: 503 });
  }
}

async function compensateSecret(name: string, previous: string | null): Promise<void> {
  // Avoid soft-deleting a newly created secret: a pending-deletion secret
  // cannot be recreated immediately on a retry. An unreferenced secret stays
  // protected in Key Vault and can safely be reused by the next attempt.
  if (previous !== null) await keyVault.setSecret(name, previous).catch(() => undefined);
}

function validationError(status: ConnectionTestStatus): Error & { status?: number } {
  return Object.assign(new Error(status.message), { status: 400 });
}

async function resolveSeaweedCredentials(
  input: Pick<SeaweedFSSaveInput, "accessKey" | "secretKey">,
  current: StoredSeaweedFSConnection | null,
): Promise<{ accessKey: string; secretKey: string; changed: boolean }> {
  const suppliedAccess = input.accessKey?.trim() || "";
  const suppliedSecret = input.secretKey || "";
  if (Boolean(suppliedAccess) !== Boolean(suppliedSecret)) {
    throw Object.assign(new Error("Debe enviar la clave de acceso y la clave secreta juntas."), { status: 400 });
  }
  if (suppliedAccess && suppliedSecret) {
    return { accessKey: suppliedAccess, secretKey: suppliedSecret, changed: true };
  }
  if (!current?.credentialsConfigured || !current.accessKeySecretName || !current.secretKeySecretName) {
    throw Object.assign(new Error("Debe ingresar las credenciales SeaweedFS."), { status: 400 });
  }
  return {
    accessKey: await readRequiredSecret(current.accessKeySecretName, "la clave de acceso SeaweedFS"),
    secretKey: await readRequiredSecret(current.secretKeySecretName, "la clave secreta SeaweedFS"),
    changed: false,
  };
}

export async function readIntegrationConnections(): Promise<{
  objectStorage: SeaweedFSConnection | null;
  externalDatabases: ExternalDatabaseConnection[];
}> {
  const [seaweed, databases] = await Promise.all([
    readStoredSeaweedFSConnection(),
    readStoredExternalDatabaseConnections(),
  ]);
  return {
    objectStorage: seaweed ? safeSeaweed(seaweed) : null,
    externalDatabases: databases.map(safeExternal),
  };
}

export async function testTransientSeaweedFSConnection(
  input: SeaweedFSValidationInput,
  actor: Actor,
): Promise<ConnectionTestStatus> {
  return validateSeaweedFSConnection(input, actor.id);
}

export async function saveSeaweedFSConnection(
  input: SeaweedFSSaveInput,
  actor: Actor,
): Promise<SeaweedFSConnection> {
  const current = await readStoredSeaweedFSConnection();
  const credentials = await resolveSeaweedCredentials(input, current);
  const validation = await validateSeaweedFSConnection({
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    forcePathStyle: input.forcePathStyle,
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
  }, actor.id);
  if (!validation.succeeded) throw validationError(validation);

  const accessSecretName = current?.accessKeySecretName ?? "portal-sag-seaweedfs-access-key";
  const secretSecretName = current?.secretKeySecretName ?? "portal-sag-seaweedfs-secret-key";
  let priorAccess: string | null = null;
  let priorSecretValue: string | null = null;
  if (credentials.changed) {
    priorAccess = await priorSecret(accessSecretName);
    priorSecretValue = await priorSecret(secretSecretName);
    try {
      await keyVault.setSecret(accessSecretName, credentials.accessKey);
      await keyVault.setSecret(secretSecretName, credentials.secretKey);
    } catch {
      await compensateSecret(accessSecretName, priorAccess);
      await compensateSecret(secretSecretName, priorSecretValue);
      throw Object.assign(new Error("No se pudieron guardar las credenciales SeaweedFS en Key Vault."), { status: 503 });
    }
  }

  let saved: StoredSeaweedFSConnection;
  try {
    saved = await saveSqlSeaweedFSConnection({
      id: current?.id ?? "seaweedfs-primary",
      provider: "seaweedfs",
      displayName: input.displayName,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      forcePathStyle: input.forcePathStyle,
      credentialsConfigured: true,
      active: input.active,
      accessKeySecretName: accessSecretName,
      secretKeySecretName: secretSecretName,
    }, actor, input.etag);
  } catch (error) {
    if (credentials.changed) {
      await compensateSecret(accessSecretName, priorAccess);
      await compensateSecret(secretSecretName, priorSecretValue);
    }
    throw error;
  }
  const tested = await recordSeaweedFSConnectionTest(validation, actor).catch(() => null);
  return safeSeaweed(tested ?? saved);
}

export async function testSavedSeaweedFSConnection(actor: Actor): Promise<{
  connection: SeaweedFSConnection;
  result: ConnectionTestStatus;
}> {
  const current = await readStoredSeaweedFSConnection();
  if (!current?.accessKeySecretName || !current.secretKeySecretName) {
    throw Object.assign(new Error("La conexión SeaweedFS no está configurada."), { status: 404 });
  }
  const result = await validateSeaweedFSConnection({
    endpoint: current.endpoint,
    region: current.region,
    bucket: current.bucket,
    forcePathStyle: current.forcePathStyle,
    accessKey: await readRequiredSecret(current.accessKeySecretName, "la clave de acceso SeaweedFS"),
    secretKey: await readRequiredSecret(current.secretKeySecretName, "la clave secreta SeaweedFS"),
  }, actor.id);
  return {
    connection: safeSeaweed(await recordSeaweedFSConnectionTest(result, actor) ?? current),
    result,
  };
}

export async function testTransientExternalDatabaseConnection(
  input: ExternalSqlValidationInput,
  actor: Actor,
): Promise<ConnectionTestStatus> {
  return validateExternalSqlConnection(input, actor.id);
}

export async function saveExternalDatabaseConnection(
  input: ExternalDatabaseSaveInput,
  actor: Actor,
): Promise<ExternalDatabaseConnection> {
  const current = input.id ? await readStoredExternalDatabaseConnection(input.id) : null;
  if (input.id && !current) throw Object.assign(new Error("Conexión externa no encontrada."), { status: 404 });
  const suppliedPassword = input.password || "";
  if (!suppliedPassword && !current?.passwordConfigured) {
    throw Object.assign(new Error("Debe ingresar la contraseña de la conexión."), { status: 400 });
  }
  const password = suppliedPassword
    || await readRequiredSecret(current!.passwordSecretName!, "la contraseña SQL");
  const validation = await validateExternalSqlConnection({
    serverHost: input.serverHost,
    serverPort: input.serverPort,
    databaseName: input.databaseName,
    username: input.username,
    password,
  }, actor.id);
  if (!validation.succeeded) throw validationError(validation);

  const id = current?.id ?? `external_sql_${randomUUID()}`;
  const passwordSecretName = current?.passwordSecretName
    ?? toKeyVaultSecretName(`portal-sag-${id}-password`);
  const changedPassword = Boolean(suppliedPassword);
  const previousPassword = changedPassword ? await priorSecret(passwordSecretName) : null;
  if (changedPassword) {
    try {
      await keyVault.setSecret(passwordSecretName, password);
    } catch {
      throw Object.assign(new Error("No se pudo guardar la contraseña SQL en Key Vault."), { status: 503 });
    }
  }
  let saved: StoredExternalDatabaseConnection;
  try {
    saved = await saveSqlExternalDatabaseConnection({
      id,
      displayName: input.displayName,
      purpose: input.purpose,
      serverHost: input.serverHost,
      serverPort: input.serverPort,
      databaseName: input.databaseName,
      username: input.username,
      passwordConfigured: true,
      passwordSecretName,
      encrypt: true,
      active: input.active,
      status: input.active ? "active" : "inactive",
    }, actor, input.etag);
  } catch (error) {
    if (changedPassword) await compensateSecret(passwordSecretName, previousPassword);
    throw error;
  }
  const tested = await recordExternalDatabaseConnectionTest(id, validation, actor).catch(() => null);
  return safeExternal(tested ?? saved);
}

export async function testSavedExternalDatabaseConnection(
  id: string,
  actor: Actor,
): Promise<{ connection: ExternalDatabaseConnection; result: ConnectionTestStatus }> {
  const current = await readStoredExternalDatabaseConnection(id);
  if (!current?.passwordSecretName) {
    throw Object.assign(new Error("Conexión externa no encontrada o sin contraseña configurada."), { status: 404 });
  }
  const result = await validateExternalSqlConnection({
    serverHost: current.serverHost,
    serverPort: current.serverPort,
    databaseName: current.databaseName,
    username: current.username,
    password: await readRequiredSecret(current.passwordSecretName, "la contraseña SQL"),
  }, actor.id);
  return {
    connection: safeExternal(await recordExternalDatabaseConnectionTest(id, result, actor) ?? current),
    result,
  };
}

export async function deleteExternalDatabaseConnection(
  id: string,
  etag: string,
  actor: Actor,
): Promise<boolean> {
  return Boolean(await deleteSqlExternalDatabaseConnection(id, etag, actor));
}
