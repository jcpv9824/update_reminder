/*
  Keep 044 immutable. SQL Server 2019 does not accept the trailing hyphen in
  that LIKE character set as a literal. Remove literal ASCII hyphens only for
  the allowed-character test while retaining the original leading and exact
  length checks. Do not copy, rewrite or retire any existing approvals.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns045Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns045Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock045 int;
  EXEC @lock045=sys.sp_getapplock @Resource=N'portal-sag:migration:045:schedule-operation-token-check',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock045<0 THROW 54500,N'Could not reserve the schedule operation token migration lock.',1;
  DECLARE @table045 int=OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U'),@definition045 nvarchar(max);
  -- Canonical definitions emitted by sys.check_constraints on SQL Server 2019.
  DECLARE @old045 nvarchar(max)=N'([operation_id] like N''[A-Za-z0-9]%'' AND NOT [operation_id] like N''%[^A-Za-z0-9._:-]%'' AND datalength([operation_id])=(2)*len([operation_id]))';
  DECLARE @new045 nvarchar(max)=N'([operation_id] like N''[A-Za-z0-9]%'' AND NOT replace([operation_id],N''-'',N'''') like N''%[^A-Za-z0-9._:]%'' AND datalength([operation_id])=(2)*len([operation_id]))';
  SELECT @definition045=definition FROM sys.check_constraints
  WHERE parent_object_id=@table045 AND name=N'CK_catalog_schedule_operation_approvals_id' AND is_disabled=0 AND is_not_trusted=0;
  IF @table045 IS NULL OR @definition045 IS NULL
    THROW 54501,N'The trusted schedule operation token constraint from 044 is missing.',1;

  IF @definition045 COLLATE Latin1_General_100_BIN2=@old045 COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(@definition045)=DATALENGTH(@old045)
  BEGIN
    ALTER TABLE scheduling.catalog_schedule_operation_approvals DROP CONSTRAINT CK_catalog_schedule_operation_approvals_id;
    ALTER TABLE scheduling.catalog_schedule_operation_approvals WITH CHECK ADD CONSTRAINT CK_catalog_schedule_operation_approvals_id CHECK (
      operation_id LIKE N'[A-Za-z0-9]%' AND REPLACE(operation_id,N'-',N'') NOT LIKE N'%[^A-Za-z0-9._:]%'
      AND DATALENGTH(operation_id)=2*LEN(operation_id));
  END;
  ELSE IF @definition045 COLLATE Latin1_General_100_BIN2<>@new045 COLLATE Latin1_General_100_BIN2
    OR DATALENGTH(@definition045)<>DATALENGTH(@new045)
    THROW 54502,N'The schedule operation token constraint is not a reviewed definition.',1;
  IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id=@table045
    AND name=N'CK_catalog_schedule_operation_approvals_id' AND is_disabled=0 AND is_not_trusted=0
    AND definition COLLATE Latin1_General_100_BIN2=@new045 COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(definition)=DATALENGTH(@new045))
    THROW 54503,N'The corrected schedule operation token constraint is not trusted.',1;
  IF @owns045Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns045Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
