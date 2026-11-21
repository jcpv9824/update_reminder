/* Optional schedule rollout: one object-level EXECUTE. No role membership or data grants. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns081 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns081=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
    OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150 AND is_read_only=0)
    THROW 58100,N'Expected an exact Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock081 int;
  EXEC @lock081=sys.sp_getapplock @Resource=N'portal-sag:migration:081:draft-runtime-execute',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock081<0 THROW 58101,N'Could not reserve the runtime grant migration lock.',1;
  DECLARE @module081 int=OBJECT_ID(N'settings.materialize_catalog_schedule_draft_review',N'P'),
    @runtime081 int=DATABASE_PRINCIPAL_ID(N'portal_runtime'),
    @approvals081 int=OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U'),
    @private081 int=SCHEMA_ID(N'migration');
  IF @module081 IS NULL OR @runtime081 IS NULL OR @approvals081 IS NULL OR @private081 IS NULL
    OR NOT EXISTS(SELECT 1 FROM sys.sql_modules m JOIN sys.objects o ON o.object_id=m.object_id
      JOIN sys.schemas s ON s.schema_id=o.schema_id
      WHERE m.object_id=@module081 AND m.execute_as_principal_id IS NULL
        AND COALESCE(o.principal_id,s.principal_id,-1)=DATABASE_PRINCIPAL_ID(N'dbo'))
    OR (SELECT COUNT(*) FROM sys.database_permissions WHERE class=3 AND major_id=@private081 AND grantee_principal_id=@runtime081
      AND state='D' AND permission_name IN (N'SELECT',N'INSERT',N'UPDATE',N'DELETE'))<>4
    OR NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND minor_id=0 AND major_id=@approvals081
      AND grantee_principal_id=@runtime081 AND state='D' AND permission_name=N'INSERT')
    THROW 58102,N'Expected the restricted materializer and its existing direct-access denials.',1;
  IF EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id=@module081
    AND (minor_id<>0 OR grantee_principal_id<>@runtime081 OR state<>'G' OR permission_name<>N'EXECUTE'))
    THROW 58103,N'Unexpected preexisting draft-materializer permission; no changes were applied.',1;

  GRANT EXECUTE ON OBJECT::settings.materialize_catalog_schedule_draft_review TO portal_runtime;

  IF (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND major_id=@module081)<>1
    OR NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND minor_id=0 AND major_id=@module081
      AND grantee_principal_id=@runtime081 AND state='G' AND permission_name=N'EXECUTE')
    THROW 58104,N'The exact object-only execution grant was not verified.',1;
  IF @owns081=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns081=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
