import sql from "mssql";
import type { UpdateSchedule, Weekday } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { normalizeEmail } from "./password";
import { runSqlTransaction } from "./sqlTransaction";
import { cancelOpenSqlTasksForSchedule } from "./workflowTaskCleanupSqlRepository";

type Actor = { id: string; email: string };

const weekdayNumber: Record<Weekday, number> = {
  MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4,
  FRIDAY: 5, SATURDAY: 6, SUNDAY: 7,
};

async function resolveScheduleOwner(
  transaction: sql.Transaction,
  record: UpdateSchedule,
): Promise<{ clientKey: number; clientName: string; domainKey: number | null; domainName: string | null }> {
  const request = new sql.Request(transaction);
  request.input("clientId", sql.NVarChar(150), record.clientId);
  request.input("domainId", sql.NVarChar(150), record.domainId ?? null);
  const result = await request.query<{ client_key: number; client_name: string; domain_key: number | null; domain_name: string | null }>(`
    SELECT client.client_key,client.name AS client_name,domain_record.domain_key,domain_record.domain_name
    FROM core.clients client WITH (UPDLOCK,HOLDLOCK)
    LEFT JOIN core.domains domain_record WITH (UPDLOCK,HOLDLOCK)
      ON domain_record.client_key=client.client_key AND domain_record.source_id=@domainId
    WHERE client.source_id=@clientId AND client.status='active';
  `);
  const owner = result.recordset[0];
  if (!owner) throw Object.assign(new Error("Cliente no encontrado o inactivo."), { status: 400 });
  if (record.domainId && !owner.domain_key) throw Object.assign(new Error("El dominio no pertenece al cliente."), { status: 400 });
  return { clientKey: owner.client_key, clientName: owner.client_name, domainKey: owner.domain_key, domainName: owner.domain_name };
}

async function scheduleKey(transaction: sql.Transaction, sourceId: string, lock = true): Promise<number | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), sourceId);
  const result = await request.query<{ schedule_key: number }>(`
    SELECT schedule_key FROM scheduling.update_schedules ${lock ? "WITH (UPDLOCK,HOLDLOCK)" : ""}
    WHERE source_id=@sourceId;
  `);
  return result.recordset[0]?.schedule_key ?? null;
}

async function replaceWeekdays(transaction: sql.Transaction, key: number, record: UpdateSchedule): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("scheduleKey", sql.BigInt, key);
  await remove.query("DELETE scheduling.schedule_weekdays WHERE schedule_key=@scheduleKey;");
  const entries: Array<{ kind: "weekly" | "preferred"; day: number }> = [
    ...(record.weekdays ?? []).map((day) => ({ kind: "weekly" as const, day: weekdayNumber[day] })),
    ...(record.preferredWeekdays ?? []).map((day) => ({ kind: "preferred" as const, day: weekdayNumber[day] })),
  ];
  for (const entry of entries) {
    const insert = new sql.Request(transaction);
    insert.input("scheduleKey", sql.BigInt, key);
    insert.input("kind", sql.VarChar(20), entry.kind);
    insert.input("weekday", sql.TinyInt, entry.day);
    await insert.query("INSERT scheduling.schedule_weekdays(schedule_key,kind,weekday) VALUES(@scheduleKey,@kind,@weekday);");
  }
}

async function replaceTargets(transaction: sql.Transaction, key: number, clientKey: number, record: UpdateSchedule): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("scheduleKey", sql.BigInt, key);
  await remove.query("DELETE scheduling.schedule_targets WHERE schedule_key=@scheduleKey;");
  for (const targetId of [...new Set(record.targetIds ?? [])]) {
    const insert = new sql.Request(transaction);
    insert.input("scheduleKey", sql.BigInt, key);
    insert.input("clientKey", sql.BigInt, clientKey);
    insert.input("targetId", sql.NVarChar(150), targetId);
    insert.input("targetType", sql.VarChar(20), record.targetType);
    const result = await insert.query(`
      INSERT scheduling.schedule_targets(schedule_key,client_key,target_type,domain_key,database_key)
      SELECT @scheduleKey,@clientKey,@targetType,
        CASE WHEN @targetType='domain' THEN domain_record.domain_key END,
        CASE WHEN @targetType='database' THEN database_record.database_key END
      FROM (VALUES(1)) seed(value)
      LEFT JOIN core.domains domain_record
        ON @targetType='domain' AND domain_record.source_id=@targetId AND domain_record.client_key=@clientKey AND domain_record.status='active'
      LEFT JOIN core.databases database_record
        ON @targetType='database' AND database_record.source_id=@targetId AND database_record.client_key=@clientKey AND database_record.status='active'
      WHERE (@targetType='domain' AND domain_record.domain_key IS NOT NULL)
         OR (@targetType='database' AND database_record.database_key IS NOT NULL);
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) {
      throw Object.assign(new Error("Un objetivo no pertenece al cliente o no está activo."), { status: 400 });
    }
  }
}

async function replaceAssignees(transaction: sql.Transaction, key: number, record: UpdateSchedule): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("scheduleKey", sql.BigInt, key);
  await remove.query("DELETE scheduling.schedule_assignees WHERE schedule_key=@scheduleKey;");
  const entries = [
    ...(record.assignedUserIds ?? []).map((id) => ({ id, kind: "general" })),
    ...(record.databaseAssignedUserIds ?? []).map((id) => ({ id, kind: "database" })),
  ];
  for (const entry of entries.filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id && other.kind === candidate.kind) === index)) {
    const insert = new sql.Request(transaction);
    insert.input("scheduleKey", sql.BigInt, key);
    insert.input("userId", sql.NVarChar(150), entry.id);
    insert.input("kind", sql.VarChar(20), entry.kind);
    const result = await insert.query(`
      INSERT scheduling.schedule_assignees(schedule_key,assignment_kind,user_key)
      SELECT @scheduleKey,@kind,user_key FROM security.users WHERE source_id=@userId AND active=1;
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) {
      throw Object.assign(new Error("Un responsable no existe o está inactivo."), { status: 400 });
    }
  }
}

async function replaceReminders(transaction: sql.Transaction, key: number, record: UpdateSchedule): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("scheduleKey", sql.BigInt, key);
  await remove.query(`
    DELETE scheduling.schedule_reminder_emails WHERE schedule_key=@scheduleKey;
    DELETE scheduling.schedule_reminder_days WHERE schedule_key=@scheduleKey;
    DELETE scheduling.schedule_reminder_settings WHERE schedule_key=@scheduleKey;
  `);
  if (!record.reminders) return;
  const reminder = new sql.Request(transaction);
  reminder.input("scheduleKey", sql.BigInt, key);
  reminder.input("enabled", sql.Bit, record.reminders.remindersEnabled);
  reminder.input("time", sql.VarChar(5), record.reminders.reminderTime ?? "08:00");
  reminder.input("mode", sql.VarChar(40), record.reminders.reminderRecipientsMode ?? "roleUsers");
  await reminder.query(`
    INSERT scheduling.schedule_reminder_settings
      (schedule_key,reminders_enabled,reminder_time,reminder_recipients_mode)
    VALUES(@scheduleKey,@enabled,CONVERT(time(0),@time),@mode);
  `);
  for (const days of [...new Set(record.reminders.reminderDaysBefore ?? [])]) {
    const insert = new sql.Request(transaction);
    insert.input("scheduleKey", sql.BigInt, key);
    insert.input("days", sql.SmallInt, days);
    await insert.query("INSERT scheduling.schedule_reminder_days(schedule_key,days_before) VALUES(@scheduleKey,@days);");
  }
  for (const rawEmail of [...new Set(record.reminders.customReminderEmails ?? [])]) {
    const email = normalizeEmail(rawEmail);
    const insert = new sql.Request(transaction);
    insert.input("scheduleKey", sql.BigInt, key);
    insert.input("email", sql.NVarChar(254), email);
    await insert.query("INSERT scheduling.schedule_reminder_emails(schedule_key,email_normalized) VALUES(@scheduleKey,@email);");
  }
}

async function replaceManualScope(transaction: sql.Transaction, key: number, record: UpdateSchedule): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("scheduleKey", sql.BigInt, key);
  await remove.query(`
    DELETE scope_database FROM scheduling.scope_databases scope_database
      JOIN scheduling.scope_domains scope_domain ON scope_domain.scope_domain_key=scope_database.scope_domain_key
      JOIN scheduling.scope_groups scope_group ON scope_group.scope_group_key=scope_domain.scope_group_key
      WHERE scope_group.schedule_key=@scheduleKey;
    DELETE scope_domain FROM scheduling.scope_domains scope_domain
      JOIN scheduling.scope_groups scope_group ON scope_group.scope_group_key=scope_domain.scope_group_key
      WHERE scope_group.schedule_key=@scheduleKey;
    DELETE scheduling.scope_groups WHERE schedule_key=@scheduleKey;
  `);
  for (const [groupOrdinal, group] of (record.scopeGroups ?? []).entries()) {
    const groupInsert = new sql.Request(transaction);
    groupInsert.input("scheduleKey", sql.BigInt, key);
    groupInsert.input("ordinal", sql.Int, groupOrdinal);
    groupInsert.input("clientId", sql.NVarChar(150), group.clientId);
    groupInsert.input("allDomains", sql.Bit, group.includeAllDomains);
    const groupResult = await groupInsert.query<{ scope_group_key: number; client_key: number }>(`
      INSERT scheduling.scope_groups(schedule_key,ordinal,client_key,include_all_domains)
      OUTPUT INSERTED.scope_group_key,INSERTED.client_key
      SELECT @scheduleKey,@ordinal,client_key,@allDomains
      FROM core.clients WHERE source_id=@clientId AND status='active';
    `);
    const insertedGroup = groupResult.recordset[0];
    if (!insertedGroup) throw Object.assign(new Error("Un grupo de alcance contiene un cliente inválido."), { status: 400 });
    for (const [domainOrdinal, domain] of group.domains.entries()) {
      const domainInsert = new sql.Request(transaction);
      domainInsert.input("groupKey", sql.BigInt, insertedGroup.scope_group_key);
      domainInsert.input("clientKey", sql.BigInt, insertedGroup.client_key);
      domainInsert.input("ordinal", sql.Int, domainOrdinal);
      domainInsert.input("domainId", sql.NVarChar(150), domain.domainId);
      domainInsert.input("allDatabases", sql.Bit, domain.includeAllDatabases);
      const domainResult = await domainInsert.query<{ scope_domain_key: number; domain_key: number; client_key: number }>(`
        INSERT scheduling.scope_domains(scope_group_key,ordinal,client_key,domain_key,include_all_databases)
        OUTPUT INSERTED.scope_domain_key,INSERTED.domain_key,INSERTED.client_key
        SELECT @groupKey,@ordinal,@clientKey,domain_key,@allDatabases
        FROM core.domains WHERE source_id=@domainId AND client_key=@clientKey AND status='active';
      `);
      const insertedDomain = domainResult.recordset[0];
      if (!insertedDomain) throw Object.assign(new Error("Un grupo de alcance contiene un dominio inválido."), { status: 400 });
      for (const databaseId of [...new Set(domain.databaseIds)]) {
        const databaseInsert = new sql.Request(transaction);
        databaseInsert.input("scopeDomainKey", sql.BigInt, insertedDomain.scope_domain_key);
        databaseInsert.input("domainKey", sql.BigInt, insertedDomain.domain_key);
        databaseInsert.input("clientKey", sql.BigInt, insertedDomain.client_key);
        databaseInsert.input("databaseId", sql.NVarChar(150), databaseId);
        const databaseResult = await databaseInsert.query(`
          INSERT scheduling.scope_databases(scope_domain_key,domain_key,client_key,database_key)
          SELECT @scopeDomainKey,@domainKey,@clientKey,database_key
          FROM core.databases
          WHERE source_id=@databaseId AND domain_key=@domainKey AND client_key=@clientKey AND status='active';
          SELECT @@ROWCOUNT AS inserted_count;
        `);
        if (Number(databaseResult.recordset[0]?.inserted_count ?? 0) !== 1) {
          throw Object.assign(new Error("Un grupo de alcance contiene una base de datos inválida."), { status: 400 });
        }
      }
    }
  }
}

async function replaceLicensingScope(transaction: sql.Transaction, key: number, record: UpdateSchedule): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("scheduleKey", sql.BigInt, key);
  await remove.query(`
    DELETE scheduling.licensing_excluded_databases WHERE schedule_key=@scheduleKey;
    DELETE scheduling.licensing_excluded_domains WHERE schedule_key=@scheduleKey;
    DELETE scheduling.licensing_scope_modules WHERE schedule_key=@scheduleKey;
    DELETE scheduling.licensing_scope WHERE schedule_key=@scheduleKey;
  `);
  if (record.selectionMode !== "licensing" || !record.licensingScope) return;
  const scope = record.licensingScope;
  const insert = new sql.Request(transaction);
  insert.input("scheduleKey", sql.BigInt, key);
  insert.input("matchMode", sql.VarChar(10), scope.licenseMatchMode);
  insert.input("environment", sql.VarChar(20), scope.environment === "all" ? null : scope.environment);
  insert.input("targetTypes", sql.VarChar(40), scope.targetTypes);
  insert.input("activeOnly", sql.Bit, scope.activeOnly);
  await insert.query(`
    INSERT scheduling.licensing_scope(schedule_key,license_match_mode,environment_id,target_types,active_only)
    VALUES(@scheduleKey,@matchMode,@environment,@targetTypes,@activeOnly);
  `);
  for (const moduleId of [...new Set(scope.licenseModuleIds)]) {
    const moduleInsert = new sql.Request(transaction);
    moduleInsert.input("scheduleKey", sql.BigInt, key);
    moduleInsert.input("moduleId", sql.NVarChar(150), moduleId);
    const result = await moduleInsert.query(`
      INSERT scheduling.licensing_scope_modules(schedule_key,module_key)
      SELECT @scheduleKey,module_key FROM licensing.license_modules WHERE source_id=@moduleId AND status='active';
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) throw Object.assign(new Error("Seleccione solo licencias activas."), { status: 400 });
  }
  for (const domainId of [...new Set(scope.excludedDomainIds ?? [])]) {
    const excluded = new sql.Request(transaction);
    excluded.input("scheduleKey", sql.BigInt, key);
    excluded.input("domainId", sql.NVarChar(150), domainId);
    const result = await excluded.query(`
      INSERT scheduling.licensing_excluded_domains(schedule_key,domain_key)
      SELECT @scheduleKey,domain_key FROM core.domains WHERE source_id=@domainId AND status='active';
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) throw Object.assign(new Error("Una excepción de dominio no es válida."), { status: 400 });
  }
  for (const databaseId of [...new Set(scope.excludedDatabaseIds ?? [])]) {
    const excluded = new sql.Request(transaction);
    excluded.input("scheduleKey", sql.BigInt, key);
    excluded.input("databaseId", sql.NVarChar(150), databaseId);
    const result = await excluded.query(`
      INSERT scheduling.licensing_excluded_databases(schedule_key,database_key)
      SELECT @scheduleKey,database_key FROM core.databases WHERE source_id=@databaseId AND status='active';
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) throw Object.assign(new Error("Una excepción de base de datos no es válida."), { status: 400 });
  }
}

async function replaceScheduleChildren(transaction: sql.Transaction, key: number, clientKey: number, record: UpdateSchedule): Promise<void> {
  await replaceWeekdays(transaction, key, record);
  await replaceTargets(transaction, key, clientKey, record);
  await replaceAssignees(transaction, key, record);
  await replaceReminders(transaction, key, record);
  await replaceManualScope(transaction, key, record);
  await replaceLicensingScope(transaction, key, record);
}

function bindSchedule(request: sql.Request, record: UpdateSchedule, actor: Actor, owner: Awaited<ReturnType<typeof resolveScheduleOwner>>): void {
  request.input("sourceId", sql.NVarChar(150), record.id);
  request.input("clientKey", sql.BigInt, owner.clientKey);
  request.input("clientName", sql.NVarChar(200), owner.clientName);
  request.input("domainKey", sql.BigInt, owner.domainKey);
  request.input("domainName", sql.NVarChar(500), owner.domainName);
  request.input("name", sql.NVarChar(240), record.name);
  request.input("targetType", sql.VarChar(20), record.targetType);
  request.input("frequencyType", sql.VarChar(20), record.frequencyType);
  request.input("everyNWeeks", sql.SmallInt, record.everyNWeeks ?? null);
  request.input("intervalDays", sql.Int, record.intervalDays ?? null);
  request.input("dayOfMonth", sql.TinyInt, record.dayOfMonth ?? null);
  request.input("startDate", sql.Date, record.startDate);
  request.input("endDate", sql.Date, record.endDate ?? null);
  request.input("timezone", sql.NVarChar(100), record.timezone);
  request.input("assignedRole", sql.NVarChar(80), record.assignedRole);
  request.input("domainRole", sql.NVarChar(80), record.domainAssignedRole ?? null);
  request.input("databaseRole", sql.NVarChar(80), record.databaseAssignedRole ?? null);
  request.input("databaseReminderMode", sql.VarChar(40), record.databaseReminderRecipientsMode ?? null);
  request.input("selectionMode", sql.VarChar(20), record.selectionMode ?? "manual");
  request.input("manualTargetTypes", sql.VarChar(40), record.manualTargetTypes ?? "domains_and_databases");
  request.input("assignmentMode", sql.VarChar(20), record.assignmentMode ?? "role");
  request.input("origin", sql.NVarChar(80), record.origin ?? null);
  request.input("active", sql.Bit, record.active);
  request.input("completedAt", sql.DateTime2(3), record.completedAt ? new Date(record.completedAt) : null);
  request.input("completedReason", sql.NVarChar(160), record.completedReason ?? null);
  request.input("notes", sql.NVarChar(sql.MAX), record.notes ?? null);
  request.input("updatedAt", sql.DateTime2(3), new Date(record.updatedAt));
  request.input("updatedBy", sql.NVarChar(150), actor.id);
}

export async function createSqlSchedule(record: UpdateSchedule, actor: Actor): Promise<UpdateSchedule> {
  return runSqlTransaction(async (transaction) => {
    const owner = await resolveScheduleOwner(transaction, record);
    const request = new sql.Request(transaction);
    bindSchedule(request, record, actor, owner);
    request.input("createdAt", sql.DateTime2(3), new Date(record.createdAt));
    request.input("createdBy", sql.NVarChar(150), actor.id);
    const result = await request.query<{ schedule_key: number }>(`
      INSERT scheduling.update_schedules
      (source_id,client_key,client_name_snapshot,domain_key,domain_name_snapshot,name,target_type,
       frequency_type,every_n_weeks,interval_days,day_of_month,start_date,end_date,timezone,
       assigned_role,domain_assigned_role,database_assigned_role,database_reminder_recipients_mode,
       selection_mode,manual_target_types,assignment_mode,origin,active,completed_at,completed_reason,
       notes,created_at,created_by,updated_at,updated_by)
      OUTPUT INSERTED.schedule_key
      VALUES
      (@sourceId,@clientKey,@clientName,@domainKey,@domainName,@name,@targetType,
       @frequencyType,@everyNWeeks,@intervalDays,@dayOfMonth,@startDate,@endDate,@timezone,
       @assignedRole,@domainRole,@databaseRole,@databaseReminderMode,
       @selectionMode,@manualTargetTypes,@assignmentMode,@origin,@active,@completedAt,@completedReason,
       @notes,@createdAt,@createdBy,@updatedAt,@updatedBy);
    `);
    const key = result.recordset[0]?.schedule_key;
    if (!key) throw new Error("No se pudo crear la programación SQL.");
    await replaceScheduleChildren(transaction, key, owner.clientKey, record);
    await writeSqlAuditLog(transaction, {
      entityType: "schedule", entityId: record.id, clientId: record.clientId,
      clientName: owner.clientName, action: "schedule_created",
      performedBy: actor.id, performedByEmail: actor.email, after: record,
    });
    return { ...record, clientName: owner.clientName, domainName: owner.domainName ?? undefined };
  });
}

export async function updateSqlSchedule(before: UpdateSchedule, after: UpdateSchedule, actor: Actor): Promise<{ schedule: UpdateSchedule; cancelledTasks: number } | null> {
  return runSqlTransaction(async (transaction) => {
    const key = await scheduleKey(transaction, before.id);
    if (!key) return null;
    const owner = await resolveScheduleOwner(transaction, after);
    let cancelledTasks = 0;
    if (before.frequencyType === "once" && after.frequencyType === "once" && before.startDate !== after.startDate) {
      cancelledTasks = await cancelOpenSqlTasksForSchedule(transaction, before.id, actor, "one_time_schedule_rescheduled", new Date());
    }
    const request = new sql.Request(transaction);
    bindSchedule(request, after, actor, owner);
    await request.query(`
      UPDATE scheduling.update_schedules SET client_key=@clientKey,client_name_snapshot=@clientName,
        domain_key=@domainKey,domain_name_snapshot=@domainName,name=@name,target_type=@targetType,
        frequency_type=@frequencyType,every_n_weeks=@everyNWeeks,interval_days=@intervalDays,
        day_of_month=@dayOfMonth,start_date=@startDate,end_date=@endDate,timezone=@timezone,
        assigned_role=@assignedRole,domain_assigned_role=@domainRole,database_assigned_role=@databaseRole,
        database_reminder_recipients_mode=@databaseReminderMode,selection_mode=@selectionMode,
        manual_target_types=@manualTargetTypes,assignment_mode=@assignmentMode,origin=@origin,active=@active,
        completed_at=@completedAt,completed_reason=@completedReason,notes=@notes,
        updated_at=@updatedAt,updated_by=@updatedBy
      WHERE source_id=@sourceId AND deleted_at IS NULL;
    `);
    await replaceScheduleChildren(transaction, key, owner.clientKey, after);
    await writeSqlAuditLog(transaction, {
      entityType: "schedule", entityId: after.id, clientId: after.clientId,
      clientName: owner.clientName, action: "schedule_updated",
      performedBy: actor.id, performedByEmail: actor.email, before, after,
      metadata: cancelledTasks ? {
        oneTimeScheduleRescheduled: true, oldDate: before.startDate,
        newDate: after.startDate, cancelledOpenTasks: cancelledTasks,
      } : undefined,
    });
    return { schedule: { ...after, clientName: owner.clientName, domainName: owner.domainName ?? undefined }, cancelledTasks };
  });
}

export async function setSqlScheduleActive(record: UpdateSchedule, active: boolean, actor: Actor, action: string): Promise<UpdateSchedule | null> {
  return runSqlTransaction(async (transaction) => {
    const key = await scheduleKey(transaction, record.id);
    if (!key) return null;
    const now = new Date();
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("active", sql.Bit, active);
    request.input("completedAt", sql.DateTime2(3), active ? null : record.completedAt ? new Date(record.completedAt) : null);
    request.input("completedReason", sql.NVarChar(160), active ? null : record.completedReason ?? null);
    request.input("updatedAt", sql.DateTime2(3), now);
    request.input("updatedBy", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE scheduling.update_schedules SET active=@active,completed_at=@completedAt,
        completed_reason=@completedReason,updated_at=@updatedAt,updated_by=@updatedBy
      WHERE source_id=@sourceId AND deleted_at IS NULL;
    `);
    if (!active) await cancelOpenSqlTasksForSchedule(transaction, record.id, actor, "schedule_deactivated_or_deleted", now);
    const after = { ...record, active, completedAt: active ? null : record.completedAt, completedReason: active ? null : record.completedReason, updatedAt: now.toISOString(), updatedBy: actor.id };
    await writeSqlAuditLog(transaction, {
      entityType: "schedule", entityId: record.id, clientId: record.clientId,
      clientName: record.clientName, action, performedBy: actor.id, performedByEmail: actor.email,
      before: record, after,
    });
    return after;
  });
}

export async function deleteSqlSchedule(record: UpdateSchedule, actor: Actor): Promise<{ deleted: boolean; cancelledTasks: number }> {
  return runSqlTransaction(async (transaction) => {
    const key = await scheduleKey(transaction, record.id);
    if (!key) return { deleted: false, cancelledTasks: 0 };
    const now = new Date();
    const cancelledTasks = await cancelOpenSqlTasksForSchedule(transaction, record.id, actor, "schedule_deactivated_or_deleted", now);
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE scheduling.update_schedules SET active=0,deleted_at=COALESCE(deleted_at,@now),
        deleted_by=COALESCE(deleted_by,@actorId),updated_at=@now,updated_by=@actorId
      WHERE source_id=@sourceId;
    `);
    await writeSqlAuditLog(transaction, {
      entityType: "schedule", entityId: record.id, clientId: record.clientId,
      clientName: record.clientName, action: "schedule_deleted",
      performedBy: actor.id, performedByEmail: actor.email,
      metadata: { cancelledOpenTasks: cancelledTasks }, before: record,
    });
    return { deleted: true, cancelledTasks };
  });
}
