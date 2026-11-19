import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock("../lib/whatsNewSqlRepository", async (original) => ({ ...await original<typeof import("../lib/whatsNewSqlRepository")>(), query: fake.query }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: fake.audit }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (work: (db: object) => Promise<unknown>) => work({}) }));
import { saveConfig } from "../lib/whatsNewService";
const actor = { id: "admin", displayName: "Administrador", email: "admin@example.invalid", areas: new Set<never>(), permissions: new Set(["configuration.whats_new.manage"]) };
const version = Buffer.from("0000000000000001", "hex");
describe("Qué hay de nuevo action catalog retries", () => {
  beforeEach(() => { fake.query.mockReset(); fake.audit.mockReset(); });
  it("returns an existing normalized label instead of duplicating an uncertain create retry", async () => {
    fake.query.mockResolvedValue([{ source_id: "existing", label: "Dar permiso", row_version: version }]);
    const result = await saveConfig(actor, "action-create", null, { label: "  DÁR   PERMISO  " }, null);
    expect(result).toMatchObject({ saved: true, id: "existing" });
    expect(fake.query).toHaveBeenCalledTimes(1); expect(fake.audit).not.toHaveBeenCalled();
    expect(fake.query.mock.calls[0][1]).toContain("UPDLOCK,HOLDLOCK");
  });
  it("does not rename another action into an existing normalized label", async () => {
    fake.query.mockResolvedValue([{ source_id: "one", label: "Probar", row_version: version }, { source_id: "two", label: "Leer", row_version: version }]);
    await expect(saveConfig(actor, "action-edit", "two", { label: "PRÓBAR" }, '"AAAAAAAAAAE="')).rejects.toMatchObject({ status: 409, code: "accion_duplicada" });
    expect(fake.query).toHaveBeenCalledTimes(1); expect(fake.audit).not.toHaveBeenCalled();
  });
  it("keeps an explicitly false publication flag false", async () => {
    fake.query.mockResolvedValueOnce([{ row_version: version }]).mockResolvedValue([]);
    await saveConfig(actor, "settings", null, { publicEnabled: false }, '"AAAAAAAAAAE="');
    expect(fake.query.mock.calls[1][2]).toMatchObject({ enabled: false });
  });
});
