/* Optional lifecycle gate: one exact, independently reviewed 044 approval. No impersonation. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns077 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns077=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS (SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150 AND is_read_only=0)
    THROW 57700,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock077 int;
  EXEC @lock077=sys.sp_getapplock @Resource=N'portal-sag:migration:077:consume-copy-review',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock077<0 THROW 57701,N'Could not reserve the copy review migration lock.',1;
  IF OBJECT_ID(N'migration.catalog_schedule_copy_review_receipts',N'U') IS NULL
    OR OBJECT_ID(N'migration.v_catalog_schedule_copy_review_state',N'V') IS NULL
    OR NOT EXISTS(SELECT 1 FROM sys.database_permissions p WHERE p.class=3 AND p.major_id=SCHEMA_ID(N'migration')
      AND p.permission_name=N'INSERT' AND p.state='D' AND p.grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime'))
    OR NOT EXISTS(SELECT 1 FROM sys.database_permissions p WHERE p.class=1
      AND p.major_id=OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U')
      AND p.permission_name=N'INSERT' AND p.state='D' AND p.grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime'))
    THROW 57702,N'Expected review receipts and both existing direct-write denials.',1;

  IF OBJECT_ID(N'migration.catalog_schedule_copy_review_uses',N'U') IS NULL
    CREATE TABLE migration.catalog_schedule_copy_review_uses (
      proposal_id uniqueidentifier NOT NULL PRIMARY KEY REFERENCES scheduling.catalog_schedule_copy_proposals(proposal_id),
      review_id uniqueidentifier NOT NULL UNIQUE REFERENCES migration.catalog_schedule_copy_review_receipts(review_id),
      copy_schedule_key bigint NOT NULL UNIQUE REFERENCES scheduling.update_schedules(schedule_key),
      copy_version binary(8) NOT NULL,
      consumed_at datetime2(3) NOT NULL
    );

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.consume_catalog_schedule_copy_review
    @environment varchar(10), @proposal uniqueidentifier, @review uniqueidentifier,
    @copyVersion binary(8)
  AS
  BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    DECLARE @now datetime2(3)=SYSUTCDATETIME(),@copy bigint,@original bigint,@reviewer bigint,@until datetime2(3),
      @operation nvarchar(200),@approvalAt datetime2(3),@created datetime2(3),@requestedDate date;
    IF ISNULL(IS_ROLEMEMBER(N''portal_runtime''),0)<>1 OR ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>0
      OR @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
      OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
      OR @proposal IS NULL OR @review IS NULL OR @copyVersion IS NULL
      OR NOT ((@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2 AND DB_NAME()=N''PortalSAGWeb-TEST'')
        OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10 AND DB_NAME()=N''PortalSAGWeb''))
      THROW 57703,N''Expected the Portal copy transaction and exact review.'',1;
    IF EXISTS (SELECT 1 FROM migration.catalog_schedule_copy_review_uses WITH (UPDLOCK,HOLDLOCK)
      WHERE proposal_id=@proposal OR review_id=@review) THROW 57704,N''This copy review has already been consumed.'',1;

    SELECT @copy=s.schedule_key,@original=o.schedule_key,@reviewer=r.reviewer_key,@until=r.expires_at,
      @operation=p.operation_id,@created=s.created_at,@requestedDate=p.requested_date
    FROM migration.catalog_schedule_copy_review_receipts r WITH (UPDLOCK,HOLDLOCK)
    JOIN scheduling.catalog_schedule_copy_proposals p WITH (HOLDLOCK) ON p.proposal_id=r.proposal_id AND p.request_sha256=r.request_sha256
    JOIN migration.v_catalog_schedule_copy_review_state proof ON proof.proposal_id=p.proposal_id
      AND proof.reviewed_state_sha256=r.reviewed_state_sha256
    JOIN scheduling.update_schedules o WITH (HOLDLOCK) ON o.schedule_key=p.original_schedule_key
      AND o.row_version=p.original_definition_version AND o.active=1 AND o.deleted_at IS NULL
    JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK) ON a.schedule_key=o.schedule_key
      AND a.schedule_version=o.row_version AND a.portal_environment=p.portal_environment AND a.operation_id=p.operation_id
      AND a.retired_at IS NULL AND a.approved_at<=@now
    JOIN security.users approver WITH (HOLDLOCK) ON approver.user_key=r.reviewer_key AND approver.active=1
    JOIN security.users requester WITH (HOLDLOCK) ON requester.active=1
      AND requester.source_id COLLATE Latin1_General_100_BIN2=p.requester_source_id
      AND DATALENGTH(requester.source_id)=DATALENGTH(p.requester_source_id) AND requester.user_key<>approver.user_key
    JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=approver.user_key AND ur.role_id=N''super_admin''
    JOIN security.roles active_role WITH (HOLDLOCK) ON active_role.role_id=ur.role_id
      AND active_role.active=1 AND active_role.system_role=1 AND active_role.protected_role=1
    JOIN scheduling.catalog_schedule_copy_intents i WITH (HOLDLOCK) ON i.intent_id=p.proposal_id AND i.portal_environment=p.portal_environment
      AND i.original_schedule_key=p.original_schedule_key AND i.original_definition_version=p.original_definition_version
      AND i.operation_id=p.operation_id AND i.actor_source_id=p.requester_source_id
    JOIN scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK) ON s.schedule_key=i.copy_schedule_key AND s.row_version=@copyVersion
      AND s.source_id COLLATE Latin1_General_100_BIN2=N''catalog-copy-''+LOWER(CONVERT(nvarchar(36),p.proposal_id))
      AND DATALENGTH(s.source_id)=98 AND s.active=1 AND s.deleted_at IS NULL AND s.catalog_activation_enabled=1
      AND s.name COLLATE Latin1_General_100_BIN2=p.requested_name COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(s.name)=DATALENGTH(p.requested_name) AND s.start_date=p.requested_date AND s.end_date IS NULL
      AND s.frequency_type=''once'' AND s.selection_mode=''manual'' AND s.origin=N''special''
      AND s.timezone COLLATE Latin1_General_100_BIN2=N''America/Bogota'' AND DATALENGTH(s.timezone)=28
      AND s.every_n_weeks IS NULL AND s.interval_days IS NULL AND s.day_of_month IS NULL AND s.manual_environment IS NULL
      AND s.domain_key IS NULL AND s.domain_name_snapshot IS NULL AND s.database_reminder_recipients_mode IS NULL
      AND s.notes IS NULL AND s.completed_at IS NULL AND s.completed_reason IS NULL AND s.deleted_by IS NULL
      AND s.created_at=s.updated_at AND s.created_at BETWEEN r.reviewed_at AND @now
      AND s.created_by COLLATE Latin1_General_100_BIN2=p.requester_source_id AND s.updated_by COLLATE Latin1_General_100_BIN2=p.requester_source_id
      AND DATALENGTH(s.created_by)=DATALENGTH(p.requester_source_id) AND DATALENGTH(s.updated_by)=DATALENGTH(p.requester_source_id)
    WHERE r.review_id=@review AND r.proposal_id=@proposal AND p.portal_environment=@environment COLLATE Latin1_General_100_BIN2
      AND p.requested_date>=CONVERT(date,DATEADD(hour,-5,@now)) AND r.reviewed_at<=@now AND r.expires_at>@now;
    IF @copy IS NULL THROW 57705,N''The independent review or copy definition no longer matches.'',1;

    IF NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_proposal_links WITH (HOLDLOCK) WHERE proposal_id=@proposal)
      OR EXISTS(SELECT link_id,kind,physical_target_id FROM scheduling.catalog_schedule_copy_proposal_links WITH (HOLDLOCK) WHERE proposal_id=@proposal
        EXCEPT SELECT link_id,target_kind,verified_target_id FROM scheduling.catalog_schedule_copy_links WITH (HOLDLOCK) WHERE copy_schedule_key=@copy)
      OR EXISTS(SELECT link_id,target_kind,verified_target_id FROM scheduling.catalog_schedule_copy_links WITH (HOLDLOCK) WHERE copy_schedule_key=@copy
        EXCEPT SELECT link_id,kind,physical_target_id FROM scheduling.catalog_schedule_copy_proposal_links WITH (HOLDLOCK) WHERE proposal_id=@proposal)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_weekdays WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_targets WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT 1 FROM scheduling.scope_groups WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT 1 FROM scheduling.licensing_scope WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_reminder_settings WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_reminder_days WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_reminder_emails WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_snapshots WITH (HOLDLOCK) WHERE schedule_key=@copy)
      THROW 57706,N''Copy targets or ancillary data differ from the approved request.'',1;

    DECLARE @scoped bit=CASE WHEN EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_links WITH (HOLDLOCK) WHERE copy_schedule_key=@original)
      OR EXISTS(SELECT 1 FROM scheduling.v_catalog_schedule_draft_approval a WITH (HOLDLOCK)
        JOIN scheduling.update_schedules d WITH (HOLDLOCK) ON d.schedule_key=a.schedule_key AND d.row_version=a.schedule_version
        WHERE a.schedule_key=@original AND a.manual_selection=1)
      OR EXISTS(SELECT 1 FROM scheduling.licensing_scope ls WITH (HOLDLOCK)
        JOIN scheduling.update_schedules original WITH (HOLDLOCK) ON original.schedule_key=ls.schedule_key
          AND original.selection_mode=''licensing'' WHERE ls.schedule_key=@original)
      OR EXISTS(SELECT 1 FROM scheduling.scope_groups WITH (HOLDLOCK) WHERE schedule_key=@original) THEN 1 ELSE 0 END;
    DECLARE @kinds table(kind varchar(8) PRIMARY KEY,source_lane varchar(20),destination_lane varchar(20),
      role_id nvarchar(80),mode varchar(10));
    INSERT @kinds
    SELECT chosen.kind,CASE WHEN @scoped=1 AND chosen.kind=''database'' THEN ''database'' ELSE ''general'' END,
      CASE WHEN chosen.kind=''database'' THEN ''database'' ELSE ''general'' END,
      CASE WHEN @scoped=0 THEN o.assigned_role WHEN chosen.kind=''database'' THEN COALESCE(o.database_assigned_role,N''database_updater'')
        ELSE COALESCE(o.domain_assigned_role,N''domain_updater'') END,
      CASE WHEN o.assignment_mode=''users'' OR (@scoped=0 AND EXISTS(
        SELECT 1 FROM scheduling.schedule_assignees WITH (HOLDLOCK) WHERE schedule_key=@original AND assignment_kind=''general''))
        THEN ''users'' ELSE ''role'' END
    FROM (SELECT DISTINCT kind FROM scheduling.catalog_schedule_copy_proposal_links WITH (HOLDLOCK) WHERE proposal_id=@proposal) chosen
    JOIN scheduling.update_schedules o WITH (HOLDLOCK) ON o.schedule_key=@original;
    DECLARE @domainRole nvarchar(80)=(SELECT role_id FROM @kinds WHERE kind=''domain''),
      @dbRole nvarchar(80)=(SELECT role_id FROM @kinds WHERE kind=''database'');
    DECLARE @mode varchar(10)=(SELECT MIN(mode) FROM @kinds);
    IF @mode IS NULL OR EXISTS(SELECT 1 FROM @kinds WHERE mode<>@mode OR LEN(role_id)=0)
      OR NOT EXISTS(SELECT 1 FROM scheduling.update_schedules s WITH (HOLDLOCK)
        WHERE s.schedule_key=@copy AND s.assignment_mode=@mode
          AND s.assigned_role COLLATE Latin1_General_100_BIN2=COALESCE(@domainRole,@dbRole) COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(s.assigned_role)=DATALENGTH(COALESCE(@domainRole,@dbRole))
          AND NOT EXISTS(SELECT s.domain_assigned_role COLLATE Latin1_General_100_BIN2,DATALENGTH(s.domain_assigned_role)
            EXCEPT SELECT @domainRole COLLATE Latin1_General_100_BIN2,DATALENGTH(@domainRole))
          AND NOT EXISTS(SELECT s.database_assigned_role COLLATE Latin1_General_100_BIN2,DATALENGTH(s.database_assigned_role)
            EXCEPT SELECT @dbRole COLLATE Latin1_General_100_BIN2,DATALENGTH(@dbRole))
          AND s.target_type=CASE WHEN @domainRole IS NULL THEN ''database'' ELSE ''domain'' END
          AND s.manual_target_types=CASE WHEN @domainRole IS NULL THEN ''databases_only'' WHEN @dbRole IS NULL THEN ''domains_only'' ELSE ''domains_and_databases'' END
          AND EXISTS(SELECT 1 FROM core.clients c WITH (HOLDLOCK)
            WHERE c.client_key=s.client_key AND c.client_key=(
              SELECT TOP (1) ol.client_key FROM scheduling.catalog_schedule_copy_proposal_links cp WITH (HOLDLOCK)
              JOIN core.catalog_operational_links ol WITH (HOLDLOCK) ON ol.link_id=cp.link_id
              WHERE cp.proposal_id=@proposal ORDER BY ol.link_key)
              AND c.status=''active'' AND c.deleted_at IS NULL
              AND s.client_name_snapshot COLLATE Latin1_General_100_BIN2=c.name COLLATE Latin1_General_100_BIN2
              AND DATALENGTH(s.client_name_snapshot)=DATALENGTH(c.name)))
      THROW 57707,N''The copy roles do not match the reviewed origin.'',1;
    DECLARE @users table(lane varchar(20), user_key bigint, PRIMARY KEY(lane,user_key));
    INSERT @users SELECT k.destination_lane,a.user_key FROM @kinds k
      JOIN scheduling.schedule_assignees a WITH (HOLDLOCK) ON a.schedule_key=@original AND a.assignment_kind=k.source_lane WHERE k.mode=''users'';
    IF EXISTS(SELECT 1 FROM @kinds k WHERE k.mode=''users'' AND
        (SELECT COUNT(*) FROM @users u WHERE u.lane=k.destination_lane) NOT BETWEEN 1 AND 100)
      OR EXISTS(SELECT 1 FROM @users u LEFT JOIN security.users usr WITH (HOLDLOCK) ON usr.user_key=u.user_key AND usr.active=1
        WHERE usr.user_key IS NULL)
      OR EXISTS(SELECT lane,user_key FROM @users EXCEPT SELECT assignment_kind,user_key FROM scheduling.schedule_assignees WITH (HOLDLOCK) WHERE schedule_key=@copy)
      OR EXISTS(SELECT assignment_kind,user_key FROM scheduling.schedule_assignees WITH (HOLDLOCK) WHERE schedule_key=@copy EXCEPT SELECT lane,user_key FROM @users)
      THROW 57708,N''The copy assignees do not match the reviewed origin.'',1;

    IF @until<=SYSUTCDATETIME() THROW 57709,N''The review expired before approval.'',1;
    INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
    VALUES (@environment,@copy,@copyVersion,@operation,@reviewer);
    SELECT @approvalAt=approved_at FROM scheduling.catalog_schedule_operation_approvals WITH (HOLDLOCK)
      WHERE portal_environment=@environment AND schedule_key=@copy AND schedule_version=@copyVersion
        AND operation_id=@operation AND approved_by=@reviewer AND retired_at IS NULL;
    IF @approvalAt IS NULL OR @approvalAt<@created OR @approvalAt>=@until
      OR @requestedDate<CONVERT(date,DATEADD(hour,-5,@approvalAt))
      THROW 57709,N''The real SQL approval did not land inside the review window.'',1;
    INSERT migration.catalog_schedule_copy_review_uses(proposal_id,review_id,copy_schedule_key,copy_version,consumed_at)
    VALUES (@proposal,@review,@copy,@copyVersion,@approvalAt);
    SELECT @approvalAt AS approvedAt,@until AS validUntil;
  END;';
  DECLARE @objects077 table(object_id int);
  INSERT @objects077 VALUES(OBJECT_ID(N'settings.consume_catalog_schedule_copy_review',N'P')),
    (OBJECT_ID(N'migration.catalog_schedule_copy_review_receipts',N'U')),
    (OBJECT_ID(N'migration.v_catalog_schedule_copy_review_state',N'V')),
    (OBJECT_ID(N'migration.catalog_schedule_copy_review_uses',N'U')),
    (OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U'));
  IF EXISTS(SELECT 1 FROM @objects077 expected LEFT JOIN sys.objects obj ON obj.object_id=expected.object_id
    LEFT JOIN sys.schemas sc ON sc.schema_id=obj.schema_id
    WHERE obj.object_id IS NULL OR COALESCE(obj.principal_id,sc.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 57710,N'The static owner chain for the restricted approval is incomplete.',1;
  GRANT EXECUTE ON OBJECT::settings.consume_catalog_schedule_copy_review TO portal_runtime;
  IF @owns077=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns077=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
