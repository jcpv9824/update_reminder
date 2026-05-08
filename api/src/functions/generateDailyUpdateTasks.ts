import { app, InvocationContext, Timer } from "@azure/functions";
import { getContainer } from "../lib/cosmos";
import { writeAuditLog } from "../lib/audit";
import { expandSchedulesWithDomainInheritance, expectedTaskKeysForDate, obsoleteTasksOutsideExpected, summarizeTaskGenerationForDate } from "../lib/taskGenerator";
import { isScheduleDueOnDate } from "../lib/scheduleEngine";
import type { DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

function todayInBogotaIso(): string {
  // America/Bogota es UTC-5 sin horario de verano.
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bogota = new Date(utcMs - 5 * 3600_000);
  return bogota.toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function listDatesInWindow(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let cur = startIso;
  while (cur <= endIso) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

async function resolveTargetName(
  targetType: "domain" | "database",
  targetId: string,
  domains: DomainRecord[],
  databases: DatabaseRecord[]
): Promise<string> {
  if (targetType === "database") {
    const db = databases.find((d) => d.id === targetId);
    if (!db) return targetId;
    return `${db.companyName} / ${db.dbAccess.initialCatalog}`;
  } else {
    const dom = domains.find((d) => d.id === targetId);
    if (!dom) return targetId;
    return dom.domainName;
  }
}

export type GenerationResult = {
  date: string;
  created: number;
  updated: number;
  obsoleted: number;
  skipped: number;
  windowStart: string;
  windowEnd: string;
  message: string;
  diagnostics: {
    activeClients: number;
    activeDomains: number;
    activeDatabases: number;
    activeSchedules: number;
    schedulesEvaluated: number;
    candidateDates: string[];
    expectedTasks: number;
    existingTasks: number;
    createdTasks: number;
    updatedTasks: number;
    obsoletedTasks: number;
    preservedCompletedTasks: number;
    eligibleDomainTasks: number;
    eligibleDatabaseTasks: number;
    createdDomainTasks: number;
    createdDatabaseTasks: number;
    skippedDomainTasks: number;
    skippedDatabaseTasks: number;
    reasons: string[];
  };
};

// Evalúa todas las fechas dentro de la ventana [windowStart, windowEnd] y
// genera tareas para cada candidato. La generación incluye:
//   - tareas de dominio por cada schedule de dominio.
//   - tareas de base de datos heredadas del schedule del dominio (para
//     bases asociadas y activas que no tengan schedule específico).
export async function runTaskGeneration(
  isoDate: string,
  log: (msg: string) => void,
  opts: { windowStart?: string; windowEnd?: string } = {}
): Promise<GenerationResult> {
  const windowStart = opts.windowStart ?? addDaysIso(isoDate, -7);
  const windowEnd = opts.windowEnd ?? addDaysIso(isoDate, 7);
  const ventana = listDatesInWindow(windowStart, windowEnd);

  const { resources: schedules } = await getContainer("updateSchedules")
    .items.query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.active = true" })
    .fetchAll();
  const { resources: clients } = await getContainer("clients")
    .items.query<any>({ query: "SELECT * FROM c WHERE c.status = 'active'" })
    .fetchAll();
  const { resources: domainsRaw } = await getContainer("domains")
    .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.status = 'active'" })
    .fetchAll();
  const { resources: databasesRaw } = await getContainer("databases")
    .items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.status = 'active'" })
    .fetchAll();
  const activeClientIds = new Set(clients.map((c: any) => c.id));
  const domains = domainsRaw.filter((d) => activeClientIds.has(d.clientId));
  const activeDomainIds = new Set(domains.map((d) => d.id));
  const databases = databasesRaw.filter((d) => activeClientIds.has(d.clientId) && activeDomainIds.has(d.domainId));
  const activeSchedules = schedules.filter((s) => activeClientIds.has(s.clientId));

  // Cargar tareas existentes en TODOS los buckets de la ventana.
  const buckets: string[] = [];
  for (const d of ventana) {
    buckets.push(`${d}_database`);
    buckets.push(`${d}_domain`);
  }
  const existing: UpdateTask[] = [];
  for (const bucket of buckets) {
    const { resources } = await getContainer("updateTasks")
      .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.taskBucket = @b", parameters: [{ name: "@b", value: bucket }] })
      .fetchAll();
    existing.push(...resources);
  }
  const initialExistingTasks = existing.length;

  const expandedSchedules = expandSchedulesWithDomainInheritance(activeSchedules, domains, databases);

  // Diagnostics
  const reasons: string[] = [];
  const candidateDatesSet = new Set<string>();
  let eligibleDomainTasks = 0;
  let eligibleDatabaseTasks = 0;
  let createdDomainTasks = 0;
  let createdDatabaseTasks = 0;
  let skippedDomainTasks = 0;
  let skippedDatabaseTasks = 0;

  // Anotamos por qué algunos schedules originales no produjeron candidatos.
  for (const s of activeSchedules) {
    const candidatos = ventana.filter((d) => isScheduleDueOnDate(s, d));
    if (candidatos.length === 0) {
      reasons.push(`Schedule ${s.id} omitido: no tiene fechas candidatas en ${windowStart}..${windowEnd}.`);
    }
  }

  // Contar dominios/bases inactivos asociados a algún schedule (informativo).
  const allDomains = (await getContainer("domains").items.query<DomainRecord>({ query: "SELECT * FROM c" }).fetchAll()).resources;
  const allDatabases = (await getContainer("databases").items.query<DatabaseRecord>({ query: "SELECT * FROM c" }).fetchAll()).resources;
  for (const s of schedules) {
    if (!activeClientIds.has(s.clientId)) {
      reasons.push(`Schedule ${s.id} omitido: cliente ${s.clientId} no existe o no está activo.`);
      continue;
    }
    if (s.targetType === "domain") {
      for (const id of s.targetIds) {
        const d = allDomains.find((x) => x.id === id);
        if (d && d.status !== "active") reasons.push(`Dominio ${id} omitido: estado ${d.status}.`);
        if (!d) reasons.push(`Dominio ${id} omitido: no existe.`);
      }
    } else if (s.targetType === "database") {
      for (const id of s.targetIds) {
        const db = allDatabases.find((x) => x.id === id);
        if (db && db.status !== "active") reasons.push(`Base de datos ${id} omitida: estado ${db.status}.`);
        if (!db) reasons.push(`Base de datos ${id} omitida: no existe.`);
      }
    }
  }

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalUpdated = 0;

  const expectedKeys = new Set<string>();
  for (const d of ventana) {
    for (const key of expectedTaskKeysForDate(expandedSchedules, d)) expectedKeys.add(key);
  }

  const obsoletedTasks = obsoleteTasksOutsideExpected(existing, expectedKeys);
  for (const task of obsoletedTasks) {
    try {
      await getContainer("updateTasks").item(task.id, task.taskBucket).replace(task);
      const reason = `Tarea ${task.id} obsoleta: ${task.targetType} ${task.targetId} ya no corresponde al estado activo actual.`;
      reasons.push(reason);
      await writeAuditLog({
        entityType: "task",
        entityId: task.id,
        clientId: task.clientId,
        clientName: task.clientName,
        domainId: task.domainId,
        domainName: task.domainName,
        action: "task_obsoleted",
        performedBy: "system",
        performedByEmail: "system",
        metadata: {
          reason: "target_or_schedule_not_expected",
          taskId: task.id,
          targetType: task.targetType,
          targetId: task.targetId,
          domainId: task.domainId,
          scheduledFor: task.taskDate,
          generationWindowStart: windowStart,
          generationWindowEnd: windowEnd,
        },
        after: { status: task.status, result: task.result },
      });
    } catch (e: any) {
      reasons.push(`Tarea ${task.id} no pudo marcarse obsoleta: ${e?.message ?? e}`);
    }
  }

  // Iteramos día por día dentro de la ventana.
  for (const d of ventana) {
    const summary = summarizeTaskGenerationForDate(
      expandedSchedules,
      d,
      existing,
      (id) => {
        // resolver síncrono usando los caches en memoria.
        const dom = domains.find((x) => x.id === id);
        if (dom) return dom.domainName;
        const db = databases.find((x) => x.id === id);
        if (db) return `${db.companyName} / ${db.dbAccess.initialCatalog}`;
        return id;
      }
    );

    if (summary.tasks.length > 0 || summary.skipped > 0) candidateDatesSet.add(d);

    eligibleDomainTasks += summary.tasks.filter((t) => t.targetType === "domain").length;
    eligibleDatabaseTasks += summary.tasks.filter((t) => t.targetType === "database").length;

    for (const task of summary.tasks) {
      try {
        await getContainer("updateTasks").items.create(task);
        existing.push(task);
        if (task.targetType === "domain") createdDomainTasks++;
        else createdDatabaseTasks++;
        totalCreated++;
        await writeAuditLog({
          entityType: "task",
          entityId: task.id,
          clientId: task.clientId,
          clientName: task.clientName,
          domainId: task.domainId,
          domainName: task.domainName,
          action: "task_generated",
          performedBy: "system",
          performedByEmail: "system",
          after: { taskDate: task.taskDate, targetType: task.targetType, targetId: task.targetId },
        });
      } catch (e: any) {
        // Si Cosmos rechaza por conflicto (409), tratamos como skip.
        if (e?.code === 409) {
          totalSkipped++;
          if (task.targetType === "domain") skippedDomainTasks++;
          else skippedDatabaseTasks++;
          reasons.push(`Tarea ${task.id} omitida: ya existe.`);
        } else {
          reasons.push(`Tarea ${task.id} no creada: ${e?.message ?? e}`);
        }
      }
    }

    for (const synced of summary.syncedTasks) {
      try {
        await getContainer("updateTasks").item(synced.id, synced.taskBucket).replace(synced);
        totalUpdated++;
        reasons.push(`Tarea ${synced.id} sincronizada con responsable actual de la frecuencia.`);
        await writeAuditLog({
          entityType: "task",
          entityId: synced.id,
          clientId: synced.clientId,
          clientName: synced.clientName,
          domainId: synced.domainId,
          domainName: synced.domainName,
          action: "task_assignment_synced",
          performedBy: "system",
          performedByEmail: "system",
          after: { assignedRole: synced.assignedRole, assignedUserIds: synced.assignedUserIds, scheduleId: synced.scheduleId },
        });
      } catch (e: any) {
        reasons.push(`Tarea ${synced.id} no sincronizada: ${e?.message ?? e}`);
      }
    }

    totalSkipped += summary.skipped;
    if (summary.skipped > 0) {
      // Distribuir skipped por tipo a partir de las fechas evaluadas.
      // Ya se contabilizó arriba si Cosmos rechazó. Aquí solo marca razón general.
      reasons.push(`Fecha ${d}: ${summary.skipped} tarea(s) ya existían (idempotencia).`);
    }
  }

  const preservedCompletedTasks = existing.filter((t) => t.status === "completed").length;

  log(`Generación ${windowStart}..${windowEnd}: creadas=${totalCreated}, actualizadas=${totalUpdated}, obsoletas=${obsoletedTasks.length}, omitidas=${totalSkipped}.`);

  return {
    date: isoDate,
    created: totalCreated,
    updated: totalUpdated,
    obsoleted: obsoletedTasks.length,
    skipped: totalSkipped,
    windowStart,
    windowEnd,
    message: "Tareas generadas correctamente.",
    diagnostics: {
      activeClients: clients.length,
      activeDomains: domains.length,
      activeDatabases: databases.length,
      activeSchedules: activeSchedules.length,
      schedulesEvaluated: expandedSchedules.length,
      candidateDates: Array.from(candidateDatesSet).sort(),
      expectedTasks: expectedKeys.size,
      existingTasks: initialExistingTasks,
      createdTasks: totalCreated,
      updatedTasks: totalUpdated,
      obsoletedTasks: obsoletedTasks.length,
      preservedCompletedTasks,
      eligibleDomainTasks: createdDomainTasks + skippedDomainTasks,
      eligibleDatabaseTasks: createdDatabaseTasks + skippedDatabaseTasks,
      createdDomainTasks,
      createdDatabaseTasks,
      skippedDomainTasks,
      skippedDatabaseTasks,
      reasons,
    },
  };
}

// Timer trigger: 06:00 UTC = 01:00 hora de Bogotá.
app.timer("generateDailyUpdateTasks", {
  schedule: "0 0 6 * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    const isoDate = todayInBogotaIso();
    ctx.log(`Iniciando generación de tareas para ${isoDate}...`);
    try {
      const r = await runTaskGeneration(isoDate, (m) => ctx.log(m));
      ctx.log(`Generación completada. Tareas nuevas: ${r.created}; omitidas: ${r.skipped}.`);
    } catch (e: any) {
      ctx.error("Error durante la generación de tareas", e);
    }
  },
});

// Endpoint manual para disparar la generación (admin / client_manager).
app.http("generateDailyUpdateTasksManual", {
  route: "tasks/generate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { requireUser, loadUserProfile } = await import("../lib/auth");
      const { canGenerateTasks } = await import("../lib/permissions");
      const auth = await requireUser(req);
      const profile = await loadUserProfile(auth);
      if (!profile || !canGenerateTasks(profile)) {
        return { status: 403, jsonBody: { error: "Solo administradores y administradores de clientes." } };
      }
      const body = (await req.json().catch(() => ({}))) as any;
      const date = typeof body.date === "string" ? body.date : todayInBogotaIso();
      const windowStart = typeof body.windowStart === "string" ? body.windowStart : undefined;
      const windowEnd = typeof body.windowEnd === "string" ? body.windowEnd : undefined;
      const r = await runTaskGeneration(date, (m) => ctx.log(m), { windowStart, windowEnd });
      return { status: 200, jsonBody: r };
    } catch (e: any) {
      ctx.error("Error en generación manual", e);
      return { status: 500, jsonBody: { error: "Error al generar tareas." } };
    }
  },
});
