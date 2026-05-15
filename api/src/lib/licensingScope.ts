import type { ClientRecord, DatabaseRecord, DomainRecord, LicensingScope, LicenseModuleRecord, UpdateSchedule } from "../types/models";

export type LicensingScopePreview = {
  clientsCount: number;
  domainsCount: number;
  databasesCount: number;
  groups: Array<{
    client: { id: string; name: string; licenses: string[] };
    domains: Array<{
      id: string;
      name: string;
      environment: string;
      databases: Array<{ id: string; companyName: string; databaseName: string; environment: string }>;
    }>;
  }>;
};

function isActive(record: { status?: string; active?: boolean; deletedAt?: string | null }): boolean {
  if (record.deletedAt) return false;
  if (record.status && record.status !== "active") return false;
  if (record.active === false) return false;
  return true;
}

function environmentMatches(recordEnvironment: string | undefined, selected: string | undefined): boolean {
  if (!selected || selected === "all") return true;
  return String(recordEnvironment ?? "").toLowerCase() === selected.toLowerCase();
}

function clientMatchesLicenses(client: ClientRecord, scope: LicensingScope): boolean {
  const selected = new Set(scope.licenseModuleIds);
  if (selected.size === 0) return false;
  const owned = new Set(client.licenseModuleIds ?? []);
  if (scope.licenseMatchMode === "all") return Array.from(selected).every((id) => owned.has(id));
  return Array.from(selected).some((id) => owned.has(id));
}

export function previewLicensingScope(args: {
  scope: LicensingScope;
  clients: ClientRecord[];
  domains: DomainRecord[];
  databases: DatabaseRecord[];
  licenseModules: LicenseModuleRecord[];
}): LicensingScopePreview {
  const moduleNames = new Map(args.licenseModules.filter(isActive).map((module) => [module.id, module.name]));
  const activeOnly = args.scope.activeOnly !== false;
  const clients = args.clients.filter((client) => (!activeOnly || isActive(client)) && clientMatchesLicenses(client, args.scope));
  const domains = args.domains.filter((domain) => (!activeOnly || isActive(domain)) && environmentMatches(domain.environment, args.scope.environment));
  const activeDomainIds = new Set(domains.map((domain) => domain.id));
  const databases = args.databases.filter((db) =>
    (!activeOnly || isActive(db)) &&
    activeDomainIds.has(db.domainId) &&
    environmentMatches(db.environment, args.scope.environment)
  );

  const includeDomains = args.scope.targetTypes !== "databases_only";
  const includeDatabases = args.scope.targetTypes !== "domains_only";
  const groups: LicensingScopePreview["groups"] = [];

  for (const client of clients) {
    const clientDomains = domains.filter((domain) => domain.clientId === client.id);
    const domainGroups = clientDomains.map((domain) => ({
      id: domain.id,
      name: domain.domainName,
      environment: domain.environment,
      databases: includeDatabases
        ? databases.filter((db) => db.clientId === client.id && db.domainId === domain.id).map((db) => ({
            id: db.id,
            companyName: db.companyName,
            databaseName: db.dbAccess.initialCatalog,
            environment: db.environment,
          }))
        : [],
    })).filter((domain) => includeDomains || domain.databases.length > 0);

    if (domainGroups.length === 0) continue;
    groups.push({
      client: {
        id: client.id,
        name: client.name,
        licenses: (client.licenseModuleIds ?? [])
          .filter((id) => args.scope.licenseModuleIds.includes(id))
          .map((id) => moduleNames.get(id) ?? id),
      },
      domains: domainGroups,
    });
  }

  return {
    clientsCount: groups.length,
    domainsCount: includeDomains ? groups.reduce((sum, group) => sum + group.domains.length, 0) : 0,
    databasesCount: includeDatabases ? groups.reduce((sum, group) => sum + group.domains.reduce((dbSum, domain) => dbSum + domain.databases.length, 0), 0) : 0,
    groups,
  };
}

export function expandLicensingSchedule(args: {
  schedule: UpdateSchedule;
  clients: ClientRecord[];
  domains: DomainRecord[];
  databases: DatabaseRecord[];
  licenseModules?: LicenseModuleRecord[];
}): UpdateSchedule[] {
  if (!args.schedule.licensingScope) return [];
  const preview = previewLicensingScope({
    scope: args.schedule.licensingScope,
    clients: args.clients,
    domains: args.domains,
    databases: args.databases,
    licenseModules: args.licenseModules ?? [],
  });
  const expanded: UpdateSchedule[] = [];
  const includeDomains = args.schedule.licensingScope.targetTypes !== "databases_only";
  const includeDatabases = args.schedule.licensingScope.targetTypes !== "domains_only";

  for (const group of preview.groups) {
    for (const domain of group.domains) {
      if (includeDomains) {
        expanded.push({
          ...args.schedule,
          id: `${args.schedule.id}__lic_domain_${domain.id}`,
          clientId: group.client.id,
          clientName: group.client.name,
          domainId: domain.id,
          domainName: domain.name,
          targetType: "domain",
          targetIds: [domain.id],
          assignedRole: args.schedule.domainAssignedRole ?? "domain_updater",
          assignedUserIds: args.schedule.assignmentMode === "users" ? (args.schedule.assignedUserIds ?? []) : [],
        });
      }
      if (includeDatabases) {
        for (const db of domain.databases) {
          expanded.push({
            ...args.schedule,
            id: `${args.schedule.id}__lic_db_${db.id}`,
            clientId: group.client.id,
            clientName: group.client.name,
            domainId: domain.id,
            domainName: domain.name,
            targetType: "database",
            targetIds: [db.id],
            assignedRole: args.schedule.databaseAssignedRole ?? "database_updater",
            assignedUserIds: args.schedule.assignmentMode === "users" ? (args.schedule.databaseAssignedUserIds ?? []) : [],
          });
        }
      }
    }
  }

  return expanded;
}
