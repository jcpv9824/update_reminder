/*
  Reviewed operation identity for one exact schedule version in one Portal
  environment. Schedule labels, notes, and customer data are not evidence.
  No approvals or roles are seeded. Runtime may read existing approvals but
  is explicitly denied writes on this new table.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns044Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns044Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock044 int;
  EXEC @lock044=sys.sp_getapplock @Resource=N'portal-sag:migration:044:schedule-operation-approvals',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock044<0 THROW 54400,N'Could not reserve the schedule approval migration lock.',1;

  IF OBJECT_ID(N'scheduling.update_schedules',N'U') IS NULL OR OBJECT_ID(N'security.users',N'U') IS NULL
    OR OBJECT_ID(N'security.user_roles',N'U') IS NULL OR OBJECT_ID(N'security.roles',N'U') IS NULL
    THROW 54400,N'Install scheduling and security before creating schedule operation approvals.',1;

  IF OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_schedule_operation_approvals
    (
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      schedule_key bigint NOT NULL,
      schedule_version binary(8) NOT NULL,
      operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
      approved_by bigint NOT NULL,
      approved_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_schedule_operation_approvals_at DEFAULT SYSUTCDATETIME(),
      retired_at datetime2(3) NULL,

      CONSTRAINT PK_catalog_schedule_operation_approvals PRIMARY KEY CLUSTERED(portal_environment,schedule_key,schedule_version),
      CONSTRAINT FK_catalog_schedule_operation_approvals_schedule FOREIGN KEY(schedule_key)
        REFERENCES scheduling.update_schedules(schedule_key),
      CONSTRAINT FK_catalog_schedule_operation_approvals_approver FOREIGN KEY(approved_by)
        REFERENCES security.users(user_key),
      CONSTRAINT CK_catalog_schedule_operation_approvals_environment CHECK (
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_schedule_operation_approvals_id CHECK (
        operation_id LIKE N'[A-Za-z0-9]%' AND operation_id NOT LIKE N'%[^A-Za-z0-9._:-]%'
        AND DATALENGTH(operation_id)=2*LEN(operation_id)),
      CONSTRAINT CK_catalog_schedule_operation_approvals_retirement CHECK (retired_at IS NULL OR retired_at>=approved_at)
    );
  END;

  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_operation_approvals_register',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_operation_approvals_register
      ON scheduling.catalog_schedule_operation_approvals INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM inserted WHERE retired_at IS NOT NULL)
        THROW 54401,N''A schedule operation cannot be approved as already retired.'',1;
      IF EXISTS (
        SELECT 1 FROM inserted n WHERE NOT EXISTS (
          SELECT 1 FROM scheduling.update_schedules s WITH (HOLDLOCK)
          JOIN security.users u WITH (HOLDLOCK) ON u.user_key=n.approved_by AND u.active=1
          JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key AND ur.role_id=N''super_admin''
          JOIN security.roles role_record WITH (HOLDLOCK) ON role_record.role_id=ur.role_id AND role_record.active=1
            AND role_record.system_role=1 AND role_record.protected_role=1
          WHERE s.schedule_key=n.schedule_key AND s.row_version=n.schedule_version AND s.active=1 AND s.deleted_at IS NULL
        )
      )
        THROW 54402,N''Approval requires the current exact active schedule and an active superadministrator.'',1;

      DECLARE @approvedAt datetime2(3)=SYSUTCDATETIME();
      INSERT scheduling.catalog_schedule_operation_approvals(
        portal_environment,schedule_key,schedule_version,operation_id,approved_by,approved_at)
      SELECT portal_environment,schedule_key,schedule_version,operation_id,approved_by,@approvedAt FROM inserted;
    END;';

  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_operation_approvals_retire',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_operation_approvals_retire
      ON scheduling.catalog_schedule_operation_approvals INSTEAD OF UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (
        SELECT 1 FROM deleted o LEFT JOIN inserted n ON n.portal_environment=o.portal_environment
          AND n.schedule_key=o.schedule_key AND n.schedule_version=o.schedule_version
        WHERE n.schedule_key IS NULL OR o.retired_at IS NOT NULL OR n.retired_at IS NULL
          OR EXISTS (
            SELECT n.operation_id,n.approved_by,n.approved_at,DATALENGTH(n.portal_environment),DATALENGTH(n.operation_id)
            EXCEPT
            SELECT o.operation_id,o.approved_by,o.approved_at,DATALENGTH(o.portal_environment),DATALENGTH(o.operation_id))
      )
        THROW 54403,N''A schedule operation approval is immutable except for one-time retirement.'',1;

      DECLARE @retiredAt datetime2(3)=SYSUTCDATETIME();
      UPDATE o SET retired_at=@retiredAt
      FROM scheduling.catalog_schedule_operation_approvals o
      JOIN inserted n ON n.portal_environment=o.portal_environment
        AND n.schedule_key=o.schedule_key AND n.schedule_version=o.schedule_version
      WHERE o.retired_at IS NULL;
      IF @@ROWCOUNT<>(SELECT COUNT_BIG(*) FROM inserted)
        THROW 54403,N''A schedule operation approval was already retired.'',1;
    END;';

  IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
    DENY INSERT,UPDATE,DELETE ON OBJECT::scheduling.catalog_schedule_operation_approvals TO portal_runtime;

  IF @owns044Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns044Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
