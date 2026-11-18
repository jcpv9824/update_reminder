import sql from "mssql";
import { getSqlPool } from "./sql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

/**
 * Read a user's source scope from SQL using the authenticated, loaded profile ID.
 * No HTTP request parameter can supply the user or the protected role.
 * Missing/revoked permissions never fall back to the unscoped legacy catalog.
 */
export async function readAuthorizedCatalogSourceIds(args: {
  actorId: string;
  environment: CatalogEnvironment;
}): Promise<ReadonlySet<string>> {
  const result = await (await getSqlPool()).request()
    .input("actorId", sql.NVarChar(150), args.actorId)
    .input("environment", sql.VarChar(10), args.environment)
    .query<{ id: string }>(`
      SELECT CONVERT(char(36), s.source_id) AS id
      FROM settings.catalog_source_bindings AS s
      JOIN security.users AS u ON u.source_id=@actorId AND u.active=1
      WHERE s.portal_environment=@environment AND s.source_role='erp-customers'
        AND s.source_state='active'
        AND (
          EXISTS (
            SELECT 1
            FROM security.catalog_source_readers AS r
            WHERE r.user_key=u.user_key AND r.catalog_source_key=s.catalog_source_key
              AND r.revoked_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM security.user_roles AS ur
            JOIN security.roles AS role ON role.role_id=ur.role_id AND role.active=1
            WHERE ur.user_key=u.user_key AND role.role_id=N'super_admin'
          )
        )
      ORDER BY s.catalog_source_key;
    `);
  return new Set(result.recordset.map(row => row.id.toLowerCase()));
}
