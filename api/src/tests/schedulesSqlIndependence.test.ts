import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRecord } from "../types/models";

const mocks = vi.hoisted(() => ({
  http: vi.fn(),
  timer: vi.fn(),
  readClients: vi.fn(),
}));

vi.mock("@azure/functions", () => ({ app: { http: mocks.http, timer: mocks.timer } }));
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
    mocks.readClients.mockReset();
    mocks.readClients.mockResolvedValue([client]);
  });

  afterEach(() => {
    delete process.env.DATA_BACKEND;
    delete process.env.SQL_SECURITY_RUNTIME_ENABLED;
  });

  it("obtiene el cliente desde el repositorio SQL", async () => {
    await expect(loadScheduleClient(client.id)).resolves.toEqual(client);
    expect(mocks.readClients).toHaveBeenCalledWith(client.id);
  });
});
