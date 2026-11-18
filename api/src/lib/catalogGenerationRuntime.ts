import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { generateApprovedCatalogOperationalScheduleDay } from "./catalogScheduleInventory";
import { appendSqlCatalogManualDayIntents } from "./catalogManualDayIntentSqlRepository";
import { readSqlCatalogScheduleRoster } from "./schedulingSqlRepository";
import { getSqlPool } from "./sql";

type Mode = "legacy" | "catalog";
type Trigger = "timer" | "generate" | "refresh" | "schedule-change";
type Request = { trigger: Trigger; actorId?: string; body?: unknown };
export type CatalogGenerationResult = {
  date: string;
  status: "evaluated" | "unverified" | "cutoff";
  created: number;
  existing: number;
  held: number;
  conflicts: number;
  accountedOrigins: number;
  manualIntentsSaved: number;
  message: string;
};
const publicError = (status: number, code: string): never => { throw Object.assign(new Error(code), { status }); };
const badRequest = (): never => publicError(400, "catalog_generation_request_invalid");
const notConfigured = (): never => publicError(503, "catalog_generation_configuration_invalid");
const dayMs = 86_400_000;
const utcOffsetMs = 5 * 3_600_000;
const validISODate = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validId = (id: unknown): id is string => typeof id === "string" && id.length >= 1 &&
  id.length <= 150 && id === id.trim() && !/\p{C}/u.test(id);

export function getTaskGenerationMode(env: NodeJS.ProcessEnv = process.env): Mode {
  const raw = env.PORTAL_CATALOG_GENERATION_MODE;
  if (raw === undefined) return "legacy";
  const configured = raw.trim();
  if (configured === "legacy") return "legacy";
  if (configured === "catalog") return "catalog";
  return notConfigured();
}

function configuration(env: NodeJS.ProcessEnv): { portalEnvironment: CatalogEnvironment; matchKeyVersion: number } {
  const portalEnvironment = env.PORTAL_SAG_ENVIRONMENT?.trim();
  const version = env.PORTAL_CATALOG_MATCH_KEY_VERSION?.trim() ?? "";
  if (getTaskGenerationMode(env) !== "catalog" || (portalEnvironment !== "qa" && portalEnvironment !== "production") ||
    env.PORTAL_CATALOG_READ_ENABLED?.trim() !== "true" || env.PORTAL_CATALOG_CUTOFF_ENABLED?.trim() !== "true" ||
    !/^[1-9]\d{0,4}$/.test(version) || Number(version) > 32767) return notConfigured();
  return { portalEnvironment, matchKeyVersion: Number(version) };
}

function scope(request: Request, now: Date): { date: string; cutoffAt: Date; manualScheduleIds: string[] } {
  if (!Number.isFinite(now.valueOf())) return notConfigured();
  // Bogotá UTC-5; only the instant matters, regardless of host local timezone.
  const today = new Date(now.valueOf() - utcOffsetMs).toISOString().slice(0, 10);
  const horizon = new Date(Date.parse(today) + 7 * dayMs).toISOString().slice(0, 10);
  const body = request.body === undefined ? {} : request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest();
  const keys = Object.keys(body);
  const http = request.trigger === "generate" || request.trigger === "refresh";
  if (keys.some(key => !(http && (key === "date" || (key === "manualScheduleIds" && request.trigger === "generate"))))) {
    return badRequest();
  }
  const { date = today, manualScheduleIds = [] } = body as Record<string, unknown>;
  if (!validISODate(date) || date < today || date > horizon || !Array.isArray(manualScheduleIds) ||
    manualScheduleIds.length > 100 || manualScheduleIds.some(id => !validId(id)) ||
    new Set(manualScheduleIds).size !== manualScheduleIds.length) return badRequest();
  const cutoffAt = new Date(Date.parse(date) + dayMs + utcOffsetMs);
  return { date, cutoffAt, manualScheduleIds: [...manualScheduleIds] };
}

async function readActiveLicenseIds(): Promise<ReadonlySet<string>> {
  // Do not use the paginated operator-grid projection as catalog evidence.
  const pool = await getSqlPool();
  const { recordset } = await pool.request().query<{ id: string }>(`
    SELECT TOP (5001) source_id AS id FROM licensing.license_modules
    WHERE status='active' AND deleted_at IS NULL ORDER BY module_key;`);
  if (!Array.isArray(recordset) || recordset.length > 5000 || recordset.some(row => !validId(row.id)) ||
    new Set(recordset.map(row => row.id)).size !== recordset.length) throw new Error("catalog_generation_licensing_unavailable");
  return new Set(recordset.map(row => row.id));
}

const dependencies = { now: () => new Date(), readActiveLicenseIds, readRoster: readSqlCatalogScheduleRoster,
  appendIntents: appendSqlCatalogManualDayIntents, generate: generateApprovedCatalogOperationalScheduleDay };

function incomplete(date: string, status: "cutoff" | "unverified", manualIntentsSaved: number): CatalogGenerationResult {
  return { date, status, created: 0, existing: 0, held: 0, conflicts: 0, accountedOrigins: 0, manualIntentsSaved,
    message: status === "cutoff" ? manualIntentsSaved
      ? "La solicitud quedó registrada. El corte de generación de esta fecha ya pasó."
      : "El corte de generación de esta fecha ya pasó."
      : manualIntentsSaved ? "La solicitud quedó registrada. No se pudo verificar la generación del catálogo."
        : "No se pudo verificar la generación del catálogo." };
}

/** The existing route must authorize generation before calling this internal service. */
export async function runCatalogGeneration(request: Request, io = dependencies,
  env: NodeJS.ProcessEnv = process.env): Promise<CatalogGenerationResult> {
  const { portalEnvironment, matchKeyVersion } = configuration(env);
  const checkedAt = io.now();
  const { date, cutoffAt, manualScheduleIds } = scope(request, checkedAt);
  if (checkedAt >= cutoffAt) return incomplete(date, "cutoff", 0);
  let manualIntentsSaved = 0;
  if (manualScheduleIds.length) {
    const { actorId } = request;
    if (request.trigger !== "generate" || !validId(actorId)) return badRequest();
    const roster = await io.readRoster(date).catch(() => publicError(503, "catalog_generation_roster_unavailable"));
    const byId = new Map(roster.map(row => [row.schedule.id, row]));
    if (byId.size !== roster.length) return publicError(503, "catalog_generation_roster_unavailable");
    const selected = manualScheduleIds.map(scheduleId => {
      const row = byId.get(scheduleId);
      if (!row?.schedule.active || row.schedule.frequencyType !== "manual" || row.schedule.startDate > date ||
        (row.schedule.endDate && row.schedule.endDate < date)) return publicError(409, "catalog_generation_schedule_unavailable");
      return { scheduleId, scheduleVersion: row.version };
    });
    try { await io.appendIntents({ date, portalEnvironment, actorId, cutoffAt, selected }); }
    catch { return publicError(503, "catalog_generation_manual_intent_unavailable"); }
    // Counts accepted exact requests, including retries, not newly inserted rows.
    manualIntentsSaved = selected.length;
  }
  try {
    const outcome = await io.generate({ date, portalEnvironment, matchKeyVersion, checkedAt, cutoffAt,
      activeLicenseIds: await io.readActiveLicenseIds(), ...(manualScheduleIds.length ? { manualScheduleIds } : {}) });
    if (outcome.status !== "evaluated") return incomplete(date, outcome.status, manualIntentsSaved);
    const { registered, existing, held, conflicts } = outcome;
    const accountedOrigins = ("accountedOrigins" in outcome ? outcome.accountedOrigins : undefined) ?? 0;
    const summary = held || conflicts ? "Fecha evaluada con destinos retenidos o en conflicto." : "Fecha del catálogo evaluada.";
    return { date, status: "evaluated", created: registered, existing, held, conflicts, accountedOrigins, manualIntentsSaved,
      message: accountedOrigins > 0 ? summary + " Los recibos de procedencia no son tareas nuevas ni conceden acceso." : summary };
  } catch { return incomplete(date, "unverified", manualIntentsSaved); }
}
