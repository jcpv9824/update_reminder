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
import { catalogReconciledIdentityHeadsSql, catalogReconciledIdentitySql } from "./catalogReconciledIdentitySql";
import { runSqlTransaction } from "./sqlTransaction";

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
  /** Trusted authenticated actor; required for V2 and revalidated against Portal SQL. */
  actorId?: string;
  /** Trusted runtime policy; not a browser-selected option. */
  includeSagDirectory?: boolean;
  /** Trusted V2 Novedades GET only. Its eligibility never relies on SAG matches. */
  erpAutocomplete?: boolean;
}

export interface CatalogReconciledDirectoryRow {
  customer_id: string;
  display_name: string;
  sag_record_id: number;
  sag_only: boolean;
}
export interface CatalogReconciledDirectoryProjection {
  rows: readonly CatalogReconciledDirectoryRow[];
  sagReady: boolean;
  partial: boolean;
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
  reconciled?: CatalogReconciledDirectoryProjection,
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
  const result: CatalogDirectoryInput = {
    erp, sag: sag ?? { state: "unavailable", verifiedAt: null, documents: [], completeScopes: [] },
    allowedSourceIds: allowed, preferredSourceByCustomer: scope.preferredSourceByCustomer,
  };
  if (scope.includeSagDirectory) {
    if (!scope.actorId || !reconciled || reconciled.rows.length > maxRows ||
        typeof reconciled.sagReady !== "boolean" || typeof reconciled.partial !== "boolean") fail();
    const seenSagRecords = new Set<number>();
    const sagHeader = headers.find(header => header.source_role === "sag-admin");
    const sagRecords = new Map((sagHeader ? rowsBySource.get(sagHeader.source_id) ?? [] : [])
      .map(row => [row.source_record_id, row]));
    const orphanNames = new Map<string, string>();
    const orphanDocuments = new Map<string, { sourceId: string; recordId: number; token: string }>();
    const documents = new Map<string, CatalogDocument>();
    const erpDocuments = new Map<string, CatalogDocument[]>();
    const knownErpDocumentKeys = new Set<string>();
    for (const source of erp) {
      if (source.state !== "verified") continue;
      for (const row of source.customers) {
        if (row.document) {
          erpDocuments.set(row.customerId, [...(erpDocuments.get(row.customerId) ?? []), row.document]);
          knownErpDocumentKeys.add(JSON.stringify([row.document.issuer, row.document.type, row.document.number]));
        }
      }
    }
    for (const row of reconciled.rows) {
      const sourceRow = sagRecords.get(row.sag_record_id);
      if (!uuid.test(row.customer_id) || typeof row.display_name !== "string" ||
          !row.display_name.trim() || row.display_name.length > 512 || /\p{C}/u.test(row.display_name) ||
          !Number.isInteger(row.sag_record_id) || row.sag_record_id < -2147483648 || row.sag_record_id > 2147483647 ||
          seenSagRecords.has(row.sag_record_id) || typeof row.sag_only !== "boolean") fail();
      seenSagRecords.add(row.sag_record_id);
      if (!reconciled.sagReady || result.sag.state !== "verified") continue;
      if (!sourceRow) fail();
      if (row.sag_only) {
        if (erpDocuments.has(row.customer_id)) fail();
        const token = tokenValue(sourceRow.document_number_token);
        const doc = toDocument(sourceRow, token);
        if (doc && knownErpDocumentKeys.has(JSON.stringify([doc.issuer, doc.type, doc.number]))) fail();
        // All environments for the same orphan identity share its SQL-generated UUID.
        const name = orphanNames.get(row.customer_id);
        if (!name || row.display_name.localeCompare(name, "es") < 0) orphanNames.set(row.customer_id, row.display_name);
        if (token && sagHeader) {
          const saved = orphanDocuments.get(row.customer_id);
          if (!saved || row.sag_record_id < saved.recordId) {
            orphanDocuments.set(row.customer_id, { sourceId: sagHeader.source_id, recordId: row.sag_record_id, token });
          }
        }
      } else {
        const candidates = erpDocuments.get(row.customer_id);
        if (!candidates?.length || candidates.some(doc => doc.issuer !== candidates[0].issuer ||
            doc.type !== candidates[0].type || doc.number !== candidates[0].number)) fail();
        for (const doc of candidates) documents.set(JSON.stringify([doc.issuer, doc.type, doc.number]), doc);
      }
    }
    // Only the common SQL match graph can certify a positive V2 relationship.
    // It may contain held/ambiguous identities; do not turn their omission into absence.
    result.sag = { ...result.sag, documents: [...documents.values()], completeScopes: [],
      unresolvedNumbers: [], ...(!reconciled.sagReady ? { state: "unavailable" as const, verifiedAt: null } : {}) };
    result.sagOnlyCustomers = [...orphanNames].map(([customerId, name]) => ({ customerId, name }));
    if (orphanDocuments.size) result.sagOnlyDocumentReferences = orphanDocuments;
    result.partial = reconciled.partial;
  }
  return result;
}

const readSnapshots = (v2: boolean, erpAutocomplete = false) => `
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
  SELECT LOWER(CONVERT(char(36), b.source_id)),
    CASE WHEN b.source_role='erp-customers' THEN p.database_name ELSE b.display_name END,
    b.source_role,
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
    AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
    ${v2 ? "AND EXISTS(SELECT 1 FROM @observedHeads captured WHERE captured.source_key=b.catalog_source_key AND captured.revision_key=r.revision_key)" : ""}
    THEN r.revision_key END)) AS ready(snapshot_key)
  WHERE b.portal_environment=@environment AND b.source_state='active'
    ${v2 ? "AND (b.source_role='sag-admin' OR EXISTS(SELECT 1 FROM @observedAllowed authorized WHERE authorized.source_id=LOWER(CONVERT(char(36),b.source_id))))" : ""}
    -- A first failed attempt still represents an authorized unavailable source.
    AND (b.source_role='sag-admin' OR (b.source_role='erp-customers'
      AND EXISTS (SELECT 1 FROM OPENJSON(@allowedSourceIds) AS a WHERE TRY_CONVERT(uniqueidentifier,a.[value])=b.source_id)));

  IF (SELECT SUM(CONVERT(bigint,expected_rows)) FROM @eligible)>@rowLimit
    THROW 53310, N'Catalog exceeds its read safety bound.', 1;

  SELECT source_id, display_name, source_role, revision_state, observed_at, expected_rows, expected_scopes FROM @eligible
  ${erpAutocomplete ? "WHERE source_role='erp-customers'" : ""};

  SELECT e.source_id, r.source_record_id, LOWER(CONVERT(char(36), c.customer_id)) AS customer_id, r.official_name,
    r.active_code, r.issuer, r.document_type, r.document_number_token
  FROM @eligible AS e JOIN core.catalog_customer_revision_rows AS r ON r.revision_key=e.snapshot_key
  LEFT JOIN core.catalog_customer_ids AS c ON c.catalog_customer_key=r.catalog_customer_key
  ${erpAutocomplete ? "WHERE e.source_role='erp-customers'" : ""}
  ORDER BY e.source_id,r.source_record_id;

  SELECT e.source_id, s.issuer, s.document_type
  FROM @eligible AS e JOIN core.catalog_customer_revision_scopes AS s ON s.revision_key=e.snapshot_key
  ${erpAutocomplete ? "WHERE e.source_role='erp-customers'" : ""};
`;

// V2 does not certify negative Web presence; the Novedades suggestions only
// exclude those negatives and never include SAG-only records. Reuse the exact
// live authorization and verified-head guard without materializing the graph.
// The immutable sealed counts still enforce the full reconciliation's bounds.
export const catalogErpAutocompleteSql = `
  ${catalogReconciledIdentityHeadsSql}
  IF @observedActor IS NOT NULL AND @observedSagReady=1
    AND (@observedIsSuper=1 OR EXISTS(SELECT 1 FROM @observedSelected))
    AND EXISTS (SELECT 1 FROM @observedHeads GROUP BY source_role
      HAVING SUM(CONVERT(bigint,expected_rows))>@rowLimit)
      THROW 54976,N'Catalog inventory bounds exceeded.',1;
  ${readSnapshots(true, true)}
`;

/** Service-only SELECTs against Portal SQL; never connects to ERP or SAG data sources. */
export async function readSqlCatalogCustomerSnapshots(scope: CatalogCustomerSnapshotsReadScope,
  transaction?: sql.Transaction): Promise<CatalogDirectoryInput> {
  const allowed = normalizedAuthorizedSources(scope);
  const v2 = scope.includeSagDirectory === true;
  const erpAutocomplete = v2 && scope.erpAutocomplete === true;
  if (v2 && (typeof scope.actorId !== "string" || !scope.actorId.trim() || scope.actorId.length > 128 ||
      /\p{C}/u.test(scope.actorId))) fail();
  if (!allowed.size && !v2) return mapCatalogCustomerSnapshots(scope, [], [], []);
  try {
    const read = async (request: sql.Request) => {
      request
        .input("environment", sql.VarChar(10), scope.environment)
        .input("matchKeyVersion", sql.SmallInt, scope.matchKeyVersion)
        .input("allowedSourceIds", sql.NVarChar(2048), JSON.stringify([...allowed]))
        .input("rowLimit", sql.Int, maxRows);
      if (v2) {
        request.input("actorId", sql.NVarChar(128), scope.actorId)
          .input("sourceIds", sql.NVarChar(2048), JSON.stringify([...allowed]))
          .input("selectedSourceIds", sql.NVarChar(sql.MAX), null);
      }
      const result = await request.query(erpAutocomplete ? catalogErpAutocompleteSql : v2 ? `
        ${catalogReconciledIdentitySql}
        ${readSnapshots(true)}
        SELECT customer_id,customer_name AS display_name,source_record_id AS sag_record_id,sag_only FROM @observedIdentity;
        SELECT @observedSagReady AS sag_ready,@observedPartial AS partial;
      ` : readSnapshots(false));
      const expectsGraph = v2 && !erpAutocomplete;
      if (!Array.isArray(result.recordsets) || result.recordsets.length !== (expectsGraph ? 5 : 3) ||
          !result.recordsets.every(Array.isArray)) fail();
      const [headers, records, scopes] = result.recordsets as unknown as [
        CatalogSnapshotHeaderRow[], CatalogSnapshotCustomerRow[], CatalogSnapshotCoverageRow[],
      ];
      let reconciled: CatalogReconciledDirectoryProjection | undefined;
      if (expectsGraph) {
        const extraSets = result.recordsets as unknown as unknown[][];
        const status = extraSets[4];
        if (status.length !== 1) fail();
        const row = status[0] as { sag_ready?: unknown; partial?: unknown };
        if (typeof row.sag_ready !== "boolean" || typeof row.partial !== "boolean") fail();
        reconciled = { rows: extraSets[3] as CatalogReconciledDirectoryRow[],
          sagReady: row.sag_ready, partial: row.partial };
      }
      return mapCatalogCustomerSnapshots(erpAutocomplete ? { ...scope, includeSagDirectory: false } : scope,
        headers, records, scopes, reconciled);
    };
    // A serializable read prevents ACL, profile or head changes between the
    // common graph and its exact immutable snapshot projection.
    return transaction ? await read(new sql.Request(transaction))
      : v2 ? await runSqlTransaction(transaction => read(new sql.Request(transaction)))
      : await read((await getSqlPool()).request());
  } catch {
    // Driver errors and internal comparison material are never exposed or logged here.
    fail();
  }
}
