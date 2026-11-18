import { randomUUID } from "node:crypto";
import type {
  ConnectionTestStatus,
  ExternalDatabaseConnection,
  SeaweedFSConnection,
} from "../types/models";
import * as keyVault from "./keyVault";
import { toKeyVaultSecretName } from "./keyVaultNames";
import { configuredPortalDatabase } from "./sql";
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
  databaseName?: string;
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
  const qa = process.env.PORTAL_SAG_ENVIRONMENT?.trim().toLowerCase() === "qa"
    || process.env.SQL_DATABASE?.trim() === "PortalSAGWeb-TEST";
  const qaNames = seaweedSecretNames("PortalSAGWeb-TEST", null);
  return qa && (accessKeySecretName !== qaNames.access || secretKeySecretName !== qaNames.secret)
    ? { ...safe, credentialsConfigured: false, lastTest: null }
    : safe;
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

function seaweedDatabaseName(supplied: string | undefined): string {
  let databaseName: string;
  try {
    databaseName = configuredPortalDatabase();
  } catch {
    throw Object.assign(new Error("La base operativa del Portal no está configurada correctamente."), { status: 503 });
  }
  if (supplied !== undefined && supplied !== databaseName) {
    throw Object.assign(new Error("La base seleccionada no corresponde al ambiente actual del Portal."), { status: 400 });
  }
  return databaseName;
}

function seaweedSecretNames(databaseName: string, current: StoredSeaweedFSConnection | null) {
  if (databaseName === "PortalSAGWeb-TEST") {
    return {
      access: "portal-sag-qa-seaweedfs-access-key",
      secret: "portal-sag-qa-seaweedfs-secret-key",
    };
  }
  return {
    access: current?.accessKeySecretName ?? "portal-sag-seaweedfs-access-key",
    secret: current?.secretKeySecretName ?? "portal-sag-seaweedfs-secret-key",
  };
}

async function resolveSeaweedCredentials(
  input: Pick<SeaweedFSSaveInput, "accessKey" | "secretKey">,
  current: StoredSeaweedFSConnection | null,
  databaseName: string,
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
  if (databaseName === "PortalSAGWeb-TEST") {
    const names = seaweedSecretNames(databaseName, current);
    if (current.accessKeySecretName !== names.access || current.secretKeySecretName !== names.secret) {
      throw Object.assign(new Error("Debe configurar las dos credenciales de SeaweedFS para el ambiente de pruebas."), { status: 400 });
    }
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
  input: Omit<SeaweedFSValidationInput, "databaseName"> & { databaseName?: string },
  actor: Actor,
): Promise<ConnectionTestStatus> {
  return validateSeaweedFSConnection({ ...input, databaseName: seaweedDatabaseName(input.databaseName) }, actor.id);
}

export async function saveSeaweedFSConnection(
  input: SeaweedFSSaveInput,
  actor: Actor,
): Promise<SeaweedFSConnection> {
  const databaseName = seaweedDatabaseName(input.databaseName);
  const current = await readStoredSeaweedFSConnection();
  if ((current && current.etag.toLowerCase() !== input.etag?.toLowerCase()) || (!current && input.etag)) {
    throw Object.assign(new Error("La configuración cambió; recargue antes de guardar."), { status: 409 });
  }
  const complete = Boolean(input.endpoint.trim() && input.region.trim());
  const suppliedKeys = Boolean(input.accessKey || input.secretKey);
  if (!complete && (input.active || suppliedKeys)) {
    throw Object.assign(new Error("Complete los parámetros adicionales para habilitar el perfil o validar claves nuevas."), { status: 400 });
  }
  const profile = {
    id: current?.id ?? "seaweedfs-primary",
    provider: "seaweedfs" as const,
    displayName: input.displayName,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    databaseName,
    forcePathStyle: input.forcePathStyle,
    active: input.active,
  };
  if (!input.active && !suppliedKeys) {
    // A draft may intentionally contain blanks. Do not probe it or repopulate its fields.
    return safeSeaweed(await saveSqlSeaweedFSConnection({
      ...profile,
      credentialsConfigured: current?.credentialsConfigured ?? false,
      accessKeySecretName: current?.accessKeySecretName ?? null,
      secretKeySecretName: current?.secretKeySecretName ?? null,
    }, actor, input.etag));
  }
  const credentials = await resolveSeaweedCredentials(input, current, databaseName);
  const validation = await validateSeaweedFSConnection({
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    databaseName,
    forcePathStyle: input.forcePathStyle,
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
  }, actor.id);
  if (!validation.succeeded) throw validationError(validation);

  const { access: accessSecretName, secret: secretSecretName } = seaweedSecretNames(databaseName, current);
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
      ...profile,
      credentialsConfigured: true,
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
  const tested = await recordSeaweedFSConnectionTest(validation, actor, saved.etag).catch(() => null);
  return safeSeaweed(tested ?? saved);
}

export async function testSavedSeaweedFSConnection(actor: Actor, expectedEtag?: string): Promise<{
  connection: SeaweedFSConnection;
  result: ConnectionTestStatus;
}> {
  const current = await readStoredSeaweedFSConnection();
  if (expectedEtag !== undefined && current?.etag.toLowerCase() !== expectedEtag.toLowerCase()) {
    throw Object.assign(new Error("La configuración cambió; recargue antes de probar."), { status: 409 });
  }
  if (!current?.accessKeySecretName || !current.secretKeySecretName) {
    throw Object.assign(new Error("La conexión SeaweedFS no está configurada."), { status: 404 });
  }
  if (!current.endpoint || !current.region) {
    throw Object.assign(new Error("Complete y guarde los parámetros adicionales antes de probar este perfil."), { status: 400 });
  }
  const databaseName = seaweedDatabaseName(current.databaseName);
  const credentials = await resolveSeaweedCredentials({}, current, databaseName);
  const result = await validateSeaweedFSConnection({
    endpoint: current.endpoint,
    region: current.region,
    bucket: current.bucket,
    databaseName,
    forcePathStyle: current.forcePathStyle,
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
  }, actor.id);
  const tested = await recordSeaweedFSConnectionTest(result, actor, current.etag);
  if (!tested) throw Object.assign(new Error("La configuración cambió durante la prueba; recargue y vuelva a probar."), { status: 409 });
  return {
    connection: safeSeaweed(tested),
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
