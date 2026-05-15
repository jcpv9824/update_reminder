import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule } from "../types/models";
import {
  buildMastersReportEmail as buildMastersReportTemplate,
  type MasterReportClient,
} from "./emailTemplates";
import { parseSemicolonEmails as parseEmailsDetailed, uniqueEmails } from "./emailRecipients";

export function parseSemicolonEmails(value: string): string[] {
  const parsed = parseEmailsDetailed(value);
  const emails = uniqueEmails(parsed.emails);
  if (emails.length === 0) throw new Error("Ingrese al menos un destinatario.");
  const invalid = parsed.invalid[0];
  if (invalid) throw new Error(`Correo inválido: ${invalid}`);
  return emails;
}

function describeSchedule(schedule?: UpdateSchedule): string {
  if (!schedule || !schedule.active) return "Sin frecuencia activa";
  if (schedule.frequencyType === "weekly") return `Semanal (${(schedule.weekdays ?? []).join(", ") || "sin día"})`;
  if (schedule.frequencyType === "interval") return `Cada ${schedule.intervalDays} día(s)`;
  if (schedule.frequencyType === "monthly") return `Mensual (día ${schedule.dayOfMonth})`;
  return "Manual";
}

export function buildMastersReportEmail(args: {
  clients: ClientRecord[];
  domains: DomainRecord[];
  databases: DatabaseRecord[];
  schedules: UpdateSchedule[];
  generatedAt?: string | Date;
  frontendBaseUrl?: string;
  timezone?: string;
}): { subject: string; html: string; text: string } {
  const domainsByClient = new Map<string, DomainRecord[]>();
  const dbsByDomain = new Map<string, DatabaseRecord[]>();
  const activeDomainSchedule = new Map<string, UpdateSchedule>();

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

  const activeClients = args.clients.filter((client) => client.status === "active");
  const activeDomains = new Set(args.domains.filter((domain) => domain.status === "active").map((domain) => domain.id));

  const reportClients: MasterReportClient[] = activeClients.map((client) => ({
    name: client.name,
    status: client.status,
    createdAt: client.createdAt,
    domains: (domainsByClient.get(client.id) ?? []).filter((domain) => domain.status === "active").map((domain) => ({
      name: domain.domainName,
      url: domain.domainName,
      publishableDomain: domain.domainName,
      environment: String(domain.environment ?? ""),
      status: domain.status,
      frequencyName: describeSchedule(activeDomainSchedule.get(domain.id)),
      databases: (dbsByDomain.get(domain.id) ?? []).filter((db) => db.status === "active" && activeDomains.has(db.domainId)).map((db) => ({
        name: db.dbAccess.initialCatalog,
        companyName: db.companyName,
        environment: String(db.environment ?? ""),
        status: db.status,
        createdAt: db.createdAt,
      })),
    })),
  }));

  return buildMastersReportTemplate({
    clients: reportClients,
    generatedAt: args.generatedAt,
    frontendBaseUrl: args.frontendBaseUrl,
    timezone: args.timezone,
  });
}
