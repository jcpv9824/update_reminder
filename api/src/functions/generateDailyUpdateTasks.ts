import { app, InvocationContext, Timer } from "@azure/functions";
import { getContainer } from "../lib/cosmos";
import { writeAuditLog } from "../lib/audit";
import { generateTasksForDate } from "../lib/taskGenerator";
import type { DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

function todayInBogotaIso(): string {
  // America/Bogota es UTC-5 sin horario de verano.
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bogota = new Date(utcMs - 5 * 3600_000);
  return bogota.toISOString().slice(0, 10);
}

async function resolveTargetName(
  targetType: "domain" | "database",
  targetId: string
): Promise<string> {
  if (targetType === "database") {
    const { resources } = await getContainer("databases")
      .items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: targetId }] })
      .fetchAll();
    if (!resources.length) return targetId;
    return `${resources[0].companyName} / ${resources[0].dbAccess.initialCatalog}`;
  } else {
    const { resources } = await getContainer("domains")
      .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: targetId }] })
      .fetchAll();
    if (!resources.length) return targetId;
    return resources[0].domainName;
  }
}

export async function runTaskGeneration(
  isoDate: string,
  log: (msg: string) => void
): Promise<{ created: number }> {
  const { resources: schedules } = await getContainer("updateSchedules")
    .items.query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.active = true" })
    .fetchAll();

  // Tareas existentes por bucket
  const buckets = new Set<string>([`${isoDate}_database`, `${isoDate}_domain`]);
  const existing: UpdateTask[] = [];
  for (const bucket of buckets) {
    const { resources } = await getContainer("updateTasks")
      .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.taskBucket = @b", parameters: [{ name: "@b", value: bucket }] })
      .fetchAll();
    existing.push(...resources);
  }

  // Resolver nombres en cache
  const nameCache = new Map<string, string>();
  const resolver = (id: string) => nameCache.get(id) ?? id;

  for (const s of schedules) {
    for (const targetId of s.targetIds) {
      if (!nameCache.has(targetId)) {
        nameCache.set(targetId, await resolveTargetName(s.targetType, targetId));
      }
    }
  }

  const newTasks = generateTasksForDate(schedules, isoDate, existing, resolver);
  for (const task of newTasks) {
    await getContainer("updateTasks").items.create(task);
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
  }
  log(`Tareas creadas: ${newTasks.length} para la fecha ${isoDate}.`);
  return { created: newTasks.length };
}

// Timer trigger: 06:00 UTC = 01:00 hora de Bogotá.
app.timer("generateDailyUpdateTasks", {
  schedule: "0 0 6 * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    const isoDate = todayInBogotaIso();
    ctx.log(`Iniciando generación de tareas para ${isoDate}...`);
    try {
      const r = await runTaskGeneration(isoDate, (m) => ctx.log(m));
      ctx.log(`Generación completada. Tareas nuevas: ${r.created}`);
    } catch (e: any) {
      ctx.error("Error durante la generación de tareas", e);
    }
  },
});

// Endpoint manual para disparar la generación (admin).
app.http("generateDailyUpdateTasksManual", {
  route: "tasks/generate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const { requireUser, loadUserProfile } = await import("../lib/auth");
      const { hasRole } = await import("../lib/permissions");
      const auth = await requireUser(req);
      const profile = await loadUserProfile(auth);
      if (!profile || !hasRole(profile, "admin")) {
        return { status: 403, jsonBody: { error: "Solo administradores." } };
      }
      const body = (await req.json().catch(() => ({}))) as any;
      const date = typeof body.date === "string" ? body.date : todayInBogotaIso();
      const r = await runTaskGeneration(date, (m) => ctx.log(m));
      return { status: 200, jsonBody: { date, created: r.created } };
    } catch (e: any) {
      return { status: 500, jsonBody: { error: e.message } };
    }
  },
});
