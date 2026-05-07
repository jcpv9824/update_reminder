import { CosmosClient, Container, Database } from "@azure/cosmos";

let _client: CosmosClient | null = null;
let _database: Database | null = null;

export function getCosmosClient(): CosmosClient {
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
  | "auditLogs";

export function getContainer(name: ContainerName): Container {
  return getDatabase().container(name);
}
