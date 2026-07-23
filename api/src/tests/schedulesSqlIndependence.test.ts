import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRecord } from "../types/models";

const mocks = vi.hoisted(() => ({
  http: vi.fn(),
  timer: vi.fn(),
  cosmosAccess: vi.fn(() => {
    throw new Error("Cosmos must not be accessed in SQL mode.");
  }),
  readClients: vi.fn(),
}));

vi.mock("@azure/functions", () => ({ app: { http: mocks.http, timer: mocks.timer } }));
vi.mock("../lib/cosmos", () => ({ getContainer: mocks.cosmosAccess }));
vi.mock("../lib/clientsSqlRepository", () => ({
  readSqlClients: mocks.readClients,
}));

import { loadScheduleClient } from "../functions/schedules";

const client: ClientRecord = {
  id: "client_sql",
  name: "Cliente SQL",
  status: "active",
  createdAt: "2026-05-01T00:00:00.000Z",
  createdBy: "system",
  updatedAt: "2026-05-01T00:00:00.000Z",
  updatedBy: "system",
};

describe("creación de programaciones SQL-only", () => {
  beforeEach(() => {
    process.env.DATA_BACKEND = "sql";
    process.env.SQL_SECURITY_RUNTIME_ENABLED = "true";
    delete process.env.COSMOS_CONNECTION_STRING;
    delete process.env.COSMOS_DATABASE_NAME;
    mocks.cosmosAccess.mockClear();
    mocks.readClients.mockReset();
    mocks.readClients.mockResolvedValue([client]);
  });

  afterEach(() => {
    delete process.env.DATA_BACKEND;
    delete process.env.SQL_SECURITY_RUNTIME_ENABLED;
  });

  it("obtiene el cliente desde SQL sin inicializar Cosmos", async () => {
    await expect(loadScheduleClient(client.id)).resolves.toEqual(client);
    expect(mocks.readClients).toHaveBeenCalledWith(client.id);
    expect(mocks.cosmosAccess).not.toHaveBeenCalled();
  });
});
