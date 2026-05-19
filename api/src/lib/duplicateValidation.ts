import { parseDbAccessString } from "./dbAccessParser";
import type { ClientRecord, DatabaseRecord, DomainRecord } from "../types/models";

export function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeDomainUrl(value: string): string {
  return normalizeComparableText(value).replace(/\/+$/, "");
}

export function normalizeDatabaseConnectionFromParts(parts: {
  serverHostPort: string;
  initialCatalog: string;
  userId: string;
}): string {
  return [
    normalizeComparableText(parts.serverHostPort),
    normalizeComparableText(parts.initialCatalog),
    normalizeComparableText(parts.userId),
  ].join("|");
}

export function normalizeDatabaseConnectionString(value: string): string {
  const parsed = parseDbAccessString(value.trim());
  return normalizeDatabaseConnectionFromParts(parsed);
}

export function hasDuplicateClientName(clients: ClientRecord[], name: string, currentId?: string): boolean {
  const normalized = normalizeComparableText(name);
  return clients.some((client) =>
    client.id !== currentId &&
    client.status !== "deleted" &&
    normalizeComparableText(client.name) === normalized
  );
}

export function hasDuplicateClientExternalId(clients: ClientRecord[], externalId: string | undefined, currentId?: string): boolean {
  const value = externalId?.trim();
  if (!value) return false;
  const normalized = normalizeComparableText(value);
  return clients.some((client) =>
    client.id !== currentId &&
    client.status !== "deleted" &&
    normalizeComparableText(client.externalId ?? "") === normalized
  );
}

export function hasDuplicateDomainUrl(domains: DomainRecord[], domainName: string, currentId?: string): boolean {
  const normalized = normalizeDomainUrl(domainName);
  return domains.some((domain) =>
    domain.id !== currentId &&
    domain.status !== "deleted" &&
    normalizeDomainUrl(domain.domainName) === normalized
  );
}

export function hasDuplicateDatabaseConnection(databases: DatabaseRecord[], rawDbAccess: string, currentId?: string): boolean {
  const normalized = normalizeDatabaseConnectionString(rawDbAccess);
  return databases.some((database) =>
    database.id !== currentId &&
    database.status !== "deleted" &&
    normalizeDatabaseConnectionFromParts(database.dbAccess) === normalized
  );
}
