import { getContainer } from "./cosmos";
import { getDataBackend } from "./dataBackend";
import { mergeRoleDefinitions, type RoleDefinitionRecord } from "./roleDefinitions";
import { readSqlRoleDefinitions, roleDefinitionParityShape } from "./securityRolesSqlRepository";

export async function loadRoleDefinitions(): Promise<RoleDefinitionRecord[]> {
  const backend = getDataBackend();
  if (backend === "sql") return mergeRoleDefinitions(await readSqlRoleDefinitions());
  const { resources } = await getContainer("roles").items.readAll<RoleDefinitionRecord>().fetchAll();
  const primary = mergeRoleDefinitions(resources);
  if (backend === "dual-read") {
    const shadow = mergeRoleDefinitions(await readSqlRoleDefinitions());
    if (roleDefinitionParityShape(primary) !== roleDefinitionParityShape(shadow)) {
      console.warn("Role definitions dual-read parity mismatch.");
    }
  }
  return primary;
}
