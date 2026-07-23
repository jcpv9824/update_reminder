import { randomUUID } from "node:crypto";
import type { CurrentUser, DatabaseRecord } from "../types/models";
import { buildDatabaseRecordFromInput, type BuildDatabaseInput } from "./databaseService";
import { parseDbAccessString } from "./dbAccessParser";
import { createSqlDatabase, type DatabaseMutationInput, updateSqlDatabase } from "./databasesSqlWriteRepository";
import * as keyVault from "./keyVault";
import { toKeyVaultSecretName } from "./keyVaultNames";

type Actor = Pick<CurrentUser, "id" | "email">;

async function compensateSecret(name: string): Promise<void> {
  try {
    await keyVault.deleteSecret(name);
  } catch {
    console.error("A compensating Key Vault cleanup could not be completed.");
  }
}

export async function createSqlDatabaseWithSecret(
  input: BuildDatabaseInput & { currentDbVersion?: string },
  actor: Actor,
): Promise<DatabaseRecord> {
  const { record, passwordToStore } = buildDatabaseRecordFromInput(input);
  record.currentDbVersion = input.currentDbVersion?.trim() || undefined;
  await keyVault.setSecret(record.dbAccess.passwordSecretName, passwordToStore);
  try {
    return await createSqlDatabase(record, actor);
  } catch (error) {
    await compensateSecret(record.dbAccess.passwordSecretName);
    throw error;
  }
}

export async function updateSqlDatabaseWithSecret(
  sourceId: string,
  patch: Omit<DatabaseMutationInput, "dbAccess"> & { rawDbAccess?: string },
  actor: Actor,
): Promise<DatabaseRecord | null> {
  if (!patch.rawDbAccess?.trim()) {
    const result = await updateSqlDatabase(sourceId, patch, actor);
    return result?.record ?? null;
  }

  const parsed = parseDbAccessString(patch.rawDbAccess);
  const newSecretName = toKeyVaultSecretName(`db-${sourceId}-password-${randomUUID()}`);
  await keyVault.setSecret(newSecretName, parsed.password);
  try {
    const result = await updateSqlDatabase(sourceId, {
      ...patch,
      dbAccess: {
        serverHostPort: parsed.serverHostPort,
        initialCatalog: parsed.initialCatalog,
        userId: parsed.userId,
        passwordSecretName: newSecretName,
      },
    }, actor);
    if (!result) {
      await compensateSecret(newSecretName);
      return null;
    }
    if (result.previousSecretName) await compensateSecret(result.previousSecretName);
    return result.record;
  } catch (error) {
    await compensateSecret(newSecretName);
    throw error;
  }
}
