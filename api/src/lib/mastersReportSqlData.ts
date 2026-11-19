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
import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

export type SqlMastersReportData = {
  clients: ClientRecord[];
  domains: DomainRecord[];
  databases: PublicDatabaseDto[];
  schedules: UpdateSchedule[];
  licenseModules: LicenseModuleRecord[];
  licenseAssignments: LicenseAssignmentRecord[];
  /** Present only for a certified catalog projection. Never identifies failed sources. */
  catalogCoverage?: Readonly<{ partial: boolean }>;
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

type CatalogReportLinkRow = {
  source_id: string; link_id: string; client_id: string; official_name: string | null; client_created_at: Date;
  domain_id: string; domain_name: string; domain_environment: string; domain_created_at: Date;
  target_kind: "domain" | "database"; database_id: string | null; database_name: string | null;
  database_alias: string | null; database_environment: string | null; database_created_at: Date | null;
};
type CatalogReportResultRow = (CatalogReportLinkRow | { source_id: null }) & {
  certified_source_count: number; open_link_count: number;
};

const maximumCatalogLinks = 5000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (): never => { throw new Error("catalog_masters_report_unavailable"); };
const testLabel = (name: string) => /\b(?:pruebas?|tests?|demo)\b/iu.test(name);
const databaseLinkPins = new WeakMap<SqlMastersReportData, ReadonlyMap<string, readonly string[]>>();
const absentLinks: readonly string[] = Object.freeze([]);

/** Internal pins for source-authorized counts only. The report DTO never carries them. */
export function catalogReportDatabaseLinkIds(data: SqlMastersReportData, databaseId: string): readonly string[] {
  return databaseLinkPins.get(data)?.get(databaseId) ?? absentLinks;
}

export const readCatalogMastersReportSql = `
SET NOCOUNT ON;
DECLARE @now datetime2(7)=SYSUTCDATETIME();
DECLARE @certified TABLE(source_id uniqueidentifier PRIMARY KEY,revision_key bigint NOT NULL);
INSERT @certified
SELECT b.source_id,r.revision_key
FROM settings.catalog_source_bindings b
JOIN OPENJSON(@allowedSourceIds) authorized ON b.source_id=TRY_CONVERT(uniqueidentifier,authorized.[value])
JOIN settings.external_database_connections profile ON profile.external_database_connection_key=b.external_database_connection_key
JOIN settings.catalog_match_key_registry mk ON mk.portal_environment=@portalEnvironment AND mk.enrolled_at<=@now
JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key
  AND h.attempt_status='succeeded' AND h.attempted_at<=@now
JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
  AND r.source_role='erp-customers' AND r.attempt_ordinal=h.attempt_ordinal AND r.match_key_version=mk.match_key_version
  AND r.binding_version=b.row_version AND r.profile_version=profile.row_version
  AND r.observed_at<=@now AND r.sealed_at<=@now AND r.verified_until>@now
WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=@portalEnvironment
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@portalEnvironment)
  AND b.source_role='erp-customers' AND b.source_state='active' AND b.contract_version='erp_v1'
  AND b.validated_at<=@now AND b.validated_profile_version=profile.row_version
  AND profile.active=1 AND profile.status='active' AND profile.encrypt_connection=1 AND profile.password_configured=1;

SELECT coverage.certified_source_count, inventory.open_link_count, links.*
FROM (SELECT COUNT(*) AS certified_source_count FROM @certified) coverage
CROSS JOIN (SELECT COUNT(*) AS open_link_count FROM (
  SELECT TOP (5001) l.link_key
  FROM core.catalog_operational_links l
  JOIN core.catalog_operational_owners ow ON ow.owner_key=l.owner_key AND ow.retired_at IS NULL
  JOIN settings.catalog_source_bindings b ON b.catalog_source_key=l.catalog_source_key
  JOIN OPENJSON(@allowedSourceIds) authorized ON b.source_id=TRY_CONVERT(uniqueidentifier,authorized.[value])
  WHERE l.portal_environment=@portalEnvironment AND l.retired_at IS NULL
  ORDER BY l.link_key
) limited) inventory
OUTER APPLY (SELECT TOP (5001)
  LOWER(CONVERT(char(36),e.catalog_source_id)) AS source_id,LOWER(CONVERT(char(36),e.link_id)) AS link_id,c.source_id AS client_id,
  published.official_name,c.created_at AS client_created_at,
  d.source_id AS domain_id,d.domain_name,d.environment_id AS domain_environment,d.created_at AS domain_created_at,
  e.target_kind,db.source_id AS database_id,db.company_name AS database_name,
  p.initial_catalog AS database_alias,db.environment_id AS database_environment,db.created_at AS database_created_at
FROM core.catalog_operational_link_evidence e
JOIN @certified authorized ON authorized.source_id=e.catalog_source_id AND authorized.revision_key=e.revision_key
JOIN core.catalog_customer_revision_rows published ON published.revision_key=authorized.revision_key
  AND published.source_record_id=e.source_record_id AND published.catalog_customer_key=e.catalog_customer_key AND published.active_code='S'
JOIN core.clients c ON c.client_key=e.client_key AND c.status='active'
JOIN core.domains d ON d.domain_key=e.domain_key AND d.client_key=e.client_key AND d.status='active'
LEFT JOIN core.databases db ON db.database_key=e.database_key AND db.client_key=e.client_key
  AND db.domain_key=e.domain_key AND db.status='active'
LEFT JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key
WHERE e.portal_environment=@portalEnvironment AND e.evidence_state='verified'
  AND e.retired_at IS NULL AND e.owner_retired_at IS NULL
ORDER BY e.link_key) links;`.trim();

const byId = <T extends { id: string }>(a: T, b: T) => a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
const validName = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/\p{C}/u.test(value);
const iso = (value: Date | null) => value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : fail();

function safeReportDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500 || /[\s\p{C}\\]/u.test(value)) return null;
  // Accept a bare public-looking DNS name or HTTPS URL; only the normalized
  // host may render. Never carry URL credentials, path, query, or fragment.
  const host = /^(?:https:\/\/)?([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i.exec(value)?.[1]?.toLowerCase();
  if (!host || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
      !/[a-z]/.test(labels.at(-1)!) || /\.(?:internal|local|localhost|invalid)$/.test(host)) return null;
  return `https://${host}`;
}

function mapCatalogMastersReportData(rows: CatalogReportLinkRow[], allowed: ReadonlySet<string>): SqlMastersReportData {
  const key = (clientId: string, domainId: string) => JSON.stringify([clientId, domainId]);
  const approvedDomains = new Set<string>();
  for (const row of rows) {
    if (!allowed.has(row.source_id) || !validName(row.client_id) || !validName(row.domain_id) ||
        typeof row.link_id !== "string" || !uuid.test(row.link_id) || row.link_id === "00000000-0000-0000-0000-000000000000" ||
        (row.target_kind !== "domain" && row.target_kind !== "database")) return fail();
    if (row.target_kind === "domain" && safeReportDomain(row.domain_name)) approvedDomains.add(key(row.client_id, row.domain_id));
  }
  const names = new Map<string, { name: string; sourceId: string; createdAt: string }>();
  for (const row of rows) {
    if (!approvedDomains.has(key(row.client_id, row.domain_id))) continue;
    if (!validName(row.official_name)) continue;
    const name = row.official_name.trim(), prior = names.get(row.client_id);
    if (!prior || Number(testLabel(name)) < Number(testLabel(prior.name)) || (testLabel(name) === testLabel(prior.name)
      && (row.source_id < prior.sourceId || (row.source_id === prior.sourceId && name < prior.name)))) {
      names.set(row.client_id, { name, sourceId: row.source_id, createdAt: iso(row.client_created_at) });
    }
  }
  const clients: ClientRecord[] = [...names].map(([id, { name, createdAt }]) => ({
    id, name, status: "active", createdAt, updatedAt: createdAt, createdBy: "system", updatedBy: "system",
  }));
  const domains = new Map<string, DomainRecord>();
  for (const row of rows) {
    const authorizedName = names.get(row.client_id)?.name;
    const domainName = safeReportDomain(row.domain_name);
    if (row.target_kind !== "domain" || !authorizedName || !domainName) continue;
    const prior = domains.get(row.domain_id);
    if (prior) {
      if (prior.clientId !== row.client_id || prior.domainName !== domainName || prior.environment !== row.domain_environment) return fail();
      continue;
    }
    const createdAt = iso(row.domain_created_at);
    domains.set(row.domain_id, { id: row.domain_id, clientId: row.client_id, clientName: authorizedName,
      domainName, environment: row.domain_environment, status: "active", assignedUpdaterIds: [],
      createdAt, updatedAt: createdAt, createdBy: "system", updatedBy: "system" });
  }
  const databases = new Map<string, PublicDatabaseDto>();
  for (const row of rows) {
    const domain = domains.get(row.domain_id);
    if (row.target_kind !== "database" || domain?.clientId !== row.client_id) continue;
    const id = row.database_id, companyName = row.database_name, initialCatalog = row.database_alias, environment = row.database_environment;
    if (!validName(id) || !validName(companyName) || !validName(initialCatalog) || !validName(environment)) return fail();
    const prior = databases.get(id);
    if (prior) {
      if (prior.clientId !== row.client_id || prior.domainId !== row.domain_id || prior.environment !== environment ||
          prior.dbAccess.initialCatalog !== initialCatalog || prior.companyName !== companyName) return fail();
      continue;
    }
    const createdAt = iso(row.database_created_at);
    databases.set(id, { id, clientId: row.client_id, clientName: domain.clientName, domainId: domain.id,
      domainName: domain.domainName, companyName, environment, dbAccess: { initialCatalog }, status: "active",
      createdAt, updatedAt: createdAt, currentDbVersion: undefined, notes: undefined, lastUpdatedAt: undefined });
  }
  // Legacy schedules and entitlements are not proof of authorization for this scope.
  return { clients: clients.sort(byId), domains: [...domains.values()].sort(byId), databases: [...databases.values()].sort(byId),
    schedules: [], licenseModules: [], licenseAssignments: [] };
}

/** Internal scoped data only; no fallback to the unscoped master queries. */
export async function loadSqlCatalogMastersReportData({ portalEnvironment, allowedSourceIds }: Readonly<{
  portalEnvironment: CatalogEnvironment; allowedSourceIds: ReadonlySet<string>;
}>): Promise<SqlMastersReportData> {
  if ((portalEnvironment !== "qa" && portalEnvironment !== "production") || !allowedSourceIds.size || allowedSourceIds.size > 50 ||
    [...allowedSourceIds].some(id => typeof id !== "string" || !uuid.test(id))) return fail();
  try {
    // Keep the certified revision pointers stable across the source and link
    // reads. Release the Portal SQL locks before any external aggregate count.
    const { recordset } = await runSqlTransaction(transaction => transaction.request()
      .input("portalEnvironment", sql.VarChar(10), portalEnvironment)
      .input("allowedSourceIds", sql.NVarChar(sql.MAX), JSON.stringify([...allowedSourceIds].sort()))
      .query<CatalogReportResultRow>(readCatalogMastersReportSql));
    if (!Array.isArray(recordset) || !recordset.length || recordset.length > maximumCatalogLinks) return fail();
    const count = recordset[0].certified_source_count;
    const open = recordset[0].open_link_count;
    if (!Number.isInteger(count) || count < 1 || count > allowedSourceIds.size || !Number.isInteger(open) ||
        open < 0 || open > maximumCatalogLinks || recordset.some(row => row.certified_source_count !== count ||
          row.open_link_count !== open || (recordset.length !== 1 && row.source_id === null))) return fail();
    const rows = recordset.filter((row): row is CatalogReportLinkRow & { certified_source_count: number; open_link_count: number } => row.source_id !== null);
    if (rows.length > open) return fail();
    const data = mapCatalogMastersReportData(rows, allowedSourceIds);
    const displayedDomains = new Set(data.domains.map(row => row.id));
    const displayedDatabases = new Map(data.databases.map(row => [row.id, row]));
    const displayed = (row: CatalogReportLinkRow) => {
      const db = row.database_id ? displayedDatabases.get(row.database_id) : undefined;
      return !!db && db.clientId === row.client_id && db.domainId === row.domain_id && db.environment === row.database_environment;
    };
    const omitted = rows.some(row => row.target_kind === "domain" ? !displayedDomains.has(row.domain_id) :
      !displayed(row));
    const result: SqlMastersReportData = {
      ...data, catalogCoverage: { partial: count !== allowedSourceIds.size || !data.domains.length || rows.length !== open || omitted },
    };
    const pins = new Map<string, Set<string>>();
    const anchoredIds = new Map<string, string>();
    for (const row of rows) {
      if (row.target_kind !== "database" || !row.database_id || !displayed(row)) continue;
      const prior = anchoredIds.get(row.link_id);
      if (prior !== undefined && prior !== row.database_id) return fail();
      anchoredIds.set(row.link_id, row.database_id);
      const links = pins.get(row.database_id) ?? new Set<string>();
      links.add(row.link_id);
      pins.set(row.database_id, links);
    }
    databaseLinkPins.set(result, new Map([...pins].map(([id, links]) => [id, Object.freeze([...links].sort())])));
    return result;
  } catch { return fail(); }
}
