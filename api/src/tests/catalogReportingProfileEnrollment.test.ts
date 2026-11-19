import type sql from "mssql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolveCertifiedCatalogActiveUserSqlTarget } from "../lib/catalogActiveUserSqlReader";
import {
  enrollCatalogReportingProfile, type CatalogReportingProfileEnrollmentOperator, type VerifiedReportingEnrollmentSnapshot,
} from "../lib/catalogReportingProfileEnrollment";

const fake = vi.hoisted(() => ({ secret: vi.fn(), createProbe: vi.fn(), probe: vi.fn(), enroll: vi.fn(), register: vi.fn() }));
vi.mock("../lib/keyVault", () => ({ getSecret: fake.secret }));
vi.mock("../lib/catalogActiveUserSqlReader", () => ({ createCatalogActiveUserSqlEnrollmentProbe: fake.createProbe }));
vi.mock("../lib/catalogSqlTargetInstanceEnrollmentSql", () => ({ enrollCatalogSqlTargetInstanceInTransaction: fake.enroll }));
vi.mock("../lib/catalogReportingProfileRegistrationSqlRepository", () => ({ registerSqlCatalogReportingProfileInTransaction: fake.register }));

const id = (last: number) => `50000000-0000-0000-0000-00000000000${last}`;
const scope = { portalEnvironment: "qa", actorId: "fixture-operator", physicalLinkId: id(1),
  physicalTargetId: id(2), reportConnectionId: "fixture-report" } as const;
const instanceId = id(3);
const databaseGuid = id(4);
const reportProfileId = id(5);
const at = new Date("2026-11-18T17:00:00.000Z");
const physicalExpiry = new Date(at.getTime() + 2 * 60 * 60_000);
const snapshot = (): VerifiedReportingEnrollmentSnapshot => ({
  scope, operationalProfileVersion: Buffer.alloc(8, 1), physicalValidUntil: new Date(physicalExpiry),
  expectedIdentityFingerprint: Buffer.alloc(32, 9), evidence: { contract: "approved_aggregate_view_v1" },
  connection: { profileVersion: Buffer.alloc(8, 2), serverHost: "Sql.Example.test", serverPort: 1433,
    databaseName: "Fixture", username: "fixture_reader", passwordSecretName: "fixture-report-secret" },
});
const approvedRoutes = JSON.stringify([{ environment: "qa", host: "Sql.Example.test", port: 1433, instanceId }]);

function operatorFixture() {
  const authorize = vi.fn<CatalogReportingProfileEnrollmentOperator["authorize"]>().mockResolvedValue(true);
  const readVerified = vi.fn<CatalogReportingProfileEnrollmentOperator["readVerified"]>().mockImplementation(async () => snapshot());
  const commit = vi.fn();
  const rollback = vi.fn();
  const clock = vi.fn().mockResolvedValue({ recordset: [{ current: true }] });
  const bindings: Record<string, unknown> = {};
  const request = {
    input: (name: string, _type: unknown, value: unknown) => { bindings[name] = value; return request; },
    query: clock,
  };
  const tx = { request: () => request } as unknown as sql.Transaction;
  const runSerializable = async <T>(work: (transaction: sql.Transaction) => Promise<T>): Promise<T> => {
    try { const value = await work(tx); commit(); return value; }
    catch (error) { rollback(); throw error; }
  };
  const operator = { authorize, readVerified, runSerializable: vi.fn(runSerializable) } as CatalogReportingProfileEnrollmentOperator;
  return { operator, authorize, readVerified, commit, rollback, tx, clock, bindings };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.stubEnv("PORTAL_CATALOG_SQL_INSTANCE_ROUTES", approvedRoutes);
  vi.resetAllMocks();
  fake.secret.mockResolvedValue("fixture-password");
  fake.createProbe.mockImplementation((resolve: ResolveCertifiedCatalogActiveUserSqlTarget) =>
    async (reference: Parameters<ResolveCertifiedCatalogActiveUserSqlTarget>[0], signal: AbortSignal) => {
      const target = await resolve(reference, signal);
      if (!target) throw new Error("not certified");
      return fake.probe(target);
    });
  fake.probe.mockResolvedValue({ databaseGuid });
  fake.enroll.mockResolvedValue("enrolled");
  fake.register.mockResolvedValue({ status: "registered", reportingProfileId: reportProfileId });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("server-internal reporting profile enrollment", () => {
  it("uses one guarded probe, one writer transaction, two distinct nonces and both exact deadlines", async () => {
    const { operator, authorize, readVerified, commit, tx, clock, bindings } = operatorFixture();
    await expect(enrollCatalogReportingProfile(scope, operator)).resolves.toEqual({ status: "registered", reportingProfileId: reportProfileId });
    expect(authorize.mock.calls[0]?.[0]).toEqual(scope);
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(fake.secret.mock.invocationCallOrder[0]);
    expect(authorize.mock.calls.at(-1)?.[2]).toBe(tx);
    expect(readVerified.mock.calls.at(-1)?.[2]).toBe(tx);
    expect(fake.secret).toHaveBeenCalledExactlyOnceWith("fixture-report-secret", expect.any(AbortSignal));
    expect(fake.probe).toHaveBeenCalledExactlyOnceWith({
      target: { physicalDatabaseId: scope.physicalTargetId, serverGroupId: instanceId, reportingProfileId: expect.any(String) },
      evidence: { contract: "approved_aggregate_view_v1" },
      identity: { instanceId, expectedFingerprint: Buffer.alloc(32, 9) },
      connection: { server: "Sql.Example.test", port: 1433, database: "Fixture", username: "fixture_reader", password: "fixture-password" },
    });
    const enrollment = fake.enroll.mock.calls[0];
    const registration = fake.register.mock.calls[0];
    expect(enrollment[0]).toBe(tx);
    expect(registration[0]).toBe(tx);
    expect(enrollment[1]).toMatchObject({ actorId: scope.actorId, environment: "qa", physicalLinkId: scope.physicalLinkId,
      physicalTargetId: scope.physicalTargetId, trustedInstanceId: instanceId,
      reportRoute: { serverHost: "Sql.Example.test", serverPort: 1433, databaseName: "Fixture" },
      proof: { databaseGuid, verifiedAt: at, validUntil: new Date(at.getTime() + 300_000) } });
    expect(registration[1]).toMatchObject({ validUntil: physicalExpiry, proofId: expect.any(String) });
    expect(registration[1].proofId).not.toBe(enrollment[1].proof.proofId);
    expect(fake.enroll.mock.invocationCallOrder[0]).toBeLessThan(fake.register.mock.invocationCallOrder[0]);
    expect(bindings.validUntil).toEqual(new Date(at.getTime() + 300_000));
    expect(clock.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]);
  });

  it.each(["denied", "stale", "bad route", "scope mismatch", "padded caller"])("does not read secrets or write for %s", async scenario => {
    const { operator, authorize, readVerified } = operatorFixture();
    if (scenario === "denied") authorize.mockResolvedValue(false);
    if (scenario === "stale") readVerified.mockResolvedValue({ ...snapshot(), physicalValidUntil: at });
    if (scenario === "bad route") vi.stubEnv("PORTAL_CATALOG_SQL_INSTANCE_ROUTES", "[]");
    if (scenario === "scope mismatch") readVerified.mockResolvedValue({ ...snapshot(), scope: { ...scope, reportConnectionId: "other" } });
    await expect(enrollCatalogReportingProfile(scenario === "padded caller" ? { ...scope, actorId: " actor" } : scope, operator))
      .resolves.toEqual({ status: "unavailable" });
    expect(fake.secret).not.toHaveBeenCalled();
    expect(fake.probe).not.toHaveBeenCalled();
    expect(fake.enroll).not.toHaveBeenCalled();
  });

  it.each(["authority", "saved route", "registry"])("does not dial if %s changes while fetching the password", async drift => {
    const { operator, authorize, readVerified } = operatorFixture();
    fake.secret.mockImplementationOnce(async () => {
      if (drift === "authority") authorize.mockResolvedValue(false);
      if (drift === "saved route") readVerified.mockResolvedValue({
        ...snapshot(), connection: { ...snapshot().connection, databaseName: "Other" },
      });
      if (drift === "registry") vi.stubEnv("PORTAL_CATALOG_SQL_INSTANCE_ROUTES", "[]");
      return "fixture-password";
    });
    await expect(enrollCatalogReportingProfile(scope, operator)).resolves.toEqual({ status: "unavailable" });
    expect(fake.probe).not.toHaveBeenCalled();
    expect(fake.enroll).not.toHaveBeenCalled();
  });

  it("never opens the writer if the count/schema/identity check fails", async () => {
    const { operator } = operatorFixture();
    fake.probe.mockRejectedValueOnce(new Error("fixture internal error"));
    await expect(enrollCatalogReportingProfile(scope, operator)).resolves.toEqual({ status: "unavailable" });
    expect(operator.runSerializable).not.toHaveBeenCalled();
  });

  it.each(["037 conflict", "audit failure", "clock expired", "live authority changed", "registry changed"])(
    "reverts 058 and never exposes diagnostics when %s", async failure => {
      const { operator, authorize, rollback, commit, clock } = operatorFixture();
      if (failure === "037 conflict") fake.register.mockResolvedValueOnce({ status: "conflict", reason: "reference-changed" });
      if (failure === "audit failure") fake.register.mockRejectedValueOnce(new Error("fixture diagnostic"));
      if (failure === "clock expired") clock.mockResolvedValueOnce({ recordset: [{ current: false }] });
      if (failure === "live authority changed") fake.register.mockImplementationOnce(async () => {
        authorize.mockResolvedValue(false); return { status: "registered", reportingProfileId: reportProfileId };
      });
      if (failure === "registry changed") fake.register.mockImplementationOnce(async () => {
        vi.stubEnv("PORTAL_CATALOG_SQL_INSTANCE_ROUTES", "[]"); return { status: "registered", reportingProfileId: reportProfileId };
      });
      await expect(enrollCatalogReportingProfile(scope, operator)).resolves.toEqual({ status: "unavailable" });
      expect(fake.enroll).toHaveBeenCalledOnce();
      expect(rollback).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
    },
  );
});
