/* Inert, append-only proposals. No schedule, task, notice or 044 approval is created here. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns075 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns075=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS (SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND is_read_only=0 AND collation_name COLLATE Latin1_General_100_BIN2=N'Modern_Spanish_CI_AS')
    THROW 57500,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock075 int;
  EXEC @lock075=sys.sp_getapplock @Resource=N'portal-sag:migration:075:copy-proposals',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock075<0 THROW 57501,N'Could not reserve the copy proposal migration lock.',1;
  IF OBJECT_ID(N'scheduling.catalog_schedule_copy_links',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
    THROW 57502,N'Install exact schedule copy and operation approval prerequisites first.',1;

  IF OBJECT_ID(N'scheduling.catalog_schedule_copy_proposals',N'U') IS NULL
    CREATE TABLE scheduling.catalog_schedule_copy_proposals (
      proposal_id uniqueidentifier NOT NULL PRIMARY KEY,
      original_schedule_key bigint NOT NULL REFERENCES scheduling.update_schedules(schedule_key),
      original_definition_version binary(8) NOT NULL,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      requester_source_id nvarchar(150) COLLATE Latin1_General_100_BIN2 NOT NULL,
      operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
      requested_date date NOT NULL,
      requested_name nvarchar(200) NOT NULL,
      request_sha256 binary(32) NOT NULL,
      created_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_schedule_copy_proposals_created DEFAULT SYSUTCDATETIME(),
      CONSTRAINT CK_catalog_schedule_copy_proposals_environment CHECK (
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_schedule_copy_proposals_name CHECK (LEN(requested_name)>0),
      CONSTRAINT CK_catalog_schedule_copy_proposals_requester CHECK (LEN(requester_source_id)>0)
    );
  IF OBJECT_ID(N'scheduling.catalog_schedule_copy_proposal_links',N'U') IS NULL
    CREATE TABLE scheduling.catalog_schedule_copy_proposal_links (
      proposal_id uniqueidentifier NOT NULL REFERENCES scheduling.catalog_schedule_copy_proposals(proposal_id),
      link_id uniqueidentifier NOT NULL REFERENCES core.catalog_operational_links(link_id),
      kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL,
      physical_target_id uniqueidentifier NOT NULL REFERENCES core.catalog_physical_targets(target_id),
      PRIMARY KEY(proposal_id,link_id),
      CONSTRAINT CK_catalog_schedule_copy_proposal_links_kind CHECK (
        (kind='domain' AND DATALENGTH(kind)=6) OR (kind='database' AND DATALENGTH(kind)=8))
    );

  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_proposals_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_copy_proposals_immutable
      ON scheduling.catalog_schedule_copy_proposals AFTER UPDATE,DELETE AS
      BEGIN
        SET NOCOUNT ON;
        IF EXISTS(SELECT 1 FROM deleted) THROW 57503,N''Copy proposals are append-only.'',1;
      END;';
  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_proposal_links_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_copy_proposal_links_immutable
      ON scheduling.catalog_schedule_copy_proposal_links AFTER UPDATE,DELETE AS
      BEGIN
        SET NOCOUNT ON;
        IF EXISTS(SELECT 1 FROM deleted) THROW 57504,N''Copy proposal links are append-only.'',1;
      END;';
  IF (SELECT COUNT(*) FROM sys.triggers WHERE is_disabled=0 AND object_id IN (
    OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_proposals_immutable',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_proposal_links_immutable',N'TR')) )<>2
    THROW 57505,N'Expected enabled proposal history guards.',1;
  IF @owns075=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns075=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
