import { isIP } from "node:net";
import sql from "mssql";
import type { CatalogActiveUserContract } from "./catalogActiveUserSqlReader";
import type { ReportingEnrollmentScope, VerifiedReportingEnrollmentSnapshot } from "./catalogReportingProfileEnrollment";

/**
 * Portal-local read only. The caller owns the transaction and the independent
 * authorization of this exact actor and scope; this SQL rechecks live authority
 * and uses the same reference locks as the 058 writer.
 */
export const READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL = `
IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
  OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
  OR @portalEnvironment IS NULL OR NOT (
    (@portalEnvironment COLLATE Latin1_General_100_BIN2='qa' AND DATALENGTH(@portalEnvironment)=2
      AND DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34)
    OR (@portalEnvironment COLLATE Latin1_General_100_BIN2='production' AND DATALENGTH(@portalEnvironment)=10
      AND DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24))
  RETURN;

SELECT TOP (2) t.portal_environment AS portalEnvironment,@actorId AS actorId,
  l.link_id AS physicalLinkId,t.target_id AS physicalTargetId,p.source_id AS reportConnectionId,
  ap.row_version AS operationalProfileVersion,l.valid_until AS physicalValidUntil,
  t.identity_fingerprint AS expectedIdentityFingerprint,p.row_version AS profileVersion,
  p.server_host AS serverHost,p.server_port AS serverPort,p.database_name AS databaseName,
  p.login_name AS username,p.password_secret_name AS passwordSecretName
FROM core.catalog_physical_targets t WITH (HOLDLOCK)
JOIN core.catalog_physical_target_links l WITH (HOLDLOCK)
  ON l.physical_target_key=t.physical_target_key AND l.portal_environment=t.portal_environment
  AND l.target_kind=t.target_kind AND l.link_id=@physicalLinkId AND l.retired_at IS NULL
  AND l.verified_at<=SYSUTCDATETIME() AND l.valid_until>SYSUTCDATETIME()
JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.status='active'
JOIN core.domains d WITH (HOLDLOCK)
  ON d.domain_key=l.domain_key AND d.client_key=l.client_key AND d.status='active'
JOIN core.databases db WITH (HOLDLOCK)
  ON db.database_key=l.database_key AND db.domain_key=l.domain_key AND db.client_key=l.client_key AND db.status='active'
JOIN core.database_access_profiles ap WITH (HOLDLOCK)
  ON ap.access_profile_key=l.access_profile_key AND ap.access_profile_key=db.access_profile_key
  AND ap.active=1 AND ap.row_version=l.access_profile_version
JOIN settings.external_database_connections p WITH (HOLDLOCK)
  ON p.source_id=@reportConnectionId
  AND p.source_id COLLATE Latin1_General_100_BIN2=@reportConnectionId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(p.source_id)=DATALENGTH(@reportConnectionId)
  AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
  AND p.password_secret_name IS NOT NULL AND p.updated_at<=SYSUTCDATETIME()
WHERE t.target_id=@physicalTargetId AND t.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(t.portal_environment)=DATALENGTH(@portalEnvironment)
  AND t.target_kind='database' AND t.created_at<=SYSUTCDATETIME()
  AND t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),ap.initial_catalog))
  AND t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.database_name))
  AND EXISTS(SELECT 1 FROM security.users u WITH (HOLDLOCK)
    JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key
    JOIN security.roles r WITH (HOLDLOCK) ON r.role_id=ur.role_id
    WHERE u.source_id=@actorId AND u.active=1
      AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(u.source_id)=DATALENGTH(@actorId)
      AND r.role_id COLLATE Latin1_General_100_BIN2=N'super_admin'
      AND DATALENGTH(r.role_id)=DATALENGTH(N'super_admin')
      AND r.active=1 AND r.system_role=1 AND r.protected_role=1
      AND 3=(SELECT COUNT(*) FROM (VALUES(N'configuration.integrations.view'),
          (N'configuration.integrations.test_database'),(N'configuration.integrations.edit_database')) required(permission_key)
        JOIN security.permissions permission WITH (HOLDLOCK)
          ON permission.permission_key=required.permission_key AND permission.active=1
          AND permission.permission_key COLLATE Latin1_General_100_BIN2=required.permission_key COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(permission.permission_key)=DATALENGTH(required.permission_key)
        JOIN security.role_permissions grant_row WITH (HOLDLOCK)
          ON grant_row.role_id=r.role_id AND grant_row.permission_key=permission.permission_key))
  AND NOT EXISTS(SELECT 1 FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
    WHERE b.external_database_connection_key=p.external_database_connection_key AND b.source_state='active')
  AND NOT EXISTS(SELECT 1 FROM settings.catalog_reporting_profiles rp WITH (HOLDLOCK)
    WHERE rp.external_database_connection_key=p.external_database_connection_key
      AND (rp.physical_target_key<>t.physical_target_key OR rp.portal_environment<>t.portal_environment));
`;

const scopeKeys = ["portalEnvironment", "actorId", "physicalLinkId", "physicalTargetId", "reportConnectionId"] as const;
const rowKeys = [
  ...scopeKeys, "operationalProfileVersion", "physicalValidUntil", "expectedIdentityFingerprint", "profileVersion",
  "serverHost", "serverPort", "databaseName", "username", "passwordSecretName",
] as const;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const dns = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const sourceId = (value: unknown): value is string => validText(value, 150) && value === value.trim();
const uuid = (value: unknown): value is string => typeof value === "string" && value.length === 36 &&
  guid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const validText = (value: unknown, max: number): value is string => typeof value === "string" &&
  value.length <= max && !!value.trim() && !/\p{C}/u.test(value);
const binary = (value: unknown, size: number): value is Buffer =>
  Buffer.isBuffer(value) && value.length === size && value.some(byte => byte !== 0);

function ownData<const K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> | null {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const data = Object.create(null) as Record<K, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    data[key] = descriptor.value;
  }
  return data;
}

function parseScope(input: ReportingEnrollmentScope): ReportingEnrollmentScope | null {
  const data = ownData(input, scopeKeys);
  if (!data) return null;
  const { portalEnvironment, actorId, physicalLinkId, physicalTargetId, reportConnectionId } = data;
  if ((portalEnvironment !== "qa" && portalEnvironment !== "production") || !sourceId(actorId) ||
    !uuid(physicalLinkId) || !uuid(physicalTargetId) || !sourceId(reportConnectionId)) return null;
  return Object.freeze({ portalEnvironment, actorId, physicalLinkId, physicalTargetId, reportConnectionId });
}

function parseContract(input: CatalogActiveUserContract): CatalogActiveUserContract | null {
  const aggregate = ownData(input, ["contract"]);
  if (aggregate?.contract === "approved_aggregate_view_v1") {
    return Object.freeze({ contract: "approved_aggregate_view_v1" });
  }
  const tableKeys = ["contract", "population", "activeColumn", "storage", "activeValue"] as const;
  const table = ownData(input, tableKeys) ?? ownData(input, [...tableKeys, "inactiveValue"]);
  if (table?.contract !== "certified_usuarios_v1" || table.population !== "all_rows" ||
    typeof table.activeColumn !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(table.activeColumn)) return null;
  const base = { contract: "certified_usuarios_v1", population: "all_rows", activeColumn: table.activeColumn } as const;
  if (table.storage === "bit" && !Object.hasOwn(table, "inactiveValue") &&
    (table.activeValue === 0 || table.activeValue === 1)) {
    return Object.freeze({ ...base, storage: "bit", activeValue: table.activeValue });
  }
  if (table.storage === "text" && "inactiveValue" in table &&
    validText(table.activeValue, 32) && validText(table.inactiveValue, 32) && table.activeValue !== table.inactiveValue) {
    return Object.freeze({ ...base, storage: "text", activeValue: table.activeValue, inactiveValue: table.inactiveValue });
  }
  return null;
}

function parseRow(raw: unknown, scope: ReportingEnrollmentScope, evidence: CatalogActiveUserContract): VerifiedReportingEnrollmentSnapshot | null {
  const row = ownData(raw, rowKeys);
  if (!row || row.portalEnvironment !== scope.portalEnvironment || row.actorId !== scope.actorId ||
    row.reportConnectionId !== scope.reportConnectionId ||
    !uuid(row.physicalLinkId) || row.physicalLinkId.toLowerCase() !== scope.physicalLinkId.toLowerCase() ||
    !uuid(row.physicalTargetId) || row.physicalTargetId.toLowerCase() !== scope.physicalTargetId.toLowerCase() ||
    !binary(row.operationalProfileVersion, 8) || !binary(row.expectedIdentityFingerprint, 32) ||
    !binary(row.profileVersion, 8) || !(row.physicalValidUntil instanceof Date) ||
    !validText(row.serverHost, 253) || !dns.test(row.serverHost) || isIP(row.serverHost) !== 0 ||
    typeof row.serverPort !== "number" || !Number.isSafeInteger(row.serverPort) || row.serverPort < 1 || row.serverPort > 65_535 ||
    !validText(row.databaseName, 128) || !validText(row.username, 128) || typeof row.passwordSecretName !== "string" ||
    !/^[A-Za-z0-9-]{1,127}$/.test(row.passwordSecretName)) return null;
  const deadline = Date.prototype.getTime.call(row.physicalValidUntil);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return null;
  return Object.freeze({
    scope, operationalProfileVersion: Buffer.from(row.operationalProfileVersion), physicalValidUntil: new Date(deadline),
    expectedIdentityFingerprint: Buffer.from(row.expectedIdentityFingerprint), evidence,
    connection: Object.freeze({ profileVersion: Buffer.from(row.profileVersion), serverHost: row.serverHost,
      serverPort: row.serverPort, databaseName: row.databaseName, username: row.username, passwordSecretName: row.passwordSecretName }),
  });
}

/**
 * For an existing approved operator transaction only. This is neither an HTTP
 * authorization check nor a login or read-only certificate for the remote SQL
 * connection. The guarded enrollment probe supplies that independent proof.
 */
export async function readCatalogReportingProfileEnrollmentInTransaction(
  transaction: sql.Transaction, requestedScope: ReportingEnrollmentScope, reviewedEvidence: CatalogActiveUserContract, signal?: AbortSignal,
): Promise<VerifiedReportingEnrollmentSnapshot | null> {
  try {
    const scope = parseScope(requestedScope);
    const evidence = parseContract(reviewedEvidence);
    if (!scope || !evidence || signal?.aborted) return null;
    const request = transaction.request();
    request.input("portalEnvironment", sql.VarChar(32), scope.portalEnvironment);
    request.input("actorId", sql.NVarChar(150), scope.actorId);
    request.input("physicalLinkId", sql.UniqueIdentifier, scope.physicalLinkId);
    request.input("physicalTargetId", sql.UniqueIdentifier, scope.physicalTargetId);
    request.input("reportConnectionId", sql.NVarChar(150), scope.reportConnectionId);
    const result = await request.query<unknown>(READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL);
    if (signal?.aborted || !Array.isArray(result.recordsets) || result.recordsets.length !== 1 ||
      !Array.isArray(result.recordset) || result.recordsets[0] !== result.recordset || result.recordset.length !== 1) return null;
    return parseRow(result.recordset[0], scope, evidence);
  } catch {
    // Unavailable without exposing SQL/provider errors or any profile data.
    return null;
  }
}
