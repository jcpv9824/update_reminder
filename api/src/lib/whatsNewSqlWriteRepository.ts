import { createHash, randomUUID } from "node:crypto";
import type sql from "mssql";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { assertCanSeeEntry, requireDeveloper, requireTester, requireView, requirePermission, access, type WhatsNewActor } from "./whatsNewAccess";
import { z } from "zod";
import { WhatsNewError, VIA_LABELS } from "./whatsNewModel";
import { query, readEntry, requireEtag, contextFor, participantDto, type Db, type Params, type EntryDetail } from "./whatsNewSqlRepository";
import * as commands from "./whatsNewCommands";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function requestFingerprint(operation: string, id: string | null, body: unknown): Buffer {
  return createHash("sha256").update(canonical({ operation, id, body })).digest();
}
export function assertIdempotencyKey(value: string | null): string {
  if (!value) throw new WhatsNewError(428, "idempotencia_requerida", "Debe enviar Idempotency-Key.");
  if (!/^[\x21-\x7e]{8,200}$/.test(value)) throw new WhatsNewError(400, "solicitud_invalida", "La llave de idempotencia no es válida.");
  return value;
}
const json = (value: unknown) => value == null ? null : JSON.stringify(value);
const userKey = `(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1)`;

export async function applyEffects(db: sql.Transaction, key: number, actor: WhatsNewActor, now: Date, effects: commands.Effect[]) {
  const base: Params = { key, actor: actor.id, now };
  for (const effect of effects) {
    const run = (statement: string, p: Params = {}) => query(db, statement, { ...base, ...p });
    switch (effect.kind) {
      case "entry.patch": {
        const columns: Record<keyof commands.EntryPatch, string> = {
          status: "status", type: "entry_type", system: "system_code", whatChanged: "what_changed_json", whatChangedText: "what_changed_text",
          whatChangedSummary: "what_changed_summary", primaryRouteText: "primary_route_text", routeSearchText: "route_search_text", clientName: "client_name_text",
          initialTesterId: "initial_tester_user_key", currentRevisionNo: "current_revision_no", currentRoundNo: "current_round_no", lastFindingNo: "last_finding_no",
          openFindingsCount: "open_findings_count", firstPublishedAt: "first_published_at", lastPublishedAt: "last_published_at", resultAt: "result_at",
          approvedAt: "approved_at", releaseMonth: "release_month", archivedAt: "archived_at", deletedAt: "deleted_at",
        };
        const values: Params = {};
        const assignments = Object.entries(effect.patch).map(([name, value], i) => {
          const column = columns[name as keyof commands.EntryPatch];
          if (!column) throw new Error("Unsupported entry field");
          values[`p${i}`] = name === "whatChanged" ? json(value) : value as Params[string];
          return `${column}=${name === "initialTesterId" ? `(SELECT user_key FROM security.users WHERE source_id=@p${i})` : `@p${i}`}`;
        });
        await run(`UPDATE whats_new.entries SET ${assignments.length ? assignments.join(",") + "," : ""}
          updated_at=@now,updated_by=@actor,last_edited_by_user_key=${userKey} WHERE entry_key=@key;`, values);
        break;
      }
      case "routes.replace":
        await run("DELETE l FROM whats_new.entry_route_levels l JOIN whats_new.entry_routes r ON r.entry_route_key=l.entry_route_key WHERE r.entry_key=@key; DELETE FROM whats_new.entry_routes WHERE entry_key=@key;");
        for (const r of effect.routes) {
          const [inserted] = await run(`INSERT whats_new.entry_routes(entry_key,route_no,via_code,level_count,display_text,route_hash)
            OUTPUT inserted.entry_route_key routeKey VALUES(@key,@no,@via,@count,@text,@hash);`, { no: r.routeNo, via: r.via, count: r.levelCount, text: r.displayText, hash: r.routeHash });
          const parts = [VIA_LABELS[r.via], ...r.submenus, r.option];
          for (let i = 0; i < parts.length; i++) await run(`INSERT whats_new.entry_route_levels(entry_route_key,level_no,level_kind,label) VALUES(@route,@no,@kind,@label);`,
            { route: Number(inserted.routeKey), no: i + 1, kind: i === 0 ? "via" : i === parts.length - 1 ? "opcion" : "submenu", label: parts[i] });
        }
        break;
      case "actions.replace":
        await run("DELETE FROM whats_new.entry_required_actions WHERE entry_key=@key;");
        for (const a of effect.actions) await run(`INSERT whats_new.entry_required_actions(entry_key,ordinal,action_catalog_key,label_snapshot,detail_json,detail_text)
          SELECT @key,@ordinal,action_catalog_key,@label,@body,@text FROM whats_new.action_catalog WHERE code=@code;`,
          { ordinal: a.ordinal, code: a.code, label: a.label, body: json(a.detail), text: a.detailText });
        break;
      case "attachments.replace": {
        await run("DELETE FROM whats_new.entry_attachments WHERE entry_key=@key;");
        const counts: Record<string, number> = {};
        for (const a of effect.attachments) {
          counts[a.group] = (counts[a.group] ?? 0) + 1;
          await run(`INSERT whats_new.entry_attachments(entry_key,attachment_group,ordinal,item_kind,entry_file_key,link_url,link_label)
            VALUES(@key,@group,@ordinal,@kind,(SELECT entry_file_key FROM whats_new.entry_files WHERE public_id=TRY_CONVERT(uniqueidentifier,@file) AND entry_key=@key),@url,@label);`,
            { group: a.group, ordinal: counts[a.group], kind: a.kind, file: a.kind === "archivo" ? a.fileId : null, url: a.kind === "enlace" ? a.url : null, label: a.kind === "enlace" ? a.label ?? null : null });
        }
        break;
      }
      case "revision.insert":
        await run(`INSERT whats_new.entry_revisions(entry_key,revision_no,revision_kind,what_changed_json,required_actions_json,routes_json,
          correction_note_json,correction_note_text,on_behalf,published_at,published_by_user_key)
          VALUES(@key,@no,@kind,@body,@actions,@routes,@note,@text,@behalf,@now,${userKey});`,
          { no: effect.revisionNo, kind: effect.revisionKind, body: json(effect.whatChanged), actions: json(effect.actions), routes: json(effect.routes),
            note: json(effect.correctionNote), text: effect.correctionNoteText, behalf: effect.onBehalf });
        break;
      case "contributor.add":
        await run(`IF NOT EXISTS(SELECT 1 FROM whats_new.entry_contributors WHERE entry_key=@key AND user_key=(SELECT user_key FROM security.users WHERE source_id=@user))
          INSERT whats_new.entry_contributors(entry_key,user_key,first_contribution,first_at) SELECT @key,user_key,@kind,@now FROM security.users WHERE source_id=@user;`, { user: effect.userId, kind: effect.contribution });
        break;
      case "participant.add":
        await run(`IF NOT EXISTS(SELECT 1 FROM whats_new.entry_participants WHERE entry_key=@key AND participant_role='asesor' AND user_key=(SELECT user_key FROM security.users WHERE source_id=@user))
          INSERT whats_new.entry_participants(entry_key,user_key,participant_role,first_round_no,first_at) SELECT @key,user_key,'asesor',@round,@now FROM security.users WHERE source_id=@user;`,
          { user: effect.userId, round: effect.roundNo });
        break;
      case "round.open": {
        const [r] = await run(`INSERT whats_new.test_rounds(source_id,entry_key,round_no,revision_no,status,holder_user_key,taken_at)
          OUTPUT inserted.round_key roundKey VALUES(@id,@key,@round,@revision,'tomada',${userKey},@now);`, { id: effect.roundId, round: effect.roundNo, revision: effect.revisionNo });
        for (let i = 0; i < effect.checklist.length; i++) await run(`INSERT whats_new.round_checklist_items(round_key,item_no,label_snapshot,checked) VALUES(@roundKey,@no,@label,0);`,
          { roundKey: Number(r.roundKey), no: i + 1, label: effect.checklist[i] });
        break;
      }
      case "round.close":
        await run(`UPDATE whats_new.test_rounds SET status=@status,closed_at=@now,closed_by_user_key=${userKey},close_reason=@reason,close_reason_text=@text
          WHERE entry_key=@key AND round_no=@round AND status='tomada';`, { status: effect.status, reason: effect.forcedReason ? "forzada" : "normal", text: effect.forcedReason, round: effect.roundNo });
        break;
      case "checklist.set":
        for (const item of effect.items) await run(`UPDATE c SET checked=@checked,checked_at=CASE WHEN @checked=1 THEN @now END,
          checked_by_user_key=CASE WHEN @checked=1 THEN ${userKey} END FROM whats_new.round_checklist_items c
          JOIN whats_new.test_rounds r ON r.round_key=c.round_key WHERE r.entry_key=@key AND r.round_no=@round AND r.status='tomada' AND c.item_no=@no;`,
          { checked: item.checked, round: effect.roundNo, no: item.itemNo });
        await run("UPDATE whats_new.test_rounds SET taken_at=taken_at WHERE entry_key=@key AND round_no=@round AND status='tomada';", { round: effect.roundNo });
        break;
      case "note.insert":
      case "finding.insert": {
        const finding = effect.kind === "finding.insert";
        await run(finding ? `INSERT whats_new.findings(source_id,entry_key,round_key,finding_no,body_json,body_text,created_by_user_key,created_at)
          SELECT @id,@key,round_key,@no,@body,@text,${userKey},@now FROM whats_new.test_rounds WHERE entry_key=@key AND round_no=@round;`
          : `INSERT whats_new.round_notes(source_id,entry_key,round_key,body_json,body_text,created_by_user_key,created_at)
          SELECT @id,@key,round_key,@body,@text,${userKey},@now FROM whats_new.test_rounds WHERE entry_key=@key AND round_no=@round;`,
          { id: effect.id, no: finding ? effect.findingNo : 0, round: effect.roundNo, body: json(effect.body), text: effect.text });
        await run("UPDATE whats_new.test_rounds SET note_draft_json=NULL WHERE entry_key=@key AND round_no=@round AND status='tomada';", { round: effect.roundNo });
        break;
      }
      case "finding.annul":
        await run(`INSERT whats_new.finding_annulments(finding_key,reason_text,annulled_at,annulled_by_user_key)
          SELECT finding_key,@reason,@now,${userKey} FROM whats_new.findings WHERE source_id=@finding AND entry_key=@key;`, { reason: effect.reason, finding: effect.findingId });
        break;
      case "clientText.upsert":
        await run(`IF EXISTS(SELECT 1 FROM whats_new.entry_client_texts WHERE entry_key=@key)
          UPDATE whats_new.entry_client_texts SET show_to_clients=@show,title=@title,body_json=@body,body_text=@text,updated_at=@now,updated_by_user_key=${userKey} WHERE entry_key=@key;
          ELSE INSERT whats_new.entry_client_texts(entry_key,show_to_clients,title,body_json,body_text,updated_at,updated_by_user_key)
          VALUES(@key,@show,@title,@body,@text,@now,${userKey});`, { show: effect.show, title: effect.title, body: json(effect.body), text: effect.text });
        break;
      case "log.insert":
        await run(`INSERT whats_new.entry_log(entry_key,log_no,action,from_status,to_status,round_no,reason_text,detail_json,occurred_at,occurred_by_user_key)
          VALUES(@key,(SELECT ISNULL(MAX(log_no),0)+1 FROM whats_new.entry_log WHERE entry_key=@key),@action,@from,@to,@round,@reason,@detail,@now,${userKey});`,
          { action: effect.action, from: effect.from, to: effect.to, round: effect.roundNo, reason: effect.reason, detail: json(effect.detail) });
        break;
      case "audit":
        await writeSqlAuditLog(db, { entityType: "whats_new_entry", entityId: String(key), action: effect.action,
          performedBy: actor.id, performedByEmail: actor.email, metadata: effect.metadata });
        break;
    }
  }
}

export type Operation = "create" | "draft" | "delete" | "publish" | "correct" | "take" | "release" | "force-release" | "mark-tested" | "mark-failed" | "archive" | "client-text" | "checklist" | "notes" | "findings" | "annul" | "note-draft";
export async function mutate(args: { actor: WhatsNewActor; operation: Operation; id: string | null; body: unknown; etag: string | null; idempotencyKey: string | null }) {
  const { actor, operation, body } = args;
  requireView(actor);
  // Current permissions and DB-loaded area are checked even when replaying a
  // previously authorized operation after a role/area has been revoked.
  if (["create", "draft", "publish"].includes(operation)) requireDeveloper(actor);
  else if (["take", "release", "mark-tested", "mark-failed", "checklist", "notes", "findings", "note-draft"].includes(operation)) requireTester(actor);
  else if (["force-release", "archive"].includes(operation)) requirePermission(actor, access.manage);
  else if (operation === "correct") requirePermission(actor, (a) => access.developer(a) || access.manage(a));
  else if (operation === "client-text") requirePermission(actor, (a) => access.tester(a) || access.publishClient(a));
  else if (operation === "annul") requirePermission(actor, (a) => access.tester(a) || access.manage(a));
  else if (operation === "delete") requirePermission(actor, (a) => access.developer(a) || access.manage(a));
  if (["publish", "take", "release", "mark-tested", "mark-failed", "delete"].includes(operation)) z.object({}).strict().parse(body);
  const idem = !["draft", "delete", "client-text", "checklist", "note-draft"].includes(operation);
  const idemKey = idem ? assertIdempotencyKey(args.idempotencyKey) : null;
  const hash = requestFingerprint(operation, args.id, body);
  return runSqlTransaction(async (db) => {
    const now = new Date();
    if (idemKey) {
      const [saved] = await query(db, `SELECT request_sha256,response_json FROM whats_new.idempotency_keys WITH (UPDLOCK,HOLDLOCK)
        WHERE actor_user_key=${userKey} AND operation=@operation AND idempotency_key=@idem AND expires_at>@now;`, { actor: actor.id, operation, idem: idemKey, now });
      if (saved) {
        if (!Buffer.from(saved.request_sha256).equals(hash)) throw new WhatsNewError(409, "llave_idempotencia_reutilizada", "La llave de idempotencia ya se usó con otra solicitud.");
        const detail = JSON.parse(saved.response_json) as EntryDetail;
        // An old response is not a grant to view a draft or removed entry.
        const [visible] = await query(db, `SELECT e.status,d.source_id developerId
          FROM whats_new.entries e JOIN security.users d ON d.user_key=e.developer_user_key
          WHERE e.source_id=@id;`, { id: detail.id });
        assertCanSeeEntry(actor, visible ? { status: visible.status, developerId: visible.developerId } : null);
        // Older snapshots may contain the internal grouping key. Preserve the
        // original response values, but never replay SQL-only participant fields.
        if (detail.participants) detail.participants = detail.participants.map(participantDto);
        return { detail, replayed: true };
      }
      await query(db, `DELETE FROM whats_new.idempotency_keys WHERE actor_user_key=${userKey} AND operation=@operation AND idempotency_key=@idem AND expires_at<=@now;`, { actor: actor.id, operation, idem: idemKey, now });
    }
    let id = args.id;
    if (operation === "create") {
      requireDeveloper(actor); // authorize before insertion
      id = randomUUID();
      await query(db, `INSERT whats_new.entries(source_id,status,developer_user_key,last_edited_by_user_key,created_at,created_by,updated_at,updated_by)
        VALUES(@id,'borrador',${userKey},${userKey},@now,@actor,@now,@actor);`, { id, actor: actor.id, now });
    }
    if (operation === "checklist" || operation === "notes" || operation === "findings" || operation === "note-draft") {
      const [entry] = await query(db, "SELECT e.source_id FROM whats_new.test_rounds r JOIN whats_new.entries e ON e.entry_key=r.entry_key WHERE r.source_id=@id;", { id });
      id = entry?.source_id ?? null;
    } else if (operation === "annul") {
      const [entry] = await query(db, "SELECT e.source_id FROM whats_new.findings f JOIN whats_new.entries e ON e.entry_key=f.entry_key WHERE f.source_id=@id;", { id });
      id = entry?.source_id ?? null;
    }
    const current = id ? await readEntry(db, id, true) : null;
    assertCanSeeEntry(actor, current?.state ?? null);
    const { state } = current!;
    const references = new Set<string>(state.initialTesterId ? [state.initialTesterId] : []);
    const stack: unknown[] = [body];
    let visited = 0;
    while (stack.length) {
      if (++visited > 10_000) throw new WhatsNewError(413, "contenido_muy_grande", "El contenido supera el tamaño permitido.");
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { stack.push(...node); continue; }
      const record = node as Record<string, unknown>;
      if (typeof record.initialTesterId === "string") references.add(record.initialTesterId);
      if (record.type === "mencion" && typeof record.attrs === "object" && record.attrs && "id" in record.attrs && typeof record.attrs.id === "string") references.add(record.attrs.id);
      stack.push(...Object.values(record));
    }
    if (references.size > 200) throw new WhatsNewError(413, "contenido_muy_grande", "Demasiados usuarios referenciados.");
    const ctx = await contextFor(db, actor, now, randomUUID, [...references]);
    const roundOp = ["checklist", "notes", "findings", "note-draft"].includes(operation);
    if (operation !== "create" && operation !== "annul") {
      const resource = roundOp ? current!.detail.rounds.find((r) => r.id === args.id) : operation === "client-text" ? current!.detail.clientText : null;
      requireEtag(args.etag, resource?.etag ?? state.etag);
      if (roundOp && (state.openRound?.id !== args.id)) throw new WhatsNewError(409, "estado_no_permite_accion", "La ronda ya está cerrada.");
    }
    let result: commands.CommandResult;
    switch (operation) {
      case "create": {
        const input = commands.DraftInSchema.parse(body);
        result = commands.decideSaveDraft(ctx, state, input);
        result.effects.unshift(...commands.decideCreate(ctx));
        await query(db, `INSERT whats_new.entry_participants(entry_key,user_key,participant_role,first_at) VALUES(@key,${userKey},'desarrollador',@now);`, { key: state.key, actor: actor.id, now });
        break;
      }
      case "draft": result = commands.decideSaveDraft(ctx, state, commands.DraftInSchema.parse(body)); break;
      case "delete": result = commands.decideDelete(ctx, state); break;
      case "publish": result = commands.decidePublish(ctx, state); break;
      case "correct": result = commands.decideCorrect(ctx, state, commands.CorrectInSchema.parse(body)); break;
      case "take": result = commands.decideTake(ctx, state); break;
      case "release": result = commands.decideRelease(ctx, state); break;
      case "force-release": result = commands.decideForceRelease(ctx, state, commands.ReasonInSchema.parse(body).reason); break;
      case "mark-tested": result = commands.decideMarkTested(ctx, state); break;
      case "mark-failed": result = commands.decideMarkFailed(ctx, state); break;
      case "archive": result = commands.decideArchive(ctx, state, commands.ReasonInSchema.parse(body).reason); break;
      case "client-text": result = commands.decideClientText(ctx, state, commands.ClientTextInSchema.parse(body)); break;
      case "checklist": result = commands.decideChecklist(ctx, state, commands.ChecklistInSchema.parse(body).items); break;
      case "notes": case "findings": {
        const input = commands.RichBodyInSchema.parse(body);
        result = commands.decideNote(ctx, state, input.body, operation === "notes" ? "nota" : "hallazgo"); break;
      }
      case "annul": result = commands.decideAnnulFinding(ctx, state, args.id!, commands.ReasonInSchema.parse(body).reason); break;
      case "note-draft": {
        const input = commands.RichBodyInSchema.parse(body);
        commands.decideChecklist(ctx, state, []); // same holder/area/state guard
        const validated = input.body === null ? null : commands.validateDocWithFiles(ctx, input.body, "medio", "nota");
        await query(db, "UPDATE whats_new.test_rounds SET note_draft_json=@body WHERE source_id=@id AND status='tomada';", { id: args.id, body: json(validated?.doc ?? null) });
        result = { effects: [{ kind: "entry.patch", patch: {} }], status: state.status, result: {} }; break;
      }
    }
    await applyEffects(db, state.key, actor, now, result.effects);
    const updated = (await readEntry(db, id!))!.detail;
    if (idemKey) await query(db, `INSERT whats_new.idempotency_keys(actor_user_key,operation,idempotency_key,request_sha256,entry_key,response_status,response_json,created_at,expires_at)
      VALUES(${userKey},@operation,@idem,@hash,@key,200,@response,@now,DATEADD(day,7,@now));`, { actor: actor.id, operation, idem: idemKey, hash, key: state.key, response: json(updated), now });
    return { detail: updated, replayed: false };
  });
}
