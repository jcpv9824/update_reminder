/*
  A SAG license equivalence is valid only for the certified versions approved
  by the reviewer. A changed source or connection profile requires a new
  approval. The earlier unversioned table is retained for history only; no
  previous approvals or entitlements are upgraded, seeded or copied.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'settings.catalog_sag_license_module_map', N'U') IS NULL
  OR OBJECT_ID(N'settings.catalog_source_bindings', N'U') IS NULL
  OR OBJECT_ID(N'settings.external_database_connections', N'U') IS NULL
  OR OBJECT_ID(N'licensing.license_modules', N'U') IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id=OBJECT_ID(N'settings.catalog_source_bindings', N'U')
      AND name=N'UX_catalog_source_bindings_typed_key' AND is_unique=1 AND is_disabled=0
  )
  THROW 54100, N'Install the SAG license map and typed source bindings before versioned license approvals.', 1;

IF OBJECT_ID(N'settings.catalog_sag_license_module_approvals', N'U') IS NULL
BEGIN
  CREATE TABLE settings.catalog_sag_license_module_approvals
  (
    catalog_source_key bigint NOT NULL,
    source_role varchar(15) NOT NULL CONSTRAINT DF_catalog_sag_license_approvals_role DEFAULT 'sag-admin',
    binding_version binary(8) NOT NULL,
    profile_version binary(8) NOT NULL,
    sag_code varchar(1) COLLATE Latin1_General_100_BIN2 NOT NULL,
    module_key bigint NOT NULL,
    approval_reference varchar(80) COLLATE Latin1_General_100_BIN2 NOT NULL,
    approved_by nvarchar(150) NOT NULL,
    approved_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_sag_license_approvals_approved DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_catalog_sag_license_module_approvals PRIMARY KEY CLUSTERED(
      catalog_source_key,binding_version,profile_version,sag_code),
    CONSTRAINT FK_catalog_sag_license_module_approvals_source FOREIGN KEY(catalog_source_key,source_role)
      REFERENCES settings.catalog_source_bindings(catalog_source_key,source_role),
    CONSTRAINT FK_catalog_sag_license_module_approvals_module FOREIGN KEY(module_key)
      REFERENCES licensing.license_modules(module_key),
    CONSTRAINT CK_catalog_sag_license_module_approvals_role CHECK (
      source_role COLLATE Latin1_General_100_BIN2='sag-admin' AND DATALENGTH(source_role)=9),
    CONSTRAINT CK_catalog_sag_license_module_approvals_code CHECK (DATALENGTH(sag_code)=1 AND sag_code LIKE '[A-SU-Z]'),
    CONSTRAINT CK_catalog_sag_license_module_approvals_metadata CHECK (
      approval_reference LIKE '[A-Za-z0-9]%' AND approval_reference NOT LIKE '%[^A-Za-z0-9._-]%'
      AND DATALENGTH(approval_reference)=LEN(approval_reference) AND LEN(LTRIM(RTRIM(approved_by)))>0)
  );
END;

IF OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_stamp', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER settings.TR_catalog_sag_license_module_approvals_stamp
    ON settings.catalog_sag_license_module_approvals INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (
        SELECT 1 FROM inserted AS n
        WHERE NOT EXISTS (
          SELECT 1 FROM settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
          JOIN settings.external_database_connections AS p WITH (UPDLOCK,HOLDLOCK)
            ON p.external_database_connection_key=b.external_database_connection_key
          WHERE b.catalog_source_key=n.catalog_source_key AND b.source_role=''sag-admin''
            AND b.source_role=n.source_role AND b.source_state=''active'' AND b.contract_version=''sag_admin_v1''
            AND b.row_version=n.binding_version AND b.validated_at IS NOT NULL
            AND b.validated_profile_version=p.row_version AND p.row_version=n.profile_version
            AND p.status=''active'' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
        )
      )
        THROW 54101, N''A SAG license approval requires the exact current certified binding and profile.'', 1;

      DECLARE @approvedAt datetime2(3)=SYSUTCDATETIME();
      INSERT settings.catalog_sag_license_module_approvals(
        catalog_source_key,source_role,binding_version,profile_version,sag_code,module_key,approval_reference,approved_by,approved_at)
      SELECT catalog_source_key,source_role,binding_version,profile_version,sag_code,module_key,
        approval_reference,approved_by,@approvedAt
      FROM inserted;
    END;';

IF OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_immutable', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER settings.TR_catalog_sag_license_module_approvals_immutable
    ON settings.catalog_sag_license_module_approvals AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted)
        THROW 54102, N''A reviewed SAG license approval is immutable.'', 1;
    END;';
