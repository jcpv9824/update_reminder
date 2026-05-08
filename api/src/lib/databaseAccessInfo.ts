import type { DatabaseRecord } from "../types/models";

export function buildDatabaseAccessInfo(db: DatabaseRecord) {
  return {
    server: db.dbAccess.serverHostPort,
    databaseName: db.dbAccess.initialCatalog,
    user: db.dbAccess.userId,
    hasPassword: !!db.dbAccess.passwordSecretName,
  };
}
