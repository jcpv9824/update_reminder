import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../lib/permissionModel";

const fakes = vi.hoisted(() => ({
  routes: new Map<string, (req: HttpRequest) => Promise<HttpResponseInit>>(),
  auth: vi.fn(), profile: vi.fn(), roles: vi.fn(),
  domains: vi.fn(), databases: vi.fn(), restrictedDb: vi.fn(), modules: vi.fn(), assignments: vi.fn(),
  findModule: vi.fn(), findAssignment: vi.fn(), workflowTasks: vi.fn(),
  createDomain: vi.fn(), updateDomain: vi.fn(), domainStatus: vi.fn(),
  createDb: vi.fn(), updateDb: vi.fn(), dbStatus: vi.fn(), cascade: vi.fn(),
  createModule: vi.fn(), updateModule: vi.fn(), deleteModule: vi.fn(),
  createAssignment: vi.fn(), updateAssignment: vi.fn(), deleteAssignment: vi.fn(),
  taskConnection: vi.fn(), audit: vi.fn(), secret: vi.fn(),
}));
vi.mock("@azure/functions", () => ({ app: { http(name: string, def: { handler: (req: HttpRequest) => Promise<HttpResponseInit> }) {
  fakes.routes.set(name, def.handler);
} } }));
vi.mock("../lib/auth", () => ({ requireUser: fakes.auth, loadUserProfile: fakes.profile }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: fakes.roles }));
vi.mock("../lib/coreMastersSqlRepository", () => ({ readSqlDomains: fakes.domains, readSqlPublicDatabases: fakes.databases,
  readSqlRestrictedDatabase: fakes.restrictedDb }));
vi.mock("../lib/domainsSqlWriteRepository", () => ({ createSqlDomain: fakes.createDomain, updateSqlDomain: fakes.updateDomain,
  setSqlDomainStatus: fakes.domainStatus }));
vi.mock("../lib/databasesSqlService", () => ({ createSqlDatabaseWithSecret: fakes.createDb, updateSqlDatabaseWithSecret: fakes.updateDb }));
vi.mock("../lib/databasesSqlWriteRepository", () => ({ setSqlDatabaseStatus: fakes.dbStatus }));
vi.mock("../lib/coreCascadeSqlRepository", () => ({ deleteSqlCoreCascade: fakes.cascade }));
vi.mock("../lib/licensingSqlRepository", () => ({ readSqlLicenseModules: fakes.modules, readSqlLicenseAssignments: fakes.assignments }));
vi.mock("../lib/licensingSqlWriteRepository", () => ({ createSqlLicenseModule: fakes.createModule, updateSqlLicenseModule: fakes.updateModule,
  deleteSqlLicenseModule: fakes.deleteModule, findSqlLicenseModule: fakes.findModule, createSqlLicenseAssignment: fakes.createAssignment,
  updateSqlLicenseAssignment: fakes.updateAssignment, deleteSqlLicenseAssignment: fakes.deleteAssignment,
  findSqlLicenseAssignment: fakes.findAssignment }));
vi.mock("../lib/workflowTasksSqlRepository", () => ({ readSqlWorkflowTasks: fakes.workflowTasks }));
vi.mock("../lib/catalogTaskDatabaseConnection", () => ({ readAuditedTaskDatabaseConnection: fakes.taskConnection }));
vi.mock("../lib/auditSqlWriter", () => ({ appendSqlAuditLog: fakes.audit }));
vi.mock("../lib/keyVault", () => ({ getSecret: fakes.secret }));
import "../functions/domains";
import "../functions/databases";
import "../functions/licenses";

const customActor = { id: "operator", email: "operator@example.invalid", roles: ["matrix-role"] };
const administrator = { ...customActor, roles: ["super_admin"] };
function role(...permissions: string[]): RoleDefinition {
  return { id: "matrix-role", name: "Matrix", system: false, permissions, taskVisibility: { domain: "none", database: "assigned" } };
}
const request = (body: unknown = {}, query: Record<string, string> = {}) => ({
  params: { id: "target" }, query: new URLSearchParams(query), json: vi.fn(async () => body),
});
const invoke = (route: string, req = request()) => fakes.routes.get(route)!(req as unknown as HttpRequest);
const domain = { id: "target", clientId: "client", domainName: "https://portal.example.invalid", environment: "test", status: "active" };
const database = { id: "target", clientId: "client", domainId: "domain", companyName: "Example", environment: "test",
  status: "active", dbAccess: { initialCatalog: "synthetic" } };
const module = { id: "target", name: "Example", status: "active" };
const assignment = { id: "target", clientId: "client", moduleId: "module", targetType: "client", status: "active" };
const mutations = [
  ["domainsCreate", "domains.create", fakes.createDomain, domain, 201],
  ["domainsUpdate", "domains.edit", fakes.updateDomain, domain, 200],
  ["domainsDeactivate", "domains.deactivate", fakes.domainStatus, {}, 200],
  ["domainsReactivate", "domains.reactivate", fakes.domainStatus, {}, 200],
  ["domainsDelete", "domains.delete", fakes.cascade, {}, 200],
  ["databasesCreate", "databases.create", fakes.createDb, { ...database,
    rawDbAccess: "fixture.example.invalid,1433;Initial Catalog=fixture;User ID=fixture;Password=synthetic" }, 201],
  ["databasesUpdate", "databases.edit", fakes.updateDb, database, 200],
  ["databasesDeactivate", "databases.deactivate", fakes.dbStatus, {}, 200],
  ["databasesReactivate", "databases.reactivate", fakes.dbStatus, {}, 200],
  ["databasesDelete", "databases.delete", fakes.cascade, {}, 200],
  ["licenseModulesCreate", "licensing.create", fakes.createModule, module, 201],
  ["licenseModulesUpdate", "licensing.edit", fakes.updateModule, { status: "inactive" }, 200],
  ["licenseModulesDelete", "licensing.delete", fakes.deleteModule, {}, 200],
  ["licenseAssignmentsCreate", "licensing.create", fakes.createAssignment, assignment, 201],
  ["licenseAssignmentsUpdate", "licensing.edit", fakes.updateAssignment, { status: "inactive" }, 200],
  ["licenseAssignmentsDelete", "licensing.delete", fakes.deleteAssignment, {}, 200],
] as const;

const targetAndSideEffectIo = [...new Set(mutations.map(([, , writer]) => writer)), fakes.domains, fakes.databases,
  fakes.restrictedDb, fakes.modules, fakes.assignments, fakes.findModule, fakes.findAssignment,
  fakes.workflowTasks, fakes.taskConnection, fakes.audit, fakes.secret];

describe("catalog ownership of legacy masters", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    fakes.auth.mockResolvedValue(customActor);
    fakes.profile.mockResolvedValue(customActor);
    fakes.domains.mockResolvedValue([domain]);
    fakes.databases.mockResolvedValue([database]);
    fakes.restrictedDb.mockResolvedValue(database);
    fakes.modules.mockResolvedValue([module]);
    fakes.assignments.mockResolvedValue([assignment]);
    fakes.createDomain.mockResolvedValue(domain);
    fakes.updateDomain.mockResolvedValue(domain);
    fakes.domainStatus.mockResolvedValue({ domain });
    fakes.createDb.mockResolvedValue(database);
    fakes.updateDb.mockResolvedValue(database);
    fakes.dbStatus.mockResolvedValue({ record: database });
    fakes.cascade.mockResolvedValue({ found: true, requiresCascade: false, dependencies: {}, obsoletedTasks: 0, cascadeSchedules: 0 });
    fakes.findModule.mockResolvedValue(module);
    fakes.findAssignment.mockResolvedValue(assignment);
    fakes.createModule.mockResolvedValue(module);
    fakes.updateModule.mockResolvedValue(module);
    fakes.deleteModule.mockResolvedValue({ found: true, deleted: true });
    fakes.createAssignment.mockResolvedValue(assignment);
    fakes.updateAssignment.mockResolvedValue(assignment);
    fakes.deleteAssignment.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  describe.each(mutations)("%s", (route, permission, writer, body, legacyStatus) => {
    it("blocks a permitted operator and a super-admin before parsing, target lookup or mutations", async () => {
      fakes.roles.mockResolvedValue([...DEFAULT_ROLE_DEFINITIONS, role(`clients.${permission}`, "clients.licensing.deactivate")]);
      const permitted = request(body, { cascade: "true" });
      const response = await invoke(route, permitted);
      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ error: expect.stringContaining("es de solo lectura") });
      expect(permitted.json).not.toHaveBeenCalled();

      fakes.profile.mockResolvedValueOnce(administrator);
      const malformed = request(null, { cascade: "true" });
      malformed.json.mockRejectedValueOnce(new Error("malformed synthetic body"));
      expect(await invoke(route, malformed)).toEqual(response);
      expect(malformed.json).not.toHaveBeenCalled();
      for (const io of targetAndSideEffectIo) expect(io).not.toHaveBeenCalled();
    });

    it("checks authentication and normal action permission before catalog ownership", async () => {
      const req = request(body);
      fakes.auth.mockRejectedValueOnce(Object.assign(new Error("No autenticado."), { status: 401 }));
      expect((await invoke(route, req)).status).toBe(401);
      fakes.profile.mockResolvedValueOnce(null);
      expect((await invoke(route, req)).status).toBe(403);
      fakes.roles.mockResolvedValue([role("clients.domains.view", "clients.databases.view", "clients.licensing.view")]);
      expect((await invoke(route, req)).status).toBe(403);
      expect(req.json).not.toHaveBeenCalled();
      for (const io of targetAndSideEffectIo) expect(io).not.toHaveBeenCalled();
    });

    it.each([undefined, "false"])("retains the legacy writer when the flag is %s", async flag => {
      vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", flag);
      fakes.roles.mockResolvedValue([role(`clients.${permission}`, "clients.licensing.deactivate")]);
      expect((await invoke(route, request(body))).status).toBe(legacyStatus);
      expect(writer).toHaveBeenCalledOnce();
    });
  });

  it("preserves the legacy GET routes used by dependent modules with the catalog active", async () => {
    fakes.roles.mockResolvedValue([role("clients.domains.view", "clients.domains.view_related_databases", "clients.databases.view", "clients.licensing.view")]);
    for (const route of ["domainsList", "domainsGet", "domainsDatabases", "databasesList", "databasesGet", "licenseModulesList", "licenseAssignmentsList"]) {
      expect((await invoke(route)).status).toBe(200);
    }
    for (const [, , writer] of mutations) expect(writer).not.toHaveBeenCalled();
  });

  it("leaves task connection view, copy, reveal and assignment denial on the existing backend path", async () => {
    fakes.taskConnection.mockResolvedValueOnce({ kind: "info", info: { hasPassword: true } })
      .mockResolvedValueOnce({ kind: "part", part: "initialCatalog", value: "synthetic" })
      .mockResolvedValueOnce({ kind: "password", value: "synthetic" }).mockResolvedValueOnce(null);
    expect((await invoke("databasesAccessInfo", request({}, { taskId: "task" }))).status).toBe(200);
    expect((await invoke("databasesCopyAccessPart", request({ taskId: "task", part: "initialCatalog" }))).status).toBe(200);
    expect(await invoke("databasesRevealPassword", request({ taskId: "task" }))).toMatchObject({ status: 200, body: "synthetic" });
    expect((await invoke("databasesRevealPassword", request({ taskId: "task" }))).status).toBe(403);
    expect(fakes.taskConnection).toHaveBeenNthCalledWith(2, { taskId: "task", databaseId: "target", actor: customActor,
      environment: "qa", action: { kind: "copy", part: "initialCatalog" } });
    expect(fakes.restrictedDb).not.toHaveBeenCalled();
    expect(fakes.audit).not.toHaveBeenCalled();
    expect(fakes.secret).not.toHaveBeenCalled();
  });
});
