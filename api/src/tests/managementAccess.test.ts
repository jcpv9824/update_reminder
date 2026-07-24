import { describe, expect, it } from "vitest";
import {
  canAssignClientLicenses,
  canCreateRoleDefinition,
  canCreateClient,
  canCreateDatabase,
  canCreateDomain,
  canCreateLicense,
  canCreatePublicDownloadDocument,
  canCreatePublicFile,
  canCreatePrintFormat,
  canCreatePrintFormatSource,
  canCreateSchedule,
  canCreateUser,
  canCopyDatabaseConnectionPart,
  canDeactivateClient,
  canDeactivateDatabase,
  canDeactivateDomain,
  canDeactivateLicense,
  canDeletePublicDownloadDocument,
  canDeletePublicFile,
  canDeleteClient,
  canDeleteDatabase,
  canDeleteDomain,
  canDeleteLicense,
  canDeletePrintFormat,
  canDeletePrintFormatSource,
  canDeleteRoleDefinition,
  canDeleteSchedule,
  canDeactivateSchedule,
  canEditClient,
  canEditDatabase,
  canEditDomain,
  canEditLicense,
  canEditEmailAlerts,
  canEditPublicDownloadDocument,
  canEditPublicFile,
  canEditPrintFormat,
  canEditPrintFormatSource,
  canEditRoleDefinition,
  canEditSchedule,
  canGenerateScheduleTasks,
  canPreviewScheduleScope,
  canReactivateClient,
  canReactivateDatabase,
  canReactivateDomain,
  canReactivateLicense,
  canReactivateSchedule,
  canRevealDatabasePassword,
  canReplacePrintFormatPdf,
  canReplacePublicDownloadFile,
  canReplacePublicFile,
  canSendAdministrativeReminderTest,
  canSendConfiguredReport,
  canSendTestEmail,
  canListRoleDefinitions,
  canListUsers,
  canViewAuditLogs,
  canViewClientRelated,
  canViewClients,
  canViewDatabaseConnection,
  canViewDatabases,
  canViewDomains,
  canViewLicensingOption,
  canViewEmailAlerts,
  canViewPrintFormats,
  canViewPublicDownloadsAdmin,
  canViewPublicFilesAdmin,
  canViewRelatedDomainDatabases,
  canViewSchedules,
  canReactivateUser,
  canResetUserPassword,
  canResendUserCredentials,
  canUpdateUser,
} from "../lib/managementAccess";
import type { RoleDefinition } from "../lib/permissionModel";
import type { CurrentUser } from "../types/models";

function user(roles: string[]): CurrentUser {
  return { id: "u1", email: "u@empresa.com", displayName: "Usuario", roles };
}

function role(id: string, permissions: string[]): RoleDefinition {
  return {
    id,
    name: id,
    permissions,
    taskVisibility: { domain: "none", database: "none" },
    system: false,
  };
}

describe("management access", () => {
  it("lets authenticated users read role definitions for permission resolution", () => {
    expect(canListRoleDefinitions(user(["viewer"]))).toBe(true);
    expect(canListRoleDefinitions(user([]))).toBe(true);
  });

  it("maps user actions to configuration.users permissions", () => {
    const roles = [
      role("user_admin", [
        "configuration.users.view",
        "configuration.users.create",
        "configuration.users.edit",
        "configuration.users.reset_password",
        "configuration.users.resend_credentials",
        "configuration.users.reactivate",
        "configuration.users.assign_roles",
      ]),
    ];
    const current = user(["user_admin"]);

    expect(canListUsers(current, roles)).toBe(true);
    expect(canCreateUser(current, roles)).toBe(true);
    expect(canUpdateUser(current, { rolesChanged: false, deactivating: false }, roles)).toBe(true);
    expect(canResetUserPassword(current, roles)).toBe(true);
    expect(canResendUserCredentials(current, roles)).toBe(true);
    expect(canReactivateUser(current, roles)).toBe(true);
  });

  it("requires assign_roles when a user update changes roles", () => {
    const editorOnly = [role("editor", ["configuration.users.edit"])];
    const roleAssigner = [role("assigner", ["configuration.users.edit", "configuration.users.assign_roles"])];

    expect(canUpdateUser(user(["editor"]), { rolesChanged: true, deactivating: false }, editorOnly)).toBe(false);
    expect(canUpdateUser(user(["assigner"]), { rolesChanged: true, deactivating: false }, roleAssigner)).toBe(true);
  });

  it("requires deactivate permission when a user update deactivates an account", () => {
    const editorOnly = [role("editor", ["configuration.users.edit"])];
    const deactivator = [role("deactivator", ["configuration.users.edit", "configuration.users.deactivate"])];

    expect(canUpdateUser(user(["editor"]), { rolesChanged: false, deactivating: true }, editorOnly)).toBe(false);
    expect(canUpdateUser(user(["deactivator"]), { rolesChanged: false, deactivating: true }, deactivator)).toBe(true);
  });

  it("maps role actions to configuration.roles permissions", () => {
    const roles = [
      role("roles_admin", [
        "configuration.roles.create",
        "configuration.roles.edit",
        "configuration.roles.manage_permissions",
        "configuration.roles.manage_task_visibility",
      ]),
    ];
    const current = user(["roles_admin"]);

    expect(canCreateRoleDefinition(current, roles)).toBe(true);
    expect(canEditRoleDefinition(current, roles)).toBe(true);
    expect(canDeleteRoleDefinition(current, [role("roles_admin", ["configuration.roles.delete"])] )).toBe(true);
  });

  it("maps client module actions to option-specific permissions", () => {
    const roles = [
      role("clients_operator", [
        "clients.clients.view",
        "clients.clients.create",
        "clients.clients.edit",
        "clients.clients.delete",
        "clients.clients.deactivate",
        "clients.clients.reactivate",
        "clients.clients.assign_licenses",
        "clients.clients.view_related",
        "clients.domains.view",
        "clients.domains.create",
        "clients.domains.edit",
        "clients.domains.delete",
        "clients.domains.deactivate",
        "clients.domains.reactivate",
        "clients.domains.view_related_databases",
        "clients.databases.view",
        "clients.databases.create",
        "clients.databases.edit",
        "clients.databases.delete",
        "clients.databases.deactivate",
        "clients.databases.reactivate",
        "clients.databases.view_connection",
        "clients.databases.copy_connection_part",
        "clients.databases.reveal_password",
        "clients.licensing.view",
        "clients.licensing.create",
        "clients.licensing.edit",
        "clients.licensing.delete",
        "clients.licensing.deactivate",
        "clients.licensing.reactivate",
      ]),
    ];
    const current = user(["clients_operator"]);

    expect(canViewClients(current, roles)).toBe(true);
    expect(canCreateClient(current, roles)).toBe(true);
    expect(canEditClient(current, roles)).toBe(true);
    expect(canDeleteClient(current, roles)).toBe(true);
    expect(canDeactivateClient(current, roles)).toBe(true);
    expect(canReactivateClient(current, roles)).toBe(true);
    expect(canAssignClientLicenses(current, roles)).toBe(true);
    expect(canViewClientRelated(current, roles)).toBe(true);
    expect(canViewDomains(current, roles)).toBe(true);
    expect(canCreateDomain(current, roles)).toBe(true);
    expect(canEditDomain(current, roles)).toBe(true);
    expect(canDeleteDomain(current, roles)).toBe(true);
    expect(canDeactivateDomain(current, roles)).toBe(true);
    expect(canReactivateDomain(current, roles)).toBe(true);
    expect(canViewRelatedDomainDatabases(current, roles)).toBe(true);
    expect(canViewDatabases(current, roles)).toBe(true);
    expect(canCreateDatabase(current, roles)).toBe(true);
    expect(canEditDatabase(current, roles)).toBe(true);
    expect(canDeleteDatabase(current, roles)).toBe(true);
    expect(canDeactivateDatabase(current, roles)).toBe(true);
    expect(canReactivateDatabase(current, roles)).toBe(true);
    expect(canViewDatabaseConnection(current, roles)).toBe(true);
    expect(canCopyDatabaseConnectionPart(current, roles)).toBe(true);
    expect(canRevealDatabasePassword(current, roles)).toBe(true);
    expect(canViewLicensingOption(current, roles)).toBe(true);
    expect(canCreateLicense(current, roles)).toBe(true);
    expect(canEditLicense(current, roles)).toBe(true);
    expect(canDeleteLicense(current, roles)).toBe(true);
    expect(canDeactivateLicense(current, roles)).toBe(true);
    expect(canReactivateLicense(current, roles)).toBe(true);
  });

  it("maps audit and alert configuration actions to option-specific permissions", () => {
    const roles = [
      role("configuration_operator", [
        "visibility.audit.view",
        "configuration.alerts.view",
        "configuration.alerts.edit",
        "configuration.alerts.test_email",
        "configuration.alerts.send_report",
        "configuration.alerts.test_administrative_reminder",
      ]),
    ];
    const current = user(["configuration_operator"]);

    expect(canViewAuditLogs(current, roles)).toBe(true);
    expect(canViewEmailAlerts(current, roles)).toBe(true);
    expect(canEditEmailAlerts(current, roles)).toBe(true);
    expect(canSendTestEmail(current, roles)).toBe(true);
    expect(canSendConfiguredReport(current, roles)).toBe(true);
    expect(canSendAdministrativeReminderTest(current, roles)).toBe(true);
  });

  it("maps schedule actions to updates.schedules permissions", () => {
    const roles = [
      role("schedule_admin", [
        "updates.schedules.view",
        "updates.schedules.create",
        "updates.schedules.edit",
        "updates.schedules.delete",
        "updates.schedules.deactivate",
        "updates.schedules.reactivate",
        "updates.schedules.preview_scope",
        "updates.schedules.generate_tasks",
      ]),
    ];
    const current = user(["schedule_admin"]);

    expect(canViewSchedules(current, roles)).toBe(true);
    expect(canCreateSchedule(current, roles)).toBe(true);
    expect(canEditSchedule(current, roles)).toBe(true);
    expect(canDeleteSchedule(current, roles)).toBe(true);
    expect(canDeactivateSchedule(current, roles)).toBe(true);
    expect(canReactivateSchedule(current, roles)).toBe(true);
    expect(canPreviewScheduleScope(current, roles)).toBe(true);
    expect(canGenerateScheduleTasks(current, roles)).toBe(true);
  });

  it("maps implementation public download actions to option-specific permissions", () => {
    const roles = [
      role("downloads_admin", [
        "implementation.public_downloads.view",
        "implementation.public_downloads.create_document",
        "implementation.public_downloads.edit_document",
        "implementation.public_downloads.delete_document",
        "implementation.public_downloads.replace_file",
      ]),
    ];
    const current = user(["downloads_admin"]);

    expect(canViewPublicDownloadsAdmin(current, roles)).toBe(true);
    expect(canCreatePublicDownloadDocument(current, roles)).toBe(true);
    expect(canEditPublicDownloadDocument(current, roles)).toBe(true);
    expect(canDeletePublicDownloadDocument(current, roles)).toBe(true);
    expect(canReplacePublicDownloadFile(current, roles)).toBe(true);
  });

  it("keeps inline public files under their own permission prefix", () => {
    const roles = [
      role("public_files_admin", [
        "implementation.public_files.view",
        "implementation.public_files.create_file",
        "implementation.public_files.edit_file",
        "implementation.public_files.delete_file",
        "implementation.public_files.replace_file",
      ]),
    ];
    const current = user(["public_files_admin"]);

    expect(canViewPublicFilesAdmin(current, roles)).toBe(true);
    expect(canCreatePublicFile(current, roles)).toBe(true);
    expect(canEditPublicFile(current, roles)).toBe(true);
    expect(canDeletePublicFile(current, roles)).toBe(true);
    expect(canReplacePublicFile(current, roles)).toBe(true);
    expect(canViewPublicDownloadsAdmin(current, roles)).toBe(false);
  });

  it("maps print format actions to option-specific permissions", () => {
    const roles = [
      role("print_admin", [
        "configuration.print_formats.view",
        "configuration.print_formats.create_source",
        "configuration.print_formats.edit_source",
        "configuration.print_formats.delete_source",
        "configuration.print_formats.create_format",
        "configuration.print_formats.edit_format",
        "configuration.print_formats.delete_format",
        "configuration.print_formats.replace_pdf",
      ]),
    ];
    const current = user(["print_admin"]);

    expect(canViewPrintFormats(current, roles)).toBe(true);
    expect(canCreatePrintFormatSource(current, roles)).toBe(true);
    expect(canEditPrintFormatSource(current, roles)).toBe(true);
    expect(canDeletePrintFormatSource(current, roles)).toBe(true);
    expect(canCreatePrintFormat(current, roles)).toBe(true);
    expect(canEditPrintFormat(current, roles)).toBe(true);
    expect(canDeletePrintFormat(current, roles)).toBe(true);
    expect(canReplacePrintFormatPdf(current, roles)).toBe(true);
  });
});
