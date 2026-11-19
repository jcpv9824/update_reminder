import { randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import sql from "mssql";
import { createCatalogActiveUserSqlEnrollmentProbe, type CatalogActiveUserContract } from "./catalogActiveUserSqlReader";
import { registerSqlCatalogReportingProfileInTransaction } from "./catalogReportingProfileRegistrationSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { resolveCatalogSqlInstanceRoute } from "./catalogSqlInstanceRegistry";
import { enrollCatalogSqlTargetInstanceInTransaction } from "./catalogSqlTargetInstanceEnrollmentSql";
import { getSecret } from "./keyVault";

export type ReportingEnrollmentScope = Readonly<{
  portalEnvironment: CatalogEnvironment;
  actorId: string;
  physicalLinkId: string;
  physicalTargetId: string;
  reportConnectionId: string;
}>;

/** Provenance belongs to the operator's trusted reader, not to the requester. */
export type VerifiedReportingEnrollmentSnapshot = Readonly<{
  scope: ReportingEnrollmentScope;
  operationalProfileVersion: Buffer;
  physicalValidUntil: Date;
  expectedIdentityFingerprint: Buffer;
  evidence: CatalogActiveUserContract;
  connection: Readonly<{
    profileVersion: Buffer;
    serverHost: string;
    serverPort: number;
    databaseName: string;
    username: string;
    passwordSecretName: string;
  }>;
}>;

/** Server-internal capability; never construct from an HTTP payload. No default operator exists. */
export interface CatalogReportingProfileEnrollmentOperator {
  /** Authenticated, exact actor and destination; verify in the supplied transaction when present. */
  authorize(scope: ReportingEnrollmentScope, signal: AbortSignal, transaction?: sql.Transaction): Promise<boolean>;
  /**
   * Read the active, verified 036 link for these exact IDs and its currently
   * pinned operational rowversion, name and identity anchors, plus the active
   * report-only saved SQL connection and reviewed count contract. No fallback.
   * Use the supplied transaction for the repeated locked read when present.
   */
  readVerified(scope: ReportingEnrollmentScope, signal: AbortSignal, transaction?: sql.Transaction):
    Promise<VerifiedReportingEnrollmentSnapshot | null>;
  /** Use an already authorized SQL operator, rollback on throw, commit only after callback success. */
  runSerializable<T>(work: (transaction: sql.Transaction) => Promise<T>): Promise<T>;
}

type Result = Readonly<{ status: "registered"; reportingProfileId: string }> | Readonly<{ status: "unavailable" }>;
const unavailable: Result = Object.freeze({ status: "unavailable" });
const scopeKeys = ["portalEnvironment", "actorId", "physicalLinkId", "physicalTargetId", "reportConnectionId"] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const guid = (value: unknown): value is string => typeof value === "string" && value.length === 36 &&
  uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max &&
  !!value.trim() && !/\p{C}/u.test(value);
const id = (value: unknown): value is string => text(value, 150) && value === value.trim();
const binary = (value: unknown, length: number): value is Buffer =>
  Buffer.isBuffer(value) && value.length === length && value.some(n => n !== 0);
const rollback = (): never => { throw new Error("catalog_reporting_profile_enrollment_rollback_required"); };
const clockSql = `
SELECT CONVERT(bit, CASE WHEN @@TRANCOUNT=1 AND XACT_STATE()=1 AND (@@OPTIONS & 2)=0
  AND @verifiedAt<=SYSUTCDATETIME() AND @validUntil>SYSUTCDATETIME()
  AND EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
  THEN 1 ELSE 0 END) AS [current];`;

function ownData<const Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, unknown> | null {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const fields = Object.create(null) as Record<Key, unknown>;
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc?.enumerable || !Object.hasOwn(desc, "value")) return null;
    fields[key] = desc.value;
  }
  return fields;
}

function validateScope(value: unknown): ReportingEnrollmentScope | null {
  const item = ownData(value, scopeKeys);
  if (!item) return null;
  const { portalEnvironment, actorId, physicalLinkId, physicalTargetId, reportConnectionId } = item;
  if ((portalEnvironment !== "qa" && portalEnvironment !== "production") || !id(actorId) || !id(reportConnectionId) ||
    !guid(physicalLinkId) || !guid(physicalTargetId)) return null;
  return Object.freeze({ portalEnvironment, actorId, physicalLinkId, physicalTargetId, reportConnectionId });
}

function snapshot(value: VerifiedReportingEnrollmentSnapshot | null, scope: ReportingEnrollmentScope) {
  if (!value || !isDeepStrictEqual(validateScope(value.scope), scope) || !binary(value.operationalProfileVersion, 8) ||
    !binary(value.expectedIdentityFingerprint, 32) || !(value.physicalValidUntil instanceof Date)) return null;
  const physicalUntilMs = Date.prototype.getTime.call(value.physicalValidUntil) as number;
  if (!Number.isFinite(physicalUntilMs) || physicalUntilMs <= Date.now()) return null;
  const { connection } = value;
  if (!connection || !text(connection.serverHost, 253) || !Number.isInteger(connection.serverPort) ||
    connection.serverPort < 1 || connection.serverPort > 65535 || !text(connection.databaseName, 128) ||
    !text(connection.username, 128) || !binary(connection.profileVersion, 8) ||
    typeof connection.passwordSecretName !== "string" ||
    !/^[A-Za-z0-9-]{1,127}(?![\s\S])/.test(connection.passwordSecretName) ||
    !/^[A-Za-z]/.test(connection.serverHost.slice(connection.serverHost.lastIndexOf(".") + 1))) return null;
  return {
    operationalProfileVersion: Buffer.from(value.operationalProfileVersion), physicalUntilMs,
    expectedIdentityFingerprint: Buffer.from(value.expectedIdentityFingerprint), evidence: structuredClone(value.evidence),
    connection: { profileVersion: Buffer.from(connection.profileVersion), serverHost: connection.serverHost,
      serverPort: connection.serverPort, databaseName: connection.databaseName, username: connection.username,
      passwordSecretName: connection.passwordSecretName },
  };
}

/** No pool, runtime role, caller-selected route, or raw proof result crosses this boundary. */
export async function enrollCatalogReportingProfile(input: unknown, operator: CatalogReportingProfileEnrollmentOperator,
  signal?: AbortSignal): Promise<Result> {
  try {
    const scope = validateScope(input);
    if (!scope) return unavailable;
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const read = async (active: AbortSignal, transaction?: sql.Transaction) => {
      if (active.aborted || await operator.authorize(scope, active, transaction) !== true || active.aborted) return null;
      const verified = await operator.readVerified(scope, active, transaction);
      return active.aborted ? null : snapshot(verified, scope);
    };
    const checked = await read(lifetime);
    if (!checked) return unavailable;
    const { connection } = checked;
    const route = () => resolveCatalogSqlInstanceRoute(process.env.PORTAL_CATALOG_SQL_INSTANCE_ROUTES,
      scope.portalEnvironment, connection.serverHost, connection.serverPort);
    const instance = route();
    if (!instance) return unavailable;
    const confirm = async (active: AbortSignal, transaction?: sql.Transaction) => {
      if (active.aborted || route() !== instance) return false;
      const current = await read(active, transaction);
      if (!current || !timingSafeEqual(current.expectedIdentityFingerprint, checked.expectedIdentityFingerprint)) return false;
      const { expectedIdentityFingerprint: _currentIdentity, ...currentPins } = current;
      const { expectedIdentityFingerprint: _checkedIdentity, ...checkedPins } = checked;
      return isDeepStrictEqual(currentPins, checkedPins) && !active.aborted && route() === instance;
    };
    const enrollmentProofId = randomUUID();
    const reportingProofId = randomUUID();
    if (enrollmentProofId === reportingProofId) return unavailable;
    const target = { physicalDatabaseId: scope.physicalTargetId, serverGroupId: instance, reportingProfileId: reportingProofId };
    const probe = createCatalogActiveUserSqlEnrollmentProbe(async (reference, active) => {
      if (!isDeepStrictEqual(reference, target) || !(await confirm(active))) return null;
      const password = await getSecret(connection.passwordSecretName, active);
      if (!password || !(await confirm(active))) return null;
      return {
        target, evidence: checked.evidence, identity: { instanceId: instance, expectedFingerprint: checked.expectedIdentityFingerprint },
        connection: { server: connection.serverHost, port: connection.serverPort, database: connection.databaseName,
          username: connection.username, password },
      };
    });
    const observed = ownData(await probe(target, lifetime), ["databaseGuid"]);
    if (lifetime.aborted || !guid(observed?.databaseGuid) || observed.databaseGuid !== observed.databaseGuid.toLowerCase() ||
      route() !== instance) return unavailable;
    const databaseGuid = observed.databaseGuid;
    const verifiedAtMs = Date.now();
    const enrollmentExpiryMs = Math.min(verifiedAtMs + 300_000, checked.physicalUntilMs);
    if (enrollmentExpiryMs <= verifiedAtMs) return unavailable;
    const reportingExpiryMs = Math.min(verifiedAtMs + 24 * 60 * 60_000, checked.physicalUntilMs);
    const registered = await operator.runSerializable<Extract<Result, { status: "registered" }>>(async transaction => {
      if (!(await confirm(lifetime, transaction)) || Date.now() >= enrollmentExpiryMs) return rollback();
      const enrolled = await enrollCatalogSqlTargetInstanceInTransaction(transaction, {
        environment: scope.portalEnvironment, actorId: scope.actorId, physicalLinkId: scope.physicalLinkId,
        physicalTargetId: scope.physicalTargetId, operationalProfileVersion: checked.operationalProfileVersion,
        reportConnectionId: scope.reportConnectionId, reportProfileVersion: connection.profileVersion,
        reportRoute: { serverHost: connection.serverHost, serverPort: connection.serverPort, databaseName: connection.databaseName },
        trustedInstanceId: instance, expectedIdentityFingerprint: checked.expectedIdentityFingerprint,
        proof: { proofId: enrollmentProofId, databaseGuid, verifiedAt: new Date(verifiedAtMs), validUntil: new Date(enrollmentExpiryMs) },
      });
      if ((enrolled !== "enrolled" && enrolled !== "already-enrolled") || lifetime.aborted ||
        Date.now() >= enrollmentExpiryMs) return rollback();
      const profile = await registerSqlCatalogReportingProfileInTransaction(transaction, {
        portalEnvironment: scope.portalEnvironment, targetId: scope.physicalTargetId, connectionId: scope.reportConnectionId,
        profileVersion: connection.profileVersion, trustedInstanceId: instance, identityFingerprint: checked.expectedIdentityFingerprint,
        evidence: checked.evidence, actor: { id: scope.actorId }, proofId: reportingProofId,
        verifiedAt: new Date(verifiedAtMs), validUntil: new Date(reportingExpiryMs),
      });
      if (profile.status !== "registered" || !guid(profile.reportingProfileId) ||
        !(await confirm(lifetime, transaction))) return rollback();
      const { recordset } = await transaction.request().input("verifiedAt", sql.DateTime2(3), new Date(verifiedAtMs))
        .input("validUntil", sql.DateTime2(3), new Date(enrollmentExpiryMs)).query<{ current: boolean }>(clockSql);
      if (lifetime.aborted || route() !== instance || Date.now() >= enrollmentExpiryMs ||
        recordset.length !== 1 || ownData(recordset[0], ["current"])?.current !== true) return rollback();
      return { status: "registered", reportingProfileId: profile.reportingProfileId };
    });
    const result = ownData(registered, ["status", "reportingProfileId"]);
    return result?.status === "registered" && guid(result.reportingProfileId)
      ? { status: "registered", reportingProfileId: result.reportingProfileId } : unavailable;
  } catch {
    // Includes audit errors, SQL conflicts and transport diagnostics without returning sensitive data.
    return unavailable;
  }
}
