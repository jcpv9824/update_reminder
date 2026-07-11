import { getContainer } from "./cosmos";
import { mergeRoleDefinitions, type RoleDefinitionRecord } from "./roleDefinitions";

export async function loadRoleDefinitions(): Promise<RoleDefinitionRecord[]> {
  const { resources } = await getContainer("roles").items.readAll<RoleDefinitionRecord>().fetchAll();
  return mergeRoleDefinitions(resources);
}
