import { randomUUID } from "node:crypto";
import sql from "mssql";
import { createCatalogActiveUserSqlReader, type CatalogActiveUserContract } from "./catalogActiveUserSqlReader";
import { registerSqlCatalogReportingProfile } from "./catalogReportingProfileRegistrationSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSecret } from "./keyVault";
import { getSqlPool } from "./sql";
import { readStoredExternalDatabaseConnection } from "./integrationConnectionsSqlRepository";
import { resolveCatalogSqlInstanceRoute } from "./catalogSqlInstanceRegistry";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function readDestination(portalEnvironment: CatalogEnvironment, id: string): Promise<{ fingerprint: Buffer; instanceId: string } | null> {
  const pool = await getSqlPool();
  const result = await pool.request().input("env", sql.VarChar(10), portalEnvironment)
    .input("id", sql.UniqueIdentifier, id).query<{ fingerprint: Buffer; instanceId: string }>(`
      DECLARE @now datetime2(3)=SYSUTCDATETIME();
      SELECT t.identity_fingerprint AS fingerprint, LOWER(CONVERT(char(36),i.trusted_instance_id)) AS instanceId
      FROM core.catalog_physical_targets t
      JOIN core.catalog_sql_target_instance_identities i ON i.physical_target_key=t.physical_target_key
        AND i.portal_environment=t.portal_environment AND i.target_kind=t.target_kind AND i.registered_at<=@now
      WHERE t.portal_environment=@env AND t.target_kind='database' AND t.target_id=@id
        AND EXISTS (
          SELECT 1 FROM core.catalog_physical_target_links l
          WHERE l.physical_target_key=t.physical_target_key AND l.portal_environment=t.portal_environment
            AND l.target_kind=t.target_kind AND l.retired_at IS NULL AND l.verified_at<=@now AND l.valid_until>@now
        );
    `);
  const row = result.recordset[0];
  return result.recordset.length === 1 && Buffer.isBuffer(row?.fingerprint) && row.fingerprint.length === 32 &&
    typeof row.instanceId === "string" && uuid.test(row.instanceId) && row.instanceId !== "00000000-0000-0000-0000-000000000000"
    ? { fingerprint: Buffer.from(row.fingerprint), instanceId: row.instanceId } : null;
}

const defaults = {
  readDestination, readConnection: readStoredExternalDatabaseConnection, readSecret: getSecret,
  createReader: createCatalogActiveUserSqlReader, register: registerSqlCatalogReportingProfile,
  readInstanceRoutes: () => process.env.PORTAL_CATALOG_SQL_INSTANCE_ROUTES,
};

/** Internal operation. Authorize the actor and choose the schema contract before calling this. */
export async function certifyCatalogReportingProfile(input: {
  portalEnvironment: CatalogEnvironment;
  targetId: string;
  connectionId: string;
  evidence: CatalogActiveUserContract;
  actor: { id: string };
  signal?: AbortSignal;
}, io: typeof defaults = defaults): Promise<Awaited<ReturnType<typeof registerSqlCatalogReportingProfile>> | { status: "unavailable" }> {
  const { portalEnvironment, connectionId, targetId, actor } = input;
  if (!["qa", "production"].includes(portalEnvironment) || typeof targetId !== "string" || targetId.length !== 36 || !uuid.test(targetId)
    || targetId === "00000000-0000-0000-0000-000000000000"
    || typeof connectionId !== "string" || !connectionId || connectionId.length > 150
    || connectionId !== connectionId.trim() || /\p{C}/u.test(connectionId)) return { status: "unavailable" };
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  try {
    if (signal.aborted) return { status: "unavailable" };
    const evidence = structuredClone(input.evidence);
    const [destination, profile] = await Promise.all([io.readDestination(portalEnvironment, targetId), io.readConnection(connectionId)]);
    if (!destination || signal.aborted || !profile || profile.id !== connectionId || !profile.active ||
      profile.status !== "active" || !profile.encrypt || !profile.passwordConfigured || !profile.passwordSecretName
      || !/^[a-f0-9]{16}$/i.test(profile.etag)) return { status: "unavailable" };
    const resolveInstance = () => resolveCatalogSqlInstanceRoute(io.readInstanceRoutes(), portalEnvironment,
      profile.serverHost, profile.serverPort);
    const trustedInstanceId = resolveInstance();
    if (!trustedInstanceId || trustedInstanceId !== destination.instanceId) return { status: "unavailable" };
    const fingerprint = destination.fingerprint;
    const proofId = randomUUID();
    const target = { physicalDatabaseId: targetId, serverGroupId: trustedInstanceId, reportingProfileId: proofId };
    const run = io.createReader(async (_ref, readerSignal) => {
      if (readerSignal.aborted || resolveInstance() !== trustedInstanceId) return null;
      const password = await io.readSecret(profile.passwordSecretName!, readerSignal);
      if (!password || readerSignal.aborted || resolveInstance() !== trustedInstanceId) return null;
      return { target, evidence, identity: { instanceId: trustedInstanceId, expectedFingerprint: fingerprint },
        connection: { server: profile.serverHost, port: profile.serverPort, database: profile.databaseName,
          username: profile.username, password } };
    });
    // The result is not used or persisted. This dry count certifies the exact SELECT contract.
    await run(target, signal);
    if (signal.aborted || resolveInstance() !== trustedInstanceId) return { status: "unavailable" };
    const verifiedAt = new Date();
    return await io.register({ portalEnvironment, targetId, connectionId, profileVersion: Buffer.from(profile.etag, "hex"),
      trustedInstanceId, identityFingerprint: fingerprint, evidence, actor, proofId, verifiedAt,
      validUntil: new Date(verifiedAt.valueOf() + 24 * 60 * 60_000) });
  } catch {
    return { status: "unavailable" };
  }
}
