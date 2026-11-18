import { readSqlCatalogOperationalLinks, type CatalogOperationalLink } from "./catalogOperationalLinksSqlRepository";
import { generateCatalogScheduleDay, type CatalogScheduleDay } from "./catalogScheduleDay";
import { generateCatalogPersistedScheduleDay } from "./catalogScheduleScopes";
import type { CatalogExecutionSourceEvidence } from "./catalogExecutionRegistrationSqlRepository";
import { readSqlCatalogScheduleOperationApprovals } from "./catalogScheduleOperationApprovalSqlRepository";
import { readSqlCatalogScheduleRoster } from "./schedulingSqlRepository";
import { readCatalogScheduleLicenseProof } from "./catalogScheduleLicenseProof";
import { readSqlCatalogSchedulePopulationCoverage } from "./catalogSchedulePopulationCoverage";

type SourceWitness = CatalogExecutionSourceEvidence;
type InventoryRow = CatalogScheduleDay["inventory"][number];
type PersistedDay = Parameters<typeof generateCatalogPersistedScheduleDay>[0];
type OperationalDay = Omit<PersistedDay, "revision" | "inventory">;

export type CatalogInventoryProofScope = Readonly<{
  portalEnvironment: OperationalDay["portalEnvironment"];
  date: string;
  checkedAt: Date;
  links: readonly CatalogOperationalLink[];
}>;

export type CatalogScheduleInventoryDependencies = {
  readLinks?: typeof readSqlCatalogOperationalLinks;
  /**
   * Mandatory server-trusted certification of the complete population represented by
   * this exact scope, not a browser claim or an inference from a bounded SQL listing.
   * Must account for missing sources/edges and return complete=false when uncertain.
   */
  certifyCoverage: (scope: CatalogInventoryProofScope) => Promise<CatalogScheduleDay["revision"]>;
  /**
   * Independent server-trusted license proof for these exact logical links. The provider
   * must check customer/target/environment and current license-mapping provenance.
   * Missing entries/null are unknown; [] means proven absence, never a query failure.
   */
  readLicenseProof?: (scope: CatalogInventoryProofScope) => Promise<ReadonlyMap<string, readonly string[] | null>>;
  /** Tests/internal composition only; normal execution uses the existing persisted generator. */
  persisted?: Parameters<typeof generateCatalogPersistedScheduleDay>[1];
};

const fail = (): never => { throw new Error("catalog_schedule_inventory_unverified"); };
const text = (value: unknown, max = 150): value is string => typeof value === "string"
  && value.length > 0 && value.length <= max && value === value.trim() && !/\p{C}/u.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && value.length === 36
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const version = (value: unknown): value is string => typeof value === "string" && value.length === 16
  && /^[0-9a-f]{16}$/.test(value);

function witness(link: CatalogOperationalLink, checkedAt: Date): SourceWitness | undefined {
  if (link.evidence.state === "unverifiable") return undefined;
  const proof = link.evidence;
  if (proof.state !== "verified" || !uuid(proof.sourceId) || !text(proof.revisionId, 19)
    || !/^[1-9][0-9]*$/.test(proof.revisionId) || BigInt(proof.revisionId) > 9223372036854775807n
    || !version(proof.bindingVersion) || !version(proof.profileVersion)
    || typeof proof.verifiedUntil !== "string" || !Number.isFinite(Date.parse(proof.verifiedUntil))) return fail();
  // A once-verified observation may expire between SQL read and composition. Keep
  // the edge as a hold, never downgrade its origin to a registrable local source.
  if (Date.parse(proof.verifiedUntil) <= Math.max(checkedAt.valueOf(), Date.now())) return undefined;
  return { sourceId: proof.sourceId, revisionId: proof.revisionId, bindingVersion: proof.bindingVersion,
    profileVersion: proof.profileVersion, verifiedUntil: proof.verifiedUntil };
}

/**
 * Lossless logical-edge adaptation only. Does not grant coverage, physical identity
 * or licenses. sourceId=null is used ONLY with state=unverifiable as a nonregistrable
 * hold here; it never denotes local authorization for a migration-042 external edge.
 */
export function composeCatalogScheduleInventory(
  links: readonly CatalogOperationalLink[],
  modulesByLink: ReadonlyMap<string, readonly string[] | null>,
  checkedAt: Date,
): InventoryRow[] {
  if (!Array.isArray(links) || links.length > 5000 || !(checkedAt instanceof Date)
    || !Number.isFinite(checkedAt.valueOf()) || !(modulesByLink instanceof Map)) return fail();
  const ids = new Set<string>();
  for (const link of links) {
    if (!uuid(link.linkId) || ids.has(link.linkId) || !uuid(link.catalogCustomerId)
      || !text(link.customerId) || !text(link.domainId)
      || !["production", "test", "demo"].includes(link.environment)
      || !text(link.catalogRecordId, 11) || !/^(?:0|-?[1-9][0-9]*)$/.test(link.catalogRecordId)
      || Number(link.catalogRecordId) < -2147483648 || Number(link.catalogRecordId) > 2147483647
      || (link.kind !== "domain" && link.kind !== "database")
      || (link.kind === "database" && !text(link.databaseId))) return fail();
    ids.add(link.linkId);
  }
  if ([...modulesByLink.keys()].some(id => !ids.has(id))) return fail();
  return links.map(link => {
    const sourceEvidence = witness(link, checkedAt);
    const modules = modulesByLink.get(link.linkId) ?? null;
    if (modules !== null && (!Array.isArray(modules) || modules.length > 128
      || modules.some(id => !text(id)) || new Set(modules).size !== modules.length)) return fail();
    const common = { linkId: link.linkId, customerId: link.customerId, domainId: link.domainId,
      catalogRecordId: link.catalogRecordId, environment: link.environment,
      state: sourceEvidence ? "active" as const : "unverifiable" as const,
      moduleIds: modules === null ? null : [...modules], target: { status: "unverifiable" as const } };
    return {
      link: link.kind === "database" ? { ...common, kind: "database", databaseId: link.databaseId }
        : { ...common, kind: "domain" },
      sourceId: sourceEvidence?.sourceId ?? null,
      ...(sourceEvidence ? { sourceEvidence } : {}),
      clientName: link.customerName, domainName: link.domainName,
      targetName: link.kind === "database" ? link.databaseName : link.domainName,
    };
  });
}

/**
 * Internal composition entry point; never bind to HTTP/timers without separate
 * authorization and complete coverage/licensing certification. All planning,
 * persisted scope handling, physical proof and writes remain in the existing engine.
 */
export async function generateCatalogOperationalScheduleDay(
  input: OperationalDay,
  io: CatalogScheduleInventoryDependencies,
): ReturnType<typeof generateCatalogPersistedScheduleDay> {
  if (!(input.checkedAt instanceof Date) || !Number.isFinite(input.checkedAt.valueOf())
    || !(input.cutoffAt instanceof Date) || !Number.isFinite(input.cutoffAt.valueOf())) return fail();
  if (input.checkedAt >= input.cutoffAt) {
    // Preserve the existing engine's cutoff semantics without reading/certifying
    // a population that cannot generate work. This neutral revision is incomplete.
    return generateCatalogPersistedScheduleDay({ ...input,
      revision: { id: "cutoff-not-certified", complete: false }, inventory: [] }, io.persisted);
  }
  const links = await (io.readLinks ?? readSqlCatalogOperationalLinks)({ portalEnvironment: input.portalEnvironment });
  // Validate source evidence before asking other proof services or generating work.
  const inventory = composeCatalogScheduleInventory(links, new Map(), input.checkedAt);
  const scope: CatalogInventoryProofScope = { portalEnvironment: input.portalEnvironment, date: input.date,
    checkedAt: input.checkedAt, links };
  const revision = await io.certifyCoverage(scope);
  if (!revision || !text(revision.id, 200) || typeof revision.complete !== "boolean") return fail();
  if (!revision.complete) {
    return generateCatalogPersistedScheduleDay({ ...input, revision, inventory }, io.persisted);
  }
  const modulesByLink = io.readLicenseProof ? await io.readLicenseProof(scope)
    : input.matchKeyVersion === undefined ? new Map<string, readonly string[] | null>()
      : await readCatalogScheduleLicenseProof({ ...scope, matchKeyVersion: input.matchKeyVersion });
  return generateCatalogPersistedScheduleDay({ ...input, revision,
    inventory: composeCatalogScheduleInventory(links, modulesByLink, input.checkedAt) }, io.persisted);
}

/**
 * Use only SQL-approved operations for the same roster that the planner will compile.
 * Neither callers nor an HTTP request can supply an operation map in this entry point.
 * The real runtime still needs certified coverage and versioned licensing authorization.
 */
export async function generateApprovedCatalogOperationalScheduleDay(
  input: Omit<OperationalDay, "operationsBySchedule">,
  io: Omit<CatalogScheduleInventoryDependencies, "certifyCoverage"> &
    Partial<Pick<CatalogScheduleInventoryDependencies, "certifyCoverage">> &
    { readOperations?: typeof readSqlCatalogScheduleOperationApprovals } = {},
): ReturnType<typeof generateCatalogPersistedScheduleDay> {
  if (!(input.checkedAt instanceof Date) || !Number.isFinite(input.checkedAt.valueOf())
    || !(input.cutoffAt instanceof Date) || !Number.isFinite(input.cutoffAt.valueOf())) return fail();
  const dependencies: CatalogScheduleInventoryDependencies = {
    ...io, certifyCoverage: io.certifyCoverage ?? readSqlCatalogSchedulePopulationCoverage,
  };
  if (input.checkedAt >= input.cutoffAt) {
    return generateCatalogOperationalScheduleDay({ ...input, operationsBySchedule: new Map() }, dependencies);
  }
  const roster = await (io.persisted?.readRoster ?? readSqlCatalogScheduleRoster)(input.date);
  const operationsBySchedule = await (io.readOperations ?? readSqlCatalogScheduleOperationApprovals)(
    input.portalEnvironment, roster.map(({ schedule, version }) => ({ scheduleId: schedule.id, scheduleVersion: version })),
  );
  return generateCatalogOperationalScheduleDay({ ...input, operationsBySchedule }, { ...dependencies, persisted: {
    readRoster: async () => roster,
    generate: io.persisted?.generate ?? generateCatalogScheduleDay,
  } });
}
