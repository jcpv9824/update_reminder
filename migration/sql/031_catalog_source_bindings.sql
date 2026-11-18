/*
  Additive schema for binding the existing external SQL profiles to the catalog.
  A normal profile check does not activate a source. No credentials, data loads
  or initial active bindings are included in this migration.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'settings.external_database_connections', N'U') IS NULL
  THROW 53110, N'Apply the external connections migration before catalog bindings.', 1;

IF OBJECT_ID(N'settings.catalog_source_bindings', N'U') IS NULL
BEGIN
  CREATE TABLE settings.catalog_source_bindings
  (
    catalog_source_key             bigint IDENTITY(1,1) NOT NULL,
    source_id                      uniqueidentifier NOT NULL
      CONSTRAINT DF_catalog_source_bindings_id DEFAULT NEWSEQUENTIALID(),
    external_database_connection_key bigint NOT NULL,
    display_name                   nvarchar(150) NOT NULL,
    source_role                    varchar(15) NOT NULL,
    portal_environment             varchar(10) NOT NULL,
    source_state                   varchar(10) NOT NULL
      CONSTRAINT DF_catalog_source_bindings_state DEFAULT 'draft',
    issuer_scope                   nvarchar(80) NULL,
    contract_version               varchar(40) NOT NULL,
    validated_profile_version      binary(8) NULL,
    validated_at                   datetime2(3) NULL,
    created_at                     datetime2(3) NOT NULL
      CONSTRAINT DF_catalog_source_bindings_created DEFAULT SYSUTCDATETIME(),
    created_by                     nvarchar(150) NOT NULL,
    updated_at                     datetime2(3) NOT NULL
      CONSTRAINT DF_catalog_source_bindings_updated DEFAULT SYSUTCDATETIME(),
    updated_by                     nvarchar(150) NOT NULL,
    row_version                    rowversion NOT NULL,

    CONSTRAINT PK_catalog_source_bindings PRIMARY KEY CLUSTERED(catalog_source_key),
    CONSTRAINT UQ_catalog_source_bindings_id UNIQUE(source_id),
    CONSTRAINT FK_catalog_source_bindings_profile FOREIGN KEY(external_database_connection_key)
      REFERENCES settings.external_database_connections(external_database_connection_key),
    CONSTRAINT CK_catalog_source_bindings_role CHECK(source_role IN ('erp-customers','sag-admin')),
    CONSTRAINT CK_catalog_source_bindings_environment CHECK(portal_environment IN ('qa','production')),
    CONSTRAINT CK_catalog_source_bindings_state CHECK(source_state IN ('draft','active','retired')),
    CONSTRAINT CK_catalog_source_bindings_text CHECK(
      LEN(LTRIM(RTRIM(display_name))) > 0 AND LEN(LTRIM(RTRIM(contract_version))) > 0
      AND (source_role <> 'erp-customers' OR (issuer_scope IS NOT NULL AND LEN(LTRIM(RTRIM(issuer_scope))) > 0))
    ),
    CONSTRAINT CK_catalog_source_bindings_validation CHECK(
      ((validated_profile_version IS NULL AND validated_at IS NULL) OR
       (validated_profile_version IS NOT NULL AND validated_at IS NOT NULL))
      AND (source_state <> 'active' OR validated_at IS NOT NULL)
    ),
    CONSTRAINT CK_catalog_source_bindings_updated CHECK(updated_at >= created_at)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_bindings')
  AND name=N'UX_catalog_source_bindings_active_profile')
  CREATE UNIQUE INDEX UX_catalog_source_bindings_active_profile
    ON settings.catalog_source_bindings(portal_environment, external_database_connection_key)
    WHERE source_state='active';

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_bindings')
  AND name=N'UX_catalog_source_bindings_active_sag')
  CREATE UNIQUE INDEX UX_catalog_source_bindings_active_sag
    ON settings.catalog_source_bindings(portal_environment)
    WHERE source_state='active' AND source_role='sag-admin';
