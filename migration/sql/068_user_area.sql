/* Optional user area, independent of roles. No backfill or permission changes. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns068 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns068=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND is_read_only=0 AND collation_name COLLATE Latin1_General_100_BIN2=N'Modern_Spanish_CI_AS')
    THROW 56801,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;

  DECLARE @lock068 int;
  EXEC @lock068=sys.sp_getapplock @Resource=N'portal-sag:migration:068:user-area',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock068<0 THROW 56802,N'Could not reserve migration 068.',1;

  IF OBJECT_ID(N'security.users',N'U') IS NULL
    THROW 56803,N'Migration 068 requires the security.users table.',1;
  IF COL_LENGTH(N'security.users',N'area') IS NULL
    ALTER TABLE security.users ADD area varchar(14) COLLATE Latin1_General_100_BIN2 NULL;

  IF NOT EXISTS(SELECT 1 FROM sys.columns
    WHERE object_id=OBJECT_ID(N'security.users',N'U') AND name=N'area' AND is_nullable=1
      AND system_type_id=TYPE_ID(N'varchar') AND max_length=14
      AND collation_name=N'Latin1_General_100_BIN2' AND default_object_id=0)
    THROW 56804,N'The existing security.users.area column has an incompatible contract.',1;

  IF OBJECT_ID(N'security.CK_users_area',N'C') IS NULL
    EXEC sys.sp_executesql N'ALTER TABLE security.users WITH CHECK ADD CONSTRAINT CK_users_area CHECK
      (area IS NULL OR (area=''support'' AND DATALENGTH(area)=7)
       OR (area=''development'' AND DATALENGTH(area)=11)
       OR (area=''administrative'' AND DATALENGTH(area)=14)
       OR (area=''sales'' AND DATALENGTH(area)=5));';

  IF NOT EXISTS(SELECT 1 FROM sys.check_constraints
    WHERE object_id=OBJECT_ID(N'security.CK_users_area',N'C')
      AND parent_object_id=OBJECT_ID(N'security.users',N'U') AND is_disabled=0 AND is_not_trusted=0)
    THROW 56805,N'The user-area constraint is not trusted.',1;

  IF @owns068=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns068=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
