import type sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { catalogDocumentNumberToken } from "../lib/catalogCustomerRefresh";
import type { CatalogExternalReadStatement, CatalogExternalSourceTransport } from "../lib/catalogExternalSourceQueries";
import { buildCatalogMatchKeyEvidence } from "../lib/catalogMatchKeyEvidence";
import type { CatalogRefreshClaim } from "../lib/catalogRefreshQueueSqlRepository";
import { publishClaimedCatalogSagV2 } from "../lib/catalogSagV2ClaimedPublication";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";
import type { CatalogEnvironment } from "../lib/catalogSourceConfiguration";

const claim: CatalogRefreshClaim = {
  jobId: "01234567-1111-4111-8111-111111111111", workerId: "01234567-2222-4222-8222-222222222222",
  leaseToken: "01234567-3333-4333-8333-333333333333", sourceId: "01234567-4444-4444-8444-444444444444",
  attempt: 1, environment: "qa", bindingRevision: "0123456789abcdef", profileRevision: "fedcba9876543210", matchKeyVersion: 2,
};
const binding: SqlCatalogSourceBinding = {
  id: claim.sourceId, profileId: "synthetic-v2-profile", label: "Synthetic", role: "sag-admin", environment: "qa",
  state: "active", bindingVersion: claim.bindingRevision, profileRevision: claim.profileRevision,
  contractVersion: "sag_admin_v2", canReadCurrentProfile: true,
};
const kvName = "catalog-synthetic-match-key";
const kvVersion = "1234abcd1234abcd1234abcd1234abcd";
const keyHex = "a7".repeat(32);
const privateError = () => new Error("synthetic-sensitive-provider-error");
const ineligible = { outcome: "ineligible", queue: "untouched" };
const cancelled = { outcome: "cancelled", queue: "untouched" };
const stale = { outcome: "stale", queue: "fenced-stale" };
const unconfirmed = { outcome: "unconfirmed", queue: "lease-recovery" };
const reserveRpc = "settings.reserve_catalog_sag_v2_attempt";
const publishRpc = "settings.publish_catalog_sag_v2_with_targets";
const failureRpc = "settings.fail_catalog_sag_v2_attempt";

function environment(): NodeJS.ProcessEnv {
  return {
    PORTAL_CATALOG_READ_ENABLED: "true", PORTAL_CATALOG_AUTOMATION_ENABLED: "true", PORTAL_CATALOG_SAG_V2_ENABLED: "true",
    PORTAL_SAG_ENVIRONMENT: "qa", PORTAL_CATALOG_MATCH_KEY_VERSION: "2", PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: kvName,
    PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: kvVersion,
    PORTAL_CATALOG_SAG_ISSUER_MAP: JSON.stringify([{ countryId: 1, issuerScope: "CO:NIT" }]),
  };
}

function harness(owner = false) {
  const events: string[] = [];
  const calls: { procedure: string; parameters: Record<string, unknown> }[] = [];
  const rows: Partial<Record<CatalogExternalReadStatement["tag"], readonly unknown[]>> = {
    schema: [{ compatible: true, readOnly: true }], counts: [{ customerCount: "2", companyCount: "1" }],
    customerPage: [1, 2].map(i => ({
      sourceRecordId: i, documentNumber: i === 1 ? " 123-4 " : "NO-ISSUER", reportedCountryId: i, environment: "production",
      licensedModules: "A", domainCandidate: null, testStartedOn: null, productionStartedOn: null, demoStartedOn: null,
    })),
    companyPage: [{ companyRecordId: 44, customerRecordId: 999, displayName: "Synthetic company", isAvailable: false,
      targetState: "unverified", targetHost: null, targetPort: null, targetDatabaseName: null }],
  };
  const readBindings = vi.fn(async (_env: CatalogEnvironment, _signal: AbortSignal, _sourceId: string):
    Promise<readonly SqlCatalogSourceBinding[]> => { events.push("binding"); return [binding]; });
  const getSecret = vi.fn(async (_name: string, _signal: AbortSignal, _version: string) => {
    events.push("key"); return keyHex;
  });
  const select = vi.fn(async (statement: CatalogExternalReadStatement) => {
    events.push(statement.tag); return rows[statement.tag] ?? [];
  });
  const transport: CatalogExternalSourceTransport = {
    withConsistentRead(request, work) {
      events.push("snapshot"); expect(request.contract).toBe("sag_admin_v2_targets");
      return work({ consistency: "verified", select });
    },
  };
  const loadTransport = vi.fn(async (_binding: SqlCatalogSourceBinding, _signal: AbortSignal) => {
    events.push("transport"); return transport;
  });
  const execute = vi.fn(async (procedure: string, parameters: Record<string, unknown>) => {
    calls.push({ procedure, parameters }); events.push(procedure);
    if (procedure === (owner ? "settings.reserve_catalog_sag_v2_owner_attempt" : reserveRpc)) return { recordsets: [[{ attemptOrdinal: "54", observedAt: new Date("2026-11-17T20:00:00Z") }]] };
    if (procedure === (owner ? "settings.publish_catalog_sag_v2_owner_with_targets" : publishRpc)) return { recordsets: [[{ result: "published", jobStatus: "succeeded" }]] };
    if (procedure === (owner ? "settings.fail_catalog_sag_v2_owner_attempt" : failureRpc)) return { recordsets: [[{ result: "failed", jobStatus: "retry" }]] };
    throw privateError();
  });
  const request = vi.fn(() => {
    const parameters: Record<string, unknown> = {};
    const rpc = {
      input(name: string, _type: unknown, value: unknown) { parameters[name] = value; return rpc; },
      execute(procedure: string) { return execute(procedure, parameters); },
    };
    return rpc as unknown as sql.Request;
  });
  const getDedicatedPool = vi.fn(async (_env: CatalogEnvironment) => { events.push("dedicated"); return { request }; });
  const io = { readBindings, getSecret, getDedicatedPool, loadTransport };
  return { io, events, calls, rows, request, execute, select, env: environment() };
}

describe("claimed SAG v2 publication service", () => {
  it("forwards Clients-only admission to the owner publisher without requiring the full inventory scope", async () => {
    const h = harness(true);
    Object.assign(h.env, { PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE: "portal-owner",
      PORTAL_CATALOG_READ_ENABLED: "false", PORTAL_CATALOG_CLIENTS_READ_ENABLED: "true" });
    expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toMatchObject({ outcome: "published" });
    expect(h.calls.map(c => c.procedure)).toEqual(["settings.reserve_catalog_sag_v2_owner_attempt", "settings.publish_catalog_sag_v2_owner_with_targets"]);
    expect(h.events.filter(e => e === "snapshot")).toHaveLength(1);
  });
  it("routes explicit owner-mode claims through fixed owner RPCs while the SAG transport remains SELECT-only", async () => {
    const h = harness(true); h.env.PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE = "portal-owner";
    const result = await publishClaimedCatalogSagV2(claim, h.io, h.env);
    expect(result.outcome).toBe("published");
    expect(h.calls.map(c => c.procedure)).toEqual(["settings.reserve_catalog_sag_v2_owner_attempt", "settings.publish_catalog_sag_v2_owner_with_targets"]);
    expect(h.events.filter(e => e === "snapshot")).toHaveLength(1);
    expect(h.select).toHaveBeenCalled();
  });

  it("owner publication never weakens the external SAG read-only proof", async () => {
    const h = harness(true); h.env.PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE = "portal-owner";
    h.rows.schema = [{ compatible: true, readOnly: false }];
    await publishClaimedCatalogSagV2(claim, h.io, h.env);
    expect(h.calls.map(c => c.procedure)).toEqual(["settings.reserve_catalog_sag_v2_owner_attempt", "settings.fail_catalog_sag_v2_owner_attempt"]);
    expect(h.select.mock.calls.map(c => c[0].tag)).toEqual(["schema"]);
  });

  it("requires explicit server feature configuration and has no I/O when disabled or invalid", async () => {
    for (const patch of [
      { PORTAL_CATALOG_SAG_V2_ENABLED: undefined }, { PORTAL_CATALOG_SAG_V2_ENABLED: "false" },
      { PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE: "portal-owner " }, { PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE: "dedicated" },
      { PORTAL_CATALOG_READ_ENABLED: "false" }, { PORTAL_CATALOG_AUTOMATION_ENABLED: undefined },
      { PORTAL_SAG_ENVIRONMENT: "test" }, { PORTAL_CATALOG_MATCH_KEY_VERSION: "02" },
      { PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "https://vault.invalid/" }, { PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "latest" },
      { PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: undefined }, { PORTAL_CATALOG_SAG_ISSUER_MAP: "[]" },
      { PORTAL_CATALOG_SAG_ISSUER_MAP: JSON.stringify([{ countryId: 1, issuerScope: "CO:NIT", complete: true }]) },
      { PORTAL_CATALOG_SAG_ISSUER_MAP: JSON.stringify([{ countryId: 1, issuerScope: "CO:NIT" }, { countryId: 1, issuerScope: "CO:CC" }]) },
    ]) {
      const h = harness();
      expect(await publishClaimedCatalogSagV2(claim, h.io, { ...h.env, ...patch })).toEqual(ineligible);
      expect(h.events).toEqual([]);
    }
  });

  it("rejects malformed claims and refuses an exact claim outside the configured realm or key version before I/O", async () => {
    const h = harness();
    const forged = { ...claim, keyProof: {}, vaultSecretVersion: kvVersion };
    for (const item of [forged, { ...claim, leaseToken: "invalid" }, { ...claim, attempt: 6 },
      { ...claim, jobId: "00000000-0000-0000-0000-000000000000" }, { ...claim, profileRevision: "xx" }]) {
      expect(await publishClaimedCatalogSagV2(item, h.io, h.env)).toEqual(ineligible);
    }
    expect(await publishClaimedCatalogSagV2({ ...claim, environment: "production" }, h.io, h.env)).toEqual(stale);
    expect(await publishClaimedCatalogSagV2({ ...claim, matchKeyVersion: 3 }, h.io, h.env)).toEqual(stale);
    expect(h.events).toEqual([]);
  });

  it.each([
    { rows: [] }, { rows: [{ ...binding, contractVersion: "sag_admin_v1" }] }, { rows: [{ ...binding, role: "erp-customers" }] },
    { rows: [{ ...binding, state: "retired" }] }, { rows: [{ ...binding, canReadCurrentProfile: false }] },
    { rows: [{ ...binding, environment: "production" }] }, { rows: [{ ...binding, bindingVersion: "1234567890abcdef" }] },
    { rows: [{ ...binding, profileRevision: "1234567890abcdef" }] },
  ])("does not access credentials, produce RPCs or fall back on stale/missing bindings $rows", async ({ rows }) => {
    const h = harness();
    h.io.readBindings.mockResolvedValue(rows as SqlCatalogSourceBinding[]);
    expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual(stale);
    expect(h.events).toEqual([]);
    expect(h.io.getSecret).not.toHaveBeenCalled();
    expect(h.io.getDedicatedPool).not.toHaveBeenCalled();
    expect(h.io.loadTransport).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("defers ambiguous, oversized, malformed or unavailable metadata without touching key, publisher or source", async () => {
    for (const metadata of [
      [binding, { ...binding, id: binding.id.toUpperCase(), canReadCurrentProfile: false }],
      Array.from({ length: 251 }, () => binding),
      [{ ...binding, profileId: " bad\u0000identifier " }],
    ]) {
      const h = harness();
      h.io.readBindings.mockResolvedValue(metadata);
      expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual(unconfirmed);
      expect(h.io.getSecret).not.toHaveBeenCalled();
      expect(h.io.getDedicatedPool).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    }
    const h = harness();
    h.io.readBindings.mockRejectedValue(privateError());
    expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual(unconfirmed);
    expect(h.io.getSecret).not.toHaveBeenCalled();
  });

  it("reads the exact immutable KV version, builds proof in-process and calls only the dedicated procedures", async () => {
    const h = harness();
    h.io.getSecret.mockImplementationOnce(async () => { h.events.push("key"); return keyHex.toUpperCase(); });
    expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual({
      outcome: "published", queue: "settled", jobStatus: "succeeded",
    });
    expect(h.io.getSecret).toHaveBeenCalledExactlyOnceWith(kvName, expect.any(AbortSignal), kvVersion);
    expect(h.io.getDedicatedPool).toHaveBeenCalledExactlyOnceWith("qa");
    expect(h.events.slice(0, 6)).toEqual(["binding", "key", "dedicated", "binding", reserveRpc, "binding"]);
    for (const call of h.io.readBindings.mock.calls) expect(call).toEqual(["qa", expect.any(AbortSignal), claim.sourceId]);
    for (const event of ["snapshot", "schema", "counts", "customerPage", "companyPage"]) {
      expect(h.events[h.events.indexOf(event) - 1]).toBe("binding");
    }
    expect(h.calls.map(item => item.procedure)).toEqual([reserveRpc, publishRpc]);
    const [reserve, published] = h.calls.map(item => item.parameters);
    const syntheticKey = Buffer.from(keyHex, "hex");
    const proof = buildCatalogMatchKeyEvidence(claim.environment, claim.matchKeyVersion, kvVersion, syntheticKey);
    expect(reserve).toMatchObject({
      environment: "qa", matchKeyVersion: 2, jobId: claim.jobId, sourceId: claim.sourceId, leaseToken: claim.leaseToken,
      vaultSecretVersion: proof.vaultSecretVersion, keyVerifier: proof.keyVerifier,
    });
    expect(JSON.parse(published.customers as string)).toMatchObject([
      { sourceRecordId: 1, token: catalogDocumentNumberToken(syntheticKey, "qa", "123-4")?.toString("hex"), issuer: "CO", documentType: "NIT" },
      { sourceRecordId: 2, issuer: null, documentType: null },
    ]);
    expect(JSON.parse(published.companies as string)).toEqual([
      { companyRecordId: 44, customerRecordId: 999, displayName: "Synthetic company", isAvailable: false },
    ]);
    expect(JSON.parse(published.targets as string)).toEqual([{ companyRecordId: 44, state: "unverified", locationToken: null }]);
    expect(JSON.stringify(h.calls, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toMatch(/synthetic-match-key|NO-ISSUER|documentNumber/);
    syntheticKey.fill(0);
  });

  it("pins claim and deployment inputs before await; refuses a changed profile before reserve", async () => {
    const h = harness();
    const request = { ...claim };
    let finish!: (rows: readonly SqlCatalogSourceBinding[]) => void;
    h.io.readBindings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce([{ ...binding, profileId: "changed-synthetic-profile" }]);
    const run = publishClaimedCatalogSagV2(request, h.io, h.env);
    await vi.waitFor(() => expect(h.io.readBindings).toHaveBeenCalledOnce());
    h.env.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION = "0".repeat(32);
    h.env.PORTAL_CATALOG_SAG_ISSUER_MAP = "[]";
    request.profileRevision = "9".repeat(16);
    finish([binding]);
    expect(await run).toEqual(stale);
    expect(h.io.getSecret).toHaveBeenCalledExactlyOnceWith(kvName, expect.any(AbortSignal), kvVersion);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.io.loadTransport).not.toHaveBeenCalled();
  });

  it("rechecks binding before each source operation; profile drift during SNAPSHOT does not trigger a write", async () => {
    const h = harness();
    h.select.mockImplementationOnce(async () => {
      h.io.readBindings.mockResolvedValue([{ ...binding, profileRevision: "9".repeat(16) }]);
      return h.rows.schema!;
    });
    expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual(stale);
    expect(h.calls.map(item => item.procedure)).toEqual([reserveRpc]);
    expect(h.select).toHaveBeenCalledOnce();
  });

  it("defers malformed or unavailable match keys and dedicated pool errors without starting transport", async () => {
    for (const key of [keyHex + "\n", " " + keyHex, "g".repeat(64), "42", new String(keyHex)]) {
      const h = harness();
      h.io.getSecret.mockResolvedValue(key as string);
      expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual(unconfirmed);
      expect(h.io.getDedicatedPool).not.toHaveBeenCalled();
      expect(h.io.loadTransport).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    }
    for (const boundary of ["getSecret", "getDedicatedPool"] as const) {
      const h = harness();
      h.io[boundary].mockRejectedValue(privateError());
      expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual(unconfirmed);
      expect(h.io.loadTransport).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    }
  });

  it.each(["readBindings", "getSecret", "getDedicatedPool"] as const)("stops when aborted inside %s even if it resolves", async phase => {
    const h = harness();
    const cancel = new AbortController();
    const original = h.io[phase].getMockImplementation()!;
    if (phase === "readBindings") h.io.readBindings.mockImplementationOnce(async (env, signal, id) => {
      cancel.abort(privateError()); return (original as typeof h.io.readBindings)(env, signal, id);
    });
    if (phase === "getSecret") h.io.getSecret.mockImplementationOnce(async (name, signal, ver) => {
      cancel.abort(privateError()); return (original as typeof h.io.getSecret)(name, signal, ver);
    });
    if (phase === "getDedicatedPool") h.io.getDedicatedPool.mockImplementationOnce(async env => {
      cancel.abort(privateError()); return (original as typeof h.io.getDedicatedPool)(env);
    });
    expect(await publishClaimedCatalogSagV2(claim, h.io, h.env, cancel.signal)).toEqual(cancelled);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.io.loadTransport).not.toHaveBeenCalled();
  });

  it("wipes all owned 32-byte key buffers after an unconfirmed publish; never retries or compensates a write", async () => {
    const h = harness();
    const originalFill = Buffer.prototype.fill;
    const owned: Buffer[] = [];
    const wipe = vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (this: Buffer, value, ...args) {
      if (value === 0 && this.length === 32 && this.toString("hex") === keyHex) owned.push(this);
      return Reflect.apply(originalFill, this, [value, ...args]);
    });
    h.execute.mockImplementationOnce(async procedure => {
      expect(procedure).toBe(reserveRpc);
      return { recordsets: [[{ attemptOrdinal: "54", observedAt: new Date("2026-11-17T20:00:00Z") }]] };
    }).mockRejectedValueOnce(privateError());
    try {
      expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual(unconfirmed);
      expect(h.request).toHaveBeenCalledTimes(2);
      expect(h.execute.mock.calls.map(call => call[0])).toEqual([reserveRpc, publishRpc]);
      expect(new Set(owned).size).toBe(3);
      expect(owned.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
    } finally { wipe.mockRestore(); }
  });

  it("returns only the confirmed procedure outcome when recording a source read failure", async () => {
    const h = harness();
    h.io.loadTransport.mockRejectedValue(privateError());
    expect(await publishClaimedCatalogSagV2(claim, h.io, h.env)).toEqual({
      outcome: "failed-recorded", queue: "settled", jobStatus: "retry",
    });
    expect(h.calls.map(item => item.procedure)).toEqual([reserveRpc, failureRpc]);
  });
});
