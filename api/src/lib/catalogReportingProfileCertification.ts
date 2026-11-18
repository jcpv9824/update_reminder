import { randomUUID } from "node:crypto";
import sql from "mssql";
import { createCatalogActiveUserSqlReader, type CatalogActiveUserContract } from "./catalogActiveUserSqlReader";
import { registerSqlCatalogReportingProfile } from "./catalogReportingProfileRegistrationSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSecret } from "./keyVault";
import { getSqlPool } from "./sql";
import { readStoredExternalDatabaseConnection } from "./integrationConnectionsSqlRepository";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function readDestination(portalEnvironment: CatalogEnvironment, id: string): Promise<Buffer | null> {
  const pool = await getSqlPool();
  const result = await pool.request().input("env", sql.VarChar(10), portalEnvironment)
    .input("id", sql.UniqueIdentifier, id).query<{ fingerprint: Buffer }>(`
      SELECT t.identity_fingerprint AS fingerprint
      FROM core.catalog_physical_targets t
      WHERE t.portal_environment=@env AND t.target_kind='database' AND t.target_id=@id
        AND EXISTS (
          SELECT 1 FROM core.catalog_physical_target_links l
          WHERE l.physical_target_key=t.physical_target_key AND l.retired_at IS NULL
            AND l.verified_at<=SYSUTCDATETIME() AND l.valid_until>SYSUTCDATETIME()
        );
    `);
  const bytes = result.recordset[0]?.fingerprint;
  return result.recordset.length === 1 && Buffer.isBuffer(bytes) && bytes.length === 32 ? Buffer.from(bytes) : null;
}

const defaults = {
  readDestination, readConnection: readStoredExternalDatabaseConnection, readSecret: getSecret,
  createReader: createCatalogActiveUserSqlReader, register: registerSqlCatalogReportingProfile,
};

/** Internal operation. Authorize the actor and choose the schema contract before calling this. */
export async function certifyCatalogReportingProfile(input: {
  portalEnvironment: CatalogEnvironment;
  targetId: string;
  connectionId: string;
  trustedInstanceId: string;
  evidence: CatalogActiveUserContract;
  actor: { id: string };
  signal?: AbortSignal;
}, io: typeof defaults = defaults): Promise<Awaited<ReturnType<typeof registerSqlCatalogReportingProfile>> | { status: "unavailable" }> {
  const { portalEnvironment, connectionId, targetId, trustedInstanceId, actor } = input;
  if (!["qa", "production"].includes(portalEnvironment) || !uuid.test(targetId) || !uuid.test(trustedInstanceId)
    || typeof connectionId !== "string" || !connectionId || connectionId.length > 150
    || connectionId !== connectionId.trim() || /\p{C}/u.test(connectionId)) return { status: "unavailable" };
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  try {
    if (signal.aborted) return { status: "unavailable" };
    const evidence = structuredClone(input.evidence);
    const [fingerprint, profile] = await Promise.all([io.readDestination(portalEnvironment, targetId), io.readConnection(connectionId)]);
    if (!fingerprint || signal.aborted || !profile || profile.id !== connectionId || !profile.active ||
      profile.status !== "active" || !profile.encrypt || !profile.passwordConfigured || !profile.passwordSecretName
      || !/^[a-f0-9]{16}$/i.test(profile.etag)) return { status: "unavailable" };
    const proofId = randomUUID();
    const target = { physicalDatabaseId: targetId, serverGroupId: trustedInstanceId, reportingProfileId: proofId };
    const run = io.createReader(async (_ref, readerSignal) => {
      if (readerSignal.aborted) return null;
      const password = await io.readSecret(profile.passwordSecretName!, readerSignal);
      if (!password || readerSignal.aborted) return null;
      return { target, evidence, identity: { instanceId: trustedInstanceId, expectedFingerprint: fingerprint },
        connection: { server: profile.serverHost, port: profile.serverPort, database: profile.databaseName,
          username: profile.username, password } };
    });
    // The result is not used or persisted. This dry count certifies the exact SELECT contract.
    await run(target, signal);
    if (signal.aborted) return { status: "unavailable" };
    const verifiedAt = new Date();
    return await io.register({ portalEnvironment, targetId, connectionId, profileVersion: Buffer.from(profile.etag, "hex"),
      trustedInstanceId, identityFingerprint: fingerprint, evidence, actor, proofId, verifiedAt,
      validUntil: new Date(verifiedAt.valueOf() + 24 * 60 * 60_000) });
  } catch {
    return { status: "unavailable" };
  }
}
