SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @lock int;
  EXEC @lock=sys.sp_getapplock
    @Resource=N'portal-sag:migration:071:schedule-activation-snapshots', @LockMode=N'Exclusive',
    @LockOwner=N'Transaction', @LockTimeout=10000;
  IF @lock<0 THROW 57100,N'Could not reserve the schedule activation migration lock.',1;
  IF COL_LENGTH(N'scheduling.update_schedules',N'manual_environment') IS NULL
    THROW 57101,N'Install manual schedule environment before preparing activation snapshots.',1;

  IF COL_LENGTH(N'scheduling.update_schedules',N'catalog_activation_enabled') IS NULL
    ALTER TABLE scheduling.update_schedules ADD catalog_activation_enabled bit NOT NULL
      CONSTRAINT DF_catalog_schedule_activation_enabled DEFAULT (0);

  IF OBJECT_ID(N'scheduling.catalog_schedule_activation_snapshots',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_schedule_activation_snapshots (
      schedule_key bigint NOT NULL PRIMARY KEY,
      definition_version binary(8) NOT NULL,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      activation_at datetime2(3) NOT NULL,
      evidence_at datetime2(3) NULL,
      recorded_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
      activation_state varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      CONSTRAINT FK_catalog_schedule_activation_schedule FOREIGN KEY(schedule_key) REFERENCES scheduling.update_schedules(schedule_key),
      CONSTRAINT CK_catalog_schedule_activation_environment CHECK (
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_schedule_activation_state CHECK (
        activation_state IN ('frozen','held','cancelled') AND DATALENGTH(activation_state)=LEN(activation_state)),
      CONSTRAINT CK_catalog_schedule_activation_boundary CHECK (
        activation_at<=recorded_at AND (evidence_at IS NULL OR evidence_at<=activation_at)
        AND (evidence_at IS NOT NULL OR activation_state='held'))
    );
  END;
  IF OBJECT_ID(N'scheduling.catalog_schedule_activation_targets',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_schedule_activation_targets (
      schedule_key bigint NOT NULL,
      link_id uniqueidentifier NOT NULL,
      client_source_id nvarchar(150) NOT NULL,
      client_name_snapshot nvarchar(512) NOT NULL,
      domain_source_id nvarchar(150) NOT NULL,
      domain_name_snapshot nvarchar(512) NOT NULL,
      target_source_id nvarchar(150) NOT NULL,
      target_name_snapshot nvarchar(512) NOT NULL,
      verified_target_id uniqueidentifier NULL,
      target_kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL,
      target_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      evidence_state varchar(12) COLLATE Latin1_General_100_BIN2 NOT NULL,
      CONSTRAINT PK_catalog_schedule_activation_targets PRIMARY KEY CLUSTERED(schedule_key,link_id),
      CONSTRAINT FK_catalog_schedule_activation_targets_snapshot FOREIGN KEY(schedule_key)
        REFERENCES scheduling.catalog_schedule_activation_snapshots(schedule_key),
      CONSTRAINT CK_catalog_schedule_activation_target_kind CHECK (
        target_kind IN ('domain','database') AND DATALENGTH(target_kind)=LEN(target_kind)),
      CONSTRAINT CK_catalog_schedule_activation_target_env CHECK (
        target_environment IN ('production','test','demo') AND DATALENGTH(target_environment)=LEN(target_environment)),
      CONSTRAINT CK_catalog_schedule_activation_target_state CHECK (
        evidence_state IN ('eligible','absent','unverifiable') AND DATALENGTH(evidence_state)=LEN(evidence_state)
        AND (evidence_state<>'eligible' OR verified_target_id IS NOT NULL))
    );
  END;
  IF OBJECT_ID(N'scheduling.catalog_schedule_activation_responsibles',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_schedule_activation_responsibles (
      schedule_key bigint NOT NULL,
      target_kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL,
      principal_kind varchar(4) COLLATE Latin1_General_100_BIN2 NOT NULL,
      principal_source_id nvarchar(150) COLLATE Latin1_General_100_BIN2 NOT NULL,
      CONSTRAINT PK_catalog_schedule_activation_responsibles PRIMARY KEY CLUSTERED(schedule_key,target_kind,principal_kind,principal_source_id),
      CONSTRAINT FK_catalog_schedule_activation_responsibles_snapshot FOREIGN KEY(schedule_key)
        REFERENCES scheduling.catalog_schedule_activation_snapshots(schedule_key),
      CONSTRAINT CK_catalog_schedule_activation_responsible CHECK (
        target_kind IN ('domain','database') AND DATALENGTH(target_kind)=LEN(target_kind)
        AND principal_kind IN ('user','role') AND DATALENGTH(principal_kind)=4 AND LEN(LTRIM(RTRIM(principal_source_id)))>0)
    );
  END;
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
