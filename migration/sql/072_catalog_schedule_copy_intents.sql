/*
  Durable replay identity and exact selected logical edges for a catalog copy.
  This migration neither records a copy nor changes 044 operation approvals,
  permissions, roles, or either source database.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns072Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns072Transaction=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND is_read_only=0 AND collation_name COLLATE Latin1_General_100_BIN2=N'Modern_Spanish_CI_AS')
    THROW 57206,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock072 int;
  EXEC @lock072=sys.sp_getapplock
    @Resource=N'portal-sag:migration:072:schedule-copy-intents',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock072<0 THROW 57200,N'Could not reserve the schedule copy migration lock.',1;

  IF OBJECT_ID(N'scheduling.update_schedules',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_activation_snapshots',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_operational_links',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_physical_targets',N'U') IS NULL
    THROW 57201,N'Install the catalog schedule lifecycle and operational target schemas before copy intents.',1;

  IF OBJECT_ID(N'scheduling.catalog_schedule_copy_intents',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_schedule_copy_intents (
      intent_id uniqueidentifier NOT NULL,
      original_schedule_key bigint NOT NULL,
      original_definition_version binary(8) NOT NULL,
      copy_schedule_key bigint NOT NULL,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      actor_source_id nvarchar(150) COLLATE Latin1_General_100_BIN2 NOT NULL,
      operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
      selection_digest binary(32) NOT NULL,
      created_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_schedule_copy_intents_created_at DEFAULT SYSUTCDATETIME(),
      CONSTRAINT PK_catalog_schedule_copy_intents PRIMARY KEY CLUSTERED(intent_id),
      CONSTRAINT UQ_catalog_schedule_copy_intents_schedule UNIQUE(copy_schedule_key),
      CONSTRAINT FK_catalog_schedule_copy_intents_original FOREIGN KEY(original_schedule_key)
        REFERENCES scheduling.update_schedules(schedule_key),
      CONSTRAINT FK_catalog_schedule_copy_intents_copy FOREIGN KEY(copy_schedule_key)
        REFERENCES scheduling.update_schedules(schedule_key),
      CONSTRAINT CK_catalog_schedule_copy_intents_distinct CHECK(original_schedule_key<>copy_schedule_key),
      CONSTRAINT CK_catalog_schedule_copy_intents_environment CHECK(
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_schedule_copy_intents_actor CHECK(
        LEN(actor_source_id)>0 AND DATALENGTH(actor_source_id)=DATALENGTH(LTRIM(RTRIM(actor_source_id)))),
      CONSTRAINT CK_catalog_schedule_copy_intents_operation CHECK(
        operation_id LIKE N'[A-Za-z0-9]%' AND REPLACE(operation_id,N'-',N'') NOT LIKE N'%[^A-Za-z0-9._:]%'
        AND DATALENGTH(operation_id)=2*LEN(operation_id))
    );
  END;

  IF OBJECT_ID(N'scheduling.catalog_schedule_copy_links',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_schedule_copy_links (
      copy_schedule_key bigint NOT NULL,
      link_id uniqueidentifier NOT NULL,
      target_kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL,
      verified_target_id uniqueidentifier NOT NULL,
      CONSTRAINT PK_catalog_schedule_copy_links PRIMARY KEY CLUSTERED(copy_schedule_key,link_id),
      CONSTRAINT FK_catalog_schedule_copy_links_intent FOREIGN KEY(copy_schedule_key)
        REFERENCES scheduling.catalog_schedule_copy_intents(copy_schedule_key),
      CONSTRAINT FK_catalog_schedule_copy_links_operational FOREIGN KEY(link_id)
        REFERENCES core.catalog_operational_links(link_id),
      CONSTRAINT FK_catalog_schedule_copy_links_physical FOREIGN KEY(verified_target_id)
        REFERENCES core.catalog_physical_targets(target_id),
      CONSTRAINT CK_catalog_schedule_copy_links_kind CHECK(
        (target_kind='domain' AND DATALENGTH(target_kind)=6)
        OR (target_kind='database' AND DATALENGTH(target_kind)=8))
    );
  END;

  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_intents_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_copy_intents_immutable
      ON scheduling.catalog_schedule_copy_intents AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 57202,N''Schedule copy intents are append-only.'',1;
    END;';

  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_links_guard',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_copy_links_guard
      ON scheduling.catalog_schedule_copy_links AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 57203,N''Schedule copy link history is append-only.'',1;
      IF EXISTS(
        SELECT 1 FROM inserted n
        JOIN scheduling.catalog_schedule_copy_intents i ON i.copy_schedule_key=n.copy_schedule_key
        JOIN core.catalog_operational_links l ON l.link_id=n.link_id
        JOIN core.catalog_physical_targets t ON t.target_id=n.verified_target_id
        WHERE i.portal_environment<>l.portal_environment OR i.portal_environment<>t.portal_environment
          OR n.target_kind<>l.target_kind OR n.target_kind<>t.target_kind
      )
        THROW 57204,N''The copy link and physical target must match the intent environment and target kind.'',1;
    END;';

  IF NOT EXISTS(
      SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_intents_immutable',N'TR')
        AND parent_id=OBJECT_ID(N'scheduling.catalog_schedule_copy_intents',N'U') AND is_disabled=0)
    OR NOT EXISTS(
      SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_links_guard',N'TR')
        AND parent_id=OBJECT_ID(N'scheduling.catalog_schedule_copy_links',N'U') AND is_disabled=0)
    THROW 57205,N'Schedule copy history guards are not active.',1;

  DECLARE @intents072 int=OBJECT_ID(N'scheduling.catalog_schedule_copy_intents',N'U'),
    @links072 int=OBJECT_ID(N'scheduling.catalog_schedule_copy_links',N'U');
  IF (SELECT COUNT(*) FROM sys.foreign_keys AS fk
    WHERE fk.parent_object_id IN (@intents072,@links072) AND fk.is_disabled=0 AND fk.is_not_trusted=0
      AND fk.delete_referential_action=0 AND fk.update_referential_action=0
      AND fk.name IN (N'FK_catalog_schedule_copy_intents_original',N'FK_catalog_schedule_copy_intents_copy',
        N'FK_catalog_schedule_copy_links_intent',N'FK_catalog_schedule_copy_links_operational',
        N'FK_catalog_schedule_copy_links_physical'))<>5
    OR (SELECT COUNT(*) FROM sys.check_constraints AS cc
      WHERE cc.parent_object_id IN (@intents072,@links072) AND cc.is_disabled=0 AND cc.is_not_trusted=0
        AND cc.name IN (N'CK_catalog_schedule_copy_intents_distinct',N'CK_catalog_schedule_copy_intents_environment',
          N'CK_catalog_schedule_copy_intents_actor',N'CK_catalog_schedule_copy_intents_operation',N'CK_catalog_schedule_copy_links_kind'))<>5
    THROW 57207,N'Schedule copy constraints are not enforced.',1;

  IF @owns072Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns072Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
