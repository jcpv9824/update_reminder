import type sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import type { CatalogRefreshPublication } from "../lib/catalogCustomerRefresh";
import { createSqlCatalogErpOwnerPublisher } from "../lib/catalogErpOwnerPublisher";

const operator = {
  kind: "worker", environment: "qa", sourceId: "af40b217-caae-ed11-9f7e-112233445566",
  jobId: "1a56df91-f51c-4320-a626-67fd22fd3db8", workerId: "3a56df91-f51c-4320-a626-67fd22fd3db8",
  leaseToken: "4a56df91-f51c-4320-a626-67fd22fd3db8", attempt: 1,
  bindingRevision: "1234567890abcdef", profileRevision: "abcdef1234567890", matchKeyVersion: 1,
  vaultSecretVersion: Buffer.alloc(16, 7), keyVerifier: Buffer.alloc(32, 9),
} as const;
const revision: CatalogRefreshPublication = {
  environment: operator.environment, sourceId: operator.sourceId, bindingRevision: operator.bindingRevision,
  profileRevision: operator.profileRevision, matchKeyVersion: operator.matchKeyVersion, attemptOrdinal: "9007199254740993",
  observedAt: new Date("2026-11-19T21:00:00Z"), role: "erp-customers", completeScopes: [],
  rows: [{ sourceRecordId: 123, issuerScope: "CO:NIT", matchToken: Buffer.alloc(32, 4), name: "Empresa de muestra", activeCode: "S" }],
};
const result = (row: Record<string, unknown>) => ({ recordsets: [[row]] });
function fakePool() {
  const calls: { procedure: string; parameters: Record<string, unknown> }[] = [];
  const execute = vi.fn();
  const pool = { request: vi.fn(() => {
    const parameters: Record<string, unknown> = {};
    const request = {
      input(name: string, _type: unknown, value: unknown) { parameters[name] = value; return request; },
      async execute(procedure: string) { calls.push({ procedure, parameters }); return execute(); },
    };
    return request;
  }) };
  return { calls, execute, pool: pool as unknown as Pick<sql.ConnectionPool, "request">, request: pool.request };
}

describe("controlled ERP owner publisher RPC", () => {
  it("binds exact typed operations and the existing normalized ERP projection", async () => {
    const fake = fakePool();
    fake.execute.mockResolvedValueOnce(result({ attemptOrdinal: revision.attemptOrdinal }))
      .mockResolvedValueOnce(result({ result: "published" })).mockResolvedValueOnce(result({ result: "failed" }));
    const publisher = createSqlCatalogErpOwnerPublisher(fake.pool, operator);
    expect(await publisher.reserveAttempt()).toBe(revision.attemptOrdinal);
    await expect(publisher.publish(revision)).resolves.toBe("published");
    await expect(publisher.recordFailure(revision)).resolves.toBeUndefined();
    const common = { environment: "qa", sourceId: operator.sourceId, jobId: operator.jobId, workerId: operator.workerId,
      leaseToken: operator.leaseToken, attempt: 1, bindingVersion: Buffer.from(operator.bindingRevision, "hex"),
      profileVersion: Buffer.from(operator.profileRevision, "hex"), matchKeyVersion: 1,
      vaultSecretVersion: operator.vaultSecretVersion, keyVerifier: operator.keyVerifier };
    const stamp = { attemptOrdinal: 9007199254740993n, observedAt: revision.observedAt };
    expect(fake.calls).toEqual([
      { procedure: "settings.reserve_catalog_erp_owner_attempt", parameters: common },
      { procedure: "settings.publish_catalog_erp_owner", parameters: { ...common, ...stamp, rowCount: 1, rows: expect.any(String) } },
      { procedure: "settings.fail_catalog_erp_owner_attempt", parameters: { ...common, ...stamp } },
    ]);
    expect(JSON.parse(fake.calls[1].parameters.rows as string)).toEqual([{
      sourceRecordId: 123, issuer: "CO", documentType: "NIT", token: "04".repeat(32), officialName: "Empresa de muestra",
      activeCode: "S", allocationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    }]);
  });

  it("keeps the worker, version, match key and ERP-only payload pinned", async () => {
    const fake = fakePool();
    const publisher = createSqlCatalogErpOwnerPublisher(fake.pool, operator);
    await expect(publisher.publish({ ...revision, sourceId: operator.jobId })).rejects.toThrow(/^invalid_catalog_erp_owner_publication$/);
    await expect(publisher.publish({ ...revision, role: "sag-admin" })).rejects.toThrow(/^invalid_catalog_erp_owner_publication$/);
    await expect(publisher.publish({ ...revision, includesSagInventory: true })).rejects.toThrow(/^invalid_catalog_erp_owner_publication$/);
    await expect(publisher.recordFailure({ ...revision, attemptOrdinal: "9223372036854775808" })).rejects.toThrow(/^invalid_catalog_erp_owner_publication$/);
    await expect(publisher.recordFailure({ ...revision, profileRevision: "12".repeat(8) })).rejects.toThrow(/^invalid_catalog_erp_owner_publication$/);
    expect(() => createSqlCatalogErpOwnerPublisher(fake.pool, { ...operator, keyVerifier: Buffer.alloc(31) })).toThrow(/^invalid_catalog_erp_owner_publication$/);
    expect(() => createSqlCatalogErpOwnerPublisher(fake.pool, { ...operator, attempt: 6 })).toThrow(/^invalid_catalog_erp_owner_publication$/);
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("accepts only one exact status row and sanitizes SQL errors without retry or fallback", async () => {
    const fake = fakePool();
    const publisher = createSqlCatalogErpOwnerPublisher(fake.pool, operator);
    fake.execute.mockRejectedValueOnce(new Error("SQL driver details must never be exposed"))
      .mockResolvedValueOnce({ recordsets: [[{ result: "published" }], [{ unexpected: true }]] })
      .mockResolvedValueOnce(result({ result: "wrong" }))
      .mockResolvedValueOnce(result({ result: "superseded" }))
      .mockResolvedValueOnce(result({ result: "superseded" }));
    await expect(publisher.reserveAttempt()).rejects.toThrow(/^catalog_erp_owner_publication_failed$/);
    await expect(publisher.publish(revision)).rejects.toThrow(/^catalog_erp_owner_publication_failed$/);
    await expect(publisher.recordFailure(revision)).rejects.toThrow(/^catalog_erp_owner_publication_failed$/);
    await expect(publisher.publish(revision)).resolves.toBe("superseded");
    await expect(publisher.recordFailure(revision)).resolves.toBeUndefined();
    expect(fake.execute).toHaveBeenCalledTimes(5);
  });
});
