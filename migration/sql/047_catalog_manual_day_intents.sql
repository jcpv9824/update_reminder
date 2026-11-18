/*
  Append-only request to include an exact manual schedule version on a
  Bogota task day. SQL verifies the referenced evidence and stamps UTC.
  The application still owns generate permission and occurrence cutoff.
  This migration creates no intent and expands no existing permission.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns047Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns047Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock047 int;
  EXEC @lock047=sys.sp_getapplock @Resource=N'portal-sag:migration:047:manual-day-intents',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock047<0 THROW 54700,N'Could not reserve the manual day intent migration lock.',1;

  IF OBJECT_ID(N'scheduling.update_schedules',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
    OR OBJECT_ID(N'security.users',N'U') IS NULL
    THROW 54701,N'Install scheduling, operation approvals and security before manual day intents.',1;

  IF OBJECT_ID(N'scheduling.catalog_manual_day_intents',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_manual_day_intents
    (
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      task_date date NOT NULL,
      schedule_key bigint NOT NULL,
      schedule_version binary(8) NOT NULL,
      requested_by bigint NOT NULL,
      requested_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_manual_day_intents_at DEFAULT SYSUTCDATETIME(),

      CONSTRAINT PK_catalog_manual_day_intents PRIMARY KEY CLUSTERED(portal_environment,task_date,schedule_key,schedule_version),
      CONSTRAINT FK_catalog_manual_day_intents_schedule FOREIGN KEY(schedule_key)
        REFERENCES scheduling.update_schedules(schedule_key),
      CONSTRAINT FK_catalog_manual_day_intents_requester FOREIGN KEY(requested_by)
        REFERENCES security.users(user_key),
      CONSTRAINT CK_catalog_manual_day_intents_environment CHECK (
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10))
    );
  END;

  IF OBJECT_ID(N'scheduling.TR_catalog_manual_day_intents_register',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_manual_day_intents_register
      ON scheduling.catalog_manual_day_intents INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (
        SELECT 1 FROM inserted n WHERE NOT EXISTS (
          SELECT 1 FROM scheduling.update_schedules s WITH (HOLDLOCK)
          JOIN security.users u WITH (HOLDLOCK) ON u.user_key=n.requested_by AND u.active=1
          JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK)
            ON a.portal_environment=n.portal_environment AND a.schedule_key=s.schedule_key AND a.schedule_version=s.row_version
            AND a.retired_at IS NULL AND a.approved_at<=SYSUTCDATETIME()
          WHERE s.schedule_key=n.schedule_key AND s.row_version=n.schedule_version AND s.frequency_type=''manual''
            AND s.active=1 AND s.deleted_at IS NULL AND s.start_date<=n.task_date
            AND (s.end_date IS NULL OR s.end_date>=n.task_date)
        )
      )
        THROW 54702,N''A manual day intent requires the current approved manual schedule and an active requester.'',1;

      DECLARE @requestedAt datetime2(3)=SYSUTCDATETIME();
      DECLARE @today date=CONVERT(date,@requestedAt AT TIME ZONE ''UTC'' AT TIME ZONE ''SA Pacific Standard Time'');
      IF EXISTS(SELECT 1 FROM inserted WHERE task_date<@today)
        THROW 54703,N''A manual day intent cannot be registered for a past Bogota task date.'',1;

      INSERT scheduling.catalog_manual_day_intents(
        portal_environment,task_date,schedule_key,schedule_version,requested_by,requested_at)
      SELECT portal_environment,task_date,schedule_key,schedule_version,requested_by,@requestedAt FROM inserted;
    END;';

  IF OBJECT_ID(N'scheduling.TR_catalog_manual_day_intents_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_manual_day_intents_immutable
      ON scheduling.catalog_manual_day_intents AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 54704,N''Catalog manual day intents are append-only.'',1;
    END;';

  IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
    DENY UPDATE,DELETE ON OBJECT::scheduling.catalog_manual_day_intents TO portal_runtime;

  IF @owns047Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns047Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
