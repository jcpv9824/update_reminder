import { describe, expect, it, vi } from "vitest";
import { readAuditedTaskDatabaseConnection } from "../lib/catalogTaskDatabaseConnection";

const request = { databaseId: "db-a", taskId: "task-a", actor: { id: "actor", email: "test@example.invalid", roles: ["ops"],
  displayName: "QA" }, environment: "qa" as const };
const grant = { serverHostPort: "synthetic.invalid:1433", initialCatalog: "synthetic-db", userId: "synthetic-login",
  secretName: "synthetic-reference", databaseId: "db-a", taskId: "task-a", linkId: "link-a", profileVersion: "1",
  linkVersion: "2", executionVersion: "3" };
function setup() {
  return { transaction: async <T>(fn: (tx: never) => Promise<T>): Promise<T> => fn({} as never),
    read: vi.fn().mockResolvedValue(grant), audit: vi.fn(), secret: vi.fn().mockResolvedValue("fixture-password") };
}
describe("task-bound database connection disclosure", () => {
  it("only opens audited metadata and does not read the password", async () => {
    const io = setup();
    const result = await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "view" } }, io);
    expect(result).toEqual({ kind: "info", info: { server: grant.serverHostPort, databaseName: grant.initialCatalog,
      user: grant.userId, hasPassword: true } });
    expect(io.audit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      action: "task_database_connection_opened", metadata: { databaseId: "db-a", linkId: "link-a" }, entityId: "task-a",
    }));
    expect(io.secret).not.toHaveBeenCalled();
    expect(JSON.stringify(io.audit.mock.calls)).not.toMatch(/synthetic-login|synthetic-reference|fixture-password/);
  });

  it("discards a retrieved password if access is revoked or the locked version changes", async () => {
    for (const after of [null, { ...grant, profileVersion: "changed" }, { ...grant, linkId: "other" }]) {
      const io = setup();
      io.read.mockResolvedValueOnce(grant).mockResolvedValueOnce(after);
      expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).toBeNull();
      expect(io.secret).toHaveBeenCalledOnce();
      expect(io.audit).not.toHaveBeenCalled();
    }
  });

  it("fails closed before retrieving any credential for a denied task, and on audit failure", async () => {
    const io = setup();
    io.read.mockResolvedValueOnce(null);
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).toBeNull();
    expect(io.secret).not.toHaveBeenCalled();
    io.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).rejects.toThrow("audit unavailable");
  });

  it("audits explicit field and password copies separately without the copied value", async () => {
    const io = setup();
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "copy", part: "userId" } }, io))
      .toEqual({ kind: "part", part: "userId", value: grant.userId });
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "copy", part: "password" } }, io))
      .toEqual({ kind: "password", value: "fixture-password" });
    expect(io.audit.mock.calls.map(([, event]) => [event.action, event.metadata.part])).toEqual([
      ["task_database_connection_copied", "userId"], ["task_database_connection_copied", "password"],
    ]);
    expect(JSON.stringify(io.audit.mock.calls)).not.toMatch(/synthetic-login|fixture-password/);
  });
});
