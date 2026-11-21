import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import sql from "mssql";
import { z } from "zod";
import { catalogDraftScopeSchema, withReprovedCatalogDraft, withVerifiedNewCatalogDraft, type DraftCatalogRequest } from "./catalogScheduleDraftPreview";
import { inferScheduleRole, validateFrequency } from "./scheduleService";
import type { UpdateSchedule } from "../types/models";

const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value);
const optionalEnd = { endDate: realDate.optional() };
const days = z.array(z.enum(weekdays)).min(1).max(7).refine(value => new Set(value).size === value.length);
const calendarSchema = z.discriminatedUnion("frequencyType", [
  z.strictObject({ frequencyType: z.literal("once") }),
  z.strictObject({ frequencyType: z.literal("weekly"), everyNWeeks: z.number().int().min(1).max(32767), weekdays: days, ...optionalEnd }),
  z.strictObject({ frequencyType: z.literal("interval"), intervalDays: z.number().int().min(1).max(32767), preferredWeekdays: days.optional(), ...optionalEnd }),
  z.strictObject({ frequencyType: z.literal("monthly"), dayOfMonth: z.number().int().min(1).max(31), ...optionalEnd }),
  z.strictObject({ frequencyType: z.literal("manual"), ...optionalEnd }),
]);
const exactText = (length: number) => z.string().min(1).max(length).refine(value => value.trim() === value && !/\p{C}/u.test(value));
const people = z.array(exactText(150)).min(1).max(100).refine(value => new Set(value).size === value.length);
const assignmentSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("role"), domainRole: exactText(80).optional(), databaseRole: exactText(80).optional() }),
  z.strictObject({ mode: z.literal("users"), domainUsers: people.optional(), databaseUsers: people.optional() }),
]);

const schema = z.strictObject({ scope: catalogDraftScopeSchema,
  name: z.string().trim().min(1).max(200).refine(value => !/\p{C}/u.test(value)),
  previewId: z.string().min(1).max(140),
  linkIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(5000).refine(ids => new Set(ids).size === ids.length),
  calendar: calendarSchema,
  assignment: assignmentSchema,
});
type ProposalRequest = DraftCatalogRequest & Omit<z.infer<typeof schema>, "scope">;
type Outcome = { id: string; status: "pending_approval" };
const changed = () => Object.assign(new Error("catalog_draft_proposal_changed"), { status: 409 });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const pinSchema = z.strictObject({ linkId: z.string().regex(uuid), physicalId: z.string().regex(uuid),
  kind: z.enum(["domain", "database"]), include: z.boolean() });
type DraftPin = z.infer<typeof pinSchema>;

export function normalizeCatalogDraftDefinition(input: Pick<ProposalRequest, "calendar" | "assignment"> &
  { scope: Pick<DraftCatalogRequest["scope"], "target" | "date"> }) {
  const { scope, calendar, assignment } = input;
  try { validateFrequency({ ...calendar, startDate: scope.date }); } catch { return null; }
  const wantDomain = scope.target !== "database", wantDatabase = scope.target !== "domain";
  const present = (value: unknown) => value !== undefined;
  if (assignment.mode === "role"
    ? wantDomain !== present(assignment.domainRole) || wantDatabase !== present(assignment.databaseRole)
    : wantDomain !== present(assignment.domainUsers) || wantDatabase !== present(assignment.databaseUsers)) return null;
  const roles = [
    ...(wantDomain ? [{ kind: "domain", id: assignment.mode === "role" ? assignment.domainRole! : inferScheduleRole("domain") }] : []),
    ...(wantDatabase ? [{ kind: "database", id: assignment.mode === "role" ? assignment.databaseRole! : inferScheduleRole("database") }] : []),
  ];
  const users = assignment.mode === "users" ? [
    ...[...(assignment.domainUsers ?? [])].sort().map(id => ({ kind: "domain", id })),
    ...[...(assignment.databaseUsers ?? [])].sort().map(id => ({ kind: "database", id })),
  ] : [];
  const choices = calendar.frequencyType === "weekly" ? calendar.weekdays
    : calendar.frequencyType === "interval" ? calendar.preferredWeekdays ?? [] : [];
  const days = choices.map(choice => weekdays.indexOf(choice) + 1).sort((a,b) => a-b);
  return { mode: assignment.mode, roles, users, days, frequency: calendar.frequencyType,
    endDate: "endDate" in calendar ? calendar.endDate ?? null : null,
    everyNWeeks: calendar.frequencyType === "weekly" ? calendar.everyNWeeks : null,
    intervalDays: calendar.frequencyType === "interval" ? calendar.intervalDays : null,
    dayOfMonth: calendar.frequencyType === "monthly" ? calendar.dayOfMonth : null };
}

type Definition = NonNullable<ReturnType<typeof normalizeCatalogDraftDefinition>>;
type ScopeIdentity = Pick<DraftCatalogRequest["scope"], "mode" | "date" | "target" | "environment"> &
  ({ mode: "manual"; customerId: string; domainChoiceId?: string } | { mode: "licensing" });
const orderPins = (pins: readonly DraftPin[]) =>
  [...pins].sort((a,b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);

function draftDigest(identity: { id: string; environment: string; actorId: string; name: string;
  scope: ScopeIdentity; moduleId: string | null; pins: readonly DraftPin[]; definition: Definition }) {
  const { id, environment, actorId, name, scope, moduleId, pins, definition } = identity;
  return createHash("sha256").update(JSON.stringify(["catalog-draft-proposal-v2", id, environment, actorId,
    name, scope.mode, scope.date, scope.target, scope.environment, scope.mode === "manual" ? scope.customerId : null,
    scope.mode === "manual" ? scope.domainChoiceId ?? null : moduleId,
    orderPins(pins).map(pin => [pin.linkId, pin.kind, pin.physicalId, pin.include]), definition])).digest();
}

const storedScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("manual"), date: realDate, target: z.enum(["domain","database","both"]),
    environment: z.enum(["all","production","test","demo"]), customerId: z.string().regex(uuid),
    domainChoiceId: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.strictObject({ mode: z.literal("licensing"), date: realDate, target: z.enum(["domain","database","both"]),
    environment: z.enum(["all","production","test","demo"]) }),
]);
const storedRowSchema = z.strictObject({
  id: z.string().regex(uuid), environment: z.enum(["qa","production"]), actorId: exactText(150), name: exactText(200),
  scope: storedScopeSchema, moduleId: exactText(150).nullable(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  assignmentMode: z.enum(["role","users"]), domainRole: exactText(80).nullable(), databaseRole: exactText(80).nullable(),
  users: z.array(z.strictObject({ kind: z.enum(["domain","database"]), id: exactText(150) })).max(200),
  frequency: z.enum(["once","weekly","interval","monthly","manual"]), endDate: realDate.nullable(),
  everyNWeeks: z.number().int().nullable(), intervalDays: z.number().int().nullable(), dayOfMonth: z.number().int().nullable(),
  days: z.array(z.number().int().min(1).max(7)).max(7), pins: z.array(pinSchema).min(1).max(5000),
});

/** Verify every normalized child before using a stored proposal, even though UPDATE/DELETE are guarded. */
export function verifyStoredCatalogDraft(raw: unknown) {
  const parsed = storedRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  if ((row.scope.mode === "licensing") !== (row.moduleId !== null) ||
      !row.pins.some(pin => pin.include) || new Set(row.pins.map(pin => pin.linkId)).size !== row.pins.length ||
      row.pins.some(pin => row.scope.target !== "both" && pin.kind !== row.scope.target) ||
      (row.scope.mode === "manual" && row.pins.some(pin => !pin.include)) ||
      (row.assignmentMode === "role" && row.users.length !== 0) ||
      (row.frequency !== "weekly" && row.frequency !== "interval" && row.days.length !== 0) ||
      (row.frequency !== "weekly" && row.everyNWeeks !== null) ||
      (row.frequency !== "interval" && row.intervalDays !== null) ||
      (row.frequency !== "monthly" && row.dayOfMonth !== null) ||
      (row.frequency === "once" && row.endDate !== null)) return null;

  const selectedDays = row.days.map(day => weekdays[day-1]);
  const calendar = calendarSchema.safeParse({
    frequencyType: row.frequency, ...(row.endDate && { endDate: row.endDate }),
    ...(row.frequency === "weekly" && { everyNWeeks: row.everyNWeeks, weekdays: selectedDays }),
    ...(row.frequency === "interval" && { intervalDays: row.intervalDays, ...(selectedDays.length && { preferredWeekdays: selectedDays }) }),
    ...(row.frequency === "monthly" && { dayOfMonth: row.dayOfMonth }),
  });
  const usersFor = (kind: DraftPin["kind"]) => row.users.filter(user => user.kind === kind).map(user => user.id);
  const domainUsers = usersFor("domain"), databaseUsers = usersFor("database");
  const assignment = assignmentSchema.safeParse(row.assignmentMode === "role" ? { mode: "role",
    domainRole: row.domainRole ?? undefined, databaseRole: row.databaseRole ?? undefined } : { mode: "users",
    domainUsers: domainUsers.length ? domainUsers : undefined, databaseUsers: databaseUsers.length ? databaseUsers : undefined });
  if (!calendar.success || !assignment.success) return null;
  const definition = normalizeCatalogDraftDefinition({ scope: row.scope, calendar: calendar.data, assignment: assignment.data });
  if (!definition || (definition.roles.find(role => role.kind === "domain")?.id ?? null) !== row.domainRole ||
      (definition.roles.find(role => role.kind === "database")?.id ?? null) !== row.databaseRole ||
      draftDigest({ ...row, definition }).toString("hex") !== row.digest) return null;
  return { id: row.id, actorId: row.actorId, environment: row.environment, name: row.name, scope: row.scope,
    moduleId: row.moduleId, digest: row.digest, pins: orderPins(row.pins), definition, calendar: calendar.data };
}

/** For use inside the reservation transaction. Never use a proposal as an operation approval. */
export async function readVerifiedCatalogDraft(tx: sql.Transaction, claim: { id: string;
  actorId: string; portalEnvironment: DraftCatalogRequest["portalEnvironment"] }) {
  if (!uuid.test(claim.id) || !exactText(150).safeParse(claim.actorId).success ||
      !["qa","production"].includes(claim.portalEnvironment)) return null;
  const { recordset } = await tx.request().input("id", sql.UniqueIdentifier, claim.id)
    .input("actor", sql.NVarChar(150), claim.actorId).input("env", sql.VarChar(10), claim.portalEnvironment)
    .query<{ body: string }>(`
      SELECT (
        SELECT LOWER(CONVERT(char(36),p.proposal_id)) AS id,p.portal_environment AS environment,p.requester_source_id AS actorId,p.name,
          p.selection_mode AS [scope.mode],CONVERT(char(10),p.requested_date,23) AS [scope.date],
          p.target_type AS [scope.target],p.target_environment AS [scope.environment],
          LOWER(CONVERT(char(36),p.catalog_customer_id)) AS [scope.customerId],
          LOWER(CONVERT(char(64),p.domain_choice_hash,2)) AS [scope.domainChoiceId],
          COALESCE(m.source_id,N'') AS moduleId,LOWER(CONVERT(char(64),p.proposal_sha256,2)) AS digest,
          p.assignment_mode AS assignmentMode,p.domain_role AS domainRole,p.database_role AS databaseRole,
          p.frequency_type AS frequency,CONVERT(char(10),p.end_date,23) AS endDate,
          p.every_n_weeks AS everyNWeeks,p.interval_days AS intervalDays,p.day_of_month AS dayOfMonth,
          JSON_QUERY((SELECT TOP (5001) LOWER(CONVERT(char(36),ln.link_id)) AS linkId,
            LOWER(CONVERT(char(36),ln.target_id)) AS physicalId,ln.kind,ln.included AS include
            FROM scheduling.catalog_schedule_draft_proposal_links ln WITH (HOLDLOCK)
            WHERE ln.proposal_id=p.proposal_id ORDER BY ln.link_id FOR JSON PATH)) AS pins,
          JSON_QUERY((SELECT TOP (201) a.kind,u.source_id AS id
            FROM scheduling.catalog_schedule_draft_proposal_assignees a WITH (HOLDLOCK)
            JOIN security.users u WITH (HOLDLOCK) ON u.user_key=a.user_key
            WHERE a.proposal_id=p.proposal_id ORDER BY a.kind,a.user_key FOR JSON PATH)) AS users,
          JSON_QUERY((SELECT w.weekday FROM scheduling.catalog_schedule_draft_proposal_weekdays w WITH (HOLDLOCK)
            WHERE w.proposal_id=p.proposal_id ORDER BY w.weekday FOR JSON PATH)) AS weekdays
        FROM scheduling.catalog_schedule_draft_proposals p WITH (UPDLOCK,HOLDLOCK)
        LEFT JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=p.license_module_key
        WHERE p.proposal_id=@id AND p.portal_environment=@env AND p.requester_source_id=@actor COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(p.requester_source_id)=DATALENGTH(@actor)
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS body;`);
  if (recordset?.length !== 1 || typeof recordset[0].body !== "string" || !recordset[0].body) return null;
  let body: unknown;
  try { body = JSON.parse(recordset[0].body); } catch { return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { weekdays: dates, ...row } = body as Record<string, unknown>;
  return verifyStoredCatalogDraft({ domainRole: null, databaseRole: null, endDate: null, everyNWeeks: null, intervalDays: null,
    dayOfMonth: null, ...row, moduleId: row.moduleId === "" ? null : row.moduleId,
    days: Array.isArray(dates) ? dates.map(day => day?.weekday) : null });
}

type VerifiedDraft = NonNullable<ReturnType<typeof verifyStoredCatalogDraft>>;
type LivePin = { linkId: string; kind: DraftPin["kind"]; physicalId: string; targetSourceId: string;
  customerId: string; customerName: string; domainId: string; domainName: string };

/**
 * Build the SQL schedule definition from independently reproved bindings. Manual
 * selections travel separately as exact pins; a database's parent is only display
 * context, never permission to update that domain. The caller must persist the
 * pins and record the independent operation approval in the same transaction.
 */
export function buildCatalogDraftScheduleDefinition(draft: VerifiedDraft, evidence: readonly LivePin[], checkedAt: Date) {
  if (!Number.isFinite(checkedAt.valueOf()) || evidence.length !== draft.pins.length) return null;
  const today = new Date(checkedAt.valueOf() - 5 * 3_600_000).toISOString().slice(0, 10);
  if (today > draft.scope.date) return null;
  const byLink = new Map(evidence.map(pin => [pin.linkId, pin]));
  if (byLink.size !== evidence.length) return null;
  const logical = new Map<string, boolean>();
  const excludedDomainIds = new Set<string>(), excludedDatabaseIds = new Set<string>();
  let representative: LivePin | undefined;
  for (const pin of draft.pins) {
    const live = byLink.get(pin.linkId);
    if (!live || live.kind !== pin.kind || live.physicalId !== pin.physicalId ||
        ![live.targetSourceId,live.customerId,live.domainId].every(value => exactText(150).safeParse(value).success) ||
        ![live.customerName,live.domainName].every(value => exactText(512).safeParse(value).success) ||
        (pin.kind === "domain" && live.targetSourceId !== live.domainId)) return null;
    if (pin.include) representative ??= live;
    if (draft.scope.mode === "licensing") {
      const key = JSON.stringify([pin.kind, live.targetSourceId]);
      // The existing exclusions are by logical target. Never silently broaden
      // one when the reviewed selection includes another alias of that target.
      if (logical.has(key) && logical.get(key) !== pin.include) return null;
      logical.set(key, pin.include);
      if (!pin.include) (pin.kind === "database" ? excludedDatabaseIds : excludedDomainIds).add(live.targetSourceId);
    }
  }
  if (!representative) return null;
  const targetTypes = draft.scope.target === "domain" ? "domains_only" :
    draft.scope.target === "database" ? "databases_only" : "domains_and_databases";
  const role = (kind: DraftPin["kind"]) => draft.definition.roles.find(item => item.kind === kind)?.id;
  const users = (kind: DraftPin["kind"]) => draft.definition.users.filter(item => item.kind === kind).map(item => item.id);
  const targetType = draft.scope.target === "database" ? "database" : "domain";
  const assignedRole = role(targetType);
  if (!assignedRole) return null;
  const at = checkedAt.toISOString();
  const record: UpdateSchedule = {
    id: `catalog-draft-${draft.id}`, name: draft.name, clientId: representative.customerId, clientName: representative.customerName,
    domainId: representative.domainId, domainName: representative.domainName, targetType, targetIds: [],
    ...draft.calendar, startDate: draft.scope.date, timezone: "America/Bogota", active: true, origin: "special",
    selectionMode: draft.scope.mode, assignedRole, assignmentMode: draft.definition.mode,
    assignedUserIds: users("domain"),
    domainAssignedRole: role("domain"), databaseAssignedRole: role("database"),
    databaseAssignedUserIds: users("database"), createdAt: at, updatedAt: at, createdBy: draft.actorId, updatedBy: draft.actorId,
    ...(draft.scope.mode === "manual" ? { manualTargetTypes: targetTypes, manualEnvironment: draft.scope.environment }
      : { licensingScope: { licenseModuleIds: [draft.moduleId!], licenseMatchMode: "all", targetTypes,
        environment: draft.scope.environment, activeOnly: true,
        excludedDomainIds: [...excludedDomainIds].sort(), excludedDatabaseIds: [...excludedDatabaseIds].sort() } }),
  };
  return { record, exactManualPins: draft.scope.mode === "manual" ? draft.pins.map(({ linkId, kind, physicalId }) =>
    ({ linkId, kind, targetId: physicalId })) : undefined };
}

/** Transaction boundary for a future independent approval consumer. No provision for approving the request here. */
export function withCatalogDraftDefinitionForApproval<T>(input: DraftCatalogRequest, draft: VerifiedDraft,
  consumeReviewed: (tx: sql.Transaction, definition: NonNullable<ReturnType<typeof buildCatalogDraftScheduleDefinition>>,
    options: { validUntil: Date; digest: string; proposalId: string; tightenDeadline: (until: Date) => void }) => Promise<T>,
  reprove = withReprovedCatalogDraft, read = readVerifiedCatalogDraft): Promise<T | null> {
  const { scope } = input, stored = draft.scope;
  if (input.actorId !== draft.actorId || input.portalEnvironment !== draft.environment || scope.date !== stored.date ||
      scope.target !== stored.target || scope.environment !== stored.environment || scope.mode !== stored.mode ||
      (scope.mode === "manual" && (stored.mode !== "manual" || scope.customerId !== stored.customerId ||
        scope.domainChoiceId !== stored.domainChoiceId))) return Promise.resolve(null);
  return reprove(input, draft, async (tx, { links, validUntil, tightenDeadline }) => {
    const locked = await read(tx, { id: draft.id, actorId: input.actorId, portalEnvironment: input.portalEnvironment });
    if (!locked || locked.digest !== draft.digest) return null;
    const definition = buildCatalogDraftScheduleDefinition(locked, links, input.checkedAt);
    if (!definition) return null;
    return consumeReviewed(tx, definition, { validUntil, digest: locked.digest, proposalId: locked.id, tightenDeadline });
  });
}

export function saveNewCatalogDraftProposal(input: ProposalRequest, verify = withVerifiedNewCatalogDraft): Promise<Outcome | null> {
  const definition = normalizeCatalogDraftDefinition(input);
  if (!definition) return Promise.resolve(null);
  return verify(input, async (tx, selected) => {
    const { scope, portalEnvironment, actorId, name } = input;
    const { intentId, moduleId, validUntil } = selected;
    const pins = orderPins(selected.pins);
    if (!uuid.test(intentId) || !pins.some(pin => pin.include) || pins.length > 5000 || new Set(pins.map(pin => pin.linkId)).size !== pins.length ||
      pins.some(pin => !uuid.test(pin.linkId) || !uuid.test(pin.physicalId) || (pin.kind !== "domain" && pin.kind !== "database")) ||
      (scope.mode === "licensing") !== Boolean(moduleId)) throw changed();
    const digest = draftDigest({ id: intentId, environment: portalEnvironment, actorId, name, scope, moduleId, pins, definition });
    const { recordset } = await tx.request().input("id", sql.UniqueIdentifier, intentId)
      .input("actor", sql.NVarChar(150), actorId).input("env", sql.VarChar(10), portalEnvironment)
      .input("name", sql.NVarChar(200), name).input("date", sql.VarChar(10), scope.date).input("mode", sql.VarChar(10), scope.mode)
      .input("kind", sql.VarChar(8), scope.target).input("targetEnv", sql.VarChar(10), scope.environment)
      .input("customer", sql.UniqueIdentifier, scope.mode === "manual" ? scope.customerId : null)
      .input("domainChoice", sql.VarBinary(32), scope.mode === "manual" && scope.domainChoiceId ? Buffer.from(scope.domainChoiceId,"hex") : null)
      .input("module", sql.NVarChar(150), moduleId).input("digest", sql.VarBinary(32), digest)
      .input("assignment", sql.VarChar(8), definition.mode).input("frequency", sql.VarChar(10), definition.frequency)
      .input("endDate", sql.VarChar(10), definition.endDate).input("weeks", sql.SmallInt, definition.everyNWeeks)
      .input("interval", sql.SmallInt, definition.intervalDays).input("dayOfMonth", sql.TinyInt, definition.dayOfMonth)
      .input("roles", sql.NVarChar(sql.MAX), JSON.stringify(definition.roles))
      .input("users", sql.NVarChar(sql.MAX), JSON.stringify(definition.users))
      .input("weekdays", sql.NVarChar(60), JSON.stringify(definition.days))
      .input("pins", sql.NVarChar(sql.MAX), JSON.stringify(pins)).input("until", sql.DateTime2(3), validUntil)
      .query<{ persisted: boolean }>(`
        DECLARE @now datetime2(3)=SYSUTCDATETIME(),@taskDate date=CONVERT(date,@date,23);
        IF @taskDate<CONVERT(date,DATEADD(hour,-5,@now)) OR @until<=@now RETURN;
        DECLARE @prior binary(32),@moduleKey bigint=NULL;
        SELECT @prior=p.proposal_sha256 FROM scheduling.catalog_schedule_draft_proposals p WITH (UPDLOCK,HOLDLOCK)
          WHERE p.proposal_id=@id;
        IF @prior IS NOT NULL
        BEGIN
          IF @prior=@digest AND EXISTS(SELECT 1 FROM scheduling.catalog_schedule_draft_proposals p
            WHERE p.proposal_id=@id AND p.requester_source_id=@actor AND p.portal_environment=@env)
            SELECT CONVERT(bit,1) AS persisted;
          RETURN;
        END;
        IF @module IS NOT NULL
        BEGIN
          SELECT @moduleKey=m.module_key FROM licensing.license_modules m WITH (HOLDLOCK)
            WHERE m.source_id=@module COLLATE Latin1_General_100_BIN2 AND DATALENGTH(m.source_id)=DATALENGTH(@module)
              AND m.status='active' AND m.deleted_at IS NULL;
          IF @moduleKey IS NULL RETURN;
        END;
        DECLARE @approvedRoles table(kind varchar(8) PRIMARY KEY, role_id nvarchar(80));
        INSERT @approvedRoles SELECT wanted.kind,r.role_id
        FROM OPENJSON(@roles) WITH(kind varchar(8),id nvarchar(80)) wanted
        JOIN security.roles r WITH (HOLDLOCK) ON r.role_id=wanted.id COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(r.role_id)=DATALENGTH(wanted.id) AND r.active=1
        WHERE @assignment='users' OR r.role_id=N'super_admin' OR
          ((CASE WHEN wanted.kind='domain' THEN r.domain_task_visibility ELSE r.database_task_visibility END) IN ('assigned','all')
            AND EXISTS(SELECT 1 FROM security.role_permissions rp WITH (HOLDLOCK)
              JOIN security.permissions p WITH (HOLDLOCK) ON p.permission_key=rp.permission_key AND p.active=1
              WHERE rp.role_id=r.role_id AND rp.permission_key=N'updates.tasks.view'));
        IF (SELECT COUNT(*) FROM @approvedRoles)<>(SELECT COUNT(*) FROM OPENJSON(@roles)) RETURN;
        DECLARE @approvedUsers table(kind varchar(8),user_key bigint,PRIMARY KEY(kind,user_key));
        INSERT @approvedUsers SELECT wanted.kind,u.user_key
        FROM OPENJSON(@users) WITH(kind varchar(8),id nvarchar(150)) wanted
        JOIN @approvedRoles lane ON lane.kind=wanted.kind
        JOIN security.users u WITH (HOLDLOCK) ON u.source_id=wanted.id COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(u.source_id)=DATALENGTH(wanted.id) AND u.active=1;
        IF (SELECT COUNT(*) FROM @approvedUsers)<>(SELECT COUNT(*) FROM OPENJSON(@users)) RETURN;
        INSERT scheduling.catalog_schedule_draft_proposals(proposal_id,portal_environment,requester_source_id,name,requested_date,
          selection_mode,target_type,target_environment,catalog_customer_id,domain_choice_hash,license_module_key,proposal_sha256,
          assignment_mode,frequency_type,end_date,every_n_weeks,interval_days,day_of_month,domain_role,database_role)
        SELECT @id,@env,@actor,@name,@taskDate,@mode,@kind,@targetEnv,@customer,@domainChoice,@moduleKey,@digest,
          @assignment,@frequency,CONVERT(date,@endDate,23),@weeks,@interval,@dayOfMonth,
          (SELECT role_id FROM @approvedRoles WHERE kind='domain'),(SELECT role_id FROM @approvedRoles WHERE kind='database');
        INSERT scheduling.catalog_schedule_draft_proposal_assignees(proposal_id,kind,user_key)
        SELECT @id,kind,user_key FROM @approvedUsers;
        INSERT scheduling.catalog_schedule_draft_proposal_weekdays(proposal_id,weekday)
        SELECT @id,CONVERT(tinyint,[value]) FROM OPENJSON(@weekdays);
        INSERT scheduling.catalog_schedule_draft_proposal_links(proposal_id,link_id,target_id,kind,included)
        SELECT @id,linkId,physicalId,kind,[include] FROM OPENJSON(@pins)
          WITH (linkId uniqueidentifier,physicalId uniqueidentifier,kind varchar(8),[include] bit);
        SELECT CONVERT(bit,1) AS persisted;`);
    if (recordset?.length !== 1 || recordset[0].persisted !== true) throw changed();
    return { id: intentId, status: "pending_approval" } as const;
  });
}

export function createNewCatalogDraftProposalHttp(io: {
  authorize: (req: HttpRequest) => Promise<Pick<DraftCatalogRequest, "actorId" | "allowedKinds" | "allowLicensing"> | { status: 401 | 403 }>;
  save: (input: Omit<ProposalRequest, "portalEnvironment" | "matchKeyVersion">) => Promise<Outcome | null>;
  now?: () => Date;
}) {
  const reply = (status: number, jsonBody: unknown): HttpResponseInit => ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
  const stale = () => reply(409, { error: "Verifique nuevamente el alcance y sus reservas antes de solicitar la programación." });
  return async (req: HttpRequest) => {
    try {
      const actor = await io.authorize(req);
      if ("status" in actor) return reply(actor.status, { error: "No tiene acceso a la solicitud." });
      const limit = 400_000;
      const declared = req.headers.get("content-length");
      if (declared && (!/^\d{1,7}$/.test(declared) || Number(declared) > limit)) return reply(413, { error: "Solicitud demasiado grande." });
      const raw = await req.text();
      if (Buffer.byteLength(raw) > limit) return reply(413, { error: "Solicitud demasiado grande." });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return reply(400, { error: "Solicitud inválida." }); }
      const parsed = schema.safeParse(body);
      if (!parsed.success) return reply(400, { error: "Indique un alcance y selección válidos." });
      const { scope } = parsed.data;
      if (!normalizeCatalogDraftDefinition(parsed.data)) return reply(400, { error: "Indique responsables y una frecuencia válidos para el alcance." });
      const kinds = scope.target === "both" ? ["domain", "database"] as const : [scope.target];
      if (kinds.some(kind => !actor.allowedKinds.includes(kind)) || (scope.mode === "licensing" && !actor.allowLicensing)) {
        return reply(403, { error: "No tiene acceso al alcance." });
      }
      const checkedAt = io.now?.() ?? new Date();
      const today = new Date(checkedAt.valueOf() - 5 * 3_600_000).toISOString().slice(0, 10);
      if (scope.date < today || Date.parse(scope.date) - Date.parse(today) > 7 * 24 * 3_600_000) return stale();
      const result = await io.save({ ...actor, ...parsed.data, checkedAt });
      return result ? reply(202, result) : stale();
    } catch (error) {
      return (error as { status?: number } | null)?.status === 409 ? stale() : reply(503, { error: "No se pudo guardar la solicitud." });
    }
  };
}
