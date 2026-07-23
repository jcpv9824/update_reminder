import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setSecret: vi.fn(), deleteSecret: vi.fn(), createSqlDatabase: vi.fn(), updateSqlDatabase: vi.fn(),
}));

vi.mock("../lib/keyVault", () => ({ setSecret: mocks.setSecret, deleteSecret: mocks.deleteSecret }));
vi.mock("../lib/databasesSqlWriteRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/databasesSqlWriteRepository")>()),
  createSqlDatabase: mocks.createSqlDatabase,
  updateSqlDatabase: mocks.updateSqlDatabase,
}));

import { createSqlDatabaseWithSecret, updateSqlDatabaseWithSecret } from "../lib/databasesSqlService";

const actor = { id: "user-1", email: "user@example.test" } as any;

describe("Databases SQL/Key Vault write coordination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes a newly created secret when the SQL transaction fails", async () => {
    mocks.setSecret.mockResolvedValue(undefined);
    mocks.deleteSecret.mockResolvedValue(undefined);
    mocks.createSqlDatabase.mockRejectedValue(new Error("sql failed"));
    await expect(createSqlDatabaseWithSecret({
      clientId: "client-1", clientName: "Client", domainId: "domain-1", domainName: "https://example.test",
      companyName: "Company", environment: "test",
      rawDbAccess: "server,1433;Initial Catalog=db;User ID=login;Password=secret;",
      assignedUpdaterIds: [], currentUser: actor,
    }, actor)).rejects.toThrow("sql failed");
    expect(mocks.setSecret).toHaveBeenCalledOnce();
    expect(mocks.deleteSecret).toHaveBeenCalledWith(mocks.setSecret.mock.calls[0][0]);
  });

  it("rotates to a new secret reference and retires the superseded reference after commit", async () => {
    mocks.setSecret.mockResolvedValue(undefined);
    mocks.deleteSecret.mockResolvedValue(undefined);
    mocks.updateSqlDatabase.mockImplementation(async (_id, patch) => ({
      record: { id: "db-1", dbAccess: patch.dbAccess }, previousSecretName: "old-secret",
    }));
    const result = await updateSqlDatabaseWithSecret("db-1", {
      rawDbAccess: "server,1433;Initial Catalog=db;User ID=login;Password=new-secret;",
    }, actor);
    const newReference = mocks.setSecret.mock.calls[0][0];
    expect(newReference).not.toBe("old-secret");
    expect(mocks.updateSqlDatabase.mock.calls[0][1].dbAccess.passwordSecretName).toBe(newReference);
    expect(mocks.deleteSecret).toHaveBeenCalledWith("old-secret");
    expect(result?.id).toBe("db-1");
  });
});
