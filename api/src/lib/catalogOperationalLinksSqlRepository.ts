import sql from "mssql";
import type { Environment } from "../types/models";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSqlPool } from "./sql";

type OperationalEvidence = Readonly<{ state: "unverifiable" }> | Readonly<{
  state: "verified";
  sourceId: string;
  /** Exact SQL bigint identity, never converted through a JavaScript number. */
  revisionId: string;
  bindingVersion: string;
  profileVersion: string;
  verifiedUntil: string;
}>;

/** Internal logical correspondence, not a task link, license grant or physical-target proof. */
export type CatalogOperationalLink = Readonly<{
  linkId: string;
  /** Opaque catalog identity; deliberately separate from the operational client's source ID. */
  catalogCustomerId: string;
  customerId: string;
  customerName: string;
  domainId: string;
  domainName: string;
  catalogRecordId: string;
  environment: Environment;
  evidence: OperationalEvidence;
}> & (Readonly<{ kind: "domain"; databaseId?: never; databaseName?: never }>
  | Readonly<{ kind: "database"; databaseId: string; databaseName: string }>);

const maxLinks = 5000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const version = /^[0-9a-f]{16}$/;
const fail = (): never => { throw new Error("catalog_operational_links_unavailable"); };

// The view owns source/approval/revision validity. Never filter unverifiable open
// edges away: absence must not masquerade as a certified inventory or a deletion.
const readLinks = `
SELECT TOP (5001)
  CONVERT(varchar(20),e.link_key) AS link_key, LOWER(CONVERT(char(36),e.link_id)) AS link_id,
  LOWER(CONVERT(char(36),ci.customer_id)) AS catalog_customer_id, e.portal_environment,
  c.source_id AS customer_id,c.name AS customer_name,d.source_id AS domain_id,d.domain_name,
  db.source_id AS database_id,db.company_name AS database_name,e.target_kind,e.link_environment,
  CONVERT(varchar(11),e.source_record_id) AS catalog_record_id,e.evidence_state,
  CASE WHEN e.evidence_state='verified' THEN LOWER(CONVERT(char(36),e.catalog_source_id)) END AS catalog_source_id,
  CASE WHEN e.evidence_state='verified' THEN CONVERT(varchar(20),e.revision_key) END AS revision_id,
  CASE WHEN e.evidence_state='verified' THEN LOWER(CONVERT(char(16),CONVERT(binary(8),e.binding_version),2)) END AS binding_version,
  CASE WHEN e.evidence_state='verified' THEN LOWER(CONVERT(char(16),CONVERT(binary(8),e.profile_version),2)) END AS profile_version,
  CASE WHEN e.evidence_state='verified' THEN e.verified_until END AS verified_until
FROM core.catalog_operational_link_evidence AS e
JOIN core.catalog_customer_ids AS ci ON ci.catalog_customer_key=e.catalog_customer_key
JOIN core.clients AS c ON c.client_key=e.client_key
JOIN core.domains AS d ON d.domain_key=e.domain_key AND d.client_key=e.client_key
LEFT JOIN core.databases AS db ON db.database_key=e.database_key
  AND db.client_key=e.client_key AND db.domain_key=e.domain_key
WHERE e.portal_environment COLLATE Latin1_General_100_BIN2=@portalEnvironment
  AND DATALENGTH(e.portal_environment)=DATALENGTH(@portalEnvironment)
  AND e.retired_at IS NULL AND e.owner_retired_at IS NULL
ORDER BY e.link_key;
`.trim();

function canonicalUuid(value: unknown): string {
  return typeof value === "string" && value.length === 36 && uuid.test(value) ? value : fail();
}

function stableId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 150
    && value === value.trim() && !/\p{C}/u.test(value) ? value : fail();
}

function label(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && value.trim().length > 0 && !/\p{C}/u.test(value) ? value : fail();
}

function positiveBigint(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !/^[1-9][0-9]{0,18}$/.test(value)
    || BigInt(value) > 9223372036854775807n) return fail();
  return value;
}

function recordId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !/^(?:0|-?[1-9][0-9]{0,9})$/.test(value)
    || Number(value) < -2147483648 || Number(value) > 2147483647) return fail();
  return value;
}

function evidence(row: Record<string, unknown>, now: number): OperationalEvidence {
  const { evidence_state: state, catalog_source_id: source, revision_id: revision,
    binding_version: binding, profile_version: profile, verified_until: until } = row;
  if (state === "unverifiable") {
    if ([source, revision, binding, profile, until].some(value => value !== null)) return fail();
    return { state };
  }
  if (state !== "verified" || typeof binding !== "string" || binding.length !== 16 || !version.test(binding)
    || typeof profile !== "string" || profile.length !== 16 || !version.test(profile) || !(until instanceof Date)
    || !Number.isFinite(until.valueOf()) || until.valueOf() <= now) return fail();
  return { state, sourceId: canonicalUuid(source), revisionId: positiveBigint(revision),
    bindingVersion: binding, profileVersion: profile, verifiedUntil: until.toISOString() };
}

/**
 * Server-internal bounded read of migration 042 evidence, not population certification.
 * No caller authorization, completeness claim, physical proof or license inference is
 * performed here. Future consumers must authorize/filter and freshly verify those
 * independent boundaries before planning or executing work. Never expose this array
 * directly through HTTP. Open but unverifiable edges remain explicit in the result.
 */
export async function readSqlCatalogOperationalLinks(input: {
  portalEnvironment: CatalogEnvironment;
}): Promise<CatalogOperationalLink[]> {
  if (input.portalEnvironment !== "qa" && input.portalEnvironment !== "production") return fail();
  try {
    const pool = await getSqlPool();
    const { recordset } = await pool.request()
      .input("portalEnvironment", sql.VarChar(10), input.portalEnvironment)
      .query<Record<string, unknown>>(readLinks);
    if (!Array.isArray(recordset) || recordset.length > maxLinks) return fail();
    const seen = new Set<string>();
    let previousKey = 0n;
    const now = Date.now();
    return recordset.map(row => {
      const key = BigInt(positiveBigint(row.link_key));
      const linkId = canonicalUuid(row.link_id);
      if (key <= previousKey || seen.has(linkId) || row.portal_environment !== input.portalEnvironment) return fail();
      previousKey = key;
      seen.add(linkId);
      const environment = row.link_environment;
      if (environment !== "production" && environment !== "test" && environment !== "demo") return fail();
      const common = { linkId, catalogCustomerId: canonicalUuid(row.catalog_customer_id),
        customerId: stableId(row.customer_id), customerName: label(row.customer_name, 200),
        domainId: stableId(row.domain_id), domainName: label(row.domain_name, 500),
        catalogRecordId: recordId(row.catalog_record_id), environment, evidence: evidence(row, now) } as const;
      if (row.target_kind === "domain" && row.database_id === null && row.database_name === null) {
        return { ...common, kind: "domain" };
      }
      if (row.target_kind === "database") {
        return { ...common, kind: "database", databaseId: stableId(row.database_id), databaseName: label(row.database_name, 240) };
      }
      return fail();
    });
  } catch {
    return fail();
  }
}
