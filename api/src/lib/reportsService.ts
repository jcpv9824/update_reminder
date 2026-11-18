import type {
  ClientRecord,
  DatabaseRecord,
  DomainRecord,
  LicenseAssignmentRecord,
  LicenseModuleRecord,
  UpdateSchedule,
} from "../types/models";
import {
  buildMastersReportEmail as buildMastersReportTemplate,
  type MasterReportClient,
} from "./emailTemplates";
import { parseSemicolonEmails as parseEmailsDetailed, uniqueEmails } from "./emailRecipients";
import type { CatalogActiveUserReport } from "./catalogActiveUserReport";

export function parseSemicolonEmails(value: string): string[] {
  const parsed = parseEmailsDetailed(value);
  const emails = uniqueEmails(parsed.emails);
  if (emails.length === 0) throw new Error("Ingrese al menos un destinatario.");
  const invalid = parsed.invalid[0];
  if (invalid) throw new Error(`Correo inválido: ${invalid}`);
  return emails;
}

export type MastersReportDatabaseRecord = Pick<
  DatabaseRecord,
  "id" | "clientId" | "domainId" | "companyName" | "environment" | "status" | "createdAt" | "lastUpdatedAt"
> & {
  dbAccess: Pick<DatabaseRecord["dbAccess"], "initialCatalog">;
  deletedAt?: string | null;
};

function describeSchedule(schedule?: UpdateSchedule): string {
  if (!schedule || !schedule.active) return "Sin frecuencia activa";
  if (schedule.frequencyType === "once") return `Única (${schedule.startDate})`;
  if (schedule.frequencyType === "weekly") return `Semanal (${(schedule.weekdays ?? []).join(", ") || "sin día"})`;
  if (schedule.frequencyType === "interval") return `Cada ${schedule.intervalDays} día(s)`;
  if (schedule.frequencyType === "monthly") return `Mensual (día ${schedule.dayOfMonth})`;
  return "Manual";
}

function isActiveRecord(record: { status?: string; active?: boolean; deletedAt?: string | null } | null | undefined): boolean {
  if (!record) return false;
  if (record.deletedAt) return false;
  if (record.status && record.status !== "active") return false;
  if (record.active === false) return false;
  return true;
}

function assignmentBelongsToClient(args: {
  assignment: LicenseAssignmentRecord;
  clientId: string;
  domainIds: Set<string>;
  databaseIds: Set<string>;
}): boolean {
  const { assignment, clientId, domainIds, databaseIds } = args;
  if (assignment.clientId === clientId) return true;
  if (assignment.domainId && domainIds.has(assignment.domainId)) return true;
  if (assignment.databaseId && databaseIds.has(assignment.databaseId)) return true;
  if (assignment.targetType === "client" && assignment.targetId === clientId) return true;
  if (assignment.targetType === "domain" && assignment.targetId && domainIds.has(assignment.targetId)) return true;
  if (assignment.targetType === "database" && assignment.targetId && databaseIds.has(assignment.targetId)) return true;
  return false;
}

export function buildMastersReportEmail(args: {
  clients: ClientRecord[];
  domains: DomainRecord[];
  databases: MastersReportDatabaseRecord[];
  schedules: UpdateSchedule[];
  licenseModules?: LicenseModuleRecord[];
  licenseAssignments?: LicenseAssignmentRecord[];
  activeUsersReport?: CatalogActiveUserReport;
  generatedAt?: string | Date;
  frontendBaseUrl?: string;
  timezone?: string;
}): { subject: string; html: string; text: string } {
  const includeAdvancedAssignments = process.env.ENABLE_ADVANCED_LICENSE_ASSIGNMENTS === "true";
  const domainsByClient = new Map<string, DomainRecord[]>();
  const dbsByDomain = new Map<string, MastersReportDatabaseRecord[]>();
  const activeDomainSchedule = new Map<string, UpdateSchedule>();
  const countsByClient = new Map<string, Map<string, number | null>>();
  const displayedLinksByClient = new Map<string, Set<string>>();
  for (const row of args.activeUsersReport?.rows ?? []) {
    const counts = countsByClient.get(row.clientId) ?? new Map<string, number | null>();
    const count = row.status === "available" && Number.isSafeInteger(row.activeUsers) && row.activeUsers >= 0
      ? row.activeUsers : null;
    const existing = counts.get(row.databaseLinkId);
    counts.set(row.databaseLinkId, existing !== undefined && existing !== count ? null : count);
    countsByClient.set(row.clientId, counts);
  }
  let hasUnverifiedDisplayedDatabase = false;

  function activeUsersFor(clientId: string, db: MastersReportDatabaseRecord): number | null | undefined {
    if (!args.activeUsersReport) return undefined;
    const matchesOwner = db.clientId === clientId;
    if (matchesOwner) {
      const displayed = displayedLinksByClient.get(clientId) ?? new Set<string>();
      displayed.add(db.id);
      displayedLinksByClient.set(clientId, displayed);
    }
    const count = (matchesOwner ? countsByClient.get(clientId)?.get(db.id) : null) ?? null;
    if (count === null) hasUnverifiedDisplayedDatabase = true;
    return count;
  }

  for (const domain of args.domains) {
    const list = domainsByClient.get(domain.clientId) ?? [];
    list.push(domain);
    domainsByClient.set(domain.clientId, list);
  }
  for (const db of args.databases) {
    const list = dbsByDomain.get(db.domainId) ?? [];
    list.push(db);
    dbsByDomain.set(db.domainId, list);
  }
  for (const schedule of args.schedules) {
    if (!schedule.active || schedule.targetType !== "domain") continue;
    for (const targetId of schedule.targetIds) {
      if (!activeDomainSchedule.has(targetId)) activeDomainSchedule.set(targetId, schedule);
    }
  }

  const activeClients = args.clients.filter((client) => isActiveRecord(client));
  const activeDomainsList = args.domains.filter((domain) => isActiveRecord(domain));
  const activeDatabasesList = args.databases.filter((db) => isActiveRecord(db));
  const activeDomains = new Set(activeDomainsList.map((domain) => domain.id));
  const activeLicenseModules = new Map(
    (args.licenseModules ?? [])
      .filter(isActiveRecord)
      .map((module) => [module.id, module])
  );
  const activeLicenseAssignments = (args.licenseAssignments ?? []).filter((assignment) =>
    isActiveRecord(assignment) && activeLicenseModules.has(assignment.moduleId)
  );

  const reportClients: MasterReportClient[] = activeClients.map((client) => {
    const clientDomainIds = new Set(activeDomainsList.filter((domain) => domain.clientId === client.id).map((domain) => domain.id));
    const clientDatabaseIds = new Set(activeDatabasesList.filter((db) => db.clientId === client.id && activeDomains.has(db.domainId)).map((db) => db.id));
    const licensesByModuleId = new Map<string, LicenseModuleRecord>();

    for (const moduleId of client.licenseModuleIds ?? []) {
      const module = activeLicenseModules.get(moduleId);
      if (module) licensesByModuleId.set(module.id, module);
    }

    if (includeAdvancedAssignments) {
      for (const assignment of activeLicenseAssignments) {
        if (!assignmentBelongsToClient({ assignment, clientId: client.id, domainIds: clientDomainIds, databaseIds: clientDatabaseIds })) continue;
        const module = activeLicenseModules.get(assignment.moduleId);
        if (module) licensesByModuleId.set(module.id, module);
      }
    }

    const licenses = Array.from(licensesByModuleId.values())
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .map((module) => ({ name: module.name, code: module.code }));

    return {
      name: client.name,
      status: client.status,
      createdAt: client.createdAt,
      licenses,
      domains: (domainsByClient.get(client.id) ?? []).filter((domain) => isActiveRecord(domain)).map((domain) => ({
        name: domain.domainName,
        url: domain.domainName,
        publishableDomain: domain.domainName,
        environment: String(domain.environment ?? ""),
        status: domain.status,
        frequencyName: describeSchedule(activeDomainSchedule.get(domain.id)),
        databases: (dbsByDomain.get(domain.id) ?? []).filter((db) => isActiveRecord(db) && activeDomains.has(db.domainId)).map((db) => ({
          name: db.dbAccess.initialCatalog,
          companyName: db.companyName,
          environment: String(db.environment ?? ""),
          status: db.status,
          createdAt: db.createdAt,
          activeUsers: activeUsersFor(client.id, db),
        })),
      })),
    };
  });

  // The collector deduplicates before returning its summary. If its scope is
  // wider than the rendered report, no safe subtotal can be derived here.
  const summaryScopeMismatch = args.activeUsersReport?.rows.some(
    (row) => !displayedLinksByClient.get(row.clientId)?.has(row.databaseLinkId),
  );
  return buildMastersReportTemplate({
    clients: reportClients,
    generatedAt: args.generatedAt,
    frontendBaseUrl: args.frontendBaseUrl,
    timezone: args.timezone,
    activeUsersSummary: args.activeUsersReport && {
      activeUsers: summaryScopeMismatch ? null : args.activeUsersReport.summary.activeUsers,
      partial: !!summaryScopeMismatch || args.activeUsersReport.summary.partial || hasUnverifiedDisplayedDatabase,
    },
  });
}
