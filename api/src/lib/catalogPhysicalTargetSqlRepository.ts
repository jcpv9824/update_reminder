import sql from "mssql";
import type { Environment } from "../types/models";
import { catalogDomainRouteFingerprintSql } from "./catalogPhysicalTargetIdentity";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { planCatalogTaskTargets, type CatalogTaskLink } from "./catalogTaskTargetPlanning";
import { getSqlPool } from "./sql";

type RequestedLink = Readonly<{
  customerId: string;
  domainId: string;
  environment: Environment;
}> & ({ kind: "domain"; databaseId?: never } | { kind: "database"; databaseId: string });

type ResolvedTarget = CatalogTaskLink["target"];
type ResolvedTargetPins = Exclude<ResolvedTarget, { status: "verified" }>
  | (Extract<ResolvedTarget, { status: "verified" }> & { physicalLinkId: string });
type ReadInput = { portalEnvironment: CatalogEnvironment; links: readonly RequestedLink[] };
type Resolver = typeof readSqlCatalogPhysicalTargets;
const maxLinks = 5000;
const opaqueId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const allowedEnvironments = new Set<Environment>(["production", "demo", "test"]);
const validSourceId = (id: string) => typeof id === "string" && id.length >= 1 && id.length <= 150
  && id === id.trim() && !/\p{C}/u.test(id);
const fail = (): never => { throw new Error("catalog_physical_inventory_unavailable"); };

const readTargets = (withPins: boolean) => `
WITH wanted AS (
  SELECT CONVERT(int,[key]) AS ordinal,
    JSON_VALUE([value],'$.kind') COLLATE Latin1_General_100_BIN2 AS target_kind,
    JSON_VALUE([value],'$.environment') AS link_environment,
    JSON_VALUE([value],'$.customerId') AS client_id, JSON_VALUE([value],'$.domainId') AS domain_id,
    JSON_VALUE([value],'$.databaseId') AS database_id
  FROM OPENJSON(@requestedLinks)
)
SELECT w.ordinal, ready.target_status,
  CASE WHEN ready.target_status='verified' THEN LOWER(CONVERT(char(36),t.target_id)) END AS physical_id${withPins ? `,
  CASE WHEN ready.target_status='verified' THEN LOWER(CONVERT(char(36),l.link_id)) END AS physical_link_id` : ""}
FROM wanted w
LEFT JOIN core.clients c ON c.source_id=w.client_id AND c.source_id COLLATE Latin1_General_100_BIN2=w.client_id COLLATE Latin1_General_100_BIN2
LEFT JOIN core.domains d ON d.client_key=c.client_key AND d.source_id=w.domain_id
  AND d.source_id COLLATE Latin1_General_100_BIN2=w.domain_id COLLATE Latin1_General_100_BIN2
LEFT JOIN core.databases db ON w.target_kind='database' AND db.client_key=c.client_key
  AND db.domain_key=d.domain_key AND db.source_id=w.database_id
  AND db.source_id COLLATE Latin1_General_100_BIN2=w.database_id COLLATE Latin1_General_100_BIN2
LEFT JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key
LEFT JOIN core.catalog_physical_target_links l ON l.portal_environment=@portalEnvironment AND l.target_kind=w.target_kind
  AND l.client_key=c.client_key AND l.domain_key=d.domain_key AND l.retired_at IS NULL
  AND ((w.target_kind='domain' AND l.database_key IS NULL) OR (w.target_kind='database' AND l.database_key=db.database_key))
LEFT JOIN core.catalog_physical_targets t ON t.physical_target_key=l.physical_target_key
  AND t.portal_environment=@portalEnvironment AND t.target_kind=w.target_kind
CROSS APPLY (VALUES (CASE
  WHEN c.client_key IS NULL OR c.status='deleted' OR d.domain_key IS NULL OR d.status='deleted'
    OR (w.target_kind='database' AND (db.database_key IS NULL OR db.status='deleted')) THEN 'not_found'
  WHEN t.target_id IS NOT NULL AND l.verified_at<=@now AND l.valid_until>@now
    AND c.status='active' AND d.status='active'
    AND ((w.target_kind='domain' AND d.environment_id=w.link_environment AND
      l.domain_route_fingerprint=${catalogDomainRouteFingerprintSql})
      OR (w.target_kind='database' AND db.status='active' AND db.environment_id=w.link_environment AND p.active=1
        AND l.access_profile_key=p.access_profile_key AND l.access_profile_version=p.row_version
        AND t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.initial_catalog))))
    THEN 'verified'
  ELSE 'unverifiable' END)) AS ready(target_status)
ORDER BY w.ordinal;
`.trim();

/** Internal. The caller must restrict requested links to a trusted, authorized catalogue selection. */
export function readSqlCatalogPhysicalTargets(input: ReadInput): Promise<ResolvedTarget[]> {
  return readWithRequest(input, async () => (await getSqlPool()).request());
}

/** Same trusted input; the caller retains ownership of the existing SQL transaction. */
export function readSqlCatalogPhysicalTargetsInTransaction(
  transaction: sql.Transaction,
  input: Parameters<typeof readSqlCatalogPhysicalTargets>[0],
): ReturnType<typeof readSqlCatalogPhysicalTargets> {
  return readWithRequest(input, () => transaction.request());
}

/** Server-only proof input: never forward the link ID as part of a plan or public DTO. */
export function readSqlCatalogPhysicalTargetPinsInTransaction(
  transaction: sql.Transaction, input: ReadInput,
): Promise<ResolvedTargetPins[]> {
  return readWithRequest(input, () => transaction.request(), true);
}

type MakeRequest = () => sql.Request | Promise<sql.Request>;
function readWithRequest(input: ReadInput, request: MakeRequest): Promise<ResolvedTarget[]>;
function readWithRequest(input: ReadInput, request: MakeRequest, withPins: true): Promise<ResolvedTargetPins[]>;
async function readWithRequest(input: ReadInput, request: MakeRequest, withPins = false): Promise<ResolvedTarget[]> {
  if (!["qa", "production"].includes(input.portalEnvironment) || input.links.length > maxLinks) fail();
  if (!input.links.length) return [];
  const links = input.links.map(link => {
    if (!validSourceId(link.customerId) || !validSourceId(link.domainId) || !allowedEnvironments.has(link.environment)
      || (link.kind === "domain" ? link.databaseId !== undefined : link.kind !== "database" || !validSourceId(link.databaseId))) fail();
    return { customerId: link.customerId, domainId: link.domainId, environment: link.environment,
      kind: link.kind, ...(link.kind === "database" ? { databaseId: link.databaseId } : {}) };
  });
  try {
    const result = await (await request())
      .input("portalEnvironment", sql.VarChar(10), input.portalEnvironment)
      .input("requestedLinks", sql.NVarChar(sql.MAX), JSON.stringify(links))
      .query<{ ordinal: number; target_status: string; physical_id: string | null; physical_link_id?: string | null }>(
        `DECLARE @now datetime2(3)=SYSUTCDATETIME();\n${readTargets(withPins)}`,
      );
    if (result.recordset.length !== links.length) fail();
    return result.recordset.map(({ ordinal, target_status: status, physical_id: id, physical_link_id: physicalLinkId }, index): ResolvedTarget | ResolvedTargetPins => {
      if (index !== ordinal) return fail();
      if (status === "verified" && typeof id === "string" && opaqueId.test(id)) {
        if (!withPins) return { status, id };
        const nil = "00000000-0000-0000-0000-000000000000";
        if (id === nil || typeof physicalLinkId !== "string" || !opaqueId.test(physicalLinkId) || physicalLinkId === nil) return fail();
        return { status, id, physicalLinkId };
      }
      if ((status === "unverifiable" || status === "not_found") && id === null && (!withPins || physicalLinkId === null)) return { status };
      return fail();
    });
  } catch {
    return fail();
  }
}

/** Replace the untrusted/old target projection, then filter logical scope and group by verified physical ID. */
export async function planCatalogTasksWithVerifiedTargets(
  portalEnvironment: CatalogEnvironment,
  input: Parameters<typeof planCatalogTaskTargets>[0],
  resolve: Resolver = readSqlCatalogPhysicalTargets,
): Promise<ReturnType<typeof planCatalogTaskTargets>> {
  if (!input.revision.complete) return planCatalogTaskTargets(input);
  const targets = await resolve({ portalEnvironment, links: input.links });
  if (targets.length !== input.links.length) return fail();
  return planCatalogTaskTargets({
    ...input, links: input.links.map((link, index) => ({ ...link, target: targets[index] })),
  });
}
