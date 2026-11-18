import { collectCatalogActiveUserReport, type CatalogActiveUserReport, type CatalogActiveUserTarget } from "./catalogActiveUserReport";
import { createCatalogActiveUserSqlReader } from "./catalogActiveUserSqlReader";
import { readSqlCatalogPhysicalTargets } from "./catalogPhysicalTargetSqlRepository";
import { readSqlCatalogReportingProfiles } from "./catalogReportingProfilesSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { readStoredExternalDatabaseConnection } from "./integrationConnectionsSqlRepository";
import { getSecret } from "./keyVault";
import type { SqlMastersReportData } from "./mastersReportSqlData";
import type { Environment } from "../types/models";

const dependencies = {
  readTargets: readSqlCatalogPhysicalTargets,
  readProfiles: readSqlCatalogReportingProfiles,
  readConnection: readStoredExternalDatabaseConnection,
  readSecret: getSecret,
  createReader: createCatalogActiveUserSqlReader,
};

export function catalogActiveUserReportEnvironment(): CatalogEnvironment | null {
  if (process.env.PORTAL_CATALOG_ACTIVE_USERS_REPORT_ENABLED?.trim() !== "true") return null;
  const env = process.env.PORTAL_SAG_ENVIRONMENT?.trim();
  if (env !== "qa" && env !== "production") throw new Error("catalog_active_users_environment_invalid");
  return env;
}

/** The report's existing authorized master-record selection is the upper bound of this collection. */
export async function loadCatalogMastersActiveUsers(
  data: SqlMastersReportData, portalEnvironment: CatalogEnvironment, io: typeof dependencies = dependencies,
): Promise<CatalogActiveUserReport> {
  const active = (row: { status: string; deletedAt?: string | null }) => row.status === "active" && !row.deletedAt;
  const clients = new Map(data.clients.filter(active).map(c => [c.id, c]));
  const domains = new Map(data.domains.filter(active).map(d => [d.id, d]));
  const databases = data.databases.filter(db => active(db) && clients.has(db.clientId)
    && domains.get(db.domainId)?.clientId === db.clientId);
  const reportLinks = databases.map(db => ({
    clientId: db.clientId, clientName: clients.get(db.clientId)!.name, databaseLinkId: db.id,
    databaseAlias: db.dbAccess.initialCatalog,
  }));
  let targets: (CatalogActiveUserTarget | null)[] = databases.map(() => null);
  let profiles: Awaited<ReturnType<typeof readSqlCatalogReportingProfiles>> = new Map();
  const linksByPhysical = new Map<string, Parameters<typeof readSqlCatalogPhysicalTargets>[0]["links"][number][]>();
  const candidates = databases.flatMap((db, index) => {
    const environment = db.environment;
    return environment === "production" || environment === "test" || environment === "demo"
      ? [{ index, link: { kind: "database" as const, databaseId: db.id, customerId: db.clientId, domainId: db.domainId,
        environment: environment as Environment } }]
      : [];
  });
  try {
    const resolved = await io.readTargets({
      portalEnvironment, links: candidates.map(candidate => candidate.link),
    });
    if (resolved.length !== candidates.length) throw new Error("catalog_active_users_targets_inconsistent");
    const physicalIds = new Set(resolved.flatMap(target => target.status === "verified" ? [target.id] : []));
    profiles = await io.readProfiles({ portalEnvironment, physicalIds });
    resolved.forEach((target, index) => {
      if (target.status !== "verified") return;
      targets[candidates[index].index] = profiles.get(target.id)?.target ?? null;
      const links = linksByPhysical.get(target.id) ?? [];
      links.push(candidates[index].link);
      linksByPhysical.set(target.id, links);
    });
  } catch {
    // Missing local evidence is not zero users, and does not stop the rest of the masters report.
    targets = databases.map(() => null);
    profiles = new Map();
  }

  const recheck = async (target: CatalogActiveUserTarget, signal: AbortSignal) => {
    const id = target.physicalDatabaseId;
    const links = linksByPhysical.get(id);
    const original = profiles.get(id);
    if (!links?.length || !original || signal.aborted) return null;
    const [currentTargets, currentProfiles] = await Promise.all([
      io.readTargets({ portalEnvironment, links }),
      io.readProfiles({ portalEnvironment, physicalIds: new Set([id]) }),
    ]);
    const profile = currentProfiles.get(id);
    if (signal.aborted || currentTargets.length !== links.length ||
      currentTargets.some(link => link.status !== "verified" || link.id !== id) || !profile ||
      profile.target.reportingProfileId !== target.reportingProfileId || profile.target.serverGroupId !== target.serverGroupId ||
      profile.connectionId !== original.connectionId || profile.profileVersion !== original.profileVersion ||
      !profile.expectedFingerprint.equals(original.expectedFingerprint)) return null;
    return profile;
  };
  const reader = io.createReader(async (target, signal) => {
    const profile = await recheck(target, signal);
    if (!profile) return null;
    const connection = await io.readConnection(profile.connectionId);
    if (!connection || connection.id !== profile.connectionId || connection.etag !== profile.profileVersion ||
      !connection.active || connection.status !== "active" || !connection.encrypt || !connection.passwordConfigured ||
      !connection.passwordSecretName || signal.aborted) return null;
    const password = await io.readSecret(connection.passwordSecretName, signal);
    if (!password || signal.aborted) return null;
    return {
      target, evidence: profile.evidence,
      identity: { instanceId: target.serverGroupId, expectedFingerprint: profile.expectedFingerprint },
      connection: { server: connection.serverHost, port: connection.serverPort,
        database: connection.databaseName, username: connection.username, password },
    };
  });
  return collectCatalogActiveUserReport(reportLinks.map((link, i) => ({ ...link, target: targets[i] })),
    async (target, signal) => {
      const count = await reader(target, signal);
      // An expiring/revoked proof or a changed alias cannot surface a count that was in flight.
      if (!await recheck(target, signal)) throw new Error("catalog_active_users_proof_changed");
      return count;
    });
}
