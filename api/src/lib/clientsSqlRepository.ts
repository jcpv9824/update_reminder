import sql from "mssql";
import type { ClientRecord, DatabaseRecord, DomainRecord } from "../types/models";
import { getSqlPool } from "./sql";

type ClientRow = {
  source_id: string; external_id: string | null; name: string; status: ClientRecord["status"];
  notes: string | null; created_at: Date; created_by: string; updated_at: Date; updated_by: string;
  deleted_at: Date | null; deleted_by: string | null; module_source_id: string | null; module_name: string | null;
};

type DomainRow = {
  source_id: string; client_source_id: string; client_name: string; domain_name: string;
  environment_id: string; current_web_version: string | null; status: DomainRecord["status"];
  notes: string | null; created_at: Date; created_by: string; updated_at: Date; updated_by: string;
  deleted_at: Date | null; deleted_by: string | null; last_updated_at: Date | null;
  last_updated_by: string | null; assignee_source_id: string | null;
};

type PublicDatabase = ReturnType<typeof mapSqlPublicDatabaseRows>;
type DatabaseRow = {
  source_id: string; client_source_id: string; client_name: string; domain_source_id: string;
  domain_name: string; company_name: string; environment_id: string; initial_catalog: string;
  current_db_version: string | null; status: DatabaseRecord["status"]; notes: string | null;
  created_at: Date; updated_at: Date; last_updated_at: Date | null; assignee_source_id: string | null;
};

const iso = (value: Date | null) => value ? value.toISOString() : null;

export function mapSqlClientRows(rows: ClientRow[]): ClientRecord {
  const first = rows[0];
  if (!first) throw new Error("El cliente SQL no existe.");
  const modules = [...new Map(rows
    .filter((row) => row.module_source_id && row.module_name)
    .map((row) => [row.module_source_id!, { id: row.module_source_id!, name: row.module_name! }])).values()];
  return {
    id: first.source_id,
    externalId: first.external_id ?? undefined,
    name: first.name,
    status: first.status,
    notes: first.notes ?? undefined,
    licenseModuleIds: modules.map((module) => module.id),
    licenseModuleNames: modules.map((module) => module.name),
    createdAt: first.created_at.toISOString(),
    createdBy: first.created_by,
    updatedAt: first.updated_at.toISOString(),
    updatedBy: first.updated_by,
    deletedAt: iso(first.deleted_at),
    deletedBy: first.deleted_by,
  };
}

export function mapSqlDomainRows(rows: DomainRow[]): DomainRecord {
  const first = rows[0];
  if (!first) throw new Error("El dominio SQL no existe.");
  return {
    id: first.source_id,
    clientId: first.client_source_id,
    clientName: first.client_name,
    domainName: first.domain_name,
    environment: first.environment_id,
    currentWebVersion: first.current_web_version ?? undefined,
    assignedUpdaterIds: rows.flatMap((row) => row.assignee_source_id ? [row.assignee_source_id] : []),
    status: first.status,
    notes: first.notes ?? undefined,
    createdAt: first.created_at.toISOString(),
    createdBy: first.created_by,
    updatedAt: first.updated_at.toISOString(),
    updatedBy: first.updated_by,
    deletedAt: iso(first.deleted_at),
    deletedBy: first.deleted_by,
    lastUpdatedAt: iso(first.last_updated_at),
    lastUpdatedBy: first.last_updated_by,
  };
}

export function mapSqlPublicDatabaseRows(rows: DatabaseRow[]) {
  const first = rows[0];
  if (!first) throw new Error("La base de datos SQL no existe.");
  return {
    id: first.source_id,
    clientId: first.client_source_id,
    clientName: first.client_name,
    domainId: first.domain_source_id,
    domainName: first.domain_name,
    companyName: first.company_name,
    environment: first.environment_id,
    dbAccess: { initialCatalog: first.initial_catalog },
    currentDbVersion: first.current_db_version ?? undefined,
    status: first.status,
    notes: first.notes ?? undefined,
    createdAt: first.created_at.toISOString(),
    updatedAt: first.updated_at.toISOString(),
    lastUpdatedAt: iso(first.last_updated_at),
  };
}

function groupRows<T extends { source_id: string }>(rows: T[]): T[][] {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(row.source_id, [...(grouped.get(row.source_id) ?? []), row]);
  return [...grouped.values()];
}

export async function readSqlClients(sourceId?: string): Promise<ClientRecord[]> {
  const pool = await getSqlPool();
  const request = pool.request();
  if (sourceId) request.input("sourceId", sql.NVarChar(150), sourceId);
  const result = await request.query<ClientRow>(`
    SELECT c.source_id,c.external_id,c.name,c.status,c.notes,c.created_at,c.created_by,
      c.updated_at,c.updated_by,c.deleted_at,c.deleted_by,m.source_id AS module_source_id,
      COALESCE(a.module_name_snapshot,m.name) AS module_name
    FROM core.clients AS c
    LEFT JOIN licensing.license_assignments AS a
      ON a.client_key=c.client_key AND a.target_type='client' AND a.status<>'deleted'
    LEFT JOIN licensing.license_modules AS m ON m.module_key=a.module_key
    ${sourceId ? "WHERE c.source_id=@sourceId" : ""}
    ORDER BY c.name,c.source_id,m.name,m.source_id;
  `);
  return groupRows(result.recordset).map(mapSqlClientRows);
}

export async function readSqlClientTree(sourceId: string): Promise<{
  client: ClientRecord;
  domains: Array<{ domain: DomainRecord; databases: PublicDatabase[] }>;
} | null> {
  const clients = await readSqlClients(sourceId);
  const client = clients[0];
  if (!client || client.status === "deleted") return null;
  const pool = await getSqlPool();
  const [domainResult, databaseResult] = await Promise.all([
    pool.request().input("clientId", sql.NVarChar(150), sourceId).query<DomainRow>(`
      SELECT d.source_id,c.source_id AS client_source_id,c.name AS client_name,d.domain_name,
        d.environment_id,d.current_web_version,d.status,d.notes,d.created_at,d.created_by,
        d.updated_at,d.updated_by,d.deleted_at,d.deleted_by,d.last_updated_at,d.last_updated_by,
        u.source_id AS assignee_source_id
      FROM core.domains AS d
      JOIN core.clients AS c ON c.client_key=d.client_key
      LEFT JOIN core.domain_assignees AS a ON a.domain_key=d.domain_key
      LEFT JOIN security.users AS u ON u.user_key=a.user_key
      WHERE c.source_id=@clientId AND d.status<>'deleted'
      ORDER BY d.domain_name,d.source_id,u.source_id;
    `),
    pool.request().input("clientId", sql.NVarChar(150), sourceId).query<DatabaseRow>(`
      SELECT db.source_id,c.source_id AS client_source_id,c.name AS client_name,
        d.source_id AS domain_source_id,d.domain_name,db.company_name,db.environment_id,
        p.initial_catalog,db.current_db_version,db.status,db.notes,db.created_at,db.updated_at,
        db.last_updated_at,u.source_id AS assignee_source_id
      FROM core.databases AS db
      JOIN core.clients AS c ON c.client_key=db.client_key
      JOIN core.domains AS d ON d.domain_key=db.domain_key
      JOIN core.database_access_profiles AS p ON p.access_profile_key=db.access_profile_key
      LEFT JOIN core.database_assignees AS a ON a.database_key=db.database_key
      LEFT JOIN security.users AS u ON u.user_key=a.user_key
      WHERE c.source_id=@clientId AND db.status<>'deleted'
      ORDER BY db.company_name,db.source_id,u.source_id;
    `),
  ]);
  const domains = groupRows(domainResult.recordset).map(mapSqlDomainRows);
  const databases = groupRows(databaseResult.recordset).map(mapSqlPublicDatabaseRows);
  return {
    client,
    domains: domains.map((domain) => ({
      domain,
      databases: databases.filter((database) => database.domainId === domain.id),
    })),
  };
}
