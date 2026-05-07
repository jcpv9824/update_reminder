import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule } from "../types/models";
import {
  buildMastersReportEmail as buildMastersReportTemplate,
  type MasterReportClient,
} from "./emailTemplates";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseSemicolonEmails(value: string): string[] {
  const emails = value.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  if (emails.length === 0) throw new Error("Ingrese al menos un destinatario.");
  const invalid = emails.find((email) => !EMAIL_RE.test(email));
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

  const reportClients: MasterReportClient[] = args.clients.map((client) => ({
    name: client.name,
    status: client.status,
    createdAt: client.createdAt,
    domains: (domainsByClient.get(client.id) ?? []).map((domain) => ({
      name: domain.domainName,
      url: domain.domainName,
      status: domain.status,
      frequencyName: describeSchedule(activeDomainSchedule.get(domain.id)),
      databases: (dbsByDomain.get(domain.id) ?? []).map((db) => ({
        name: `${db.companyName} / ${db.dbAccess.initialCatalog}`,
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
