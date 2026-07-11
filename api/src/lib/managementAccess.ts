import type { CurrentUser } from "../types/models";
import type { RoleDefinition } from "./permissionModel";
import { hasPermissionWithRoleDefinitions } from "./taskAccess";

export type UserUpdateAccessContext = {
  rolesChanged: boolean;
  deactivating: boolean;
};

export function canListRoleDefinitions(user: CurrentUser | null): boolean {
  return !!user;
}

export function canCreateRoleDefinition(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.roles.create", roleDefinitions)
    && hasPermissionWithRoleDefinitions(user, "configuration.roles.manage_permissions", roleDefinitions)
    && hasPermissionWithRoleDefinitions(user, "configuration.roles.manage_task_visibility", roleDefinitions);
}

export function canEditRoleDefinition(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.roles.edit", roleDefinitions)
    && hasPermissionWithRoleDefinitions(user, "configuration.roles.manage_permissions", roleDefinitions)
    && hasPermissionWithRoleDefinitions(user, "configuration.roles.manage_task_visibility", roleDefinitions);
}

export function canDeleteRoleDefinition(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.roles.delete", roleDefinitions);
}

export function canListUsers(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.users.view", roleDefinitions);
}

export function canCreateUser(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.users.create", roleDefinitions)
    && hasPermissionWithRoleDefinitions(user, "configuration.users.assign_roles", roleDefinitions);
}

export function canUpdateUser(
  user: CurrentUser,
  context: UserUpdateAccessContext,
  roleDefinitions: RoleDefinition[]
): boolean {
  if (!hasPermissionWithRoleDefinitions(user, "configuration.users.edit", roleDefinitions)) return false;
  if (context.rolesChanged && !hasPermissionWithRoleDefinitions(user, "configuration.users.assign_roles", roleDefinitions)) return false;
  if (context.deactivating && !hasPermissionWithRoleDefinitions(user, "configuration.users.deactivate", roleDefinitions)) return false;
  return true;
}

export function canResetUserPassword(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.users.reset_password", roleDefinitions);
}

export function canResendUserCredentials(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.users.resend_credentials", roleDefinitions);
}

export function canDeactivateUser(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.users.deactivate", roleDefinitions);
}

export function canReactivateUser(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.users.reactivate", roleDefinitions);
}

export function canViewAuditLogs(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "visibility.audit.view", roleDefinitions);
}

export function canViewEmailAlerts(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.alerts.view", roleDefinitions);
}

export function canEditEmailAlerts(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.alerts.edit", roleDefinitions);
}

export function canSendTestEmail(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.alerts.test_email", roleDefinitions);
}

export function canSendAdministrativeReminderTest(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.alerts.test_administrative_reminder", roleDefinitions);
}

export function canSendConfiguredReport(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.alerts.send_report", roleDefinitions);
}

export function canViewSchedules(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.view", roleDefinitions);
}

export function canCreateSchedule(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.create", roleDefinitions);
}

export function canEditSchedule(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.edit", roleDefinitions);
}

export function canDeleteSchedule(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.delete", roleDefinitions);
}

export function canDeactivateSchedule(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.deactivate", roleDefinitions);
}

export function canReactivateSchedule(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.reactivate", roleDefinitions);
}

export function canPreviewScheduleScope(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.preview_scope", roleDefinitions);
}

export function canGenerateScheduleTasks(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "updates.schedules.generate_tasks", roleDefinitions);
}

export function canViewClients(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.view", roleDefinitions);
}

export function canCreateClient(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.create", roleDefinitions);
}

export function canEditClient(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.edit", roleDefinitions);
}

export function canDeleteClient(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.delete", roleDefinitions);
}

export function canDeactivateClient(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.deactivate", roleDefinitions);
}

export function canReactivateClient(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.reactivate", roleDefinitions);
}

export function canAssignClientLicenses(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.assign_licenses", roleDefinitions);
}

export function canViewClientRelated(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.clients.view_related", roleDefinitions);
}

export function canViewDomains(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.domains.view", roleDefinitions);
}

export function canCreateDomain(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.domains.create", roleDefinitions);
}

export function canEditDomain(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.domains.edit", roleDefinitions);
}

export function canDeleteDomain(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.domains.delete", roleDefinitions);
}

export function canDeactivateDomain(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.domains.deactivate", roleDefinitions);
}

export function canReactivateDomain(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.domains.reactivate", roleDefinitions);
}

export function canViewRelatedDomainDatabases(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.domains.view_related_databases", roleDefinitions);
}

export function canViewDatabases(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.view", roleDefinitions);
}

export function canCreateDatabase(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.create", roleDefinitions);
}

export function canEditDatabase(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.edit", roleDefinitions);
}

export function canDeleteDatabase(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.delete", roleDefinitions);
}

export function canDeactivateDatabase(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.deactivate", roleDefinitions);
}

export function canReactivateDatabase(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.reactivate", roleDefinitions);
}

export function canViewDatabaseConnection(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.view_connection", roleDefinitions);
}

export function canCopyDatabaseConnectionPart(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.copy_connection_part", roleDefinitions);
}

export function canRevealDatabasePassword(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.databases.reveal_password", roleDefinitions);
}

export function canViewLicensingOption(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.licensing.view", roleDefinitions);
}

export function canCreateLicense(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.licensing.create", roleDefinitions);
}

export function canEditLicense(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.licensing.edit", roleDefinitions);
}

export function canDeleteLicense(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.licensing.delete", roleDefinitions);
}

export function canDeactivateLicense(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.licensing.deactivate", roleDefinitions);
}

export function canReactivateLicense(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "clients.licensing.reactivate", roleDefinitions);
}

export function canViewPublicDownloadsAdmin(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.view", roleDefinitions);
}

export function canCreatePublicDownloadSection(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.create_section", roleDefinitions);
}

export function canEditPublicDownloadSection(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.edit_section", roleDefinitions);
}

export function canDeletePublicDownloadSection(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.delete_section", roleDefinitions);
}

export function canCreatePublicDownloadDocument(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.create_document", roleDefinitions);
}

export function canEditPublicDownloadDocument(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.edit_document", roleDefinitions);
}

export function canDeletePublicDownloadDocument(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.delete_document", roleDefinitions);
}

export function canReplacePublicDownloadFile(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "implementation.public_downloads.replace_file", roleDefinitions);
}

export function canViewPrintFormats(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.view", roleDefinitions);
}

export function canCreatePrintFormatSource(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.create_source", roleDefinitions);
}

export function canEditPrintFormatSource(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.edit_source", roleDefinitions);
}

export function canDeletePrintFormatSource(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.delete_source", roleDefinitions);
}

export function canCreatePrintFormat(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.create_format", roleDefinitions);
}

export function canEditPrintFormat(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.edit_format", roleDefinitions);
}

export function canDeletePrintFormat(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.delete_format", roleDefinitions);
}

export function canReplacePrintFormatPdf(user: CurrentUser, roleDefinitions: RoleDefinition[]): boolean {
  return hasPermissionWithRoleDefinitions(user, "configuration.print_formats.replace_pdf", roleDefinitions);
}
