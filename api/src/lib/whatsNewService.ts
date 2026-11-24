import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { access, assertCanSeeEntry, requireDeveloper, requirePermission, requireView, viewsFor, type WhatsNewActor } from "./whatsNewAccess";
import { AREA_CODES, ENTRY_TYPES, SYSTEM_CODES, WhatsNewError, bogotaDayStartUtc, bogotaMonth, bogotaMonthStartUtc, formatEntryNumber, normalizeForCompare } from "./whatsNewModel";
import { query, readEntry, readEntries, requireEtag, etag, effectiveAreaSql, supportAreaPredicateSql, type Db, type Params, type EntryDetail } from "./whatsNewSqlRepository";
import { extractPlainText, toClientProfile, validateRichDoc, RICH_LIMITS } from "./whatsNewRichText";
import { canReadWhatsNewErpClients, lookupWhatsNewErpClients } from "./whatsNewErpClients";
import { whatsNewMediaAvailable } from "./whatsNewMedia";

export const pendingStorage = (): never => { throw new WhatsNewError(503, "almacenamiento_no_disponible", "El almacenamiento de archivos todavía no está conectado."); };
const integer = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const textSearch = z.string().trim().max(100).optional();
export const ListSchema = z.object({ scope: z.enum(["mine", "all"]).default("mine"), status: z.enum(["borrador", "sin_probar", "en_pruebas", "probado", "fallida", "archivada"]).optional(),
  type: z.enum(ENTRY_TYPES).optional(), system: z.enum(SYSTEM_CODES).optional(), q: textSearch,
  tab: z.enum(["sin_probar", "en_pruebas", "probadas", "todas", "borradores", "publicadas"]).optional(), result: z.enum(["sin_errores", "fallidas", "ambas"]).default("ambas"),
  month: month.optional(), assignedToMe: z.enum(["true", "false"]).optional(), page: integer(1, 100_000), pageSize: integer(25, 50) }).strict();

export async function listEntries(actor: WhatsNewActor, input: unknown, queue = false, db?: Db) {
  requireView(actor);
  // Option access alone does not grant a record-reading view. Check current
  // permissions/areas before opening the pool or counting any entries.
  requirePermission(actor, (a) => viewsFor(a).length > 0);
  const f = ListSchema.parse(input); const p: Params = { actor: actor.id, offset: (f.page - 1) * f.pageSize, size: f.pageSize };
  const tab = f.tab ?? (queue ? "sin_probar" : "todas");
  if (queue ? !["sin_probar", "en_pruebas", "probadas"].includes(tab) : !["todas", "borradores", "publicadas"].includes(tab)) {
    throw new WhatsNewError(400, "solicitud_invalida", "La pestaña no corresponde a esta vista.");
  }
  if (queue) requirePermission(actor, (a) => access.tester(a) || access.viewAll(a) || access.manage(a) || tab === "probadas" && access.report(a));
  const where = ["e.status<>'eliminada'"];
  if (!access.manage(actor)) where.push(access.developer(actor) ? "(e.status<>'borrador' OR d.source_id=@actor)" : "e.status<>'borrador'");
  if (!queue && (f.scope === "mine" || !access.viewAll(actor) && !access.manage(actor))) where.push("d.source_id=@actor");
  if (queue) {
    if (tab === "probadas") where.push(f.result === "fallidas" ? "e.status='fallida'" : f.result === "sin_errores" ? "e.status IN ('probado','archivada')" : "e.status IN ('probado','archivada','fallida')");
    else { where.push("e.status=@status"); p.status = tab; }
  } else if (f.status) { where.push("e.status=@status"); p.status = f.status; }
  if (f.type) { where.push("e.entry_type=@type"); p.type = f.type; }
  if (f.system) { where.push("e.system_code=@system"); p.system = f.system; }
  if (f.q) { where.push("(e.primary_route_text LIKE @search ESCAPE '~' OR e.what_changed_text LIKE @search ESCAPE '~')"); p.search = `%${f.q.replace(/[~%_\[]/g, "~$&")}%`; }
  if (f.assignedToMe === "true") where.push("t.source_id=@actor");
  if (f.month) {
    const column = queue && tab === "probadas" ? "e.result_at" : "e.last_published_at";
    where.push(`${column}>=@from AND ${column}<@until`); p.from = bogotaMonthStartUtc(f.month); p.until = bogotaMonthStartUtc(f.month, 1);
  }
  const from = `FROM whats_new.entries e JOIN security.users d ON d.user_key=e.developer_user_key LEFT JOIN security.users t ON t.user_key=e.initial_tester_user_key WHERE ${where.join(" AND ")}`;
  const source = db ?? await getSqlPool();
  const [count] = await query(source, `SELECT COUNT_BIG(*) total${queue ? "" : ", COUNT_BIG(CASE WHEN e.status='borrador' THEN 1 END) borradores, COUNT_BIG(CASE WHEN e.status<>'borrador' THEN 1 END) publicadas"} ${from};`, p);
  const tabWhere = queue || tab === "todas" ? "" : tab === "borradores" ? " AND e.status='borrador'" : " AND e.status<>'borrador'";
  const rows = await query(source, `SELECT e.source_id,e.entry_number,e.status,e.entry_type,e.system_code,e.what_changed_summary,e.primary_route_text,
    e.open_findings_count,e.row_version,e.created_at,e.updated_at,e.result_at,e.release_month,d.source_id developer_id,d.display_name developer_name,t.source_id tester_id,
    (SELECT TOP(1) u.source_id FROM whats_new.test_rounds r JOIN security.users u ON u.user_key=r.holder_user_key WHERE r.entry_key=e.entry_key AND r.status='tomada') holder_id,
    (SELECT TOP(1) u.display_name FROM whats_new.test_rounds r JOIN security.users u ON u.user_key=r.holder_user_key WHERE r.entry_key=e.entry_key AND r.status='tomada') holder_name,
    (SELECT COUNT(*) FROM whats_new.round_checklist_items c JOIN whats_new.test_rounds r ON r.round_key=c.round_key WHERE r.entry_key=e.entry_key AND r.status='tomada' AND c.checked=1) checklist_done,
    (SELECT COUNT(*) FROM whats_new.round_checklist_items c JOIN whats_new.test_rounds r ON r.round_key=c.round_key WHERE r.entry_key=e.entry_key AND r.status='tomada') checklist_total
    ${from}${tabWhere} ORDER BY ${queue && tab === "sin_probar" ? "e.last_published_at ASC" : "e.updated_at DESC"},e.entry_key OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;`, p);
  const items = rows.map((row) => ({ id: row.source_id as string, number: formatEntryNumber(Number(row.entry_number)), status: row.status as EntryDetail["status"],
    type: row.entry_type as EntryDetail["type"], system: row.system_code as EntryDetail["system"], developer: { id: row.developer_id as string, displayName: row.developer_name as string },
    summary: row.what_changed_summary as string | null, primaryRoute: row.primary_route_text as string | null, initialTesterId: row.tester_id as string | null,
    holder: row.holder_id ? { id: row.holder_id as string, displayName: row.holder_name as string } : null, checklistDone: Number(row.checklist_done), checklistTotal: Number(row.checklist_total),
    openFindings: Number(row.open_findings_count), etag: etag(row.row_version), createdAt: row.created_at.toISOString() as string, updatedAt: row.updated_at.toISOString() as string,
    resultAt: (row.result_at?.toISOString() ?? null) as string | null, releaseMonth: row.release_month as string | null }));
  const tabCounts = { todas: Number(count.total), borradores: Number(count.borradores ?? 0), publicadas: Number(count.publicadas ?? 0) };
  return { items, total: queue ? tabCounts.todas : tabCounts[tab as keyof typeof tabCounts], page: f.page, pageSize: f.pageSize,
    ...(!queue && { tabCounts }) };
}

export async function getEntry(actor: WhatsNewActor, id: string) {
  const current = await readEntry(await getSqlPool(), id); assertCanSeeEntry(actor, current?.state ?? null); return current!.detail;
}
export async function readConfig(actor: WhatsNewActor) {
  requirePermission(actor, access.configView);
  const db = await getSqlPool();
  const [settings] = await query(db, "SELECT public_enabled,row_version FROM whats_new.settings WHERE settings_key=1;");
  const actions = (await query(db, "SELECT * FROM whats_new.action_catalog ORDER BY sort_order,code;"))
    .map((a) => ({ id: a.source_id, code: a.code, label: a.label, sortOrder: a.sort_order, active: !!a.active, isOther: !!a.is_other, etag: etag(a.row_version) }));
  return { settings: { publicEnabled: !!settings.public_enabled, etag: etag(settings.row_version) }, actions, publicUrl: "/novedades" };
}
export async function me(actor: WhatsNewActor) {
  requirePermission(actor, (a) => access.view(a) || access.configView(a));
  const [settings] = await query(await getSqlPool(), "SELECT public_enabled FROM whats_new.settings WHERE settings_key=1;");
  const views = viewsFor(actor);
  return { user: { id: actor.id, displayName: actor.displayName, email: actor.email }, views, defaultView: views[0] ?? null,
    areas: [...actor.areas], permissions: [...actor.permissions], publicEnabled: !!settings.public_enabled, storageAvailable: whatsNewMediaAvailable(),
    clientCatalogAvailable: canReadWhatsNewErpClients(actor) };
}
export async function lookups(actor: WhatsNewActor, kind: string, q = "") {
  if (kind === "clients") return lookupWhatsNewErpClients(actor, q);
  const db = await getSqlPool();
  if (kind === "required-actions") {
    requireView(actor); return query(db, "SELECT code,label,is_other isOther FROM whats_new.action_catalog WHERE active=1 ORDER BY sort_order,code;");
  }
  if (kind === "support-users") requireDeveloper(actor);
  else if (kind === "recipients") requirePermission(actor, access.report);
  else if (kind === "mentionable-users") requirePermission(actor, (a) => access.developer(a) || access.tester(a));
  else throw new WhatsNewError(404, "no_encontrado", "No encontrado.");
  const search = z.string().trim().max(100).parse(q);
  const rows = await query(db, `SELECT TOP (50) u.source_id id,u.display_name displayName,u.email,u.active FROM security.users u WHERE u.active=1
    AND (@search=N'' OR u.display_name LIKE @search ESCAPE '~' OR u.email LIKE @search ESCAPE '~')
    ${kind === "support-users" ? "AND " + supportAreaPredicateSql : ""}
    ORDER BY u.display_name,u.source_id;`, { search: search ? `%${search.replace(/[~%_\[]/g, "~$&")}%` : "" });
  return rows.map((r) => kind === "recipients" ? { id: r.id, displayName: r.displayName, email: r.email } : { id: r.id, displayName: r.displayName, active: true });
}

export async function saveConfig(actor: WhatsNewActor, operation: "settings" | "action-create" | "action-edit", id: string | null, input: unknown, version: string | null) {
  requirePermission(actor, access.manage);
  return runSqlTransaction(async (db) => {
    const now = new Date();
    if (operation === "settings") {
      const body = z.object({ publicEnabled: z.boolean() }).strict().parse(input);
      const [row] = await query(db, "SELECT row_version FROM whats_new.settings WITH(UPDLOCK,HOLDLOCK) WHERE settings_key=1;"); requireEtag(version, etag(row.row_version));
      await query(db, "UPDATE whats_new.settings SET public_enabled=@enabled,updated_at=@now,updated_by=@actor WHERE settings_key=1;", { enabled: body.publicEnabled, now, actor: actor.id });
    } else {
      const schema = z.object({ label: z.string().trim().min(1).max(120), active: z.boolean().optional(), sortOrder: z.number().int().min(1).max(999).optional() }).strict();
      const body = schema.parse(input);
      // Serialize the whole catalog: two simultaneous deactivations cannot remove the last active action.
      const rows = await query(db, "SELECT * FROM whats_new.action_catalog WITH(UPDLOCK,HOLDLOCK) ORDER BY action_catalog_key;");
      const duplicate = rows.find((r) => r.source_id !== id && normalizeForCompare(r.label) === normalizeForCompare(body.label));
      // Creation has no arbitrary client key: a retried label resolves to its
      // existing catalog identity while this serialized lock prevents races.
      if (duplicate && operation === "action-create") return { saved: true, id: duplicate.source_id as string };
      if (operation === "action-edit") {
        const row = rows.find((r) => r.source_id === id); if (!row) throw new WhatsNewError(404, "no_encontrado", "No encontrado.");
        requireEtag(version, etag(row.row_version));
        if (duplicate) throw new WhatsNewError(409, "accion_duplicada", "Ya existe una acción requerida con ese nombre.");
        if (body.active === false && row.active && rows.filter((r) => r.active).length === 1) throw new WhatsNewError(409, "debe_quedar_una_accion", "Debe quedar al menos una acción requerida activa.");
        await query(db, "UPDATE whats_new.action_catalog SET label=@label,active=@active,sort_order=@sort,updated_at=@now,updated_by=@actor WHERE source_id=@id;",
          { label: body.label, active: body.active ?? !!row.active, sort: body.sortOrder ?? row.sort_order, now, actor: actor.id, id });
      } else {
        id = randomUUID();
        await query(db, `INSERT whats_new.action_catalog(source_id,code,label,sort_order,active,is_other,created_at,created_by,updated_at,updated_by)
          VALUES(@id,@code,@label,@sort,1,0,@now,@actor,@now,@actor);`, { id, code: `a_${id.replaceAll("-", "")}`, label: body.label, sort: body.sortOrder ?? Math.min(999, rows.length + 1), now, actor: actor.id });
      }
    }
    await writeSqlAuditLog(db, { entityType: "whats_new_config", entityId: id ?? "settings", action: "whats_new_configuration_updated", performedBy: actor.id, performedByEmail: actor.email, metadata: { operation } });
    return { saved: true, id };
  });
}

export async function businessAreas(actor: WhatsNewActor, id: string | null, input?: unknown, version: string | null = null) {
  requirePermission(actor, (a) => a.permissions.has(input === undefined ? "configuration.users.view" : "configuration.users.edit"));
  if (!id) return AREA_CODES.map((code) => ({ code, label: { soporte: "Soporte", desarrollo: "Desarrollo", ventas: "Ventas", administrativa: "Administrativa" }[code] }));
  return runSqlTransaction(async (db) => {
    const [user] = await query(db, "SELECT user_key,row_version,area FROM security.users WITH(UPDLOCK,HOLDLOCK) WHERE source_id=@id;", { id });
    if (!user) throw new WhatsNewError(404, "no_encontrado", "No encontrado.");
    const key = Number(user.user_key);
    if (input !== undefined) {
      requireEtag(version, etag(user.row_version));
      const { areas } = z.object({ areas: z.array(z.enum(AREA_CODES)).max(4).refine((a) => new Set(a).size === a.length) }).strict().parse(input);
      if (!areas.length && user.area) {
        throw new WhatsNewError(409, "area_general_asignada", "Quite primero el área general del usuario para dejarlo sin áreas efectivas.");
      }
      await query(db, "DELETE FROM security.user_business_areas WHERE user_key=@key;", { key });
      for (const area of areas) await query(db, "INSERT security.user_business_areas(user_key,area_code,assigned_at,assigned_by) VALUES(@key,@area,@now,@actor);", { key, area, now: new Date(), actor: actor.id });
      await query(db, "UPDATE security.users SET updated_at=@now,updated_by=@actor WHERE user_key=@key;", { key, now: new Date(), actor: actor.id });
      await writeSqlAuditLog(db, { entityType: "user", entityId: id, action: "user_business_areas_updated", performedBy: actor.id, performedByEmail: actor.email, metadata: { areas } });
    }
    const [updated] = await query(db, "SELECT row_version FROM security.users WHERE user_key=@key;", { key });
    const rows = await query(db, `SELECT ${effectiveAreaSql} area_code FROM security.users u
      LEFT JOIN security.user_business_areas a ON a.user_key=u.user_key WHERE u.user_key=@key ORDER BY area_code;`, { key });
    return { areas: rows.flatMap((r) => r.area_code ? [r.area_code] : []), etag: etag(updated.row_version) };
  });
}

const DateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
export const PublicFilters = z.object({ categoria: z.enum(["todo", "nuevas", "mejoras"]).default("todo"),
  periodo: z.enum(["mes_actual", "ultimos_3_meses", "ultimo_ano", "todo", "rango"]).default("todo"), desde: DateInput.optional(), hasta: DateInput.optional(),
  page: integer(1, 100_000), pageSize: integer(25, 100) }).strict().superRefine((f, ctx) => {
    if (f.periodo === "rango" && (!f.desde || !f.hasta || f.desde > f.hasta)) ctx.addIssue({ code: "custom", message: "Indique un rango de fechas válido." });
  });
export function publicDateRange(filters: z.infer<typeof PublicFilters>, now = new Date()): { from: Date | null; until: Date | null } {
  if (filters.periodo === "todo") return { from: null, until: null };
  if (filters.periodo === "rango") return { from: bogotaDayStartUtc(filters.desde!), until: bogotaDayStartUtc(filters.hasta!, 1) };
  const current = bogotaMonth(now);
  return { from: bogotaMonthStartUtc(current, filters.periodo === "ultimos_3_meses" ? -2 : filters.periodo === "ultimo_ano" ? -11 : 0), until: bogotaMonthStartUtc(current, 1) };
}
export function publicProjection(row: Record<string, any>, detail = false) {
  // Separate positive allowlist: never spread an internal aggregate into a public DTO.
  const body = validateRichDoc(row.body_json ? JSON.parse(row.body_json) : { type: "doc" }, "cliente", RICH_LIMITS.jsonChars.cliente);
  const clean = toClientProfile(body.doc);
  const card = { publicId: String(row.public_id), category: row.entry_type === "nuevo" ? "nuevo" : "mejora", releaseMonth: row.release_month as string,
    title: row.title as string, summary: extractPlainText(clean).slice(0, 280), whereToFind: row.primary_route_text as string | null };
  return detail ? { ...card, body: clean } : card;
}
export async function publicNews(input: unknown, publicId?: string) {
  const filters = PublicFilters.parse(input); const db = await getSqlPool();
  const [settings] = await query(db, "SELECT public_enabled FROM whats_new.settings WHERE settings_key=1;");
  if (!settings?.public_enabled) {
    if (publicId) throw new WhatsNewError(404, "no_encontrado", "No encontrado.");
    return { enabled: false, items: [], total: 0, page: filters.page, pageSize: filters.pageSize };
  }
  const where = ["e.status='probado'", "e.entry_type<>'sp_critico'", "c.show_to_clients=1", "c.title IS NOT NULL", "c.body_json IS NOT NULL"];
  const dates = publicDateRange(filters);
  const p: Params = { offset: (filters.page - 1) * filters.pageSize, size: filters.pageSize };
  if (publicId) { if (!z.string().uuid().safeParse(publicId).success) throw new WhatsNewError(404, "no_encontrado", "No encontrado."); where.push("c.public_id=TRY_CONVERT(uniqueidentifier,@id)"); p.id = publicId; }
  if (filters.categoria !== "todo") where.push(filters.categoria === "nuevas" ? "e.entry_type='nuevo'" : "e.entry_type<>'nuevo'");
  if (dates.from) { where.push("e.approved_at>=@from AND e.approved_at<@until"); p.from = dates.from; p.until = dates.until; }
  const from = `FROM whats_new.entries e JOIN whats_new.entry_client_texts c ON c.entry_key=e.entry_key WHERE ${where.join(" AND ")}`;
  const [count] = await query(db, `SELECT COUNT_BIG(*) total ${from};`, p);
  const rows = await query(db, `SELECT c.public_id,c.title,c.body_json,e.entry_type,e.release_month,e.primary_route_text ${from}
    ORDER BY e.approved_at DESC,c.public_id OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;`, p);
  if (publicId) { if (!rows[0]) throw new WhatsNewError(404, "no_encontrado", "No encontrado."); return publicProjection(rows[0], true); }
  return { enabled: true, items: rows.map((r) => publicProjection(r)), total: Number(count.total), page: filters.page, pageSize: filters.pageSize };
}

export const ReportInput = z.object({ include: z.enum(["todas", "aprobadas", "fallidas"]), filters: z.object({ type: z.enum(ENTRY_TYPES).optional(), system: z.enum(SYSTEM_CODES).optional(), month: month.optional(), q: textSearch }).strict().optional() }).strict();
export const ReportSendInput = ReportInput.extend({ recipientIds: z.array(z.string().min(1).max(150)).min(1).max(30).refine((a) => new Set(a).size === a.length) });
export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function renderReport(entries: EntryDetail[]) {
  const text = (doc: Parameters<typeof extractPlainText>[0] | null) => escapeHtml(doc ? extractPlainText(doc, { forReport: true }) : "");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte Qué hay de nuevo</title></head><body><h1>Reporte Qué hay de nuevo</h1>${entries.map((e) => `<article><h2>${escapeHtml(e.number)} · ${escapeHtml(e.primaryRoute)}</h2>
    <p>${escapeHtml(e.status)} · ${escapeHtml(e.type)} · ${escapeHtml(e.system)}</p><p>Desarrollador: ${escapeHtml(e.developer.displayName)}</p>
    <p>Asesores: ${e.participants.filter((p) => p.role === "asesor").map((p) => escapeHtml(p.displayName)).join(", ")}</p>
    <p>Creada: ${escapeHtml(e.createdAt)} · Resultado: ${escapeHtml(e.resultAt)}</p><h3>Qué cambió</h3><pre>${text(e.whatChanged)}</pre>
    <h3>Acciones requeridas</h3>${e.requiredActions.map((a) => `<p>${escapeHtml(a.label)}</p><pre>${text(a.detail)}</pre>`).join("")}
    <h3>Hallazgos</h3>${e.findings.length ? e.findings.map((f) => `<p>${f.number} · Ronda ${f.roundNo}${f.annulled ? " · Anulado: " + escapeHtml(f.annulled.reason) : ""}</p><pre>${text(f.body)}</pre>`).join("") : "<p>Sin hallazgos</p>"}
    <h3>Rondas de prueba</h3>${e.rounds.map((r) => `<p>Ronda ${r.roundNo} · ${escapeHtml(r.holderName)} · ${escapeHtml(r.status)} · ${escapeHtml(r.takenAt)} · ${escapeHtml(r.closedAt)}</p>
      <ul>${r.checklist.map((c) => `<li>${c.checked ? "✓" : "—"} ${escapeHtml(c.label)}</li>`).join("")}</ul>${r.notes.map((n) => `<pre>${text(n.body)}</pre>`).join("")}`).join("")}
    <h3>Bitácora</h3><ul>${e.log.map((l) => `<li>${escapeHtml(l.at)} · ${escapeHtml(l.byId)} · ${escapeHtml(l.action)} · ${escapeHtml(l.reason)}</li>`).join("")}</ul></article>`).join("")}</body></html>`;
}
export async function previewReport(actor: WhatsNewActor, input: unknown) {
  requirePermission(actor, access.report); const body = ReportInput.parse(input);
  return runSqlTransaction(async (db) => {
    const filters = { ...body.filters, scope: "all", tab: "probadas", result: body.include === "aprobadas" ? "sin_errores" : body.include === "fallidas" ? "fallidas" : "ambas", page: 1, pageSize: 50 };
    // Report permission is sufficient for result reading; do not grant the user queue mutation authority.
    const reportActor = { ...actor, permissions: new Set([...actor.permissions, "updates.whats_new.view_all"]) };
    const first = await listEntries(reportActor, filters, true, db);
    if (first.total > 200) throw new WhatsNewError(422, "reporte_muy_grande", "El reporte supera 200 entradas. Filtre por mes.");
    const summaries = [...first.items];
    for (let page = 2; summaries.length < first.total; page++) summaries.push(...(await listEntries(reportActor, { ...filters, page }, true, db)).items);
    const entries = await readEntries(db, summaries.map((s) => s.id));
    return { html: renderReport(entries), entryCount: entries.length, approvedCount: entries.filter((e) => e.status !== "fallida").length, failedCount: entries.filter((e) => e.status === "fallida").length };
  });
}
