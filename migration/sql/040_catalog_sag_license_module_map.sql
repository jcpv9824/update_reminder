/*
  Reviewed equivalences from a specific SAG Admin source to operational
  modules. Matching names or letter codes alone establish no equivalence.
  Approval references are opaque ticket identifiers, never credentials,
  payloads, or external URLs. No assignments or grants are seeded here.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'settings.catalog_source_bindings', N'U') IS NULL
  OR OBJECT_ID(N'licensing.license_modules', N'U') IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id=OBJECT_ID(N'settings.catalog_source_bindings', N'U')
      AND name=N'UX_catalog_source_bindings_typed_key' AND is_unique=1 AND is_disabled=0
  )
  THROW 54000, N'Install typed catalog source bindings and the operational license master before the SAG license map.', 1;

IF OBJECT_ID(N'settings.catalog_sag_license_module_map', N'U') IS NULL
BEGIN
  CREATE TABLE settings.catalog_sag_license_module_map
  (
    catalog_source_key bigint NOT NULL,
    source_role varchar(15) NOT NULL CONSTRAINT DF_catalog_sag_license_map_role DEFAULT 'sag-admin',
    sag_code varchar(1) COLLATE Latin1_General_100_BIN2 NOT NULL,
    module_key bigint NOT NULL,
    approval_reference varchar(80) COLLATE Latin1_General_100_BIN2 NOT NULL,
    approved_by nvarchar(150) NOT NULL,
    approved_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_sag_license_map_approved DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_catalog_sag_license_module_map PRIMARY KEY CLUSTERED(catalog_source_key,sag_code),
    CONSTRAINT FK_catalog_sag_license_module_map_source FOREIGN KEY(catalog_source_key,source_role)
      REFERENCES settings.catalog_source_bindings(catalog_source_key,source_role),
    CONSTRAINT FK_catalog_sag_license_module_map_module FOREIGN KEY(module_key)
      REFERENCES licensing.license_modules(module_key),
    CONSTRAINT CK_catalog_sag_license_module_map_role CHECK (
      source_role COLLATE Latin1_General_100_BIN2='sag-admin' AND DATALENGTH(source_role)=9),
    CONSTRAINT CK_catalog_sag_license_module_map_code CHECK (DATALENGTH(sag_code)=1 AND sag_code LIKE '[A-SU-Z]'),
    CONSTRAINT CK_catalog_sag_license_module_map_approval CHECK (
      approval_reference LIKE '[A-Za-z0-9]%' AND approval_reference NOT LIKE '%[^A-Za-z0-9._-]%'
      AND DATALENGTH(approval_reference)=LEN(approval_reference) AND LEN(LTRIM(RTRIM(approved_by)))>0)
  );
END;

IF OBJECT_ID(N'settings.TR_catalog_sag_license_module_map_stamp', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER settings.TR_catalog_sag_license_module_map_stamp
    ON settings.catalog_sag_license_module_map INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @approvedAt datetime2(3)=SYSUTCDATETIME();
      INSERT settings.catalog_sag_license_module_map(
        catalog_source_key,source_role,sag_code,module_key,approval_reference,approved_by,approved_at)
      SELECT catalog_source_key,source_role,sag_code,module_key,approval_reference,approved_by,@approvedAt
      FROM inserted;
    END;';

IF OBJECT_ID(N'settings.TR_catalog_sag_license_module_map_immutable', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER settings.TR_catalog_sag_license_module_map_immutable
    ON settings.catalog_sag_license_module_map AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted)
        THROW 54001, N''A reviewed SAG license mapping is immutable.'', 1;
    END;';
