import { createHash, randomUUID } from "node:crypto";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import sql from "mssql";
import { z } from "zod";
import { readSqlCatalogOperationalLinks, type CatalogOperationalLink } from "./catalogOperationalLinksSqlRepository";
import { readSqlCatalogScheduleRoster } from "./schedulingSqlRepository";
import { readSqlCatalogManualDayIntents } from "./catalogManualDayIntentSqlRepository";
import { readAuthorizedCatalogSourceIds } from "./catalogSourceAccessSqlRepository";
import { readSqlCatalogSchedulePopulationCoverage } from "./catalogSchedulePopulationCoverage";
import { readCatalogOperationalScheduleDayEvidence } from "./catalogScheduleInventory";
import { catalogScheduleRosterToken } from "./catalogScheduleActivation";
import { previewCatalogScheduleDay, withCatalogScheduleDayPreview, type CatalogScheduleRule } from "./catalogScheduleDay";
import { isCatalogScheduleChoiceDomain, isCatalogScheduleChoiceModule, isCatalogScheduleChoiceUuid } from "./catalogScheduleChoices";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSqlPool } from "./sql";
import { catalogCopyOpaqueId, issueCatalogCopyIntent, validateCatalogCopySelection } from "./catalogScheduleCopyIntent";
import { inferScheduleRole } from "./scheduleService";
import { catalogSagPositiveLicenseRevisionSql } from "./catalogSagPositiveLicenseSql";

const environment = z.enum(["all", "production", "test", "demo"]);
const target = z.enum(["domain", "database", "both"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const shape = { environment, target, date };
export const catalogDraftScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...shape, mode: z.literal("manual"), customerId: z.string().refine(isCatalogScheduleChoiceUuid),
    domainChoiceId: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.strictObject({ ...shape, mode: z.literal("licensing"), moduleCode: z.string().refine(isCatalogScheduleChoiceModule) }),
]);
export type DraftCatalogScope = z.infer<typeof catalogDraftScopeSchema>;
type Actor = { actorId: string; allowedKinds: readonly ("domain" | "database")[]; allowLicensing: boolean };
export type DraftCatalogRequest = Actor & { scope: DraftCatalogScope; portalEnvironment: CatalogEnvironment; matchKeyVersion: number; checkedAt: Date };
const hourMs = 3_600_000;
const kindsOf = (scope: DraftCatalogScope) => scope.target === "both" ? ["domain", "database"] as const : [scope.target];

export function catalogDraftDomainChoiceId(customerId: string, hostname: string, env: string) {
  return createHash("sha256").update(`catalog-schedule-choice:domain:${customerId}:${hostname}:${env}`, "utf16le").digest("hex");
}
function safeHostname(value: string): string | null {
  const route = /^(?:https:\/\/)?([A-Za-z0-9.-]{3,253})\/?$/i.exec(value.trim());
  const host = route?.[1]?.toLowerCase();
  return host && isCatalogScheduleChoiceDomain(host) ? host : null;
}

/** Same 041 version constraints as the operational licensing proof, not an observed code-to-name guess. */
async function readApprovedDraftModuleMapping(portalEnvironment: CatalogEnvironment, matchKeyVersion: number,
  selector: { code: string } | { moduleId: string }) {
  const code = "code" in selector ? selector.code : null;
  const moduleId = "moduleId" in selector ? selector.moduleId : null;
  const { recordset } = await (await getSqlPool()).request().input("env", sql.VarChar(10), portalEnvironment)
    .input("key", sql.SmallInt, matchKeyVersion).input("code", sql.VarChar(1), code)
    .input("moduleId", sql.NVarChar(150), moduleId).query<{ id: string; code: string }>(`
      DECLARE @now datetime2(3)=SYSUTCDATETIME();
      SELECT TOP (2) m.source_id AS id,a.sag_code AS code
      FROM settings.catalog_source_bindings b
      JOIN settings.external_database_connections p ON p.external_database_connection_key=b.external_database_connection_key
        AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1 AND p.row_version=b.validated_profile_version
      JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key
      JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key
        AND r.catalog_source_key=b.catalog_source_key AND r.source_role=b.source_role AND r.attempt_ordinal=h.attempt_ordinal
      JOIN settings.catalog_sag_license_module_approvals a ON a.catalog_source_key=b.catalog_source_key
        AND a.binding_version=b.row_version AND a.profile_version=p.row_version AND a.approved_at<=@now
      JOIN licensing.license_modules m ON m.module_key=a.module_key AND m.status='active' AND m.deleted_at IS NULL
      WHERE b.portal_environment=@env AND b.source_role='sag-admin' AND b.source_state='active'
        AND (@code IS NULL OR a.sag_code=@code)
        AND (@moduleId IS NULL OR (m.source_id COLLATE Latin1_General_100_BIN2=@moduleId AND DATALENGTH(m.source_id)=DATALENGTH(@moduleId)))
        AND ${catalogSagPositiveLicenseRevisionSql} AND b.validated_at<=@now
        AND h.attempt_status='succeeded' AND h.attempted_at<=@now AND r.binding_version=b.row_version AND r.profile_version=p.row_version
        AND r.match_key_version=@key AND r.verified_until>@now AND r.observed_at<=@now AND r.sealed_at<=@now
        AND r.has_sag_inventory_evidence=1
        AND (SELECT COUNT(*) FROM settings.catalog_source_bindings WHERE portal_environment=@env
          AND source_role='sag-admin' AND source_state='active')=1;`);
  return recordset.length === 1 && typeof recordset[0].id === "string" && recordset[0].id.trim() === recordset[0].id
    && recordset[0].id.length <= 150 && recordset[0].id.length > 0 &&
    isCatalogScheduleChoiceModule(recordset[0].code) ? recordset[0] : null;
}
const readApprovedDraftModule = async (environment: CatalogEnvironment, version: number, code: string) =>
  (await readApprovedDraftModuleMapping(environment, version, { code }))?.id ?? null;
export const findApprovedDraftModuleCode = async (environment: CatalogEnvironment, version: number, moduleId: string) =>
  (await readApprovedDraftModuleMapping(environment, version, { moduleId }))?.code ?? null;

export type DraftCatalogPreview = Readonly<{ previewId?: string; coverage: "verified" | "partial"; groups: readonly {
  id: string; kind: "domain" | "database"; label: string;
  state: "ready" | "reserved"; links: readonly { id: string; customerName: string; environment: string }[];
}[] }>;
const dependencies = () => ({ links: readSqlCatalogOperationalLinks, roster: readSqlCatalogScheduleRoster,
  intents: readSqlCatalogManualDayIntents, sources: readAuthorizedCatalogSourceIds,
  certify: readSqlCatalogSchedulePopulationCoverage, evidence: readCatalogOperationalScheduleDayEvidence,
  preview: previewCatalogScheduleDay, module: readApprovedDraftModule,
  secret: () => process.env.JWT_SECRET ?? "" });
type Dependencies = ReturnType<typeof dependencies>;

async function prepareCatalogDraft(input: DraftCatalogRequest, io: Omit<Dependencies, "secret">) {
  const { scope, portalEnvironment, matchKeyVersion, actorId, checkedAt } = input;
  const cutoffAt = new Date(Date.parse(scope.date) + 29 * hourMs);
  const kinds = kindsOf(scope);
  if (!Number.isFinite(checkedAt.valueOf()) || checkedAt >= cutoffAt ||
      kinds.some(kind => !input.allowedKinds.includes(kind)) || (scope.mode === "licensing" && !input.allowLicensing)) return null;
  const needModule = scope.mode === "licensing";
  const [links, roster, manualIntents, sources, module] = await Promise.all([
    io.links({ portalEnvironment }), io.roster(scope.date), io.intents({ date: scope.date, portalEnvironment }),
    io.sources({ actorId, environment: portalEnvironment }),
    scope.mode === "licensing" ? io.module(portalEnvironment, matchKeyVersion, scope.moduleCode) : Promise.resolve(null),
  ]);
  if (needModule && !module) return null;
  const day = await io.evidence({ date: scope.date, portalEnvironment, matchKeyVersion, checkedAt, cutoffAt,
    activeLicenseIds: new Set(module ? [module] : []), operationsBySchedule: new Map() },
  { readLinks: async () => links, certifyCoverage: io.certify,
    populationRoster: new Map(roster.map(row => [row.schedule.id, catalogScheduleRosterToken(row)])), manualIntents });
  if (!day.revision.complete || !day.populationFence) return null;
  const eligibleSources = (link: CatalogOperationalLink) => link.evidence.state === "verified" && sources.has(link.evidence.sourceId);
  const matching = links.filter(link => eligibleSources(link) && kinds.includes(link.kind) &&
    (scope.environment === "all" || scope.environment === link.environment) &&
    (scope.mode === "licensing" || (scope.customerId === link.catalogCustomerId &&
      (!scope.domainChoiceId || (() => {
        const hostname = safeHostname(link.domainName);
        return hostname !== null && scope.domainChoiceId === catalogDraftDomainChoiceId(link.catalogCustomerId, hostname, link.environment);
      })()))));
  const parentKeys = new Set(links.filter(link => link.kind === "domain" && eligibleSources(link))
    .map(link => JSON.stringify([link.customerId, link.domainId, link.environment])));
  const hasParent = (link: CatalogOperationalLink) => link.kind === "domain" || parentKeys.has(JSON.stringify([link.customerId, link.domainId, link.environment]));
  const eligible = matching.filter(hasParent);
  if (scope.mode === "manual" && !eligible.length) return null;
  const eligibleLinkIds = new Set(eligible.map(link => link.linkId));
  const provisional = `draft-${randomUUID()}`;
  const rules: CatalogScheduleRule[] = kinds.map(kind => ({
    calendar: { id: provisional, startDate: scope.date, frequencyType: "once", active: true, timezone: "America/Bogota", version: "0000000000000001" },
    operationId: provisional, workflowRole: inferScheduleRole(kind), assignment: { kind: "role", id: inferScheduleRole(kind) },
    scope: { kind, linkIds: eligible.filter(row => row.kind === kind).map(row => row.linkId),
      ...(module && { modules: { mode: "all", ids: [module] } }) },
  }));
  return { day: { ...day, previewActorId: actorId, rules }, module, eligible, eligibleLinkIds,
    partial: eligible.length !== matching.length };
}
type PreparedDraft = NonNullable<Awaited<ReturnType<typeof prepareCatalogDraft>>>;
type ComputedDraft = NonNullable<Awaited<ReturnType<typeof previewCatalogScheduleDay>>>;

function draftAuthority(input: DraftCatalogRequest, prepared: PreparedDraft, computed: ComputedDraft) {
  const scope = input.scope;
  const identity = createHash("sha256").update(JSON.stringify([scope.mode, scope.target, scope.environment, scope.date,
    scope.mode === "manual" ? [scope.customerId, scope.domainChoiceId ?? null] : [scope.moduleCode, prepared.module]])).digest("hex");
  return { ...computed, scheduleId: `new-draft-${identity}`, scheduleVersion: "0000000000000001", operationId: "catalog-draft-intent-v1",
    actorId: input.actorId, environment: input.portalEnvironment, date: input.scope.date, revisionId: prepared.day.revision.id,
    coverage: computed.coverage === "partial" || prepared.partial ? "partial" as const : "verified" as const };
}

export async function previewNewCatalogSchedule(input: DraftCatalogRequest,
  io: Omit<Dependencies, "secret"> & Partial<Pick<Dependencies, "secret">> = dependencies()): Promise<DraftCatalogPreview | null> {
  const prepared = await prepareCatalogDraft(input, io);
  if (!prepared) return null;
  const computed = await io.preview(prepared.day);
  if (!computed) return null;
  const authority = draftAuthority(input, prepared, computed);
  const { previewId, nonce: runId } = io.secret ? issueCatalogCopyIntent(io.secret(), input.checkedAt, authority)
    : { previewId: undefined, nonce: randomUUID() };
  const byLink = new Map(prepared.day.inventory.map(row => [row.link.linkId, row]));
  const groups = new Map<string, DraftCatalogPreview["groups"][number] & { links: { id: string; customerName: string; environment: string }[] }>();
  for (const candidate of computed.candidates) {
    if (candidate.state === "unverifiable" || !candidate.targetId) continue;
    const row = byLink.get(candidate.linkId);
    if (!row || !prepared.eligibleLinkIds.has(candidate.linkId) || row.link.kind !== candidate.kind ||
        !row.clientName || row.clientName.length > 512 || /\p{C}|(?:password|pwd|initial catalog|data source)\s*=/iu.test(row.clientName)) return null;
    const label = candidate.kind === "domain" ? safeHostname(row.domainName) : row.targetName;
    if (!label || label.length > 512 || /\p{C}|(?:password|pwd|initial catalog|data source)\s*=/iu.test(label)) return null;
    const kind = candidate.kind;
    const id = catalogCopyOpaqueId(runId, kind, candidate.targetId);
    const group = groups.get(id) ?? { id, kind, label, state: "ready", links: [] };
    group.links.push({ id: catalogCopyOpaqueId(runId, "link", candidate.linkId), customerName: row.clientName, environment: row.link.environment });
    groups.set(id, { ...group,
      state: candidate.state === "conflict" || group.state === "reserved" ? "reserved" : "ready" });
  }
  return { ...(previewId && { previewId }), coverage: authority.coverage, groups: [...groups.values()] };
}

/** Reopens the day locks and re-derives the scope before any durable proposal is written. */
export async function withVerifiedNewCatalogDraft<T>(input: DraftCatalogRequest & { previewId: string; linkIds: readonly string[] },
  save: (transaction: sql.Transaction, selection: Readonly<{
    intentId: string; moduleId: string | null; pins: readonly { linkId: string; kind: "domain" | "database"; physicalId: string; include: boolean }[];
    validUntil: Date;
  }>) => Promise<T>, io = { ...dependencies(), withPreview: withCatalogScheduleDayPreview, now: () => new Date() }): Promise<T | null> {
  const prepared = await prepareCatalogDraft(input, io);
  if (!prepared) return null;
  return io.withPreview(prepared.day, async (tx, computed, validUntil) => {
    const authority = draftAuthority(input, prepared, computed);
    const selected = validateCatalogCopySelection(io.secret(), io.now(), authority, input);
    if (!selected?.length || (input.scope.mode === "licensing" && authority.coverage !== "verified")) return null;
    const included = new Set(selected.map(link => link.linkId));
    // The licensed rule remains dynamic; store explicit exclusions by logical link.
    // A physical reservation is not an implicit exclusion or an authorization.
    const pins = authority.candidates.filter(link => input.scope.mode === "licensing" || included.has(link.linkId))
      .map(link => link.targetId && link.state !== "unverifiable" && prepared.eligibleLinkIds.has(link.linkId)
        ? { linkId: link.linkId, kind: link.kind, physicalId: link.targetId, include: included.has(link.linkId) } : null);
    if (!pins.length || pins.some(pin => pin === null)) return null;
    return save(tx, { intentId: input.previewId.split(".")[1], moduleId: prepared.module,
      pins: pins.filter(pin => pin !== null), validUntil });
  });
}

type StoredPin = { linkId: string; kind: "domain" | "database"; physicalId: string; include: boolean };

/** Recheck proposal bindings and reservations while holding the same locks used by execution. */
export async function withReprovedCatalogDraft<T>(input: DraftCatalogRequest,
  expected: { moduleId: string | null; pins: readonly StoredPin[] },
  use: (tx: sql.Transaction, proof: { links: readonly { linkId: string; kind: StoredPin["kind"]; physicalId: string;
    targetSourceId: string; customerId: string; customerName: string; domainId: string; domainName: string }[];
    validUntil: Date; tightenDeadline: (until: Date) => void }) => Promise<T>,
  io = { ...dependencies(), withPreview: withCatalogScheduleDayPreview }): Promise<T | null> {
  const prepared = await prepareCatalogDraft(input, io);
  if (!prepared || expected.moduleId !== prepared.module || !expected.pins.some(pin => pin.include)) return null;
  return io.withPreview(prepared.day, async (tx, computed, validUntil, tightenDeadline) => {
    const authority = draftAuthority(input, prepared, computed);
    // The reviewer sees a sealed licensed population. Changes since request must
    // be reviewed again. The activated rule can then track changes until start.
    if (input.scope.mode === "licensing" && (authority.coverage !== "verified" ||
        authority.candidates.length !== expected.pins.length)) return null;
    const byLink = new Map(prepared.eligible.map(link => [link.linkId, link]));
    const candidates = new Map(authority.candidates.map(candidate => [candidate.linkId, candidate]));
    const reserved = new Set(authority.candidates.filter(candidate => candidate.state === "conflict")
      .map(candidate => JSON.stringify([candidate.kind, candidate.targetId])));
    if (candidates.size !== authority.candidates.length || new Set(expected.pins.map(pin => pin.linkId)).size !== expected.pins.length) return null;
    const links = [];
    for (const pin of expected.pins) {
      const current = candidates.get(pin.linkId), link = byLink.get(pin.linkId);
      if (!current || !link || current.kind !== pin.kind || link.kind !== pin.kind || current.targetId !== pin.physicalId ||
          current.state === "unverifiable" || (pin.include && (current.state !== "ready" ||
            reserved.has(JSON.stringify([pin.kind, pin.physicalId])))) ||
          (input.scope.mode === "manual" && !pin.include)) return null;
      links.push({ linkId: pin.linkId, kind: link.kind, physicalId: pin.physicalId,
        targetSourceId: link.kind === "database" ? link.databaseId : link.domainId, customerId: link.customerId,
        customerName: link.customerName, domainId: link.domainId, domainName: link.domainName });
    }
    return use(tx, { links, validUntil, tightenDeadline });
  });
}

export function createNewCatalogSchedulePreviewHttp(io: {
  authorize: (req: HttpRequest) => Promise<Actor | { status: 401 | 403 }>;
  read: (input: Omit<DraftCatalogRequest, "portalEnvironment" | "matchKeyVersion">) => Promise<DraftCatalogPreview | null>;
  now?: () => Date;
}) {
  const reply = (status: number, jsonBody: unknown): HttpResponseInit => ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
  return async (req: HttpRequest) => {
    try {
      const actor = await io.authorize(req);
      if ("status" in actor) return reply(actor.status, { error: "No tiene acceso al alcance operativo." });
      const raw = await req.text();
      if (Buffer.byteLength(raw) > 4096) return reply(413, { error: "Solicitud demasiado grande." });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return reply(400, { error: "Indique un alcance válido." }); }
      const parsed = catalogDraftScopeSchema.safeParse(body);
      if (!parsed.success) return reply(400, { error: "Indique un alcance válido." });
      const scope = parsed.data;
      if (kindsOf(scope).some(kind => !actor.allowedKinds.includes(kind)) || (scope.mode === "licensing" && !actor.allowLicensing)) {
        return reply(403, { error: "No tiene acceso al alcance operativo." });
      }
      const checkedAt = io.now?.() ?? new Date(), today = new Date(checkedAt.valueOf() - 5 * hourMs).toISOString().slice(0, 10);
      if (scope.date < today || Date.parse(scope.date) - Date.parse(today) > 7 * 24 * hourMs) {
        return reply(400, { error: "Seleccione una fecha desde hoy hasta los próximos siete días." });
      }
      const result = await io.read({ ...actor, scope, checkedAt });
      return result ? reply(200, result) : reply(409, { error: "No se pudo verificar el alcance operativo." });
    } catch { return reply(503, { error: "No se pudo consultar el catálogo operativo." }); }
  };
}
