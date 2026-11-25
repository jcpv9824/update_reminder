import sql from "mssql";
import { getSqlPool } from "./sql";
import { WhatsNewError, formatEntryNumber, type AreaCode } from "./whatsNewModel";
import type { EntryState, CommandContext, FileState } from "./whatsNewCommands";
import type { WhatsNewActor } from "./whatsNewAccess";

export type Db = sql.ConnectionPool | sql.Transaction;
export type Params = Record<string, string | number | boolean | Buffer | Date | null>;
// Values are always parameters. SQL identifiers in this module are fixed code.
export async function query<T = Record<string, any>>(db: Db, statement: string, values: Params = {}): Promise<T[]> {
  const request = db instanceof sql.Transaction ? new sql.Request(db) : new sql.Request(db);
  for (const [key, value] of Object.entries(values)) {
    const type = Buffer.isBuffer(value) ? sql.VarBinary(sql.MAX) : value instanceof Date ? sql.DateTime2(3)
      : typeof value === "boolean" ? sql.Bit : typeof value === "number" ? sql.BigInt : sql.NVarChar(sql.MAX);
    request.input(key, type, value);
  }
  return (await request.query<T>(statement)).recordset;
}
export const etag = (value: Buffer): string => `"${value.toString("base64")}"`;
export function requireEtag(expected: string | null, actual: string): void {
  if (!expected) throw new WhatsNewError(428, "version_requerida", "Debe enviar If-Match con la versión vigente.");
  if (expected !== actual) throw new WhatsNewError(409, "version_desactualizada", "Alguien más modificó esta información. Recargue.", { currentEtag: actual });
}
const parse = (value: string | null) => value === null ? null : JSON.parse(value);
const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Positive DTO projection: SQL entry_key remains available only for grouping. */
export function participantDto(row: { id: string; displayName: string; role: string }) {
  return { id: row.id, displayName: row.displayName, role: row.role };
}

// Alias u is the user and a an optional explicit module area. Existing 068
// classifications remain effective only until one or more 060 rows exist.
export const effectiveAreaSql = `COALESCE(a.area_code,CASE u.area
  WHEN 'support' THEN 'soporte' WHEN 'development' THEN 'desarrollo'
  WHEN 'administrative' THEN 'administrativa' WHEN 'sales' THEN 'ventas' END)`;

export const supportAreaPredicateSql = `(
  EXISTS(SELECT 1 FROM security.user_business_areas a WHERE a.user_key=u.user_key AND a.area_code='soporte')
  OR (u.area='support' AND NOT EXISTS(SELECT 1 FROM security.user_business_areas a WHERE a.user_key=u.user_key))
)`;

export async function directory(db: Db, ids: string[]) {
  const users = await query(db, `SELECT u.source_id id,u.display_name displayName,u.email,u.active,${effectiveAreaSql} area
    FROM security.users u LEFT JOIN security.user_business_areas a ON a.user_key=u.user_key
    WHERE u.source_id IN (SELECT value FROM OPENJSON(@ids)) ORDER BY u.display_name,u.user_key;`, { ids: JSON.stringify([...new Set(ids)].slice(0, 200)) });
  const map = new Map<string, { id: string; displayName: string; email: string; active: boolean; areas: AreaCode[] }>();
  for (const row of users) {
    let user = map.get(row.id);
    if (!user) { user = { id: row.id, displayName: row.displayName, email: row.email, active: row.active, areas: [] }; map.set(row.id, user); }
    if (row.area) user.areas.push(row.area);
  }
  return map;
}
export async function areasFor(id: string): Promise<AreaCode[]> {
  const rows = await query<{ area_code: AreaCode | null }>(await getSqlPool(), `SELECT ${effectiveAreaSql} area_code
    FROM security.users u LEFT JOIN security.user_business_areas a ON a.user_key=u.user_key
    WHERE u.source_id=@id AND u.active=1;`, { id });
  return rows.flatMap((r) => r.area_code ? [r.area_code] : []);
}
export async function contextFor(db: Db, actor: WhatsNewActor, now: Date, newId: () => string, userIds: string[] = []): Promise<CommandContext> {
  const catalog = await query(db, "SELECT code,label,active,is_other isOther FROM whats_new.action_catalog ORDER BY sort_order,code;");
  return { actor, now, newId, catalog: catalog as CommandContext["catalog"], users: await directory(db, [actor.id, ...userIds]), files: new Map() };
}

export async function readWhatsNewMediaStates(db: Db, key: number, actorId: string, fileIds: string[]) {
  // Only verified files belonging to this entry and this uploader can move
  // into the entry. Previously linked files remain available for corrections.
  const rows = await query<FileState>(db, `SELECT LOWER(CONVERT(char(36),f.public_id)) fileId,f.kind,f.target,f.status,
    f.original_name [name], CONVERT(int,f.declared_byte_count) bytes
    FROM whats_new.entry_files f WITH(UPDLOCK,HOLDLOCK)
    JOIN content.files c ON c.storage_provider='s3' AND c.storage_bucket=f.storage_bucket AND c.object_key=f.object_key
      AND c.content_sha256=f.declared_sha256 AND c.byte_count=f.declared_byte_count AND c.mime_type=f.mime_type
    WHERE f.entry_key=@key AND f.storage_provider='s3'
      AND f.public_id IN (SELECT TRY_CONVERT(uniqueidentifier,value) FROM OPENJSON(@ids))
      AND ((f.status='en_entrada' AND c.file_key=f.file_key) OR
        (f.status='verificada' AND f.expires_at>SYSUTCDATETIME() AND f.uploaded_by_user_key=
          (SELECT user_key FROM security.users WHERE source_id=@actor AND active=1)));`,
  { key, actor: actorId, ids: JSON.stringify(fileIds) });
  return new Map(rows.map((row) => [row.fileId, row]));
}

export async function readEntry(db: Db, id: string, lock = false, load: typeof query = query) {
  const [row] = await load(db, `SELECT e.*,d.source_id developer_id,d.display_name developer_name,t.source_id initial_tester_id,t.display_name initial_assignee_name
    FROM whats_new.entries e ${lock ? "WITH (UPDLOCK,HOLDLOCK)" : ""}
    JOIN security.users d ON d.user_key=e.developer_user_key
    LEFT JOIN security.users t ON t.user_key=e.initial_tester_user_key WHERE e.source_id=@id;`, { id });
  if (!row) return null;
  const p = { key: Number(row.entry_key) };
  const levels = await load(db, `SELECT r.entry_key,r.route_no,r.via_code,l.level_no,l.level_kind,l.label FROM whats_new.entry_routes r
    JOIN whats_new.entry_route_levels l ON l.entry_route_key=r.entry_route_key WHERE r.entry_key=@key ORDER BY r.route_no,l.level_no;`, p);
  const routes: EntryState["routes"] = [];
  for (const l of levels) {
    const index = Number(l.route_no) - 1;
    routes[index] ??= { via: l.via_code, submenus: [], option: "" };
    if (l.level_kind === "submenu") routes[index].submenus.push(l.label);
    if (l.level_kind === "opcion") routes[index].option = l.label;
  }
  const actions = (await load(db, `SELECT a.entry_key,c.code,a.label_snapshot label,a.detail_json FROM whats_new.entry_required_actions a
    JOIN whats_new.action_catalog c ON c.action_catalog_key=a.action_catalog_key WHERE a.entry_key=@key ORDER BY a.ordinal;`, p))
    .map((a) => ({ code: a.code as string, label: a.label as string, detail: parse(a.detail_json) }));
  const attachments = (await load(db, `SELECT a.*,CONVERT(varchar(36),f.public_id) file_id,f.original_name file_name FROM whats_new.entry_attachments a
    LEFT JOIN whats_new.entry_files f ON f.entry_file_key=a.entry_file_key WHERE a.entry_key=@key ORDER BY a.attachment_group,a.ordinal;`, p))
    .map((a) => a.item_kind === "archivo" ? { group: a.attachment_group, kind: "archivo" as const, fileId: a.file_id, name: a.file_name as string }
      : { group: a.attachment_group, kind: "enlace" as const, url: a.link_url, label: a.link_label });
  const rounds = (await load(db, `SELECT r.*,u.source_id holder_id,u.display_name holder_name FROM whats_new.test_rounds r
    JOIN security.users u ON u.user_key=r.holder_user_key WHERE r.entry_key=@key ORDER BY r.round_no;`, p));
  const checklist = await load(db, `SELECT r.entry_key,c.*,r.source_id round_id FROM whats_new.round_checklist_items c
    JOIN whats_new.test_rounds r ON r.round_key=c.round_key WHERE r.entry_key=@key ORDER BY r.round_no,c.item_no;`, p);
  const notes = await load(db, `SELECT n.*,r.source_id round_id,u.source_id created_by_id FROM whats_new.round_notes n
    JOIN whats_new.test_rounds r ON r.round_key=n.round_key JOIN security.users u ON u.user_key=n.created_by_user_key
    WHERE n.entry_key=@key ORDER BY n.created_at,n.round_note_key;`, p);
  const findings = await load(db, `SELECT f.*,r.round_no,u.source_id created_by_id,a.reason_text annul_reason,a.annulled_at
    FROM whats_new.findings f JOIN whats_new.test_rounds r ON r.round_key=f.round_key
    JOIN security.users u ON u.user_key=f.created_by_user_key LEFT JOIN whats_new.finding_annulments a ON a.finding_key=f.finding_key
    WHERE f.entry_key=@key ORDER BY f.finding_no;`, p);
  const contributors = await load(db, `SELECT c.entry_key,u.source_id id FROM whats_new.entry_contributors c JOIN security.users u ON u.user_key=c.user_key WHERE c.entry_key=@key;`, p);
  const participants = await load(db, `SELECT p.entry_key,u.source_id id,u.display_name displayName,p.participant_role role FROM whats_new.entry_participants p
    JOIN security.users u ON u.user_key=p.user_key WHERE p.entry_key=@key ORDER BY p.first_at,u.source_id;`, p);
  const logs = await load(db, `SELECT l.*,u.source_id by_id FROM whats_new.entry_log l JOIN security.users u ON u.user_key=l.occurred_by_user_key
    WHERE l.entry_key=@key ORDER BY l.log_no;`, p);
  const [ct] = await load(db, "SELECT * FROM whats_new.entry_client_texts WHERE entry_key=@key;", p);
  const revisions = await load(db, `SELECT entry_key,revision_no,revision_kind,what_changed_json,required_actions_json,routes_json,correction_note_json,published_at,on_behalf
    FROM whats_new.entry_revisions WHERE entry_key=@key ORDER BY revision_no;`, p);
  const roundDtos = rounds.map((r) => ({ id: r.source_id as string, roundNo: Number(r.round_no), revisionNo: Number(r.revision_no), holderId: r.holder_id as string,
    holderName: r.holder_name as string, status: r.status as string, takenAt: iso(r.taken_at), closedAt: iso(r.closed_at), etag: etag(r.row_version),
    checklist: checklist.filter((c) => c.round_id === r.source_id).map((c) => ({ itemNo: Number(c.item_no), label: c.label_snapshot as string, checked: !!c.checked })),
    notes: notes.filter((n) => n.round_id === r.source_id).map((n) => ({ id: n.source_id, body: parse(n.body_json), createdById: n.created_by_id, createdAt: iso(n.created_at) })),
    noteDraft: parse(r.note_draft_json ?? null),
  }));
  const findingDtos = findings.map((f) => ({ id: f.source_id as string, number: Number(f.finding_no), roundNo: Number(f.round_no), body: parse(f.body_json),
    createdById: f.created_by_id as string, createdAt: iso(f.created_at), annulled: f.annulled_at ? { reason: f.annul_reason, at: iso(f.annulled_at) } : null }));
  const open = roundDtos.find((r) => r.status === "tomada");
  const lastTester = roundDtos.filter((r) => r.status === "probada" || r.status === "fallida").at(-1);
  const last = logs.at(-1);
  const state: EntryState = { key: p.key, id: row.source_id, number: Number(row.entry_number), status: row.status, type: row.entry_type, system: row.system_code,
    whatChanged: parse(row.what_changed_json), clientName: row.client_name_text, initialTesterId: row.initial_tester_id ?? null, developerId: row.developer_id,
    currentRevisionNo: Number(row.current_revision_no), currentRoundNo: Number(row.current_round_no), lastFindingNo: Number(row.last_finding_no),
    openFindingsCount: Number(row.open_findings_count), etag: etag(row.row_version), routes, actions, attachments,
    contributorIds: contributors.map((c) => c.id), asesorParticipantIds: participants.filter((u) => u.role === "asesor").map((u) => u.id),
    openRound: open ? { id: open.id, roundNo: open.roundNo, revisionNo: open.revisionNo, holderId: open.holderId, checklist: open.checklist } : null,
    findings: findingDtos.map((f) => ({ ...f, annulled: f.annulled !== null })), clientText: ct ? { show: !!ct.show_to_clients, title: ct.title, body: parse(ct.body_json) } : null,
    lastLog: last ? { action: last.action, byId: last.by_id, at: last.occurred_at } : null };
  const detail = { id: state.id, number: formatEntryNumber(state.number), status: state.status, type: state.type, system: state.system,
    developer: { id: state.developerId, displayName: row.developer_name }, clientName: state.clientName, initialTesterId: state.initialTesterId,
    initialAssigneeName: (row.initial_assignee_name ?? null) as string | null, lastTesterName: lastTester?.holderName ?? null,
    whatChanged: state.whatChanged, summary: row.what_changed_summary, primaryRoute: row.primary_route_text, routes, requiredActions: actions, attachments,
    rounds: roundDtos, findings: findingDtos, participants: participants.map((p) => participantDto({ id: p.id, displayName: p.displayName, role: p.role })), log: logs.map((l) => ({ action: l.action, byId: l.by_id, at: iso(l.occurred_at), reason: l.reason_text })),
    revisions: revisions.map((r) => ({ revisionNo: Number(r.revision_no), kind: r.revision_kind, whatChanged: parse(r.what_changed_json),
      requiredActions: parse(r.required_actions_json), routes: parse(r.routes_json), correctionNote: parse(r.correction_note_json), publishedAt: iso(r.published_at), onBehalf: !!r.on_behalf })),
    clientText: ct ? { showToClients: !!ct.show_to_clients, title: ct.title, body: parse(ct.body_json), etag: etag(ct.row_version) } : null,
    etag: state.etag, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), resultAt: iso(row.result_at), releaseMonth: row.release_month,
  };
  return { state, detail };
}
export type EntryDetail = NonNullable<Awaited<ReturnType<typeof readEntry>>>["detail"];

/** One fixed set of thirteen normalized reads for up to 200 selected entries,
 * not thirteen roundtrips per entry. No history is truncated or reconstructed
 * from the present state. Caller owns the consistent read transaction. */
export async function readEntries(db: Db, ids: string[], execute: typeof query = query): Promise<EntryDetail[]> {
  if (ids.length > 200) throw new WhatsNewError(422, "reporte_muy_grande", "El reporte supera 200 entradas. Filtre por mes.");
  const cache = new Map<string, Record<string, any>[]>();
  const load: typeof query = async <T = Record<string, any>>(_db: Db, statement: string, values: Params = {}): Promise<T[]> => {
    let rows = cache.get(statement);
    if (!rows) {
      const selection = "SELECT value FROM OPENJSON(@ids)";
      const sqlText = statement.replace(/e\.source_id=@id/g, `e.source_id IN (${selection})`)
        .replace(/([a-z]+\.)?entry_key=@key/g, (match) => `${match.slice(0, -5)} IN (SELECT entry_key FROM whats_new.entries WHERE source_id IN (${selection}))`);
      rows = await execute(db, sqlText, { ids: JSON.stringify(ids) });
      cache.set(statement, rows);
    }
    return rows.filter((r) => values.id !== undefined ? r.source_id === values.id : Number(r.entry_key) === Number(values.key)) as T[];
  };
  const result: EntryDetail[] = [];
  for (const id of ids) { const entry = await readEntry(db, id, false, load); if (entry) result.push(entry.detail); }
  return result;
}
