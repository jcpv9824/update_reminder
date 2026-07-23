import type {
  ClientRecord,
  DomainRecord,
  LicenseAssignmentRecord,
  LicenseModuleRecord,
  UpdateSchedule,
} from "../types/models";
import { readSqlClients } from "./clientsSqlRepository";
import { readSqlDomains, readSqlPublicDatabases, type PublicDatabaseDto } from "./coreMastersSqlRepository";
import { readSqlLicenseAssignments, readSqlLicenseModules } from "./licensingSqlRepository";
import { readSqlSchedules } from "./schedulingSqlRepository";

export type SqlMastersReportData = {
  clients: ClientRecord[];
  domains: DomainRecord[];
  databases: PublicDatabaseDto[];
  schedules: UpdateSchedule[];
  licenseModules: LicenseModuleRecord[];
  licenseAssignments: LicenseAssignmentRecord[];
};

function asArray<T>(value: T[] | { items: T[] }): T[] {
  return Array.isArray(value) ? value : value.items;
}

export async function loadSqlMastersReportData(today: string): Promise<SqlMastersReportData> {
  const pagination = { enabled: false, page: 1, pageSize: 500 };
  const [clients, domains, databases, schedules, licenseModules, licenseAssignments] = await Promise.all([
    readSqlClients(),
    readSqlDomains({ status: "active" }, pagination),
    readSqlPublicDatabases({ visibility: "active" }, pagination),
    readSqlSchedules({}, pagination, today),
    readSqlLicenseModules({ includeDeleted: false }, pagination),
    readSqlLicenseAssignments(false, pagination),
  ]);

  return {
    clients: clients.filter((client) => client.status === "active" && !client.deletedAt),
    domains: asArray(domains),
    databases: asArray(databases),
    schedules: asArray(schedules).filter((schedule) => schedule.active),
    licenseModules: asArray(licenseModules),
    licenseAssignments: asArray(licenseAssignments),
  };
}
