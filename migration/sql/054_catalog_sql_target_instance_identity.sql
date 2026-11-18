/* Optional, immutable instance namespace for a verified SQL physical target.
   No enrollment, legacy backfill, route metadata or runtime writer. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns054 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns054=1 BEGIN TRANSACTION;
  IF DB_NAME() NOT IN(N'PortalSAGWeb',N'PortalSAGWeb-TEST')
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
    THROW 55401,N'Expected Portal database on SQL Server 2019 compatibility level 150.',1;
  DECLARE @lock054 int;
  EXEC @lock054=sys.sp_getapplock @Resource=N'portal-sag:migration:054:sql-target-instance-identity',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock054<0 THROW 55402,N'Could not reserve the SQL target identity migration.',1;
  IF OBJECT_ID(N'core.catalog_physical_targets',N'U') IS NULL
    OR OBJECT_ID(N'core.UQ_catalog_physical_targets_typed',N'UQ') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NULL
    OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NULL
    OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    THROW 55403,N'Install the prerequisite catalog migrations and runtime role first.',1;

  IF OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U') IS NULL
    CREATE TABLE core.catalog_sql_target_instance_identities (
      physical_target_key bigint NOT NULL,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      target_kind varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
      trusted_instance_id uniqueidentifier NOT NULL,
      proof_id uniqueidentifier NOT NULL,
      registered_at datetime2(3) NOT NULL
        CONSTRAINT DF_catalog_sql_target_instance_identities_registered DEFAULT SYSUTCDATETIME(),
      CONSTRAINT PK_catalog_sql_target_instance_identities PRIMARY KEY CLUSTERED(physical_target_key),
      CONSTRAINT UQ_catalog_sql_target_instance_identities_proof UNIQUE(proof_id),
      CONSTRAINT FK_catalog_sql_target_instance_identities_target FOREIGN KEY(physical_target_key,portal_environment,target_kind)
        REFERENCES core.catalog_physical_targets(physical_target_key,portal_environment,target_kind),
      CONSTRAINT CK_catalog_sql_target_instance_identities_scope CHECK (
        target_kind='database' AND DATALENGTH(target_kind)=8
        AND ((portal_environment='qa' AND DATALENGTH(portal_environment)=2)
          OR (portal_environment='production' AND DATALENGTH(portal_environment)=10))),
      CONSTRAINT CK_catalog_sql_target_instance_identities_ids CHECK (
        trusted_instance_id<>'00000000-0000-0000-0000-000000000000'
        AND proof_id<>'00000000-0000-0000-0000-000000000000')
    );

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER core.TR_catalog_sql_target_instance_identities_insert
    ON core.catalog_sql_target_instance_identities INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @registeredAt datetime2(3)=SYSUTCDATETIME();
      INSERT core.catalog_sql_target_instance_identities(physical_target_key,portal_environment,target_kind,
        trusted_instance_id,proof_id,registered_at)
      SELECT n.physical_target_key,n.portal_environment,n.target_kind,n.trusted_instance_id,n.proof_id,@registeredAt
      FROM inserted AS n;
    END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER core.TR_catalog_sql_target_instance_identities_immutable
    ON core.catalog_sql_target_instance_identities AFTER UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 55404,N''SQL target instance identity history is immutable.'',1;
    END;';

  -- The table is not authorization to enroll a namespace. A separately reviewed
  -- writer must prove the association; existing inherited read access is unchanged.
  DENY INSERT,UPDATE,DELETE ON OBJECT::core.catalog_sql_target_instance_identities TO portal_runtime;

  IF @owns054=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns054=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
