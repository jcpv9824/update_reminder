import sql from "mssql";

type ContentSchemaCapabilities = {
  provider_neutral_locators: boolean;
  public_files: boolean;
};

export async function readContentSchemaCapabilities(
  request: sql.Request,
): Promise<ContentSchemaCapabilities> {
  const result = await request.query<{
    provider_neutral_locators: boolean;
    public_files: boolean;
  }>(`
    SELECT
      CONVERT(bit,CASE WHEN
        COL_LENGTH(N'content.files',N'storage_bucket') IS NOT NULL
        AND COL_LENGTH(N'content.files',N'object_key') IS NOT NULL
        AND COL_LENGTH(N'content.files',N'object_etag') IS NOT NULL
        THEN 1 ELSE 0 END) AS provider_neutral_locators,
      CONVERT(bit,CASE WHEN
        OBJECT_ID(N'content.public_files',N'U') IS NOT NULL
        AND OBJECT_ID(N'content.public_file_versions',N'U') IS NOT NULL
        THEN 1 ELSE 0 END) AS public_files;
  `);
  return {
    provider_neutral_locators: Boolean(result.recordset[0]?.provider_neutral_locators),
    public_files: Boolean(result.recordset[0]?.public_files),
  };
}

export function contentFileLocatorProjection(alias: string, providerNeutralLocators: boolean): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("Alias SQL de archivo no válido.");
  if (providerNeutralLocators) {
    return `${alias}.storage_provider,${alias}.storage_container,${alias}.blob_name,` +
      `${alias}.storage_bucket,${alias}.object_key,${alias}.object_etag`;
  }
  return `${alias}.storage_provider,${alias}.storage_container,${alias}.blob_name,` +
    `CAST(NULL AS NVARCHAR(255)) AS storage_bucket,` +
    `CAST(NULL AS NVARCHAR(1024)) AS object_key,` +
    `CAST(NULL AS NVARCHAR(200)) AS object_etag`;
}

export async function requirePublicFilesSchema(transaction: sql.Transaction): Promise<void> {
  const capabilities = await readContentSchemaCapabilities(new sql.Request(transaction));
  if (!capabilities.public_files) {
    throw Object.assign(
      new Error("El módulo Archivos Públicos aún no está habilitado en la base de datos."),
      { status: 503 },
    );
  }
}
