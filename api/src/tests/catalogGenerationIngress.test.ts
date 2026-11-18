import type { HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  http: new Map<string, (req: HttpRequest, ctx: InvocationContext) => Promise<HttpResponseInit>>(),
  timers: new Map<string, (timer: Timer, ctx: InvocationContext) => Promise<void>>(),
  mode: vi.fn(), catalog: vi.fn(), cutoff: vi.fn(), audit: vi.fn(), authenticate: vi.fn(), profile: vi.fn(),
  schedules: vi.fn(), clients: vi.fn(), modules: vi.fn(), domains: vi.fn(), databases: vi.fn(), tasks: vi.fn(),
  deleteSchedule: vi.fn(),
}));
vi.mock("@azure/functions", () => ({
  app: {
    http: (name: string, config: { handler: (typeof fakes.http extends Map<string, infer H> ? H : never) }) =>
      fakes.http.set(name, config.handler),
    timer: (name: string, config: { handler: (typeof fakes.timers extends Map<string, infer H> ? H : never) }) =>
      fakes.timers.set(name, config.handler),
  },
}));
vi.mock("../lib/catalogGenerationRuntime", () => ({ getTaskGenerationMode: fakes.mode, runCatalogGeneration: fakes.catalog }));
vi.mock("../lib/catalogTaskCutoffWorker", () => ({ runCatalogTaskCutoffSweep: fakes.cutoff }));
vi.mock("../lib/audit", () => ({ writeAuditLog: fakes.audit }));
vi.mock("../lib/auth", () => ({ requireUser: fakes.authenticate, loadUserProfile: fakes.profile }));
vi.mock("../lib/roleDefinitionStore", () => ({
  loadRoleDefinitions: async () => (await import("../lib/permissionModel")).DEFAULT_ROLE_DEFINITIONS,
}));
vi.mock("../lib/schedulingSqlRepository", () => ({ readSqlSchedules: fakes.schedules }));
vi.mock("../lib/clientsSqlRepository", () => ({ readSqlClients: fakes.clients }));
vi.mock("../lib/licensingSqlRepository", () => ({ readSqlLicenseModules: fakes.modules }));
vi.mock("../lib/coreMastersSqlRepository", () => ({ readSqlDomains: fakes.domains, readSqlPublicDatabases: fakes.databases }));
vi.mock("../lib/workflowTasksSqlRepository", () => ({ readSqlWorkflowTasks: fakes.tasks }));
vi.mock("../lib/schedulingSqlWriteRepository", () => ({ deleteSqlSchedule: fakes.deleteSchedule }));
import "../functions/schedules";
import "../functions/generateDailyUpdateTasks";

const admin = { id: "trusted-operator", email: "operator@example.invalid", roles: ["super_admin"] };
const ctx = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as InvocationContext;
const request = (body: string = "") => ({
  params: { id: "saved-schedule" }, query: new URLSearchParams(), text: vi.fn(async () => body),
  json: vi.fn(async () => JSON.parse(body)),
}) as unknown as HttpRequest;
const evaluated = {
  date: "2026-11-18", status: "evaluated", created: 0, existing: 0, held: 0, conflicts: 0,
  accountedOrigins: 1, manualIntentsSaved: 1, message: "Se registró la procedencia sin crear una tarea.",
};
const invoke = (handler: string, req = request(), context = ctx()) => fakes.http.get(handler)!(req, context);
const runTimer = (context = ctx()) => fakes.timers.get("generateDailyUpdateTasks")!({} as Timer, context);

describe("catalog generation ingress", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fakes.mode.mockReturnValue("catalog");
    fakes.catalog.mockResolvedValue(evaluated);
    fakes.authenticate.mockResolvedValue(admin);
    fakes.profile.mockResolvedValue(admin);
    fakes.schedules.mockResolvedValue([]);
    fakes.clients.mockResolvedValue([]);
    fakes.modules.mockResolvedValue([]);
    fakes.domains.mockResolvedValue([]);
    fakes.databases.mockResolvedValue([]);
    fakes.tasks.mockResolvedValue([]);
    fakes.deleteSchedule.mockResolvedValue({ deleted: true });
  });

  it.each(["generateDailyUpdateTasksManual", "refreshUpdateTasksManual"])("protects %s before reading settings, body or running generation", async handler => {
    const req = request('{"manualScheduleIds":["unknown"]}');
    fakes.profile.mockResolvedValue({ ...admin, roles: [] });
    expect((await invoke(handler, req)).status).toBe(403);
    expect(fakes.mode).not.toHaveBeenCalled();
    expect(req.text).not.toHaveBeenCalled();
    expect(req.json).not.toHaveBeenCalled();
    expect(fakes.catalog).not.toHaveBeenCalled();
    expect(fakes.clients).not.toHaveBeenCalled();
    expect(fakes.cutoff).not.toHaveBeenCalled();
  });

  it.each(["generateDailyUpdateTasksManual", "refreshUpdateTasksManual"])("rejects an unauthenticated %s before resolving the generation mode", async handler => {
    fakes.authenticate.mockRejectedValue(Object.assign(new Error("private session diagnostics"), { status: 401 }));
    const req = request();
    expect(await invoke(handler, req)).toEqual({ status: 401, jsonBody: { error: "No autenticado." } });
    expect(fakes.profile).not.toHaveBeenCalled();
    expect(fakes.mode).not.toHaveBeenCalled();
    expect(req.text).not.toHaveBeenCalled();
    expect(fakes.catalog).not.toHaveBeenCalled();
    expect(fakes.cutoff).not.toHaveBeenCalled();
  });

  it("passes the trusted actor to explicit generation and keeps accounting-only counters separate", async () => {
    const body = { manualScheduleIds: ["manual-a"] };
    const response = await invoke("generateDailyUpdateTasksManual", request(JSON.stringify(body)));
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ created: 0, existing: 0, accountedOrigins: 1 });
    expect(fakes.catalog).toHaveBeenCalledExactlyOnceWith({ trigger: "generate", body, actorId: admin.id });
    expect(fakes.audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: "catalog_tasks_evaluated_manually", performedBy: admin.id, metadata: {
        date: evaluated.date, status: evaluated.status, created: 0, existing: 0, held: 0, conflicts: 0,
        accountedOrigins: 1, manualIntentsSaved: 1,
      },
    }));
    expect(fakes.clients).not.toHaveBeenCalled();
  });

  it.each([["cutoff", 409], ["unverified", 503]])("reports %s and never falls back", async (status, responseStatus) => {
    fakes.catalog.mockResolvedValue({ ...evaluated, status });
    expect((await invoke("refreshUpdateTasksManual")).status).toBe(responseStatus);
    expect(fakes.catalog).toHaveBeenCalledExactlyOnceWith({ trigger: "refresh", body: undefined, actorId: admin.id });
    expect(fakes.cutoff).toHaveBeenCalledOnce();
    expect(fakes.clients).not.toHaveBeenCalled();
  });

  it("reports saved intent on the original unverified outcome even if the separate audit operation fails", async () => {
    fakes.catalog.mockResolvedValue({ ...evaluated, accountedOrigins: 0, status: "unverified" });
    fakes.audit.mockRejectedValue(new Error("private audit diagnostics"));
    const context = ctx();
    const response = await invoke("generateDailyUpdateTasksManual", request(), context);
    expect(response).toMatchObject({ status: 503, jsonBody: { status: "unverified", manualIntentsSaved: 1, created: 0 } });
    expect(fakes.catalog).toHaveBeenCalledOnce();
    expect(vi.mocked(context.error).mock.calls).toEqual([["No se pudo auditar la evaluación de tareas del catálogo."]]);
  });

  it("rejects a refresh carrying manual selection and rejects malformed JSON without invoking either generator", async () => {
    expect((await invoke("refreshUpdateTasksManual", request('{"manualScheduleIds":["manual-a"]}'))).status).toBe(400);
    expect((await invoke("generateDailyUpdateTasksManual", request("{not json"))).status).toBe(400);
    expect((await invoke("generateDailyUpdateTasksManual", request(JSON.stringify("x".repeat(65_536))))).status).toBe(400);
    expect(fakes.catalog).not.toHaveBeenCalled();
    expect(fakes.cutoff).not.toHaveBeenCalled();
    expect(fakes.clients).not.toHaveBeenCalled();
  });

  it("does not reveal raw catalog errors in responses or telemetry", async () => {
    const context = ctx();
    fakes.catalog.mockRejectedValue(Object.assign(new Error("private catalog diagnostics"), { status: 503 }));
    const response = await invoke("generateDailyUpdateTasksManual", request(), context);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response)).not.toContain("private catalog diagnostics");
    expect(JSON.stringify(vi.mocked(context.error).mock.calls)).not.toContain("private catalog diagnostics");
    expect(fakes.clients).not.toHaveBeenCalled();
  });

  it("runs catalog timer without manual input and never falls back on failure", async () => {
    const context = ctx();
    fakes.catalog.mockRejectedValue(new Error("private timer diagnostics"));
    await runTimer(context);
    expect(fakes.catalog).toHaveBeenCalledExactlyOnceWith({ trigger: "timer" });
    expect(fakes.cutoff).not.toHaveBeenCalled();
    expect(fakes.clients).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(context.error).mock.calls)).not.toContain("private timer diagnostics");
  });

  it("runs cutoff reconciliation on a resolved timer outcome without calling legacy", async () => {
    fakes.catalog.mockResolvedValue({ ...evaluated, status: "unverified" });
    await runTimer();
    expect(fakes.catalog).toHaveBeenCalledExactlyOnceWith({ trigger: "timer" });
    expect(fakes.cutoff).toHaveBeenCalledOnce();
    expect(fakes.clients).not.toHaveBeenCalled();
  });

  it("reports a partial timer window without treating unavailable dates as success or invoking legacy", async () => {
    const context = ctx();
    fakes.catalog.mockResolvedValue({ ...evaluated, status: "unverified", created: 2,
      days: [{ ...evaluated, created: 2 }, { ...evaluated, date: "2026-11-19", status: "unverified" }] });
    await runTimer(context);
    expect(fakes.catalog).toHaveBeenCalledExactlyOnceWith({ trigger: "timer" });
    expect(fakes.clients).not.toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(expect.stringContaining("fechas evaluadas=1/2"));
    expect(context.log).toHaveBeenCalledWith(expect.stringContaining("creadas=2"));
  });

  it("fails closed on invalid mode configuration for HTTP and timer before operational reads", async () => {
    fakes.mode.mockImplementation(() => { throw Object.assign(new Error("private configuration"), { status: 503 }); });
    expect((await invoke("refreshUpdateTasksManual")).status).toBe(503);
    await runTimer();
    expect(fakes.catalog).not.toHaveBeenCalled();
    expect(fakes.cutoff).not.toHaveBeenCalled();
    expect(fakes.clients).not.toHaveBeenCalled();
  });

  it("preserves a successful schedule deletion even if its catalog regeneration fails", async () => {
    fakes.schedules.mockResolvedValueOnce([{ id: "saved-schedule" }]);
    fakes.catalog.mockRejectedValue(new Error("catalog regeneration unavailable"));
    expect((await invoke("schedulesDelete")).status).toBe(204);
    expect(fakes.deleteSchedule).toHaveBeenCalledOnce();
    expect(fakes.catalog).toHaveBeenCalledExactlyOnceWith({ trigger: "schedule-change" });
    expect(fakes.clients).not.toHaveBeenCalled();
  });

  it("continues to invoke only the legacy engine in explicitly legacy mode", async () => {
    fakes.mode.mockReturnValue("legacy");
    const date = "2026-11-18";
    const response = await invoke("generateDailyUpdateTasksManual", request(JSON.stringify({ date, windowStart: date, windowEnd: date })));
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ date, windowStart: date, windowEnd: date });
    expect(fakes.clients).toHaveBeenCalledOnce();
    expect(fakes.catalog).not.toHaveBeenCalled();
  });
});
