/*
  Source access is separate from permission to open Clientes. No grants to
  individual users and no permission changes on existing objects are seeded.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'settings.catalog_source_bindings', N'U') IS NULL
   OR OBJECT_ID(N'security.users', N'U') IS NULL
  THROW 53140, N'Apply the source registry and security schema before source access.', 1;

IF OBJECT_ID(N'security.catalog_source_readers', N'U') IS NULL
BEGIN
  CREATE TABLE security.catalog_source_readers
  (
    user_key bigint NOT NULL,
    catalog_source_key bigint NOT NULL,
    granted_at datetime2(3) NOT NULL
      CONSTRAINT DF_catalog_source_readers_granted DEFAULT SYSUTCDATETIME(),
    granted_by nvarchar(150) NOT NULL,
    revoked_at datetime2(3) NULL,
    revoked_by nvarchar(150) NULL,
    row_version rowversion NOT NULL,
    CONSTRAINT PK_catalog_source_readers PRIMARY KEY CLUSTERED(user_key, catalog_source_key),
    CONSTRAINT FK_catalog_source_readers_user FOREIGN KEY(user_key)
      REFERENCES security.users(user_key),
    CONSTRAINT FK_catalog_source_readers_source FOREIGN KEY(catalog_source_key)
      REFERENCES settings.catalog_source_bindings(catalog_source_key),
    CONSTRAINT CK_catalog_source_readers_revoke CHECK(
      (revoked_at IS NULL AND revoked_by IS NULL)
      OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_at >= granted_at))
  );
END;
