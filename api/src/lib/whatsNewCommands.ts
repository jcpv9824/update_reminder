import { z } from "zod";
import { access, assertMayTest, canDeleteEntry, requireDeveloper, requirePermission, requireTester, type WhatsNewActor } from "./whatsNewAccess";
import {
  ENTRY_TYPES, LIMITS, SYSTEM_CODES, WhatsNewError, bogotaMonth,
  type AreaCode, type EntryStatus, type EntryType, type FileTarget, type LogAction, type SystemCode,
} from "./whatsNewModel";
import {
  RICH_LIMITS, extractPlainText, rewriteMentions, summaryLine, validateRichDoc,
  type RichDoc, type RichDocResult, type RichProfile,
} from "./whatsNewRichText";
import { RouteInputSchema, normalizeRoutes, routeSearchText, type NormalizedRoute, type RouteInput } from "./whatsNewRoutes";
import { nextStatus } from "./whatsNewStateMachine";

/* Reglas de negocio puras de Qué hay de nuevo. Cada comando recibe el estado
   de la entrada (leído con bloqueo dentro de la transacción) y devuelve los
   efectos que el repositorio SQL aplica en la MISMA transacción. No habla con
   SQL ni con el almacenamiento: así se prueba sin base de datos. */

/* ---------------------------------------------------------------- estado */

export type FileState = { fileId: string; kind: "imagen" | "documento" | "video"; target: FileTarget; status: string; name?: string; bytes?: number };

export type RoundState = {
  id: string;
  roundNo: number;
  revisionNo: number;
  holderId: string;
  checklist: Array<{ itemNo: number; label: string; checked: boolean }>;
};

export type EntryState = {
  key: number;
  id: string;
  number: number;
  status: EntryStatus;
  type: EntryType | null;
  system: SystemCode | null;
  whatChanged: RichDoc | null;
  clientName: string | null;
  initialTesterId: string | null;
  developerId: string;
  currentRevisionNo: number;
  currentRoundNo: number;
  lastFindingNo: number;
  openFindingsCount: number;
  etag: string;
  routes: RouteInput[];
  actions: Array<{ code: string; label: string; detail: RichDoc | null }>;
  attachments: AttachmentIn[];
  contributorIds: string[];
  asesorParticipantIds: string[];
  openRound: RoundState | null;
  findings: Array<{ id: string; number: number; roundNo: number; createdById: string; annulled: boolean }>;
  clientText: { show: boolean; title: string | null; body: RichDoc | null } | null;
  lastLog: { action: LogAction; byId: string; at: Date } | null;
};

export type CatalogAction = { code: string; label: string; active: boolean; isOther: boolean };
export type DirectoryUser = { id: string; displayName: string; active: boolean; areas: AreaCode[] };

export type CommandContext = {
  actor: WhatsNewActor;
  now: Date;
  newId: () => string;
  catalog: CatalogAction[];
  /** Usuarios referenciados por el comando (asesor a cargo, menciones). */
  users: Map<string, DirectoryUser>;
  /** Archivos de la entrada, por `fileId`. */
  files: Map<string, FileState>;
  mediaAvailable?: boolean;
};

/* -------------------------------------------------------------- efectos */

export type ActionValue = { ordinal: number; code: string; label: string; detail: RichDoc | null; detailText: string | null };

export type EntryPatch = Partial<{
  status: EntryStatus;
  type: EntryType | null;
  system: SystemCode | null;
  whatChanged: RichDoc | null;
  whatChangedText: string | null;
  whatChangedSummary: string | null;
  primaryRouteText: string | null;
  routeSearchText: string | null;
  clientName: string | null;
  initialTesterId: string | null;
  currentRevisionNo: number;
  currentRoundNo: number;
  lastFindingNo: number;
  openFindingsCount: number;
  firstPublishedAt: Date;
  lastPublishedAt: Date;
  resultAt: Date;
  approvedAt: Date | null;
  releaseMonth: string | null;
  archivedAt: Date;
  deletedAt: Date;
}>;

export type Effect =
  | { kind: "files.promote"; fileIds: string[] }
  | { kind: "entry.patch"; patch: EntryPatch }
  | { kind: "routes.replace"; routes: NormalizedRoute[] }
  | { kind: "actions.replace"; actions: ActionValue[] }
  | { kind: "attachments.replace"; attachments: AttachmentIn[] }
  | { kind: "revision.insert"; revisionNo: number; revisionKind: "publicacion" | "correccion"; whatChanged: RichDoc;
      actions: ActionValue[]; routes: RouteInput[]; correctionNote: RichDoc | null; correctionNoteText: string | null; onBehalf: boolean }
  | { kind: "contributor.add"; userId: string; contribution: "creo" | "edito" | "publico" | "corrigio" }
  | { kind: "participant.add"; userId: string; role: "asesor"; roundNo: number }
  | { kind: "round.open"; roundId: string; roundNo: number; revisionNo: number; holderId: string; checklist: string[] }
  | { kind: "round.close"; roundNo: number; status: "soltada" | "fallida" | "probada"; forcedReason: string | null }
  | { kind: "checklist.set"; roundNo: number; items: Array<{ itemNo: number; checked: boolean }> }
  | { kind: "note.insert"; id: string; roundNo: number; body: RichDoc; text: string }
  | { kind: "finding.insert"; id: string; roundNo: number; findingNo: number; body: RichDoc; text: string }
  | { kind: "finding.annul"; findingId: string; reason: string }
  | { kind: "clientText.upsert"; show: boolean; title: string | null; body: RichDoc | null; text: string | null }
  | { kind: "log.insert"; action: LogAction; from: EntryStatus | null; to: EntryStatus | null; roundNo: number | null;
      reason: string | null; detail: Record<string, string | number | boolean> | null }
  | { kind: "audit"; action: string; metadata: Record<string, unknown> };

export type CommandResult = { effects: Effect[]; status: EntryStatus; result: Record<string, unknown> };

/* -------------------------------------------------------------- entradas */

const RichIn = z.unknown();
const Reason = z.string().trim().min(LIMITS.reason.min, "El motivo debe tener al menos 10 caracteres.").max(LIMITS.reason.max);

const AttachmentInSchema = z.discriminatedUnion("kind", [
  z.object({ group: z.enum(["reglas_negocio", "video"]), kind: z.literal("archivo"), fileId: z.string().uuid() }).strict(),
  z.object({
    group: z.enum(["reglas_negocio", "video"]),
    kind: z.literal("enlace"),
    url: z.string().trim().max(2000),
    label: z.string().trim().max(200).nullable().optional(),
  }).strict(),
]);
export type AttachmentIn = z.infer<typeof AttachmentInSchema>;

export const DraftInSchema = z.object({
  type: z.enum(ENTRY_TYPES).nullable().optional(),
  system: z.enum(SYSTEM_CODES).nullable().optional(),
  routes: z.array(RouteInputSchema).max(LIMITS.routes).optional(),
  whatChanged: RichIn.optional(),
  editorLayoutVersion: z.literal(1).optional(),
  requiredActions: z.array(z.object({ actionCode: z.string().trim().min(2).max(40), detail: RichIn }).strict())
    .max(LIMITS.actions).optional(),
  clientId: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i).transform((s) => s.toLowerCase()).nullable().optional(),
  initialTesterId: z.string().trim().min(1).max(150).nullable().optional(),
  attachments: z.array(AttachmentInSchema).max(LIMITS.attachmentsPerGroup * 2).optional(),
}).strict();
/** Canonical client name is passed only by the write service after ERP authorization and lookup. */
export type DraftIn = Omit<z.infer<typeof DraftInSchema>, "clientId"> & { clientName?: string | null };

export const CorrectInSchema = z.object({
  whatChanged: RichIn,
  editorLayoutVersion: z.literal(1).optional(),
  requiredActions: z.array(z.object({ actionCode: z.string().trim().min(2).max(40), detail: RichIn }).strict())
    .min(1).max(LIMITS.actions),
  correctionNote: RichIn,
}).strict();
export type CorrectIn = z.infer<typeof CorrectInSchema>;

export const ReasonInSchema = z.object({ reason: Reason }).strict();
export const RichBodyInSchema = z.object({ body: RichIn }).strict();
export const ChecklistInSchema = z.object({
  items: z.array(z.object({ itemNo: z.number().int().min(1).max(LIMITS.actions), checked: z.boolean() }).strict())
    .min(1).max(LIMITS.actions),
}).strict();
export const ClientTextInSchema = z.object({
  showToClients: z.boolean(),
  title: z.string().trim().max(LIMITS.clientTitle).nullable(),
  body: RichIn.nullable(),
}).strict();
export type ClientTextIn = z.infer<typeof ClientTextInSchema>;

/* --------------------------------------------------------------- ayudas */

function richMax(profile: RichProfile, field: keyof typeof RICH_LIMITS.jsonChars): number {
  void profile;
  return RICH_LIMITS.jsonChars[field];
}

/** Shared validation for published content and partial drafts; callers decide
 * whether empty content is allowed. Mention labels always come from SQL users. */
export function validateDocWithFiles(
  ctx: CommandContext,
  input: unknown,
  profile: RichProfile,
  field: keyof typeof RICH_LIMITS.jsonChars,
): RichDocResult {
  const result = validateRichDoc(input, profile, richMax(profile, field));
  if ((result.imageFileIds.length || result.attachmentFileIds.length) && (!ctx.mediaAvailable || field !== "que_cambio" || profile === "cliente")) {
    throw new WhatsNewError(503, "almacenamiento_no_disponible", "El almacenamiento de archivos todavía no está conectado.");
  }
  const check = (fileId: string, kinds: string[]) => {
    const file = ctx.files.get(fileId.toLowerCase());
    if (!file || file.target !== "que_cambio" || !kinds.includes(file.kind)) {
      throw new WhatsNewError(400, "texto_enriquecido_invalido", "El contenido tiene un formato no permitido.", { rule: "archivo_ajeno" });
    }
    if (file.status !== "en_entrada" && file.status !== "verificada") {
      throw new WhatsNewError(422, "archivo_no_verificado", "El archivo no coincide con lo declarado.", { reason: file.status });
    }
  };
  result.imageFileIds.forEach((id) => check(id, ["imagen"]));
  result.attachmentFileIds.forEach((id) => check(id, ["documento", "video"]));
  if (result.attachmentFileIds.length) {
    // Do not let incoming rich text rename the bytes served by the portal.
    const nodes = [...(result.doc.content ?? [])];
    while (nodes.length) {
      const node = nodes.pop()!;
      if (node.type === "adjuntoArchivo") {
        const file = ctx.files.get(String(node.attrs?.fileId));
        node.attrs = { fileId: node.attrs?.fileId, nombre: file?.name ?? "Archivo adjunto", ...(file?.bytes === undefined ? {} : { tamano: file.bytes }) };
      }
      if (node.content) nodes.push(...node.content);
    }
    result.plainText = extractPlainText(result.doc);
  }
  if (result.mentionUserIds.length > 0) {
    const names = new Map<string, string>();
    for (const id of result.mentionUserIds) {
      const user = ctx.users.get(id);
      if (user) names.set(id, user.displayName);
    }
    result.doc = rewriteMentions(result.doc, names);
  }
  return result;
}

function shouldLog(state: EntryState, action: LogAction, ctx: CommandContext): boolean {
  // El autoguardado, el checklist y el texto para clientes se agrupan: una fila por actor cada 15 minutos.
  const last = state.lastLog;
  return !(last && last.action === action && last.byId === ctx.actor.id && ctx.now.getTime() - last.at.getTime() < 15 * 60_000);
}

function log(state: EntryState, action: LogAction, to: EntryStatus | null, extra: Partial<Extract<Effect, { kind: "log.insert" }>> = {}): Effect {
  return {
    kind: "log.insert", action, from: state.status, to, roundNo: extra.roundNo ?? null,
    reason: extra.reason ?? null, detail: extra.detail ?? null,
  };
}

function resolveActions(
  ctx: CommandContext,
  state: EntryState | null,
  input: Array<{ actionCode: string; detail: unknown }>,
  requireDetail: boolean,
): ActionValue[] {
  const seen = new Set<string>();
  return input.map((item, index) => {
    if (seen.has(item.actionCode)) throw new WhatsNewError(400, "solicitud_invalida", "Hay acciones requeridas repetidas.");
    seen.add(item.actionCode);
    const catalog = ctx.catalog.find((action) => action.code === item.actionCode);
    const existing = state?.actions.find((action) => action.code === item.actionCode);
    // Una acción desactivada en el catálogo solo se conserva si ya estaba en la entrada.
    if (!catalog || (!catalog.active && !existing)) {
      throw new WhatsNewError(400, "solicitud_invalida", "La acción requerida no existe o está inactiva.", { actionCode: item.actionCode });
    }
    let detail: RichDoc | null = null;
    let detailText: string | null = null;
    if (item.detail !== null && item.detail !== undefined) {
      const result = validateDocWithFiles(ctx, item.detail, "compacto", "accion");
      if (!result.isEmpty) {
        detail = result.doc;
        detailText = result.plainText.slice(0, 4000);
      }
    }
    if (requireDetail && !detail) {
      throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", { fields: [`requiredActions[${index}].detail`] });
    }
    return { ordinal: index + 1, code: item.actionCode, label: existing?.label ?? catalog.label, detail, detailText };
  });
}

function validateAttachmentUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WhatsNewError(400, "solicitud_invalida", "El enlace no es válido.");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || /\s/.test(url)) {
    throw new WhatsNewError(400, "solicitud_invalida", "El enlace debe ser https, sin credenciales ni espacios.");
  }
  return parsed.toString();
}

function validateAttachments(ctx: CommandContext, attachments: AttachmentIn[]): AttachmentIn[] {
  const counts: Record<string, number> = { reglas_negocio: 0, video: 0 };
  return attachments.map((item) => {
    counts[item.group] += 1;
    if (counts[item.group] > LIMITS.attachmentsPerGroup) {
      throw new WhatsNewError(400, "solicitud_invalida", `Se admiten hasta ${LIMITS.attachmentsPerGroup} adjuntos por lista.`);
    }
    if (item.kind === "enlace") return { ...item, url: validateAttachmentUrl(item.url), label: item.label || null };
    if (!ctx.mediaAvailable) throw new WhatsNewError(503, "almacenamiento_no_disponible", "El almacenamiento de archivos no está disponible.");
    const file = ctx.files.get(item.fileId.toLowerCase());
    const expectedKinds = item.group === "video" ? ["video"] : ["documento"];
    if (!file || file.target !== item.group || !expectedKinds.includes(file.kind)) {
      throw new WhatsNewError(400, "solicitud_invalida", "El archivo adjunto no pertenece a esta lista.");
    }
    if (file.status !== "en_entrada" && file.status !== "verificada") {
      throw new WhatsNewError(422, "archivo_no_verificado", "El archivo no coincide con lo declarado.", { reason: file.status });
    }
    return { ...item, fileId: item.fileId.toLowerCase() };
  });
}

function promotionEffect(ctx: CommandContext, ids: readonly string[]): Effect[] {
  const fileIds = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => ctx.files.get(id)?.status === "verificada");
  return fileIds.length ? [{ kind: "files.promote", fileIds }] : [];
}

/** Campos que faltan para publicar (se muestran como «Faltan campos» en el borrador). */
export function missingFieldsForPublish(state: Pick<EntryState, "type" | "system" | "routes" | "whatChanged" | "actions" | "initialTesterId" | "clientName">): string[] {
  const missing: string[] = [];
  if (!state.type) missing.push("type");
  if (!state.system) missing.push("system");
  let routesOk = state.routes.length > 0;
  try {
    normalizeRoutes(state.routes, "publish");
  } catch {
    routesOk = false;
  }
  if (!routesOk) missing.push("routes");
  if (!state.whatChanged || validateRichDoc(state.whatChanged, "medio", RICH_LIMITS.jsonChars.que_cambio).isEmpty) missing.push("whatChanged");
  if (state.actions.length === 0) missing.push("requiredActions");
  state.actions.forEach((action, index) => {
    if (!action.detail) missing.push(`requiredActions[${index}].detail`);
  });
  if (state.type === "nuevo") {
    if (!state.clientName?.trim()) missing.push("clientId");
    if (!state.initialTesterId) missing.push("initialTesterId");
  }
  return missing;
}

/* ------------------------------------------------------- desarrollador */

export function decideCreate(ctx: CommandContext): Effect[] {
  requireDeveloper(ctx.actor);
  return [
    { kind: "contributor.add", userId: ctx.actor.id, contribution: "creo" },
    { kind: "log.insert", action: "crear", from: null, to: "borrador", roundNo: null, reason: null, detail: null },
    { kind: "audit", action: "whats_new_entry_created", metadata: { toStatus: "borrador" } },
  ];
}

function assertDeveloperOwner(ctx: CommandContext, state: EntryState): void {
  requireDeveloper(ctx.actor);
  if (state.developerId !== ctx.actor.id) {
    throw new WhatsNewError(403, "no_es_autor", "Solo el autor puede modificar esta entrada.");
  }
}

export function decideSaveDraft(ctx: CommandContext, state: EntryState, input: DraftIn): CommandResult {
  assertDeveloperOwner(ctx, state);
  nextStatus("guardar_borrador", state.status);
  if (input.whatChanged !== undefined) assertCurrentEditor(state.whatChanged, input.editorLayoutVersion);
  const effects: Effect[] = [];
  const fileIds: string[] = [];
  const patch: EntryPatch = {};
  const type = input.type !== undefined ? input.type : state.type;
  const cleared: string[] = [];

  if (input.type !== undefined) patch.type = input.type;
  if (input.system !== undefined) patch.system = input.system;

  const nuevoFields = input.clientName !== undefined || input.initialTesterId !== undefined || input.attachments !== undefined;
  if (type !== "nuevo") {
    const sendsNuevoValues = (input.clientName ?? null) !== null || (input.initialTesterId ?? null) !== null
      || (input.attachments?.length ?? 0) > 0;
    if (sendsNuevoValues) {
      throw new WhatsNewError(400, "solicitud_invalida", "Cliente, asesor a cargo y adjuntos solo aplican a entradas Nuevo.");
    }
    // Si el tipo dejó de ser Nuevo, el servidor borra lo que era solo de Nuevo.
    if (state.clientName) cleared.push("clientName");
    if (state.initialTesterId) cleared.push("initialTesterId");
    if (state.attachments.length > 0) cleared.push("attachments");
    if (state.clientName || state.initialTesterId || nuevoFields) {
      patch.clientName = null;
      patch.initialTesterId = null;
    }
    if (state.attachments.length > 0 || input.attachments !== undefined) effects.push({ kind: "attachments.replace", attachments: [] });
  } else {
    if (input.clientName !== undefined) patch.clientName = input.clientName ? input.clientName : null;
    if (input.initialTesterId !== undefined) {
      if (input.initialTesterId && !ctx.users.get(input.initialTesterId)) {
        throw new WhatsNewError(400, "solicitud_invalida", "El asesor a cargo no existe.");
      }
      patch.initialTesterId = input.initialTesterId;
    }
    if (input.attachments !== undefined) {
      const attachments = validateAttachments(ctx, input.attachments);
      fileIds.push(...attachments.flatMap((item) => item.kind === "archivo" ? [item.fileId] : []));
      effects.push({ kind: "attachments.replace", attachments });
    }
  }

  let routes = state.routes;
  if (input.routes !== undefined) {
    const normalized = normalizeRoutes(input.routes, "draft");
    routes = normalized.map(({ via, submenus, option }) => ({ via, submenus, option }));
    effects.push({ kind: "routes.replace", routes: normalized });
    patch.primaryRouteText = normalized[0]?.displayText ?? null;
    patch.routeSearchText = routeSearchText(normalized);
  }

  let whatChanged = state.whatChanged;
  if (input.whatChanged !== undefined) {
    if (input.whatChanged === null) {
      whatChanged = null;
      Object.assign(patch, { whatChanged: null, whatChangedText: null, whatChangedSummary: null });
    } else {
      const result = validateDocWithFiles(ctx, input.whatChanged, "medio", "que_cambio");
      whatChanged = result.doc;
      fileIds.push(...result.imageFileIds, ...result.attachmentFileIds);
      Object.assign(patch, {
        whatChanged: result.doc, whatChangedText: result.plainText, whatChangedSummary: summaryLine(result.plainText),
      });
    }
  }

  let actions = state.actions;
  if (input.requiredActions !== undefined) {
    const resolved = resolveActions(ctx, state, input.requiredActions, false);
    actions = resolved.map(({ code, label, detail }) => ({ code, label, detail }));
    effects.push({ kind: "actions.replace", actions: resolved });
  }

  effects.unshift(...promotionEffect(ctx, fileIds), { kind: "entry.patch", patch });
  if (shouldLog(state, "editar_borrador", ctx)) effects.push(log(state, "editar_borrador", null));
  const missingFields = missingFieldsForPublish({
    type, system: input.system !== undefined ? input.system : state.system, routes, whatChanged, actions,
    clientName: patch.clientName !== undefined ? patch.clientName : (type === "nuevo" ? state.clientName : null),
    initialTesterId: patch.initialTesterId !== undefined ? patch.initialTesterId : (type === "nuevo" ? state.initialTesterId : null),
  });
  return { effects, status: state.status, result: { missingFields, cleared } };
}

export function decidePublish(ctx: CommandContext, state: EntryState): CommandResult {
  assertDeveloperOwner(ctx, state);
  const to = nextStatus("publicar", state.status);
  const missing = missingFieldsForPublish(state);
  if (missing.length > 0) {
    throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", { fields: missing });
  }
  const routes = normalizeRoutes(state.routes, "publish");
  if (state.type === "nuevo") {
    const tester = ctx.users.get(state.initialTesterId ?? "");
    if (!tester || !tester.active || !tester.areas.includes("soporte")) {
      throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", { fields: ["initialTesterId"] });
    }
  }
  // Copia del nombre de cada acción al publicar (QA-18).
  const actions: ActionValue[] = state.actions.map((action, index) => {
    const catalog = ctx.catalog.find((item) => item.code === action.code);
    return {
      ordinal: index + 1, code: action.code, label: catalog?.label ?? action.label, detail: action.detail,
      detailText: null,
    };
  });
  const revisionNo = state.currentRevisionNo + 1;
  return {
    status: to,
    result: { revisionNo },
    effects: [
      {
        kind: "entry.patch",
        patch: {
          status: to, currentRevisionNo: revisionNo, firstPublishedAt: ctx.now, lastPublishedAt: ctx.now,
          primaryRouteText: routes[0].displayText, routeSearchText: routeSearchText(routes),
        },
      },
      { kind: "actions.replace", actions },
      {
        kind: "revision.insert", revisionNo, revisionKind: "publicacion", whatChanged: state.whatChanged!, actions,
        routes: state.routes, correctionNote: null, correctionNoteText: null, onBehalf: false,
      },
      { kind: "contributor.add", userId: ctx.actor.id, contribution: "publico" },
      log(state, "publicar", to, { detail: { revisionNo } }),
      { kind: "audit", action: "whats_new_entry_published", metadata: { fromStatus: state.status, toStatus: to, revisionNo, routeCount: routes.length, actionCount: actions.length } },
    ],
  };
}

export function decideDelete(ctx: CommandContext, state: EntryState): CommandResult {
  const to = nextStatus("eliminar", state.status);
  requirePermission(ctx.actor, (actor) => canDeleteEntry(actor, state));
  const openRound = state.openRound;
  if (state.status === "en_pruebas" && !openRound) {
    throw new WhatsNewError(409, "estado_no_permite_accion", "La entrada no tiene la ronda abierta esperada.");
  }
  return {
    status: to,
    result: {},
    effects: [
      { kind: "entry.patch", patch: { status: to, deletedAt: ctx.now } },
      ...(openRound ? [{ kind: "round.close" as const, roundNo: openRound.roundNo, status: "soltada" as const, forcedReason: null }] : []),
      log(state, "eliminar", to, { roundNo: openRound?.roundNo }),
      { kind: "audit", action: "whats_new_entry_deleted", metadata: { fromStatus: state.status, toStatus: to } },
    ],
  };
}

/**
 * Corregir y volver a publicar (`sin_probar` o `fallida` → `sin_probar`).
 * Lo hace el desarrollador. Si ya no está, un líder con `manage` corrige en su
 * nombre: queda en la bitácora y el Desarrollador NO cambia (decisión 10).
 */
export function decideCorrect(ctx: CommandContext, state: EntryState, input: CorrectIn): CommandResult {
  const isOwner = state.developerId === ctx.actor.id && access.developer(ctx.actor);
  const onBehalf = !isOwner && access.manage(ctx.actor);
  if (!isOwner && !onBehalf) {
    if (state.developerId !== ctx.actor.id) throw new WhatsNewError(403, "no_es_autor", "Solo el autor puede modificar esta entrada.");
    requireDeveloper(ctx.actor);
  }
  const to = nextStatus("corregir", state.status);
  assertCurrentEditor(state.whatChanged, input.editorLayoutVersion);
  const whatChanged = validateDocWithFiles(ctx, input.whatChanged, "medio", "que_cambio");
  if (whatChanged.isEmpty) throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", { fields: ["whatChanged"] });
  const note = validateDocWithFiles(ctx, input.correctionNote, "medio", "nota");
  if (note.isEmpty) throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", { fields: ["correctionNote"] });
  const actions = resolveActions(ctx, state, input.requiredActions, true);
  const revisionNo = state.currentRevisionNo + 1;
  const action: LogAction = onBehalf ? "corregir_en_nombre" : "corregir";
  return {
    status: to,
    result: { revisionNo, onBehalf },
    effects: [
      ...promotionEffect(ctx, [...whatChanged.imageFileIds, ...whatChanged.attachmentFileIds]),
      {
        kind: "entry.patch",
        patch: {
          status: to, currentRevisionNo: revisionNo, lastPublishedAt: ctx.now, whatChanged: whatChanged.doc,
          whatChangedText: whatChanged.plainText, whatChangedSummary: summaryLine(whatChanged.plainText),
        },
      },
      { kind: "actions.replace", actions },
      {
        kind: "revision.insert", revisionNo, revisionKind: "correccion", whatChanged: whatChanged.doc, actions,
        routes: state.routes, correctionNote: note.doc, correctionNoteText: note.plainText, onBehalf,
      },
      { kind: "contributor.add", userId: ctx.actor.id, contribution: "corrigio" },
      log(state, action, to, { detail: { revisionNo } }),
      { kind: "audit", action: "whats_new_entry_corrected", metadata: { fromStatus: state.status, toStatus: to, revisionNo, actionCount: actions.length } },
    ],
  };
}

function assertCurrentEditor(doc: RichDoc | null, version?: number) {
  if (version !== 1 && doc?.content?.some(node => node.type === "imageWithText")) {
    throw new WhatsNewError(409, "editor_desactualizado", "Este borrador usa un formato nuevo. Recargue el Portal antes de editarlo.");
  }
}

/* --------------------------------------------------------------- asesor */

export function decideTake(ctx: CommandContext, state: EntryState): CommandResult {
  assertMayTest(ctx.actor, state.contributorIds);
  const to = nextStatus("tomar", state.status);
  const roundNo = state.currentRoundNo + 1;
  const effects: Effect[] = [
    { kind: "entry.patch", patch: { status: to, currentRoundNo: roundNo } },
    {
      kind: "round.open", roundId: ctx.newId(), roundNo, revisionNo: state.currentRevisionNo, holderId: ctx.actor.id,
      // La prueba empieza en blanco: un ítem por acción requerida de la revisión vigente.
      checklist: state.actions.map((action) => action.label),
    },
  ];
  if (!state.asesorParticipantIds.includes(ctx.actor.id)) {
    effects.push({ kind: "participant.add", userId: ctx.actor.id, role: "asesor", roundNo });
  }
  effects.push(log(state, "tomar", to, { roundNo }));
  effects.push({ kind: "audit", action: "whats_new_round_taken", metadata: { roundNo, revisionNo: state.currentRevisionNo, fromStatus: state.status, toStatus: to } });
  return { status: to, result: { roundNo }, effects };
}

function requireHolder(ctx: CommandContext, state: EntryState): RoundState {
  const round = state.openRound;
  if (state.status !== "en_pruebas" || !round) {
    throw new WhatsNewError(409, "estado_no_permite_accion", "La entrada no está en pruebas.", { status: state.status });
  }
  if (round.holderId !== ctx.actor.id) {
    throw new WhatsNewError(403, "no_tiene_la_ronda", "La prueba la tiene otra persona.", { holderId: round.holderId });
  }
  // Si perdió el permiso o el área a mitad de la ronda, solo `manage` puede forzar Soltar.
  requireTester(ctx.actor);
  return round;
}

export function decideRelease(ctx: CommandContext, state: EntryState): CommandResult {
  const round = requireHolder(ctx, state);
  const to = nextStatus("soltar", state.status);
  // Soltar devuelve a Sin probar y la prueba empieza de nuevo. No se envía nada.
  return {
    status: to,
    result: { roundNo: round.roundNo },
    effects: [
      { kind: "entry.patch", patch: { status: to } },
      { kind: "round.close", roundNo: round.roundNo, status: "soltada", forcedReason: null },
      log(state, "soltar", to, { roundNo: round.roundNo }),
      { kind: "audit", action: "whats_new_round_released", metadata: { roundNo: round.roundNo, fromStatus: state.status, toStatus: to } },
    ],
  };
}

export function decideForceRelease(ctx: CommandContext, state: EntryState, reason: string): CommandResult {
  requirePermission(ctx.actor, access.manage);
  const to = nextStatus("forzar_soltar", state.status);
  const round = state.openRound;
  if (!round) throw new WhatsNewError(409, "estado_no_permite_accion", "La entrada no tiene una ronda abierta.");
  return {
    status: to,
    result: { roundNo: round.roundNo },
    effects: [
      { kind: "entry.patch", patch: { status: to } },
      { kind: "round.close", roundNo: round.roundNo, status: "soltada", forcedReason: reason },
      log(state, "forzar_soltar", to, { roundNo: round.roundNo, reason }),
      { kind: "audit", action: "whats_new_round_force_released", metadata: { roundNo: round.roundNo, reasonLength: reason.length } },
    ],
  };
}

export function decideChecklist(ctx: CommandContext, state: EntryState, items: Array<{ itemNo: number; checked: boolean }>): CommandResult {
  const round = requireHolder(ctx, state);
  nextStatus("checklist", state.status);
  for (const item of items) {
    if (!round.checklist.some((existing) => existing.itemNo === item.itemNo)) {
      throw new WhatsNewError(400, "solicitud_invalida", "El ítem del checklist no existe.", { itemNo: item.itemNo });
    }
  }
  const merged = round.checklist.map((existing) => ({
    ...existing, checked: items.find((item) => item.itemNo === existing.itemNo)?.checked ?? existing.checked,
  }));
  const done = merged.filter((item) => item.checked).length;
  const effects: Effect[] = [
    { kind: "entry.patch", patch: {} },
    { kind: "checklist.set", roundNo: round.roundNo, items },
  ];
  if (shouldLog(state, "checklist", ctx)) effects.push(log(state, "checklist", null, { roundNo: round.roundNo, detail: { done, total: merged.length } }));
  return { status: state.status, result: { done, total: merged.length }, effects };
}

export function decideNote(ctx: CommandContext, state: EntryState, body: unknown, kind: "nota" | "hallazgo"): CommandResult {
  const round = requireHolder(ctx, state);
  nextStatus(kind === "nota" ? "registrar_nota" : "registrar_hallazgo", state.status);
  const result = validateDocWithFiles(ctx, body, "medio", "nota");
  if (result.isEmpty) throw new WhatsNewError(400, "solicitud_invalida", "La nota está vacía.");
  const id = ctx.newId();
  if (kind === "nota") {
    return {
      status: state.status,
      result: { noteId: id },
      effects: [
        { kind: "entry.patch", patch: {} },
        { kind: "note.insert", id, roundNo: round.roundNo, body: result.doc, text: result.plainText },
        log(state, "registrar_nota", null, { roundNo: round.roundNo }),
        { kind: "audit", action: "whats_new_note_registered", metadata: { roundNo: round.roundNo, textLength: result.plainText.length } },
      ],
    };
  }
  const findingNo = state.lastFindingNo + 1;
  return {
    status: state.status,
    result: { findingId: id, findingNo },
    effects: [
      { kind: "entry.patch", patch: { lastFindingNo: findingNo, openFindingsCount: state.openFindingsCount + 1 } },
      { kind: "finding.insert", id, roundNo: round.roundNo, findingNo, body: result.doc, text: result.plainText },
      log(state, "registrar_hallazgo", null, { roundNo: round.roundNo, detail: { findingNo } }),
      { kind: "audit", action: "whats_new_finding_registered", metadata: { roundNo: round.roundNo, findingNo, textLength: result.plainText.length } },
    ],
  };
}

/** Un hallazgo no se borra: se anula con motivo (QA-26). Lo anula quien lo registró con su ronda abierta, o `manage`. */
export function decideAnnulFinding(ctx: CommandContext, state: EntryState, findingId: string, reason: string): CommandResult {
  nextStatus("anular_hallazgo", state.status);
  const finding = state.findings.find((item) => item.id === findingId);
  if (!finding) throw new WhatsNewError(404, "no_encontrado", "No encontrado.");
  if (finding.annulled) throw new WhatsNewError(409, "estado_no_permite_accion", "El hallazgo ya está anulado.");
  const ownOpenRound = state.openRound && state.openRound.roundNo === finding.roundNo
    && state.openRound.holderId === ctx.actor.id && finding.createdById === ctx.actor.id && access.tester(ctx.actor);
  if (!ownOpenRound) requirePermission(ctx.actor, access.manage);
  return {
    status: state.status,
    result: { findingNo: finding.number },
    effects: [
      { kind: "entry.patch", patch: { openFindingsCount: Math.max(0, state.openFindingsCount - 1) } },
      { kind: "finding.annul", findingId, reason },
      log(state, "anular_hallazgo", null, { roundNo: finding.roundNo, reason, detail: { findingNo: finding.number } }),
      { kind: "audit", action: "whats_new_finding_annulled", metadata: { roundNo: finding.roundNo, findingNo: finding.number, reasonLength: reason.length } },
    ],
  };
}

export function decideMarkTested(ctx: CommandContext, state: EntryState): CommandResult {
  const round = requireHolder(ctx, state);
  const to = nextStatus("marcar_probado", state.status);
  const done = round.checklist.filter((item) => item.checked).length;
  const total = round.checklist.length;
  if (total === 0 || done < total) {
    throw new WhatsNewError(409, "checklist_incompleto", "Complete el checklist antes de marcar probado.", { done, total });
  }
  // La fecha de liberación que ve el cliente es el mes en que se aprobó, en Bogotá.
  const releaseMonth = bogotaMonth(ctx.now);
  return {
    status: to,
    result: { roundNo: round.roundNo, releaseMonth },
    effects: [
      { kind: "entry.patch", patch: { status: to, resultAt: ctx.now, approvedAt: ctx.now, releaseMonth } },
      { kind: "round.close", roundNo: round.roundNo, status: "probada", forcedReason: null },
      log(state, "marcar_probado", to, { roundNo: round.roundNo }),
      { kind: "audit", action: "whats_new_round_marked_tested", metadata: { roundNo: round.roundNo, checklistDone: done, checklistTotal: total, toStatus: to } },
    ],
  };
}

export function decideMarkFailed(ctx: CommandContext, state: EntryState): CommandResult {
  const round = requireHolder(ctx, state);
  const to = nextStatus("marcar_fallida", state.status);
  const findingsInRound = state.findings.filter((item) => item.roundNo === round.roundNo && !item.annulled).length;
  if (findingsInRound === 0) {
    throw new WhatsNewError(409, "requiere_hallazgo", "Registre al menos un hallazgo en esta ronda.");
  }
  return {
    status: to,
    result: { roundNo: round.roundNo, findingsInRound },
    effects: [
      { kind: "entry.patch", patch: { status: to, resultAt: ctx.now } },
      { kind: "round.close", roundNo: round.roundNo, status: "fallida", forcedReason: null },
      log(state, "marcar_fallida", to, { roundNo: round.roundNo, detail: { findingsInRound } }),
      { kind: "audit", action: "whats_new_round_marked_failed", metadata: { roundNo: round.roundNo, findingsInRound, toStatus: to } },
    ],
  };
}

export function decideArchive(ctx: CommandContext, state: EntryState, reason: string): CommandResult {
  requirePermission(ctx.actor, access.manage);
  const to = nextStatus("archivar", state.status);
  return {
    status: to,
    result: {},
    effects: [
      // Al archivar, la entrada sale de la página pública. `approvedAt` se conserva (sigue en reportes).
      { kind: "entry.patch", patch: { status: to, archivedAt: ctx.now } },
      log(state, "archivar", to, { reason }),
      { kind: "audit", action: "whats_new_entry_archived", metadata: { fromStatus: state.status, toStatus: to, reasonLength: reason.length } },
    ],
  };
}

/**
 * Texto para clientes (QA-09): pertenece a la entrada. En `en_pruebas` lo edita
 * quien tiene la ronda; en `probado`, `publish_client` + Soporte. SP crítico
 * nunca se muestra. Mostrar a clientes es mostrar a todos (decisión 5).
 */
export function decideClientText(ctx: CommandContext, state: EntryState, input: ClientTextIn): CommandResult {
  nextStatus("texto_clientes", state.status);
  if (state.status === "en_pruebas") requireHolder(ctx, state);
  else requirePermission(ctx.actor, access.publishClient);
  if (input.showToClients && state.type === "sp_critico") {
    throw new WhatsNewError(409, "visibilidad_bloqueada", "Esta entrada no se puede mostrar a clientes: es un SP crítico.");
  }
  let body: RichDoc | null = null;
  let text: string | null = null;
  if (input.body !== null) {
    const result = validateDocWithFiles(ctx, input.body, "cliente", "cliente");
    if (!result.isEmpty) {
      body = result.doc;
      text = result.plainText;
    }
  }
  const title = input.title ? input.title : null;
  if (input.showToClients && (!title || !body)) {
    const fields = [...(!title ? ["clientText.title"] : []), ...(!body ? ["clientText.body"] : [])];
    throw new WhatsNewError(422, "validacion_publicacion", "Faltan campos para publicar.", { fields });
  }
  const visibilityChanged = (state.clientText?.show ?? false) !== input.showToClients;
  const effects: Effect[] = [
    { kind: "entry.patch", patch: {} },
    { kind: "clientText.upsert", show: input.showToClients, title, body, text },
  ];
  if (visibilityChanged || shouldLog(state, "texto_clientes", ctx)) {
    effects.push(log(state, "texto_clientes", null, { detail: { showToClients: input.showToClients } }));
  }
  effects.push({
    kind: "audit", action: "whats_new_client_text_updated",
    metadata: { showToClients: input.showToClients, titleLength: title?.length ?? 0, bodyLength: text?.length ?? 0, visibilityChanged },
  });
  return { status: state.status, result: { visibilityChanged }, effects };
}
