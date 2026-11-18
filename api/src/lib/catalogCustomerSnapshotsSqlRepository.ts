import sql from "mssql";
import { catalogDocumentNumberToken } from "./catalogCustomerRefresh";
import {
  CatalogDirectoryError,
  type CatalogDirectoryInput,
  type CatalogDocument,
  type CatalogDocumentScope,
  type CatalogErpRevision,
  type CatalogRevisionState,
} from "./catalogCustomerDirectory";
import type { CatalogEnvironment, CatalogSourceRole } from "./catalogSourceConfiguration";
import { getSqlPool } from "./sql";

const maxSources = 32;
const maxRows = 100_000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface CatalogCustomerSnapshotsReadScope {
  environment: CatalogEnvironment;
  /** Trusted server-side scope from source authorization, never a caller's query filter. */
  allowedSourceIds: ReadonlySet<string>;
  /** Version of the protected comparison key selected by trusted runtime policy. */
  matchKeyVersion: number;
  sourcePriorityById?: ReadonlyMap<string, number>;
  preferredSourceByCustomer?: ReadonlyMap<string, string>;
}

export interface CatalogSnapshotHeaderRow {
  source_id: string;
  display_name: string;
  source_role: CatalogSourceRole;
  revision_state: CatalogRevisionState;
  observed_at: Date | null;
  expected_rows: number;
  expected_scopes: number;
}

export interface CatalogSnapshotCustomerRow {
  source_id: string;
  source_record_id: number;
  customer_id: string | null;
  official_name: string | null;
  active_code: "S" | "N" | null;
  issuer: string | null;
  document_type: string | null;
  document_number_token: Buffer | null;
}

export interface CatalogSnapshotCoverageRow {
  source_id: string;
  issuer: string;
  document_type: string;
}

export function makeCatalogDocumentNumberToken(key: Buffer, environment: CatalogEnvironment, number: string): Buffer | null {
  try { return catalogDocumentNumberToken(key, environment, number); }
  catch { return fail(); }
}

function fail(): never { throw new CatalogDirectoryError("inconsistent_revision"); }

function normalizedAuthorizedSources(scope: CatalogCustomerSnapshotsReadScope): Set<string> {
  if (scope.allowedSourceIds.size > maxSources || !["qa", "production"].includes(scope.environment) ||
      !Number.isInteger(scope.matchKeyVersion) || scope.matchKeyVersion < 1 || scope.matchKeyVersion > 32767) fail();
  return new Set([...scope.allowedSourceIds].map(id => uuid.test(id) ? id.toLowerCase() : fail()));
}

function tokenValue(value: Buffer | null): string | null {
  if (value === null) return null;
  if (!Buffer.isBuffer(value) || value.length !== 32) fail();
  // CatalogDocument.number is a private equality input, not necessarily a literal number.
  // Only this version-matched token reaches the in-process comparison, never the raw document.
  return `hmac:${value.toString("hex")}`;
}

function coverage(issuer: string, type: string): CatalogDocumentScope {
  if (!/^[A-Z]{2}$/.test(issuer) || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(type)) fail();
  return { issuer, type };
}

function toDocument(row: CatalogSnapshotCustomerRow, token: string | null): CatalogDocument | null {
  if (row.issuer === null && row.document_type === null) return null;
  if (row.issuer === null || row.document_type === null || token === null) fail();
  return { ...coverage(row.issuer, row.document_type), number: token };
}

/** Internal mapping only. Use the directory service to obtain the safe HTTP DTO. */
export function mapCatalogCustomerSnapshots(
  scope: CatalogCustomerSnapshotsReadScope,
  headers: readonly CatalogSnapshotHeaderRow[],
  records: readonly CatalogSnapshotCustomerRow[],
  scopes: readonly CatalogSnapshotCoverageRow[],
): CatalogDirectoryInput {
  const allowed = normalizedAuthorizedSources(scope);
  if (headers.length > maxSources + 1 || records.length > maxRows || scopes.length > 512) fail();
  const rowsBySource = new Map<string, CatalogSnapshotCustomerRow[]>();
  const scopesBySource = new Map<string, CatalogSnapshotCoverageRow[]>();
  for (const row of records) {
    const rows = rowsBySource.get(row.source_id) ?? [];
    rows.push(row);
    rowsBySource.set(row.source_id, rows);
  }
  for (const row of scopes) {
    const rows = scopesBySource.get(row.source_id) ?? [];
    rows.push(row);
    scopesBySource.set(row.source_id, rows);
  }

  const seen = new Set<string>();
  const erp: CatalogErpRevision[] = [];
  let sag: CatalogDirectoryInput["sag"] | undefined;
  for (const header of headers) {
    const id = header.source_id;
    if (!uuid.test(id) || seen.has(id)) fail();
    seen.add(id);
    const rows = rowsBySource.get(id) ?? [];
    const evidence = scopesBySource.get(id) ?? [];
    if (rows.length !== header.expected_rows || evidence.length !== header.expected_scopes ||
        !["verified", "stale", "unavailable"].includes(header.revision_state)) fail();
    if (header.revision_state === "unavailable") {
      if (header.observed_at !== null || rows.length || evidence.length) fail();
    } else if (!(header.observed_at instanceof Date) || !Number.isFinite(header.observed_at.valueOf())) fail();
    const verifiedAt = header.observed_at?.toISOString() ?? null;
    const sourceRecordIds = new Set<number>();
    for (const row of rows) {
      if (!Number.isInteger(row.source_record_id) || row.source_record_id < -2147483648 || row.source_record_id > 2147483647 ||
          sourceRecordIds.has(row.source_record_id)) fail();
      sourceRecordIds.add(row.source_record_id);
    }

    if (header.source_role === "erp-customers") {
      if (!allowed.has(id) || evidence.length) fail();
      const priority = scope.sourcePriorityById?.get(id) ?? 0;
      if (!Number.isFinite(priority)) fail();
      erp.push({ sourceId: id, label: header.display_name, priority, state: header.revision_state, verifiedAt,
        customers: rows.map(row => {
          const token = tokenValue(row.document_number_token);
          const document = toDocument(row, token);
          if (!row.customer_id || !uuid.test(row.customer_id) || (token && !document) ||
              !["S", "N", null].includes(row.active_code)) fail();
          return { sourceCustomerId: String(row.source_record_id), customerId: row.customer_id,
            officialName: row.official_name, activeCode: row.active_code, document };
        }),
      });
    } else if (header.source_role === "sag-admin" && !sag) {
      const documents: CatalogDocument[] = [];
      const unresolvedNumbers = new Set<string>();
      let missingNumber = false;
      for (const row of rows) {
        if (row.customer_id !== null || row.official_name !== null || row.active_code !== null) fail();
        const token = tokenValue(row.document_number_token);
        const doc = toDocument(row, token);
        if (doc) documents.push(doc);
        else if (token) unresolvedNumbers.add(token);
        else missingNumber = true;
      }
      // A source record with no usable token could belong to any namespace. Do not certify negative matches.
      const covered = evidence.map(row => coverage(row.issuer, row.document_type));
      sag = { state: header.revision_state, verifiedAt, documents, unresolvedNumbers: [...unresolvedNumbers],
        completeScopes: !missingNumber && header.revision_state === "verified" ? covered : [] };
    } else fail();
  }
  if ([...rowsBySource.keys(), ...scopesBySource.keys()].some(id => !seen.has(id))) fail();
  return { erp, sag: sag ?? { state: "unavailable", verifiedAt: null, documents: [], completeScopes: [] },
    allowedSourceIds: allowed, preferredSourceByCustomer: scope.preferredSourceByCustomer };
}

const readSnapshots = `
  SET NOCOUNT ON;
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  DECLARE @eligible TABLE (
    source_id char(36) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
    display_name nvarchar(150) NOT NULL,
    source_role varchar(15) NOT NULL,
    revision_state varchar(11) NOT NULL,
    snapshot_key bigint NULL,
    observed_at datetime2(3) NULL,
    expected_rows int NOT NULL,
    expected_scopes int NOT NULL
  );
  -- Capture all pointers before selecting from the sealed, immutable bodies.
  INSERT INTO @eligible
  SELECT LOWER(CONVERT(char(36), b.source_id)), b.display_name, b.source_role,
    CASE WHEN ready.snapshot_key IS NULL THEN 'unavailable'
         WHEN h.attempt_status='succeeded' AND h.attempted_at<=@now AND r.verified_until>@now THEN 'verified' ELSE 'stale' END,
    ready.snapshot_key,
    CASE WHEN ready.snapshot_key IS NOT NULL THEN r.observed_at END,
    CASE WHEN ready.snapshot_key IS NULL THEN 0 ELSE r.expected_rows END,
    CASE WHEN ready.snapshot_key IS NULL THEN 0 ELSE r.expected_scopes END
  FROM settings.catalog_source_bindings AS b
  JOIN settings.external_database_connections AS p
    ON p.external_database_connection_key=b.external_database_connection_key
  LEFT JOIN settings.catalog_customer_revision_heads AS h ON h.catalog_source_key=b.catalog_source_key
  LEFT JOIN core.catalog_customer_source_revisions AS r ON r.catalog_source_key=b.catalog_source_key AND r.revision_key=h.revision_key
  CROSS APPLY (VALUES (CASE WHEN r.sealed_at IS NOT NULL AND r.sealed_at<=@now AND r.match_key_version=@matchKeyVersion
    AND b.validated_profile_version=p.row_version AND r.profile_version=p.row_version AND r.binding_version=b.row_version
    AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1 THEN r.revision_key END)) AS ready(snapshot_key)
  WHERE b.portal_environment=@environment AND b.source_state='active'
    -- A first failed attempt still represents an authorized unavailable source.
    AND (b.source_role='sag-admin' OR (b.source_role='erp-customers'
      AND EXISTS (SELECT 1 FROM OPENJSON(@allowedSourceIds) AS a WHERE TRY_CONVERT(uniqueidentifier,a.[value])=b.source_id)));

  IF (SELECT SUM(CONVERT(bigint,expected_rows)) FROM @eligible)>@rowLimit
    THROW 53310, N'Catalog exceeds its read safety bound.', 1;

  SELECT source_id, display_name, source_role, revision_state, observed_at, expected_rows, expected_scopes FROM @eligible;

  SELECT e.source_id, r.source_record_id, LOWER(CONVERT(char(36), c.customer_id)) AS customer_id, r.official_name,
    r.active_code, r.issuer, r.document_type, r.document_number_token
  FROM @eligible AS e JOIN core.catalog_customer_revision_rows AS r ON r.revision_key=e.snapshot_key
  LEFT JOIN core.catalog_customer_ids AS c ON c.catalog_customer_key=r.catalog_customer_key
  ORDER BY e.source_id,r.source_record_id;

  SELECT e.source_id, s.issuer, s.document_type
  FROM @eligible AS e JOIN core.catalog_customer_revision_scopes AS s ON s.revision_key=e.snapshot_key;
`;

/** Service-only SELECTs against Portal SQL; never connects to ERP or SAG data sources. */
export async function readSqlCatalogCustomerSnapshots(scope: CatalogCustomerSnapshotsReadScope): Promise<CatalogDirectoryInput> {
  const allowed = normalizedAuthorizedSources(scope);
  if (!allowed.size) return mapCatalogCustomerSnapshots(scope, [], [], []);
  try {
    const pool = await getSqlPool();
    const result = await pool.request()
      .input("environment", sql.VarChar(10), scope.environment)
      .input("matchKeyVersion", sql.SmallInt, scope.matchKeyVersion)
      .input("allowedSourceIds", sql.NVarChar(2048), JSON.stringify([...allowed]))
      .input("rowLimit", sql.Int, maxRows)
      .query(readSnapshots);
    if (!Array.isArray(result.recordsets) || result.recordsets.length !== 3 ||
        !result.recordsets.every(Array.isArray)) fail();
    const [headers, records, scopes] = result.recordsets as unknown as [
      CatalogSnapshotHeaderRow[], CatalogSnapshotCustomerRow[], CatalogSnapshotCoverageRow[],
    ];
    return mapCatalogCustomerSnapshots(scope, headers, records, scopes);
  } catch {
    // Driver errors and internal comparison material are never exposed or logged here.
    fail();
  }
}
