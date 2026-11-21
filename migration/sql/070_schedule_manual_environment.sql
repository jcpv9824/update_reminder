SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @migrationLock int;
  EXEC @migrationLock=sys.sp_getapplock
    @Resource=N'portal-sag:migration:070:schedule-manual-environment', @LockMode=N'Exclusive',
    @LockOwner=N'Transaction', @LockTimeout=10000;
  IF @migrationLock<0 THROW 57000,N'Could not reserve the manual schedule environment migration lock.',1;
  IF OBJECT_ID(N'scheduling.update_schedules',N'U') IS NULL
    THROW 57001,N'Create the schedule schema before adding manual environments.',1;

  IF COL_LENGTH(N'scheduling.update_schedules',N'manual_environment') IS NULL
    ALTER TABLE scheduling.update_schedules ADD manual_environment varchar(10) COLLATE Latin1_General_100_BIN2 NULL;

  IF OBJECT_ID(N'scheduling.CK_schedules_manual_environment',N'C') IS NULL
    EXEC sys.sp_executesql N'ALTER TABLE scheduling.update_schedules WITH CHECK ADD CONSTRAINT CK_schedules_manual_environment
      CHECK (manual_environment IS NULL OR (manual_environment IN (''all'',''production'',''test'',''demo'')
        AND DATALENGTH(manual_environment) = LEN(manual_environment)));';
  IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
    WHERE parent_object_id=OBJECT_ID(N'scheduling.update_schedules',N'U')
      AND name=N'CK_schedules_manual_environment' AND is_disabled=0 AND is_not_trusted=0)
    THROW 57002,N'Manual schedule environment constraint is not enforced.',1;
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
