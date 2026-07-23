import sql from "mssql";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";
import { cancelOpenSqlTasksForSchedule, cancelOpenSqlTasksForTarget } from "./workflowTaskCleanupSqlRepository";

type Actor = { id: string; email: string };
export type CascadeDependencies = { domains?: number; databases?: number; schedules: number; pendingTasks: number };
export type CascadeDeleteResult = { found: boolean; requiresCascade: boolean; dependencies: CascadeDependencies; obsoletedTasks: number; cascadeSchedules: number };

type HierarchyRow = {
  client_key: number; client_id: string; client_name: string;
  domain_key: number | null; domain_id: string | null; domain_name: string | null;
  database_key: number | null; database_id: string | null; company_name: string | null;
};

async function hierarchy(transaction: sql.Transaction, kind: "client" | "domain" | "database", id: string): Promise<HierarchyRow | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), id);
  const predicate = kind === "client" ? "client.source_id=@sourceId"
    : kind === "domain" ? "domain_record.source_id=@sourceId"
      : "database_record.source_id=@sourceId";
  const result = await request.query<HierarchyRow>(`
    SELECT TOP (1) client.client_key,client.source_id AS client_id,client.name AS client_name,
      domain_record.domain_key,domain_record.source_id AS domain_id,domain_record.domain_name,
      database_record.database_key,database_record.source_id AS database_id,database_record.company_name
    FROM core.clients client WITH (UPDLOCK,HOLDLOCK)
    LEFT JOIN core.domains domain_record WITH (UPDLOCK,HOLDLOCK) ON domain_record.client_key=client.client_key
    LEFT JOIN core.databases database_record WITH (UPDLOCK,HOLDLOCK) ON database_record.domain_key=domain_record.domain_key
    WHERE ${predicate}
    ORDER BY domain_record.domain_key,database_record.database_key;
  `);
  return result.recordset[0] ?? null;
}

async function dependencyCounts(transaction: sql.Transaction, kind: "client" | "domain" | "database", row: HierarchyRow): Promise<CascadeDependencies> {
  const request = new sql.Request(transaction);
  request.input("clientKey", sql.BigInt, row.client_key);
  request.input("domainKey", sql.BigInt, row.domain_key);
  request.input("databaseKey", sql.BigInt, row.database_key);
  const scope = kind === "client" ? "client_key=@clientKey" : kind === "domain" ? "domain_key=@domainKey" : "database_key=@databaseKey";
  const scheduleScope = kind === "client"
    ? "schedule_record.client_key=@clientKey"
    : kind === "domain"
      ? `(schedule_record.domain_key=@domainKey OR EXISTS(SELECT 1 FROM scheduling.schedule_targets target WHERE target.schedule_key=schedule_record.schedule_key AND target.domain_key=@domainKey))`
      : `EXISTS(SELECT 1 FROM scheduling.schedule_targets target WHERE target.schedule_key=schedule_record.schedule_key AND target.database_key=@databaseKey)`;
  const result = await request.query<{ domains: number; databases: number; schedules: number; tasks: number }>(`
    SELECT
      ${kind === "client" ? "(SELECT COUNT_BIG(*) FROM core.domains WHERE client_key=@clientKey AND status<>'deleted')" : "0"} AS domains,
      ${kind === "client" ? "(SELECT COUNT_BIG(*) FROM core.databases WHERE client_key=@clientKey AND status<>'deleted')" : kind === "domain" ? "(SELECT COUNT_BIG(*) FROM core.databases WHERE domain_key=@domainKey AND status<>'deleted')" : "0"} AS databases,
      (SELECT COUNT_BIG(*) FROM scheduling.update_schedules schedule_record WHERE schedule_record.deleted_at IS NULL AND ${scheduleScope}) AS schedules,
      (SELECT COUNT_BIG(*) FROM workflow.update_tasks WHERE ${scope} AND status NOT IN ('completed','cancelled')) AS tasks;
  `);
  const counts = result.recordset[0];
  return {
    ...(kind === "client" ? { domains: Number(counts.domains) } : {}),
    ...(kind !== "database" ? { databases: Number(counts.databases) } : {}),
    schedules: Number(counts.schedules), pendingTasks: Number(counts.tasks),
  };
}

async function deleteSchedules(
  transaction: sql.Transaction,
  kind: "client" | "domain" | "database",
  row: HierarchyRow,
  actor: Actor,
  now: Date,
): Promise<number> {
  const request = new sql.Request(transaction);
  request.input("clientKey", sql.BigInt, row.client_key);
  request.input("domainKey", sql.BigInt, row.domain_key);
  request.input("databaseKey", sql.BigInt, row.database_key);
  const predicate = kind === "client" ? "schedule_record.client_key=@clientKey"
    : kind === "domain"
      ? `(schedule_record.domain_key=@domainKey OR EXISTS(SELECT 1 FROM scheduling.schedule_targets target WHERE target.schedule_key=schedule_record.schedule_key AND target.domain_key=@domainKey))`
      : `EXISTS(SELECT 1 FROM scheduling.schedule_targets target WHERE target.schedule_key=schedule_record.schedule_key AND target.database_key=@databaseKey)`;
  const schedules = await request.query<{ schedule_key: number; source_id: string; client_id: string; client_name: string }>(`
    SELECT schedule_record.schedule_key,schedule_record.source_id,client.source_id AS client_id,client.name AS client_name
    FROM scheduling.update_schedules schedule_record WITH (UPDLOCK,HOLDLOCK)
    JOIN core.clients client ON client.client_key=schedule_record.client_key
    WHERE schedule_record.deleted_at IS NULL AND ${predicate};
  `);
  for (const schedule of schedules.recordset) {
    await cancelOpenSqlTasksForSchedule(transaction, schedule.source_id, actor, `cascade_from_${kind}`, now);
    const update = new sql.Request(transaction);
    update.input("scheduleKey", sql.BigInt, schedule.schedule_key);
    update.input("now", sql.DateTime2(3), now);
    update.input("actorId", sql.NVarChar(150), actor.id);
    await update.query(`UPDATE scheduling.update_schedules SET active=0,deleted_at=@now,deleted_by=@actorId,
      updated_at=@now,updated_by=@actorId WHERE schedule_key=@scheduleKey;`);
    await writeSqlAuditLog(transaction, {
      entityType: "schedule", entityId: schedule.source_id, clientId: schedule.client_id,
      clientName: schedule.client_name, domainId: row.domain_id ?? undefined, domainName: row.domain_name ?? undefined,
      action: "schedule_deleted_cascade", performedBy: actor.id, performedByEmail: actor.email,
      metadata: kind === "client" ? { cascadeFromClient: row.client_id }
        : kind === "domain" ? { cascadeFromDomain: row.domain_id }
          : { cascadeFromDatabase: row.database_id },
      before: { id: schedule.source_id, active: true }, after: { active: false },
    });
  }
  return schedules.recordset.length;
}

async function softDeleteDatabases(
  transaction: sql.Transaction,
  predicate: string,
  row: HierarchyRow,
  actor: Actor,
  now: Date,
  metadata: Record<string, unknown>,
  cancellationReason: string,
): Promise<number> {
  const request = new sql.Request(transaction);
  request.input("clientKey", sql.BigInt, row.client_key); request.input("domainKey", sql.BigInt, row.domain_key); request.input("databaseKey", sql.BigInt, row.database_key);
  const databases = await request.query<{ database_key: number; source_id: string; domain_id: string; domain_name: string; company_name: string }>(`
    SELECT database_record.database_key,database_record.source_id,domain_record.source_id AS domain_id,
      domain_record.domain_name,database_record.company_name
    FROM core.databases database_record WITH (UPDLOCK,HOLDLOCK)
    JOIN core.domains domain_record ON domain_record.domain_key=database_record.domain_key
    WHERE ${predicate} AND database_record.status<>'deleted';
  `);
  let cancelledTasks = 0;
  for (const database of databases.recordset) {
    cancelledTasks += await cancelOpenSqlTasksForTarget(
      transaction,
      { type: "database", key: database.database_key },
      actor,
      cancellationReason,
      now,
    );
    const update = new sql.Request(transaction); update.input("key", sql.BigInt, database.database_key); update.input("now", sql.DateTime2(3), now); update.input("actorId", sql.NVarChar(150), actor.id);
    await update.query(`UPDATE core.databases SET status='deleted',deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId WHERE database_key=@key;
      UPDATE licensing.license_assignments SET status='deleted',deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId WHERE database_key=@key AND status<>'deleted';`);
    await writeSqlAuditLog(transaction, { entityType: "database", entityId: database.source_id,
      clientId: row.client_id, clientName: row.client_name, domainId: database.domain_id, domainName: database.domain_name,
      companyName: database.company_name, action: "database_deleted_cascade", performedBy: actor.id, performedByEmail: actor.email,
      metadata, before: { id: database.source_id, status: "active" }, after: { status: "deleted" } });
  }
  return cancelledTasks;
}

export async function deleteSqlCoreCascade(
  kind: "client" | "domain" | "database",
  sourceId: string,
  cascade: boolean,
  actor: Actor,
): Promise<CascadeDeleteResult> {
  return runSqlTransaction(async (transaction) => {
    const row = await hierarchy(transaction, kind, sourceId);
    const empty: CascadeDeleteResult = { found: false, requiresCascade: false, dependencies: { schedules: 0, pendingTasks: 0 }, obsoletedTasks: 0, cascadeSchedules: 0 };
    if (!row) return empty;
    const dependencies = await dependencyCounts(transaction, kind, row);
    const dependencyTotal = Object.values(dependencies).reduce((sum, count) => sum + Number(count ?? 0), 0);
    if (!cascade && dependencyTotal > 0) return { ...empty, found: true, requiresCascade: true, dependencies };
    const now = new Date();
    const cascadeSchedules = await deleteSchedules(transaction, kind, row, actor, now);
    let obsoletedTasks = 0;
    if (kind === "database" && row.database_key) {
      obsoletedTasks = await softDeleteDatabases(transaction, "database_record.database_key=@databaseKey", row, actor, now,
        { cascadeFromDatabase: row.database_id }, "target_database_deleted");
    } else {
      const domainsRequest = new sql.Request(transaction);
      domainsRequest.input("clientKey", sql.BigInt, row.client_key); domainsRequest.input("domainKey", sql.BigInt, row.domain_key);
      const domains = await domainsRequest.query<{ domain_key: number; source_id: string; domain_name: string }>(`
        SELECT domain_key,source_id,domain_name FROM core.domains WITH (UPDLOCK,HOLDLOCK)
        WHERE ${kind === "client" ? "client_key=@clientKey" : "domain_key=@domainKey"} AND status<>'deleted';
      `);
      for (const domain of domains.recordset) {
        obsoletedTasks += await cancelOpenSqlTasksForTarget(transaction, { type: "domain", key: domain.domain_key }, actor, "target_domain_deleted", now);
      }
      obsoletedTasks += await softDeleteDatabases(
        transaction,
        kind === "client" ? "database_record.client_key=@clientKey" : "database_record.domain_key=@domainKey",
        row,
        actor,
        now,
        kind === "client" ? { cascadeFromClient: row.client_id } : { cascadeFromDomain: row.domain_id },
        kind === "client" ? "target_client_deleted" : "target_domain_deleted",
      );
      for (const domain of domains.recordset) {
        const update = new sql.Request(transaction); update.input("key", sql.BigInt, domain.domain_key); update.input("now", sql.DateTime2(3), now); update.input("actorId", sql.NVarChar(150), actor.id);
        await update.query(`UPDATE core.domains SET status='deleted',deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId WHERE domain_key=@key;
          UPDATE licensing.license_assignments SET status='deleted',deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId WHERE domain_key=@key AND status<>'deleted';`);
        await writeSqlAuditLog(transaction, { entityType: "domain", entityId: domain.source_id,
          clientId: row.client_id, clientName: row.client_name, domainId: domain.source_id, domainName: domain.domain_name,
          action: "domain_deleted_cascade", performedBy: actor.id, performedByEmail: actor.email,
          metadata: kind === "client" ? { cascadeFromClient: row.client_id } : { cascadeFromDomain: row.domain_id },
          before: { id: domain.source_id, status: "active" }, after: { status: "deleted" } });
      }
      if (kind === "client") {
        const update = new sql.Request(transaction); update.input("key", sql.BigInt, row.client_key); update.input("now", sql.DateTime2(3), now); update.input("actorId", sql.NVarChar(150), actor.id);
        await update.query(`UPDATE core.clients SET status='deleted',deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId WHERE client_key=@key;
          UPDATE licensing.license_assignments SET status='deleted',deleted_at=@now,deleted_by=@actorId,updated_at=@now,updated_by=@actorId WHERE client_key=@key AND status<>'deleted';`);
        await writeSqlAuditLog(transaction, { entityType: "client", entityId: row.client_id, clientId: row.client_id,
          clientName: row.client_name, action: "client_deleted_cascade", performedBy: actor.id, performedByEmail: actor.email,
          metadata: dependencies, before: { id: row.client_id, status: "active" }, after: { status: "deleted" } });
      }
    }
    if (kind === "domain" && row.domain_key) {
      // Domain was already deleted in the shared branch; this audit is included there.
    }
    return { found: true, requiresCascade: false, dependencies, obsoletedTasks, cascadeSchedules };
  });
}
