import { mergeRoleDefinitions, type RoleDefinitionRecord } from "./roleDefinitions";
import { readSqlRoleDefinitions } from "./securityRolesSqlRepository";

export async function loadRoleDefinitions(): Promise<RoleDefinitionRecord[]> {
  return mergeRoleDefinitions(await readSqlRoleDefinitions());
}
