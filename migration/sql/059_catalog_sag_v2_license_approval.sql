/* Accept reviewed mappings for either exact SAG discovery contract. No data seeded. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns059 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns059=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
    THROW 55901,N'Expected Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock059 int;
  EXEC @lock059=sys.sp_getapplock @Resource=N'portal-sag:migration:059:sag-v2-license-approval',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock059<0 THROW 55902,N'Could not reserve migration 059.',1;
  IF OBJECT_ID(N'settings.catalog_sag_license_module_approvals',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NULL
    OR EXISTS(SELECT 1 FROM (VALUES
       (OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_stamp',N'TR')),
       (OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_immutable',N'TR'))
     ) required_trigger(object_id) LEFT JOIN sys.triggers t ON t.object_id=required_trigger.object_id
     WHERE t.object_id IS NULL OR t.is_disabled=1)
    THROW 55903,N'Expected the existing approval guards and SAG v2 inventory schema.',1;

  EXEC sys.sp_executesql N'ALTER TRIGGER settings.TR_catalog_sag_license_module_approvals_stamp
    ON settings.catalog_sag_license_module_approvals INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @approvedAt datetime2(3)=SYSUTCDATETIME();
      IF EXISTS (
        SELECT 1 FROM inserted AS n
        WHERE NOT EXISTS (
          SELECT 1 FROM settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
          JOIN settings.external_database_connections AS p WITH (UPDLOCK,HOLDLOCK)
            ON p.external_database_connection_key=b.external_database_connection_key
          JOIN licensing.license_modules AS m WITH (HOLDLOCK)
            ON m.module_key=n.module_key AND m.status=''active'' AND m.deleted_at IS NULL
          WHERE b.catalog_source_key=n.catalog_source_key
            AND b.source_role COLLATE Latin1_General_100_BIN2=''sag-admin'' AND DATALENGTH(b.source_role)=9
            AND b.source_role=n.source_role AND b.source_state=''active''
            AND b.contract_version COLLATE Latin1_General_100_BIN2 IN (''sag_admin_v1'',''sag_admin_v2'')
            AND DATALENGTH(b.contract_version)=12
            AND b.row_version=n.binding_version AND b.validated_at<=@approvedAt
            AND b.validated_profile_version=p.row_version AND p.row_version=n.profile_version
            AND p.status=''active'' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
        )
      )
        THROW 54101,N''A SAG license approval requires the exact current certified binding, profile and active module.'',1;
      INSERT settings.catalog_sag_license_module_approvals(
        catalog_source_key,source_role,binding_version,profile_version,sag_code,module_key,
        approval_reference,approved_by,approved_at)
      SELECT catalog_source_key,source_role,binding_version,profile_version,sag_code,module_key,
        approval_reference,approved_by,@approvedAt
      FROM inserted;
    END;';
  IF @owns059=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns059=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
