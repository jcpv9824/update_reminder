import { randomUUID } from "node:crypto";
import { parseDbAccessString } from "./dbAccessParser";
import { toKeyVaultSecretName } from "./keyVaultNames";
import type { CurrentUser, DatabaseRecord } from "../types/models";

export type BuildDatabaseInput = {
  clientId: string;
  clientName: string;
  domainId: string;
  domainName: string;
  companyName: string;
  environment: string;
  rawDbAccess: string;
  assignedUpdaterIds: string[];
  notes?: string;
  currentUser: CurrentUser;
};

export type BuildDatabaseResult = {
  record: DatabaseRecord;
  passwordToStore: string;
};

export function buildDatabaseRecordFromInput(
  input: BuildDatabaseInput
): BuildDatabaseResult {
  const parsed = parseDbAccessString(input.rawDbAccess);
  const id = `db_${randomUUID()}`;
  const now = new Date().toISOString();
  const passwordSecretName = toKeyVaultSecretName(`db-${id}-password`);

  const record: DatabaseRecord = {
    id,
    clientId: input.clientId,
    clientName: input.clientName,
    domainId: input.domainId,
    domainName: input.domainName,
    companyName: input.companyName,
    environment: input.environment,
    dbAccess: {
      serverHostPort: parsed.serverHostPort,
      initialCatalog: parsed.initialCatalog,
      userId: parsed.userId,
      passwordSecretName,
    },
    assignedUpdaterIds: input.assignedUpdaterIds,
    status: "active",
    notes: input.notes,
    createdAt: now,
    createdBy: input.currentUser.id,
    updatedAt: now,
    updatedBy: input.currentUser.id,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
  };

  return { record, passwordToStore: parsed.password };
}
