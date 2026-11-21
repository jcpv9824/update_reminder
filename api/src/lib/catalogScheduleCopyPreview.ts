import type sql from "mssql";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { previewCatalogScheduleDay, withCatalogScheduleDayPreview } from "./catalogScheduleDay";
import { catalogCopyOpaqueId, issueCatalogCopyIntent, validateCatalogCopySelection } from "./catalogScheduleCopyIntent";
import { compileCatalogScheduleScopes, compileExactCopyProposal } from "./catalogScheduleScopes";
import { catalogScheduleRosterToken } from "./catalogScheduleActivation";
import { readCatalogOperationalScheduleDayEvidence } from "./catalogScheduleInventory";
import { readSqlCatalogScheduleCopyOrigin, readSqlCatalogScheduleRoster } from "./schedulingSqlRepository";
import { readSqlCatalogSchedulePopulationCoverage } from "./catalogSchedulePopulationCoverage";
import { readSqlCatalogScheduleOperationApprovals } from "./catalogScheduleOperationApprovalSqlRepository";
import { readSqlCatalogManualDayIntents } from "./catalogManualDayIntentSqlRepository";
import { readActiveLicenseIds } from "./catalogGenerationRuntime";

const hour = 3_600_000;
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 150 &&
  id === id.trim() && !/[\p{C}/\\]/u.test(id);
const isoDate = (date: unknown): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
type PreviewRequest = { scheduleId: string; actorId: string; date: string; checkedAt: Date; portalEnvironment: CatalogEnvironment;
  matchKeyVersion: number; allowedKinds: readonly ("database" | "domain")[]; allowLicensing: boolean };
type ActorScope = Pick<PreviewRequest, "actorId" | "allowedKinds" | "allowLicensing">;
type PublicGroup = { kind: "domain" | "database"; physicalTargetId: string; label: string;
  conflict?: { id: string; reason: string }; links: { id: string; label: string; verified: boolean }[] };
export type PublicCopyPreview = { previewId: string; coverage: "verified" | "partial"; groups: PublicGroup[] };
const dependencies = () => ({ readRoster: readSqlCatalogScheduleRoster, readOrigin: readSqlCatalogScheduleCopyOrigin,
  readOperations: readSqlCatalogScheduleOperationApprovals,
  readIntents: readSqlCatalogManualDayIntents, licenses: () => readActiveLicenseIds(), evidence: readCatalogOperationalScheduleDayEvidence,
  preview: previewCatalogScheduleDay, secret: () => process.env.JWT_SECRET ?? "" });
type Dependencies = ReturnType<typeof dependencies>;

/** A new hypothetical scope based on an existing definition, with no inherited snapshot or provenance. */
async function prepareCatalogScheduleCopy(input: PreviewRequest, io: Dependencies) {
  const { date, scheduleId, actorId, portalEnvironment, checkedAt, matchKeyVersion } = input;
  if (!isoDate(date) || !validId(scheduleId) || !validId(actorId) || !Number.isFinite(checkedAt.getTime())) return null;
  const cutoffAt = new Date(Date.parse(date) + 29 * hour);
  if (checkedAt >= cutoffAt) return null;
  const roster = await io.readRoster(date);
  const original = roster.find(row => row.schedule.id === scheduleId) ?? await io.readOrigin(scheduleId, date);
  if (!original?.schedule.active || original.schedule.origin !== "special") return null;
  const { version, schedule } = original;
  if (schedule.selectionMode === "licensing" && !input.allowLicensing) return null;
  const kinds = schedule.selectionMode === "licensing" ? schedule.licensingScope?.targetTypes
    : schedule.scopeGroups?.length ? schedule.manualTargetTypes ?? "domains_and_databases" : undefined;
  const required = kinds === "domains_only" ? ["domain"] : kinds === "databases_only" ? ["database"]
    : kinds === "domains_and_databases" ? ["domain", "database"] : [schedule.targetType];
  const exactLinks = original.copyLinks ?? original.draftLinks;
  if ((exactLinks?.map(link => link.kind) ?? required).some(kind => !input.allowedKinds.some(allowed => allowed === kind))) return null;
  const requested = { scheduleId, scheduleVersion: version };
  const operationsBySchedule = await io.readOperations(portalEnvironment, [requested]);
  const operation = operationsBySchedule.get(scheduleId);
  if (operation?.scheduleVersion !== version || (original.draftOrigin &&
      (original.draftOrigin.environment !== portalEnvironment || original.draftOrigin.version !== version ||
       original.draftOrigin.operationId !== operation.operationId))) return null;
  const manualIntents = await io.readIntents({ date, portalEnvironment });
  const activeLicenseIds = schedule.selectionMode === "licensing" ? await io.licenses() : new Set<string>();
  const day = await io.evidence({ date, checkedAt, cutoffAt, portalEnvironment, matchKeyVersion, operationsBySchedule, activeLicenseIds }, {
    certifyCoverage: readSqlCatalogSchedulePopulationCoverage,
    populationRoster: new Map(roster.map(row => [row.schedule.id, catalogScheduleRosterToken(row)])), manualIntents,
  });
  if (!day.revision.complete) return null;
  const compiled = exactLinks ? compileExactCopyProposal(original, date, operation.operationId)
    : compileCatalogScheduleScopes(day, [{ version, schedule: { ...schedule, startDate: date, endDate: null, frequencyType: "once" } }]);
  if (compiled.status !== "ready" || !compiled.rules.length) return null;
  return { original: schedule, missingSelections: compiled.missingSelections,
    day: { ...day, rules: compiled.rules, previewActorId: actorId,
      previewOrigin: { ...requested, operationId: operation.operationId } } };
}

type Prepared = NonNullable<Awaited<ReturnType<typeof prepareCatalogScheduleCopy>>>;
type VerifiedPreview = NonNullable<Awaited<ReturnType<typeof previewCatalogScheduleDay>>>;
function copyAuthority(prepared: Prepared, preview: VerifiedPreview) {
  return { ...preview, coverage: (prepared.missingSelections ? "partial" : preview.coverage) as "verified" | "partial",
    ...prepared.day.previewOrigin, actorId: prepared.day.previewActorId, date: prepared.day.date,
    environment: prepared.day.portalEnvironment, revisionId: prepared.day.revision.id };
}

export async function readCatalogScheduleCopyPreview(input: PreviewRequest, io = dependencies()): Promise<PublicCopyPreview | null> {
  const prepared = await prepareCatalogScheduleCopy(input, io);
  if (!prepared) return null;
  const preview = await io.preview(prepared.day);
  if (!preview) return null;
  const authority = copyAuthority(prepared, preview);
  const inventory = new Map(prepared.day.inventory.map(record => [record.link.linkId, record]));
  const { nonce, previewId } = issueCatalogCopyIntent(io.secret(), input.checkedAt, authority);
  const opaque = (...parts: string[]) => catalogCopyOpaqueId(nonce, ...parts);
  const groups = new Map<string, PublicGroup>();
  for (const item of preview.candidates) {
    if (item.state === "unverifiable" || !item.targetId) continue;
    const label = inventory.get(item.linkId);
    if (!label) return null;
    let targetLabel = label.targetName;
    if (item.kind === "domain") {
      // A historic domain field may contain a URL. Expose only the host, not
      // any userinfo, path, query or connection material.
      try { targetLabel = new URL(/^https?:\/\//i.test(targetLabel) ? targetLabel : `https://${targetLabel}`).hostname; }
      catch { targetLabel = "Dominio verificado"; }
    }
    // Do not disclose raw execution, source, link or physical IDs, or details
    // about the task with which this proposal conflicts.
    const publicId = opaque(item.kind, item.targetId);
    const group: PublicGroup = groups.get(publicId) ?? { kind: item.kind, physicalTargetId: publicId,
      label: targetLabel, links: [] };
    group.links.push({ id: opaque("link", item.linkId), label: `${label.clientName} · ${targetLabel}`, verified: true });
    if (item.state === "conflict") group.conflict = { id: opaque("conflict", publicId),
      reason: "Ya hay una reserva incompatible para el mismo destino y fecha." };
    groups.set(publicId, group);
  }
  return { previewId, coverage: authority.coverage, groups: [...groups.values()] };
}

/**
 * Server-only save boundary. No HTTP-provided callbacks, raw target IDs or
 * revisions are accepted. `write` must stick to the supplied transaction.
 */
export async function withVerifiedCatalogCopySelection<T>(input: PreviewRequest & { previewId: string; linkIds: readonly string[] },
  write: (transaction: sql.Transaction, selection: Readonly<{
    original: Prepared["original"]; day: Prepared["day"];
    selected: NonNullable<ReturnType<typeof validateCatalogCopySelection>>;
    /** One logical save per preview; the writer must enforce its uniqueness. */
    intentId: string;
    proofValidUntil: Date;
    tightenDeadline: (until: Date) => void;
  }>) => Promise<T>, io = { ...dependencies(), withPreview: withCatalogScheduleDayPreview, now: () => new Date() },
): Promise<T | null> {
  return withFreshCatalogCopyPreview(input, async (transaction, prepared, preview, proofValidUntil, tightenDeadline) => {
    const selected = validateCatalogCopySelection(io.secret(), io.now(), copyAuthority(prepared, preview), input);
    return selected === null ? null : write(transaction, { ...prepared, selected, proofValidUntil, tightenDeadline,
      intentId: input.previewId.split(".")[1] });
  }, io);
}

/** Rebuild server-owned evidence while holding the same reservation and origin locks. */
export async function withFreshCatalogCopyPreview<T>(input: PreviewRequest,
  review: (transaction: sql.Transaction, prepared: Prepared, preview: VerifiedPreview,
    proofValidUntil: Date, tightenDeadline: (until: Date) => void) => Promise<T>,
  io = { ...dependencies(), withPreview: withCatalogScheduleDayPreview },
): Promise<T | null> {
  const prepared = await prepareCatalogScheduleCopy(input, io);
  if (!prepared) return null;
  return io.withPreview(prepared.day, (tx, preview, until, tighten) => review(tx, prepared, preview, until, tighten));
}

export function createCatalogScheduleCopyPreviewHttp(io: {
  authorize: (request: HttpRequest) => Promise<ActorScope | { status: 401 | 403 }>;
  read: (request: Omit<PreviewRequest, "portalEnvironment" | "matchKeyVersion">) => Promise<PublicCopyPreview | null>;
  now?: () => Date;
}) {
  const respond = (status: number, jsonBody: unknown): HttpResponseInit => ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
  return async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const actor = await io.authorize(request);
      if ("status" in actor) return respond(actor.status, { error: "No tiene acceso a la previsualización." });
      const scheduleId = request.params.id, date = request.query.get("date");
      if (!validId(scheduleId) || !isoDate(date) || [...request.query.keys()].length !== 1) {
        return respond(400, { error: "Indique una programación y fecha válidas." });
      }
      const checkedAt = io.now?.() ?? new Date();
      const today = new Date(checkedAt.getTime() - 5 * hour).toISOString().slice(0, 10);
      if (date < today || Date.parse(date) - Date.parse(today) > 7 * 24 * hour) {
        return respond(400, { error: "Seleccione una fecha desde hoy hasta los próximos siete días." });
      }
      const preview = await io.read({ ...actor, scheduleId, date, checkedAt });
      return preview ? respond(200, preview) : respond(409, { error: "No se pudo verificar el alcance de la copia." });
    } catch { return respond(503, { error: "La previsualización del catálogo no está disponible." }); }
  };
}
