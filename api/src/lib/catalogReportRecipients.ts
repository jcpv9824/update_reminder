import { findSqlUserByEmail } from "./securityManagementSqlWriteRepository";
import { canSendConfiguredReport } from "./managementAccess";
import { loadRoleDefinitions } from "./roleDefinitionStore";

/** Recheck at generation and delivery. A mixed/unknown group is rejected as a whole. */
export async function mayReceiveCatalogActiveUsersReport(recipients: readonly string[]): Promise<boolean> {
  if (!recipients.length || recipients.length > 25) return false;
  try {
    const roles = await loadRoleDefinitions();
    // Sequential, capped SQL lookups; user-controlled addresses never cause fan-out.
    for (const email of recipients) {
      const user = await findSqlUserByEmail(email);
      if (!user || user.active !== true || !canSendConfiguredReport(user, roles)) return false;
    }
    return true;
  } catch { return false; }
}
