import sql from "mssql";
import type { CatalogActiveUserContract } from "./catalogActiveUserSqlReader";
import type { CatalogActiveUserTarget } from "./catalogActiveUserReport";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSqlPool } from "./sql";

type ReportingProfileRow = {
  target_id: string;
  profile_id: string;
  instance_id: string;
  connection_id: string;
  version: string;
  fingerprint: Buffer;
  count_contract: string;
  active_column: string | null;
  active_storage: string | null;
  active_bit: boolean | null;
  active_text: string | null;
  inactive_text: string | null;
};

export type SqlCatalogReportingProfile = Readonly<{
  target: CatalogActiveUserTarget;
  connectionId: string;
  profileVersion: string;
  expectedFingerprint: Buffer;
  evidence: CatalogActiveUserContract;
}>;

const opaqueId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const fail = (): never => { throw new Error("catalog_reporting_profile_unavailable"); };

function map(row: ReportingProfileRow): SqlCatalogReportingProfile {
  if (![row.target_id, row.profile_id, row.instance_id].every(v => typeof v === "string" && opaqueId.test(v))
      || typeof row.connection_id !== "string" || row.connection_id.length < 1 || row.connection_id.length > 150
      || !/^[0-9a-f]{16}$/.test(row.version) || !Buffer.isBuffer(row.fingerprint) || row.fingerprint.length !== 32) fail();
  let evidence: CatalogActiveUserContract;
  if (row.count_contract === "approved_aggregate_view_v1") {
    if ([row.active_column, row.active_storage, row.active_bit, row.active_text, row.inactive_text].some(value => value !== null)) return fail();
    evidence = { contract: row.count_contract };
  } else if (row.count_contract === "certified_usuarios_v1" && typeof row.active_column === "string" && identifier.test(row.active_column)) {
    if (row.active_storage === "bit" && typeof row.active_bit === "boolean" && row.active_text === null && row.inactive_text === null) {
      evidence = { contract: row.count_contract, population: "all_rows", activeColumn: row.active_column,
        storage: "bit", activeValue: row.active_bit ? 1 : 0 };
    } else if (row.active_storage === "text" && row.active_bit === null && typeof row.active_text === "string"
        && typeof row.inactive_text === "string" && row.active_text.trim() && row.inactive_text.trim()) {
      evidence = { contract: row.count_contract, population: "all_rows", activeColumn: row.active_column,
        storage: "text", activeValue: row.active_text, inactiveValue: row.inactive_text };
    } else return fail();
  } else return fail();
  return {
    target: { physicalDatabaseId: row.target_id, reportingProfileId: row.profile_id, serverGroupId: row.instance_id },
    connectionId: row.connection_id, profileVersion: row.version,
    expectedFingerprint: Buffer.from(row.fingerprint), evidence,
  };
}

/** Service only: safe metadata for already-resolved database IDs; never expose this projection in HTTP or email. */
export async function readSqlCatalogReportingProfiles(input: {
  portalEnvironment: CatalogEnvironment; physicalIds: ReadonlySet<string>;
}): Promise<ReadonlyMap<string, SqlCatalogReportingProfile>> {
  if (!["qa", "production"].includes(input.portalEnvironment) || input.physicalIds.size > 5000
    || [...input.physicalIds].some(id => !opaqueId.test(id))) fail();
  if (!input.physicalIds.size) return new Map();
  try {
    const ids = new Set([...input.physicalIds].map(id => id.toLowerCase()));
    const pool = await getSqlPool();
    const result = await pool.request().input("env", sql.VarChar(10), input.portalEnvironment)
      .input("ids", sql.NVarChar(sql.MAX), JSON.stringify([...ids]))
      .query<ReportingProfileRow>(`
        DECLARE @now datetime2(3)=SYSUTCDATETIME();
        SELECT LOWER(CONVERT(char(36), t.target_id)) AS target_id,
          LOWER(CONVERT(char(36), r.reporting_profile_id)) AS profile_id,
          LOWER(CONVERT(char(36), r.trusted_instance_id)) AS instance_id,
          p.source_id AS connection_id, LOWER(CONVERT(char(16),CONVERT(binary(8),p.row_version),2)) AS version,
          r.verified_identity_fingerprint AS fingerprint, r.count_contract,
          r.active_column,r.active_storage,r.active_bit,r.active_text,r.inactive_text
        FROM core.catalog_physical_targets t
        JOIN settings.catalog_reporting_profiles r ON r.physical_target_key=t.physical_target_key
          AND r.portal_environment=t.portal_environment AND r.target_kind=t.target_kind
        JOIN settings.external_database_connections p ON p.external_database_connection_key=r.external_database_connection_key
        WHERE t.portal_environment=@env AND t.target_kind='database'
          AND r.retired_at IS NULL AND r.verified_at<=@now AND r.valid_until>@now
          AND r.verified_identity_fingerprint=t.identity_fingerprint
          AND p.row_version=r.verified_profile_version AND p.active=1 AND p.status='active'
          AND p.encrypt_connection=1 AND p.password_configured=1
          AND t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.database_name))
          AND EXISTS (SELECT 1 FROM OPENJSON(@ids) AS allowed WHERE TRY_CONVERT(uniqueidentifier,allowed.[value])=t.target_id);
      `);
    const found = new Map<string, SqlCatalogReportingProfile>();
    for (const row of result.recordset) {
      const profile = map(row);
      if (!ids.has(profile.target.physicalDatabaseId) || found.has(profile.target.physicalDatabaseId)) fail();
      found.set(profile.target.physicalDatabaseId, profile);
    }
    return found;
  } catch { return fail(); }
}
