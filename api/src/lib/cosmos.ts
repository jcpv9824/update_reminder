import { CosmosClient, Container, Database } from "@azure/cosmos";

let _client: CosmosClient | null = null;
let _database: Database | null = null;

function assertLegacyCosmosBackend(): void {
  if ((process.env.DATA_BACKEND ?? "").trim().toLowerCase() === "sql") {
    throw new Error(
      "Dependencia Cosmos inesperada durante la ejecución SQL. Esta ruta debe usar exclusivamente repositorios SQL."
    );
  }
}

export function getCosmosClient(): CosmosClient {
  assertLegacyCosmosBackend();
  if (_client) return _client;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    throw new Error(
      "Falta la variable de entorno COSMOS_CONNECTION_STRING."
    );
  }
  _client = new CosmosClient(conn);
  return _client;
}

export function getDatabase(): Database {
  assertLegacyCosmosBackend();
  if (_database) return _database;
  const name = process.env.COSMOS_DATABASE_NAME ?? "erp-update-scheduler";
  _database = getCosmosClient().database(name);
  return _database;
}

export type ContainerName =
  | "users"
  | "clients"
  | "domains"
  | "databases"
  | "updateSchedules"
  | "updateTasks"
  | "licenseModules"
  | "licenseAssignments"
  | "auditLogs"
  | "appSettings"
  | "emailNotifications"
  | "securityRateLimits"
  | "authSessions"
  | "roles"
  | "fuentesFormatos"
  | "formatosImpresion"
  | "publicDownloads";

export function getContainer(name: ContainerName): Container {
  assertLegacyCosmosBackend();
  return getDatabase().container(name);
}
