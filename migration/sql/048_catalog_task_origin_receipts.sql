/*
  Append-only evidence that another logical origin was verified for an
  existing execution. A receipt is not an execution link, an assignment,
  a visibility grant, an access-profile selector, or a lifecycle event.
  The app independently proves logical/physical identity and licensing.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns048Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns048Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock048 int;
  EXEC @lock048=sys.sp_getapplock @Resource=N'portal-sag:migration:048:task-origin-receipts',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock048<0 THROW 54800,N'Could not reserve the task origin receipt migration lock.',1;

  IF OBJECT_ID(N'workflow.catalog_task_executions',N'U') IS NULL
    OR OBJECT_ID(N'workflow.catalog_task_execution_links',N'U') IS NULL
    OR OBJECT_ID(N'workflow.update_tasks',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_operational_links',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_operational_link_evidence',N'V') IS NULL
    OR OBJECT_ID(N'core.catalog_physical_targets',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_physical_target_links',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.update_schedules',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
    THROW 54801,N'Install execution, operational and physical evidence, and versioned schedule approvals before origin receipts.',1;

  IF OBJECT_ID(N'workflow.catalog_task_origin_receipts',N'U') IS NULL
  BEGIN
    CREATE TABLE workflow.catalog_task_origin_receipts
    (
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      catalog_execution_key bigint NOT NULL,
      link_key bigint NOT NULL,
      schedule_key bigint NOT NULL,
      schedule_version binary(8) NOT NULL,
      valid_until datetime2(3) NOT NULL,
      received_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_task_origin_receipts_at DEFAULT SYSUTCDATETIME(),

      CONSTRAINT PK_catalog_task_origin_receipts PRIMARY KEY CLUSTERED(catalog_execution_key,link_key,schedule_key,schedule_version),
      CONSTRAINT FK_catalog_task_origin_receipts_execution FOREIGN KEY(catalog_execution_key)
        REFERENCES workflow.catalog_task_executions(catalog_execution_key),
      CONSTRAINT FK_catalog_task_origin_receipts_link FOREIGN KEY(link_key)
        REFERENCES core.catalog_operational_links(link_key),
      CONSTRAINT FK_catalog_task_origin_receipts_schedule FOREIGN KEY(schedule_key)
        REFERENCES scheduling.update_schedules(schedule_key),
      CONSTRAINT CK_catalog_task_origin_receipts_environment CHECK (
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_task_origin_receipts_expiry CHECK (valid_until>received_at)
    );
  END;

  IF OBJECT_ID(N'workflow.TR_catalog_task_origin_receipts_register',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER workflow.TR_catalog_task_origin_receipts_register
      ON workflow.catalog_task_origin_receipts INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @checkedAt datetime2(3)=SYSUTCDATETIME();
      IF EXISTS (
        SELECT 1 FROM inserted n WHERE NOT EXISTS (
          SELECT 1
          FROM workflow.catalog_task_executions e WITH (HOLDLOCK)
          JOIN workflow.update_tasks t WITH (HOLDLOCK) ON t.task_key=e.task_key AND t.status<>''cancelled''
          JOIN core.catalog_physical_targets target WITH (HOLDLOCK)
            ON target.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id)
            AND DATALENGTH(e.verified_target_id)=72
            AND target.portal_environment=n.portal_environment
            AND target.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2
          JOIN core.catalog_operational_link_evidence l WITH (HOLDLOCK)
            ON l.link_key=n.link_key AND l.portal_environment=target.portal_environment
            AND l.target_kind=target.target_kind AND l.evidence_state=''verified''
            AND l.verified_until>=n.valid_until
          JOIN core.catalog_physical_target_links p WITH (HOLDLOCK)
            ON p.physical_target_key=target.physical_target_key AND p.portal_environment=target.portal_environment
            AND p.target_kind=target.target_kind AND p.client_key=l.client_key AND p.domain_key=l.domain_key
            AND (p.database_key=l.database_key OR (p.database_key IS NULL AND l.database_key IS NULL))
            AND p.retired_at IS NULL AND p.verified_at<=@checkedAt AND p.registered_at<=@checkedAt
            AND p.valid_until>=n.valid_until
          JOIN scheduling.update_schedules s WITH (HOLDLOCK)
            ON s.schedule_key=n.schedule_key AND s.row_version=n.schedule_version
            AND s.active=1 AND s.deleted_at IS NULL AND t.task_date>=s.start_date
            AND (s.end_date IS NULL OR t.task_date<=s.end_date)
          JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK)
            ON a.portal_environment=target.portal_environment AND a.schedule_key=s.schedule_key
            AND a.schedule_version=s.row_version AND a.operation_id=e.operation_id
            AND DATALENGTH(a.operation_id)=DATALENGTH(e.operation_id)
            AND a.retired_at IS NULL AND a.approved_at<=@checkedAt
          WHERE e.catalog_execution_key=n.catalog_execution_key AND e.retired_at IS NULL
            AND e.cutoff_at>@checkedAt AND n.valid_until>@checkedAt
            -- A previously attached alias is never reclassified as accounting.
            -- Include hidden and retired task links, not just its active set.
            AND NOT EXISTS (
              SELECT 1 FROM workflow.catalog_task_execution_links attached WITH (HOLDLOCK)
              WHERE attached.catalog_execution_key=e.catalog_execution_key
                AND DATALENGTH(attached.link_id)=72
                AND TRY_CONVERT(uniqueidentifier,attached.link_id)=l.link_id
            )
        )
      )
        THROW 54802,N''An origin receipt requires current evidence for the same execution, target, operation and schedule version.'',1;

      -- Sample the SQL clock again after obtaining dependency locks. Retain
      -- accounting on an already-completed, unretired execution only before cutoff.
      DECLARE @receivedAt datetime2(3)=SYSUTCDATETIME();
      IF EXISTS (
        SELECT 1 FROM inserted n JOIN workflow.catalog_task_executions e ON e.catalog_execution_key=n.catalog_execution_key
        WHERE n.valid_until<=@receivedAt OR e.cutoff_at<=@receivedAt
      )
        THROW 54803,N''The origin receipt deadline or execution cutoff has passed.'',1;

      INSERT workflow.catalog_task_origin_receipts(
        portal_environment,catalog_execution_key,link_key,schedule_key,schedule_version,valid_until,received_at)
      SELECT portal_environment,catalog_execution_key,link_key,schedule_key,schedule_version,valid_until,@receivedAt FROM inserted;
    END;';

  IF OBJECT_ID(N'workflow.TR_catalog_task_origin_receipts_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER workflow.TR_catalog_task_origin_receipts_immutable
      ON workflow.catalog_task_origin_receipts AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted)
        THROW 54804,N''Catalog task origin receipts are append-only.'',1;
    END;';

  IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
    DENY UPDATE,DELETE ON OBJECT::workflow.catalog_task_origin_receipts TO portal_runtime;

  IF @owns048Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns048Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
