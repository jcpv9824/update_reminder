import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseAssignmentRecord } from "../types/models";

function isActive(record: { status?: string; active?: boolean; deletedAt?: string | null } | null | undefined): boolean {
  if (!record) return false;
  if (record.deletedAt) return false;
  if (record.status && record.status !== "active") return false;
  if (record.active === false) return false;
  return true;
}

export type LicenseDeleteDependency = {
  clientId: string;
  clientName: string;
  assignments: number;
};

export function summarizeLicenseDeleteDependencies(args: {
  moduleId: string;
  assignments: LicenseAssignmentRecord[];
  clients: ClientRecord[];
  domains: DomainRecord[];
  databases: DatabaseRecord[];
}): LicenseDeleteDependency[] {
  const clientsById = new Map(args.clients.filter(isActive).map((client) => [client.id, client]));
  const domainsById = new Map(args.domains.filter(isActive).map((domain) => [domain.id, domain]));
  const databasesById = new Map(args.databases.filter(isActive).map((database) => [database.id, database]));
  const counts = new Map<string, number>();

  for (const assignment of args.assignments) {
    if (assignment.moduleId !== args.moduleId || !isActive(assignment)) continue;
    const clientId =
      assignment.clientId ||
      (assignment.domainId ? domainsById.get(assignment.domainId)?.clientId : undefined) ||
      (assignment.databaseId ? databasesById.get(assignment.databaseId)?.clientId : undefined) ||
      (assignment.targetType === "client" ? assignment.targetId : undefined) ||
      (assignment.targetType === "domain" && assignment.targetId ? domainsById.get(assignment.targetId)?.clientId : undefined) ||
      (assignment.targetType === "database" && assignment.targetId ? databasesById.get(assignment.targetId)?.clientId : undefined);
    if (!clientId || !clientsById.has(clientId)) continue;
    counts.set(clientId, (counts.get(clientId) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([clientId, assignments]) => ({
      clientId,
      clientName: clientsById.get(clientId)?.name ?? clientId,
      assignments,
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName, "es"));
}
