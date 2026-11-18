import { describe, expect, it, vi } from "vitest";
import { runCatalogCustomerRefresh } from "../lib/catalogCustomerRefreshService";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";
import type { StoredExternalDatabaseConnection } from "../lib/integrationConnectionsSqlRepository";
import type { CatalogExternalSourceTransport } from "../lib/catalogExternalSourceQueries";

const id = "7a391825-482a-4dca-8af7-edc6570b1a01";
const otherId = "7a391825-482a-4dca-8af7-edc6570b1a02";
const binding: SqlCatalogSourceBinding = {
  id, profileId: "erp", label: "ERP", role: "erp-customers", environment: "qa", state: "active",
  profileRevision: "0000000000000001", bindingVersion: "0000000000000002", canReadCurrentProfile: true,
  contractVersion: "erp_v1", issuerScope: "CO:NIT",
};
const profile: StoredExternalDatabaseConnection = {
  id: "erp", etag: "0000000000000001", displayName: "ERP", serverHost: "test.example", serverPort: 1433,
  databaseName: "test", username: "readonly", passwordSecretName: "test-ref", passwordConfigured: true, encrypt: true,
  active: true, status: "active", lastTest: null, createdBy: "system", updatedBy: "system",
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
};

function setup(bindings: SqlCatalogSourceBinding[] = [binding]) {
  const transport: CatalogExternalSourceTransport = {
    withConsistentRead: async (_, read) => read({ consistency: "verified",
      select: async (statement) => statement.tag === "schema" ? [{ compatible: true, readOnly: true }] : [] }),
  };
  const io = {
    readBindings: vi.fn(async () => bindings),
    readProfile: vi.fn(async (profileId: string) => ({ ...profile, id: profileId })),
    readSecret: vi.fn(async () => "fictitious-test-value"),
    createTransport: vi.fn(() => transport),
  };
  let ordinal = 0;
  const sink = { reserveAttempt: vi.fn(async () => String(++ordinal)),
    publish: vi.fn(async () => "published" as const), recordFailure: vi.fn(async () => {}) };
  return { io, sink, options: { environment: "qa" as const, sink, matchKey: Buffer.alloc(32), matchKeyVersion: 1 } };
}

describe("runCatalogCustomerRefresh", () => {
  it("never resolves a draft or a profile revision that no longer matches the binding", async () => {
    const { io, options, sink } = setup([binding, { ...binding, id: otherId, state: "draft", profileId: "draft" }]);
    io.readProfile.mockResolvedValue({ ...profile, etag: "0000000000000004" });
    expect(await runCatalogCustomerRefresh(options, io)).toEqual([{ sourceId: id, outcome: "unavailable" }]);
    expect(io.readProfile).toHaveBeenCalledExactlyOnceWith("erp");
    expect(io.readSecret).not.toHaveBeenCalled();
    expect(io.createTransport).not.toHaveBeenCalled();
    expect(sink.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ sourceId: id }));
  });

  it("publishes independent sources even if one cannot access its secret or record a failure", async () => {
    const { io, options, sink } = setup([binding, { ...binding, id: otherId, profileId: "second" }]);
    io.readProfile.mockImplementation(async (profileId) =>
      ({ ...profile, id: profileId, passwordSecretName: profileId === "erp" ? "missing" : "test-ref" }));
    io.readSecret.mockRejectedValueOnce(new Error("synthetic private detail"));
    sink.recordFailure.mockRejectedValueOnce(new Error("synthetic private SQL detail"));
    expect(await runCatalogCustomerRefresh(options, io)).toEqual(expect.arrayContaining([
      { sourceId: id, outcome: "publication_failed" }, { sourceId: otherId, outcome: "published" },
    ]));
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({ sourceId: otherId, rows: [] }));
    expect(JSON.stringify(sink.publish.mock.calls)).not.toContain("fictitious-test-value");
  });
});
