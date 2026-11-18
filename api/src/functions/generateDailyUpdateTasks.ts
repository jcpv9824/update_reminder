import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { writeAuditLog } from "../lib/audit";
import { expandSchedulesWithDomainInheritance, expectedTaskKeysForDate, markOneTimeScheduleCompleted, obsoleteTasksOutsideExpected, oneTimeSchedulesReadyToComplete, summarizeTaskGenerationForDate } from "../lib/taskGenerator";
import { isScheduleDueOnDate } from "../lib/scheduleEngine";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseModuleRecord, UpdateSchedule, UpdateTask } from "../types/models";
import { readSqlSchedules } from "../lib/schedulingSqlRepository";
import { readSqlClients } from "../lib/clientsSqlRepository";
import { readSqlDomains, readSqlPublicDatabases } from "../lib/coreMastersSqlRepository";
import { readSqlLicenseModules } from "../lib/licensingSqlRepository";
import { readSqlWorkflowTasks } from "../lib/workflowTasksSqlRepository";
import { runCatalogTaskCutoffSweep } from "../lib/catalogTaskCutoffWorker";
import { getTaskGenerationMode, runCatalogGeneration } from "../lib/catalogGenerationRuntime";
import {
  completeSqlOneTimeSchedule,
  createSqlGeneratedTask,
  syncSqlGeneratedTask,
} from "../lib/workflowTaskGenerationSqlRepository";

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
  deduplicated: number;
  updatedSources: number;
  completedOneTimeSchedules: number;
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
    completedOneTimeSchedules: number;
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

  let schedules: UpdateSchedule[];
  let clients: ClientRecord[];
  let licenseModules: LicenseModuleRecord[];
  let domainsRaw: DomainRecord[];
  let databasesRaw: DatabaseRecord[];
  let allDomains: DomainRecord[];
  let allDatabases: DatabaseRecord[];
  const page = { enabled: false, page: 1, pageSize: 1000 };
  const [scheduleResult, sqlClients, moduleResult, domainResult, databaseResult] = await Promise.all([
    readSqlSchedules({}, page, isoDate),
    readSqlClients(),
    readSqlLicenseModules({ includeDeleted: false }, page),
    readSqlDomains({}, page),
    readSqlPublicDatabases({}, page),
  ]);
  schedules = (Array.isArray(scheduleResult) ? scheduleResult : scheduleResult.items).filter((schedule) => schedule.active);
  clients = sqlClients.filter((client) => client.status === "active");
  licenseModules = (Array.isArray(moduleResult) ? moduleResult : moduleResult.items).filter((module) => module.status === "active");
  allDomains = Array.isArray(domainResult) ? domainResult : domainResult.items;
  allDatabases = (Array.isArray(databaseResult) ? databaseResult : databaseResult.items) as DatabaseRecord[];
  domainsRaw = allDomains.filter((domain) => domain.status === "active");
  databasesRaw = allDatabases.filter((database) => database.status === "active");
  const activeClientIds = new Set(clients.map((c: any) => c.id));
  const domains = domainsRaw.filter((d) => activeClientIds.has(d.clientId));
  const activeDomainIds = new Set(domains.map((d) => d.id));
  const databases = databasesRaw.filter((d) => activeClientIds.has(d.clientId) && activeDomainIds.has(d.domainId));
  const activeSchedules = schedules.filter((s) => activeClientIds.has(s.clientId));

  // Cargar tareas existentes en toda la ventana.
  const existing: UpdateTask[] = await readSqlWorkflowTasks({
    today: isoDate,
    dateFrom: windowStart,
    dateTo: windowEnd,
    operationalOnly: false,
    includeCancelled: true,
    legacyOnly: true,
  });
  const initialExistingTasks = existing.length;

  const expandedSchedules = expandSchedulesWithDomainInheritance(activeSchedules, domains, databases, clients, licenseModules);

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

  const obsoletedTasks = obsoleteTasksOutsideExpected(existing, expectedKeys, new Date().toISOString(), isoDate);
  for (const task of obsoletedTasks) {
    try {
      await syncSqlGeneratedTask(task, "task_obsoleted");
      reasons.push(`Tarea ${task.id} obsoleta: ${task.targetType} ${task.targetId} ya no corresponde al estado activo actual.`);
    } catch (e: any) {
      reasons.push(`Tarea ${task.id} no pudo marcarse obsoleta: ${e?.message ?? e}`);
    }
  }

  let completedOneTimeSchedules = 0;

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
        const inserted = await createSqlGeneratedTask(task);
        if (!inserted) {
          totalSkipped++;
          if (task.targetType === "domain") skippedDomainTasks++;
          else skippedDatabaseTasks++;
          reasons.push(`Tarea ${task.id} omitida: ya existe.`);
          continue;
        }
        existing.push(task);
        if (task.targetType === "domain") createdDomainTasks++;
        else createdDatabaseTasks++;
        totalCreated++;
      } catch (e: any) {
        reasons.push(`Tarea ${task.id} no creada: ${e?.message ?? e}`);
      }
    }

    for (const synced of summary.syncedTasks) {
      try {
        if (await syncSqlGeneratedTask(synced, "task_assignment_synced")) totalUpdated++;
        reasons.push(`Tarea ${synced.id} sincronizada con responsable actual de la frecuencia.`);
      } catch (e: any) {
        reasons.push(`Tarea ${synced.id} no sincronizada: ${e?.message ?? e}`);
      }
    }

    totalSkipped += summary.skipped;
    if (summary.skipped > 0) {
      // Distribuir skipped por tipo a partir de las fechas evaluadas.
      // La idempotencia ya se contabilizó arriba; aquí solo marca la razón general.
      reasons.push(`Fecha ${d}: ${summary.skipped} tarea(s) ya existían (idempotencia).`);
    }
  }

  const oneTimeSchedulesToComplete = oneTimeSchedulesReadyToComplete(activeSchedules, existing, isoDate);
  for (const schedule of oneTimeSchedulesToComplete) {
    try {
      const completed = markOneTimeScheduleCompleted(schedule, new Date().toISOString(), "system");
      if (await completeSqlOneTimeSchedule(completed)) completedOneTimeSchedules++;
      reasons.push(`Programación única ${schedule.id} marcada como inactiva porque sus tareas ya están cerradas.`);
    } catch (e: any) {
      reasons.push(`Programación única ${schedule.id} no pudo marcarse como inactiva: ${e?.message ?? e}`);
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
    deduplicated: totalSkipped,
    updatedSources: totalUpdated,
    completedOneTimeSchedules,
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
      completedOneTimeSchedules,
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

async function sweepCatalogCutoffs(log: (message: string) => void): Promise<void> {
  try {
    const swept = await runCatalogTaskCutoffSweep();
    if (swept) log(`Corte de catálogo: actualizadas=${swept.updated}; omitidas=${swept.skipped}; fallidas=${swept.failed}.`);
  } catch { log("No se pudo comprobar el corte del catálogo; no se presume la ausencia de destinos."); }
}

// Timer trigger: 06:00 UTC = 01:00 hora de Bogotá.
app.timer("generateDailyUpdateTasks", {
  schedule: "0 0 6 * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    let mode: ReturnType<typeof getTaskGenerationMode> | undefined;
    try {
      mode = getTaskGenerationMode();
      if (mode === "catalog") {
        const result = await runCatalogGeneration({ trigger: "timer" });
        await sweepCatalogCutoffs(message => ctx.log(message));
        const dates = result.days ? ` fechas evaluadas=${result.days.filter(day => day.status === "evaluated").length}/${result.days.length};` : "";
        ctx.log(`Catálogo: estado=${result.status};${dates} creadas=${result.created}; existentes=${result.existing}; retenidas=${result.held}; conflictos=${result.conflicts}; procedencias=${result.accountedOrigins}; programaciones únicas completadas=${result.completedOneTimeSchedules ?? 0}; fallos de cierre=${result.onceClosure?.failed ?? 0}.`);
        return;
      }
      const isoDate = todayInBogotaIso();
      ctx.log(`Iniciando generación de tareas para ${isoDate}...`);
      await sweepCatalogCutoffs(message => ctx.log(message));
      const r = await runTaskGeneration(isoDate, (m) => ctx.log(m));
      ctx.log(`Generación completada. Tareas nuevas: ${r.created}; omitidas: ${r.skipped}.`);
    } catch (error) {
      if (mode === "legacy") ctx.error("Error durante la generación de tareas", error);
      else ctx.error("No se pudo ejecutar la generación del catálogo.");
    }
  },
});

async function readCatalogGenerationBody(req: HttpRequest): Promise<unknown> {
  try {
    const raw = await req.text();
    if (raw.length === 0) return undefined;
    if (raw.length > 65_536) throw new Error("Límite del cuerpo excedido.");
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error("Cuerpo de la solicitud inválido."), { status: 400 });
  }
}

async function handleManualGeneration(trigger: "generate" | "refresh", req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  let mode: ReturnType<typeof getTaskGenerationMode> | undefined;
  try {
    const { requireUser, loadUserProfile } = await import("../lib/auth");
    const { canGenerateScheduleTasks } = await import("../lib/managementAccess");
    const { loadRoleDefinitions } = await import("../lib/roleDefinitionStore");
    const auth = await requireUser(req);
    const profile = await loadUserProfile(auth);
    const roleDefinitions = profile ? await loadRoleDefinitions() : [];
    if (!profile || !canGenerateScheduleTasks(profile, roleDefinitions)) {
      return { status: 403, jsonBody: { error: "No tiene permisos para generar tareas." } };
    }
    mode = getTaskGenerationMode();
    if (mode === "catalog") {
      const body = await readCatalogGenerationBody(req);
      if (trigger === "refresh" && body !== null && typeof body === "object" && "manualScheduleIds" in body) {
        return { status: 400, jsonBody: { error: "El refresco no admite una selección manual de programaciones." } };
      }
      const result = await runCatalogGeneration({ trigger, body, actorId: profile.id });
      if (trigger === "refresh") await sweepCatalogCutoffs(message => ctx.log(message));
      const { date, status, created, existing, held, conflicts, accountedOrigins, manualIntentsSaved, message } = result;
      const metadata = { date, status, created, existing, held, conflicts, accountedOrigins, manualIntentsSaved,
        ...(result.completedOneTimeSchedules === undefined ? {} : { completedOneTimeSchedules: result.completedOneTimeSchedules }),
        ...(result.onceClosure ? { onceClosure: result.onceClosure } : {}) };
      try {
        await writeAuditLog({
          entityType: "task",
          entityId: trigger === "generate" ? "catalog_manual_generate" : "catalog_manual_refresh",
          action: "catalog_tasks_evaluated_manually",
          performedBy: profile.id,
          performedByEmail: profile.email,
          metadata,
        });
      } catch {
        // The catalog transaction already resolved. An audit write failure must
        // not falsely report that persisted intents or tasks were rolled back.
        ctx.error("No se pudo auditar la evaluación de tareas del catálogo.");
      }
      const httpStatus = status === "cutoff" ? 409 : status === "unverified" ? 503 : 200;
      return { status: httpStatus, jsonBody: { ...metadata, message } };
    }

    if (trigger === "refresh") await sweepCatalogCutoffs(message => ctx.log(message));
    const body = (await req.json().catch(() => ({}))) as any;
    const date = typeof body.date === "string" ? body.date : todayInBogotaIso();
    const windowStart = typeof body.windowStart === "string" ? body.windowStart : undefined;
    const windowEnd = typeof body.windowEnd === "string" ? body.windowEnd : undefined;
    const r = await runTaskGeneration(date, (m) => ctx.log(m), { windowStart, windowEnd });
    await writeAuditLog({
      entityType: "task",
      entityId: "manual_refresh",
      action: "tasks_refreshed_manually",
      performedBy: profile.id,
      performedByEmail: profile.email,
      metadata: { date, windowStart: r.windowStart, windowEnd: r.windowEnd, created: r.created, updated: r.updated, obsoleted: r.obsoleted, skipped: r.skipped },
    });
    return { status: 200, jsonBody: trigger === "refresh" ? { ...r, message: "Tareas actualizadas correctamente." } : r };
  } catch (error: any) {
    if (mode === "legacy") {
      ctx.error(trigger === "refresh" ? "Error en refresco manual" : "Error en generación manual", error);
      const message = trigger === "refresh" ? "No se pudieron actualizar las tareas." : "Error al generar tareas.";
      return { status: error?.status ?? 500, jsonBody: { error: error?.status === 503 ? error.message : message } };
    }
    const status = error?.status;
    if (status === 400) return { status, jsonBody: { error: "Solicitud de generación inválida." } };
    if (status === 401) return { status, jsonBody: { error: "No autenticado." } };
    if (status === 403) return { status, jsonBody: { error: "No tiene permisos para generar tareas." } };
    if (status === 409) return { status, jsonBody: { error: "No se pudo confirmar la solicitud para la fecha indicada." } };
    ctx.error("No se pudo ejecutar la evaluación manual de tareas.");
    return { status: status === 503 ? 503 : 500, jsonBody: { error: "No se pudo ejecutar la generación de tareas." } };
  }
}

app.http("generateDailyUpdateTasksManual", {
  route: "tasks/generate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (req, ctx) => handleManualGeneration("generate", req, ctx),
});

app.http("refreshUpdateTasksManual", {
  route: "tasks/refresh",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (req, ctx) => handleManualGeneration("refresh", req, ctx),
});
