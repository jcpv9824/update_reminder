import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  testSavedSeaweedFSConnection,
  testTransientSeaweedFSConnection,
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
  vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "production");
  vi.stubEnv("SQL_DATABASE", "PortalSAGWeb");
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
afterEach(() => vi.unstubAllEnvs());

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
    expect(mocks.validateSeaweed).toHaveBeenCalledWith(expect.objectContaining({ databaseName: "PortalSAGWeb" }), actor.id);
    expect(mocks.saveSeaweed).toHaveBeenCalledWith(expect.objectContaining({ databaseName: "PortalSAGWeb" }), actor, undefined);
    expect(JSON.stringify(mocks.saveSeaweed.mock.calls[0][0])).not.toContain("access-value");
    expect(JSON.stringify(mocks.saveSeaweed.mock.calls[0][0])).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("SecretName");
  });

  it("persists erased advanced fields and false path style as an untested inactive draft", async () => {
    mocks.readSeaweed.mockResolvedValue(seaweedStored);
    mocks.saveSeaweed.mockResolvedValue({
      ...seaweedStored, databaseName: "PortalSAGWeb", displayName: "", endpoint: "", region: "",
      forcePathStyle: false, lastTest: null,
    });
    const result = await saveSeaweedFSConnection({
      etag: seaweedStored.etag, displayName: "", endpoint: "", region: "", databaseName: "PortalSAGWeb",
      bucket: "portal-files", forcePathStyle: false, active: false,
    }, actor);
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.validateSeaweed).not.toHaveBeenCalled();
    expect(mocks.recordSeaweedTest).not.toHaveBeenCalled();
    expect(mocks.saveSeaweed).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "", endpoint: "", region: "", databaseName: "PortalSAGWeb",
      active: false, forcePathStyle: false, credentialsConfigured: true,
      accessKeySecretName: seaweedStored.accessKeySecretName, secretKeySecretName: seaweedStored.secretKeySecretName,
    }), actor, seaweedStored.etag);
    expect(result).toMatchObject({ displayName: "", endpoint: "", region: "", forcePathStyle: false, lastTest: null });
  });

  it("cannot activate an incomplete profile or persist new keys in an incomplete draft", async () => {
    const draft = { displayName: "", endpoint: "", region: "", bucket: "portal-files", forcePathStyle: false };
    await expect(saveSeaweedFSConnection({ ...draft, active: true }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(saveSeaweedFSConnection({
      ...draft, active: false, accessKey: "fixture-access", secretKey: "fixture-secret",
    }, actor)).rejects.toMatchObject({ status: 400 });
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.saveSeaweed).not.toHaveBeenCalled();
  });

  it("blocks a cross-environment path before probing or reading credentials", async () => {
    await expect(testTransientSeaweedFSConnection({
      databaseName: "PortalSAGWeb-TEST", endpoint: "https://s3.example.com", region: "us-east-1",
      bucket: "portal-files", forcePathStyle: true, accessKey: "access", secretKey: "secret",
    }, actor)).rejects.toMatchObject({ status: 400 });
    expect(mocks.validateSeaweed).not.toHaveBeenCalled();
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it("uses separate QA secret names and never reads legacy production references from QA", async () => {
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    vi.stubEnv("SQL_DATABASE", "PortalSAGWeb-TEST");
    const legacy = {
      ...seaweedStored, accessKeySecretName: "portal-sag-seaweedfs-access-key",
      secretKeySecretName: "portal-sag-seaweedfs-secret-key",
    };
    mocks.readSeaweed.mockResolvedValue(legacy);
    expect((await readIntegrationConnections()).objectStorage).toMatchObject({ credentialsConfigured: false, lastTest: null });
    await expect(testSavedSeaweedFSConnection(actor)).rejects.toMatchObject({ status: 400 });
    expect(mocks.getSecret).not.toHaveBeenCalled();
    await saveSeaweedFSConnection({
      etag: legacy.etag, displayName: "QA", endpoint: "https://s3.example.com", region: "us-east-1",
      bucket: "portal-files", forcePathStyle: true, accessKey: "fixture-access", secretKey: "fixture-secret",
      databaseName: "PortalSAGWeb-TEST", active: false,
    }, actor);
    expect(mocks.setSecret.mock.calls.map(([name]) => name)).toEqual([
      "portal-sag-qa-seaweedfs-access-key", "portal-sag-qa-seaweedfs-secret-key",
    ]);
    expect(mocks.validateSeaweed).toHaveBeenCalledWith(expect.objectContaining({ databaseName: "PortalSAGWeb-TEST" }), actor.id);
  });

  it("refuses to attach a saved test result to a newer profile revision", async () => {
    mocks.readSeaweed.mockResolvedValue(seaweedStored);
    mocks.getSecret.mockResolvedValue("fixture-only");
    mocks.recordSeaweedTest.mockResolvedValue(null);
    await expect(testSavedSeaweedFSConnection(actor)).rejects.toMatchObject({ status: 409 });
    expect(mocks.recordSeaweedTest).toHaveBeenCalledWith(success, actor, seaweedStored.etag);
  });

  it("honors client If-Match before probing and accepts a cleared display label", async () => {
    mocks.readSeaweed.mockResolvedValue({ ...seaweedStored, displayName: "" });
    mocks.getSecret.mockResolvedValue("fixture-only");
    await expect(testSavedSeaweedFSConnection(actor, "1111111111111111")).rejects.toMatchObject({ status: 409 });
    expect(mocks.getSecret).not.toHaveBeenCalled();
    await expect(testSavedSeaweedFSConnection(actor, seaweedStored.etag))
      .resolves.toMatchObject({ result: { succeeded: true } });
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
