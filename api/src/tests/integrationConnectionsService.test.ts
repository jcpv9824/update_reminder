import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  readSeaweed: vi.fn(),
  readDatabases: vi.fn(),
  readDatabase: vi.fn(),
  saveSeaweed: vi.fn(),
  saveDatabase: vi.fn(),
  recordSeaweedTest: vi.fn(),
  recordDatabaseTest: vi.fn(),
  deleteDatabase: vi.fn(),
  validateSeaweed: vi.fn(),
  validateDatabase: vi.fn(),
}));

vi.mock("../lib/keyVault", () => ({
  getSecret: mocks.getSecret,
  setSecret: mocks.setSecret,
}));
vi.mock("../lib/integrationConnectionsSqlRepository", () => ({
  readStoredSeaweedFSConnection: mocks.readSeaweed,
  readStoredExternalDatabaseConnections: mocks.readDatabases,
  readStoredExternalDatabaseConnection: mocks.readDatabase,
  saveSqlSeaweedFSConnection: mocks.saveSeaweed,
  saveSqlExternalDatabaseConnection: mocks.saveDatabase,
  recordSeaweedFSConnectionTest: mocks.recordSeaweedTest,
  recordExternalDatabaseConnectionTest: mocks.recordDatabaseTest,
  deleteSqlExternalDatabaseConnection: mocks.deleteDatabase,
}));
vi.mock("../lib/integrationConnectionValidation", () => ({
  validateSeaweedFSConnection: mocks.validateSeaweed,
  validateExternalSqlConnection: mocks.validateDatabase,
}));

import {
  readIntegrationConnections,
  saveExternalDatabaseConnection,
  saveSeaweedFSConnection,
} from "../lib/integrationConnectionsService";

const actor = { id: "admin-1", email: "admin@example.com" };
const success = {
  succeeded: true,
  testedAt: "2026-07-29T10:00:00.000Z",
  testedBy: actor.id,
  message: "Validada.",
};
const seaweedStored = {
  id: "seaweedfs-primary",
  etag: "0102030405060708",
  provider: "seaweedfs" as const,
  displayName: "SeaweedFS",
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "portal-files",
  forcePathStyle: true,
  credentialsConfigured: true,
  active: false,
  lastTest: success,
  createdAt: "2026-07-29T10:00:00.000Z",
  createdBy: actor.id,
  updatedAt: "2026-07-29T10:00:00.000Z",
  updatedBy: actor.id,
  accessKeySecretName: "hidden-access-name",
  secretKeySecretName: "hidden-secret-name",
};
const databaseStored = {
  id: "external_sql_1",
  etag: "0102030405060708",
  displayName: "QA externa",
  purpose: "Validación",
  serverHost: "sql.example.com",
  serverPort: 1433,
  databaseName: "PortalQA",
  username: "portal_user",
  passwordConfigured: true,
  encrypt: true as const,
  active: true,
  status: "active" as const,
  lastTest: success,
  createdAt: "2026-07-29T10:00:00.000Z",
  createdBy: actor.id,
  updatedAt: "2026-07-29T10:00:00.000Z",
  updatedBy: actor.id,
  passwordSecretName: "hidden-password-name",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSeaweed.mockResolvedValue(null);
  mocks.readDatabases.mockResolvedValue([]);
  mocks.readDatabase.mockResolvedValue(null);
  mocks.validateSeaweed.mockResolvedValue(success);
  mocks.validateDatabase.mockResolvedValue(success);
  mocks.getSecret.mockRejectedValue(new Error("not found"));
  mocks.setSecret.mockResolvedValue(undefined);
  mocks.saveSeaweed.mockResolvedValue(seaweedStored);
  mocks.recordSeaweedTest.mockResolvedValue(seaweedStored);
  mocks.saveDatabase.mockResolvedValue(databaseStored);
  mocks.recordDatabaseTest.mockResolvedValue(databaseStored);
});

describe("integrationConnectionsService", () => {
  it("never exposes Key Vault secret names on reads", async () => {
    mocks.readSeaweed.mockResolvedValue(seaweedStored);
    mocks.readDatabases.mockResolvedValue([databaseStored]);

    const response = await readIntegrationConnections();
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain("hidden-access-name");
    expect(serialized).not.toContain("hidden-secret-name");
    expect(serialized).not.toContain("hidden-password-name");
    expect(response.objectStorage?.credentialsConfigured).toBe(true);
    expect(response.externalDatabases[0].passwordConfigured).toBe(true);
  });

  it("does not persist credentials when SeaweedFS validation fails", async () => {
    mocks.validateSeaweed.mockResolvedValue({ ...success, succeeded: false, message: "No conecta." });

    await expect(saveSeaweedFSConnection({
      displayName: "SeaweedFS",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "portal-files",
      forcePathStyle: true,
      accessKey: "access",
      secretKey: "secret",
      active: false,
    }, actor)).rejects.toMatchObject({ status: 400 });

    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.saveSeaweed).not.toHaveBeenCalled();
  });

  it("validates first, stores SeaweedFS secrets in Key Vault and sends only references to SQL", async () => {
    const result = await saveSeaweedFSConnection({
      displayName: "SeaweedFS",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "portal-files",
      forcePathStyle: true,
      accessKey: "access-value",
      secretKey: "secret-value",
      active: false,
    }, actor);

    expect(mocks.validateSeaweed).toHaveBeenCalledBefore(mocks.setSecret);
    expect(mocks.setSecret).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.saveSeaweed.mock.calls[0][0])).not.toContain("access-value");
    expect(JSON.stringify(mocks.saveSeaweed.mock.calls[0][0])).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("SecretName");
  });

  it("does not write an external SQL password when validation fails", async () => {
    mocks.validateDatabase.mockResolvedValue({ ...success, succeeded: false, message: "No conecta." });

    await expect(saveExternalDatabaseConnection({
      displayName: "QA externa",
      serverHost: "sql.example.com",
      serverPort: 1433,
      databaseName: "PortalQA",
      username: "portal_user",
      password: "db-secret",
      active: true,
    }, actor)).rejects.toMatchObject({ status: 400 });

    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.saveDatabase).not.toHaveBeenCalled();
  });

  it("stores an external SQL password only in Key Vault", async () => {
    const result = await saveExternalDatabaseConnection({
      displayName: "QA externa",
      serverHost: "sql.example.com",
      serverPort: 1433,
      databaseName: "PortalQA",
      username: "portal_user",
      password: "db-secret",
      active: true,
    }, actor);

    expect(mocks.setSecret).toHaveBeenCalledTimes(1);
    expect(mocks.setSecret.mock.calls[0][1]).toBe("db-secret");
    expect(JSON.stringify(mocks.saveDatabase.mock.calls[0][0])).not.toContain("db-secret");
    expect(JSON.stringify(result)).not.toContain("passwordSecretName");
  });
});
