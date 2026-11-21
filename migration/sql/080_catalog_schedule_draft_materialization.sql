/* Atomically bind a reviewed draft, new schedule version, and its exact operation approval. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns080 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns080=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
    OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS (SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150 AND is_read_only=0)
    THROW 58000,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock080 int;
  EXEC @lock080=sys.sp_getapplock @Resource=N'portal-sag:migration:080:draft-materialization',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock080<0 THROW 58001,N'Could not reserve the draft materialization migration lock.',1;
  IF OBJECT_ID(N'migration.catalog_schedule_draft_review_receipts',N'U') IS NULL
    OR OBJECT_ID(N'migration.v_catalog_schedule_draft_review_state',N'V') IS NULL
    OR OBJECT_ID(N'scheduling.v_catalog_schedule_draft_approval',N'V') IS NULL
    OR OBJECT_ID(N'scheduling.v_catalog_schedule_draft_pins',N'V') IS NULL
    OR NOT EXISTS(SELECT 1 FROM sys.database_permissions p WHERE p.class=3 AND p.major_id=SCHEMA_ID(N'migration')
      AND p.permission_name=N'INSERT' AND p.state='D' AND p.grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime'))
    THROW 58002,N'Expected independent receipts and existing migration-schema denial.',1;

  IF OBJECT_ID(N'migration.catalog_schedule_draft_uses',N'U') IS NULL
    CREATE TABLE migration.catalog_schedule_draft_uses (
      proposal_id uniqueidentifier NOT NULL PRIMARY KEY REFERENCES scheduling.catalog_schedule_draft_proposals(proposal_id),
      review_id uniqueidentifier NOT NULL UNIQUE REFERENCES migration.catalog_schedule_draft_review_receipts(review_id),
      schedule_key bigint NOT NULL UNIQUE,
      schedule_version binary(8) NOT NULL,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      approved_at datetime2(3) NOT NULL,
      manual_selection bit NOT NULL,
      FOREIGN KEY(portal_environment,schedule_key,schedule_version)
        REFERENCES scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version)
    );
  IF OBJECT_ID(N'migration.catalog_schedule_draft_manual_pins',N'U') IS NULL
    CREATE TABLE migration.catalog_schedule_draft_manual_pins (
      schedule_key bigint NOT NULL REFERENCES migration.catalog_schedule_draft_uses(schedule_key),
      link_id uniqueidentifier NOT NULL REFERENCES core.catalog_operational_links(link_id),
      target_kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(target_kind IN ('domain','database')),
      verified_target_id uniqueidentifier NOT NULL REFERENCES core.catalog_physical_targets(target_id),
      PRIMARY KEY(schedule_key,link_id)
    );

  -- Read projections only: no runtime writes through the scheduling schema.
  -- Do not project receipt IDs, approvers, or review fingerprints.
  EXEC sys.sp_executesql N'CREATE OR ALTER VIEW scheduling.v_catalog_schedule_draft_approval AS
    SELECT DISTINCT u.schedule_key,u.schedule_version,u.portal_environment,u.proposal_id,u.approved_at,u.manual_selection,a.operation_id
    FROM migration.catalog_schedule_draft_uses u
    JOIN scheduling.catalog_schedule_operation_approvals a ON a.schedule_key=u.schedule_key
      AND a.schedule_version=u.schedule_version AND a.portal_environment=u.portal_environment;';
  EXEC sys.sp_executesql N'CREATE OR ALTER VIEW scheduling.v_catalog_schedule_draft_pins AS
    SELECT DISTINCT pin.schedule_key,pin.link_id,pin.target_kind,pin.verified_target_id
    FROM migration.catalog_schedule_draft_manual_pins pin;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.materialize_catalog_schedule_draft_review
    @environment varchar(10), @proposal uniqueidentifier, @review uniqueidentifier, @version binary(8)
  AS
  BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF ISNULL(IS_ROLEMEMBER(N''portal_runtime''),0)<>1 OR ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>0
      OR @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
      OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
      OR @proposal IS NULL OR @review IS NULL OR @version IS NULL
      OR NOT ((@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2 AND DB_NAME()=N''PortalSAGWeb-TEST'')
        OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10 AND DB_NAME()=N''PortalSAGWeb''))
      THROW 58003,N''Expected the exact Portal draft transaction.'',1;
    IF EXISTS(SELECT 1 FROM migration.catalog_schedule_draft_uses WITH (UPDLOCK,HOLDLOCK)
      WHERE proposal_id=@proposal OR review_id=@review)
      THROW 58004,N''Draft or review already used.'',1;

    DECLARE @now datetime2(3)=SYSUTCDATETIME(),@approvedAt datetime2(3),@until datetime2(3),
      @key bigint,@reviewer bigint,@operation nvarchar(200),@requestedDate date,@frequency varchar(10),
      @mode varchar(10),@target varchar(8),@types varchar(40),@targetEnv varchar(10),
      @module bigint,@domainRole nvarchar(80),@databaseRole nvarchar(80),@assignment varchar(8),
      @catalogCustomer uniqueidentifier,@domainChoice binary(32);
    SELECT @key=s.schedule_key,@reviewer=r.reviewer_key,@operation=r.operation_id,@until=r.expires_at,
      @requestedDate=p.requested_date,@frequency=p.frequency_type,@mode=p.selection_mode,@target=p.target_type,
      @targetEnv=p.target_environment,@module=p.license_module_key,@domainRole=p.domain_role,@databaseRole=p.database_role,
      @catalogCustomer=p.catalog_customer_id,@domainChoice=p.domain_choice_hash,
      @assignment=p.assignment_mode,@types=CASE p.target_type WHEN ''domain'' THEN ''domains_only''
        WHEN ''database'' THEN ''databases_only'' ELSE ''domains_and_databases'' END
    FROM migration.catalog_schedule_draft_review_receipts r WITH (UPDLOCK,HOLDLOCK)
    JOIN scheduling.catalog_schedule_draft_proposals p WITH (HOLDLOCK) ON p.proposal_id=r.proposal_id
      AND p.proposal_sha256=r.proposal_sha256
    JOIN migration.v_catalog_schedule_draft_review_state proof ON proof.proposal_id=p.proposal_id
      AND proof.reviewed_state_sha256=r.reviewed_state_sha256
    JOIN security.users requester WITH (HOLDLOCK) ON requester.active=1 AND requester.user_key<>r.reviewer_key
      AND requester.source_id COLLATE Latin1_General_100_BIN2=p.requester_source_id
      AND DATALENGTH(requester.source_id)=DATALENGTH(p.requester_source_id)
    JOIN scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
      ON s.source_id COLLATE Latin1_General_100_BIN2=N''catalog-draft-''+LOWER(CONVERT(nvarchar(36),p.proposal_id))
      AND DATALENGTH(s.source_id)=100 AND s.row_version=@version
      AND s.active=1 AND s.deleted_at IS NULL AND s.deleted_by IS NULL AND s.catalog_activation_enabled=1
      AND s.origin=N''special'' AND s.timezone COLLATE Latin1_General_100_BIN2=N''America/Bogota'' AND DATALENGTH(s.timezone)=28
      AND s.start_date=p.requested_date AND s.name COLLATE Latin1_General_100_BIN2=p.name COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(s.name)=DATALENGTH(p.name)
      AND s.frequency_type COLLATE Latin1_General_100_BIN2=p.frequency_type
      AND s.selection_mode COLLATE Latin1_General_100_BIN2=p.selection_mode
      AND s.target_type=CASE WHEN p.target_type=''database'' THEN ''database'' ELSE ''domain'' END
      AND s.manual_target_types=CASE WHEN p.selection_mode=''licensing'' OR p.target_type=''both'' THEN ''domains_and_databases''
        WHEN p.target_type=''domain'' THEN ''domains_only'' ELSE ''databases_only'' END
      AND s.assignment_mode COLLATE Latin1_General_100_BIN2=p.assignment_mode
      AND s.created_at=s.updated_at AND s.created_at BETWEEN r.reviewed_at AND @now
      AND s.created_by COLLATE Latin1_General_100_BIN2=p.requester_source_id
      AND s.updated_by COLLATE Latin1_General_100_BIN2=p.requester_source_id
      AND DATALENGTH(s.created_by)=DATALENGTH(p.requester_source_id) AND DATALENGTH(s.updated_by)=DATALENGTH(p.requester_source_id)
      AND s.notes IS NULL AND s.completed_at IS NULL AND s.completed_reason IS NULL AND s.database_reminder_recipients_mode IS NULL
      AND NOT EXISTS(SELECT s.end_date,s.every_n_weeks,s.interval_days,s.day_of_month,s.manual_environment COLLATE Latin1_General_100_BIN2,
        s.domain_assigned_role COLLATE Latin1_General_100_BIN2,DATALENGTH(s.domain_assigned_role),
        s.database_assigned_role COLLATE Latin1_General_100_BIN2,DATALENGTH(s.database_assigned_role),
        s.assigned_role COLLATE Latin1_General_100_BIN2,DATALENGTH(s.assigned_role)
        EXCEPT SELECT p.end_date,p.every_n_weeks,p.interval_days,p.day_of_month,
          CASE WHEN p.selection_mode=''manual'' THEN p.target_environment END,
          p.domain_role COLLATE Latin1_General_100_BIN2,DATALENGTH(p.domain_role),
          p.database_role COLLATE Latin1_General_100_BIN2,DATALENGTH(p.database_role),
          COALESCE(p.domain_role,p.database_role) COLLATE Latin1_General_100_BIN2,DATALENGTH(COALESCE(p.domain_role,p.database_role)))
    WHERE p.proposal_id=@proposal AND r.review_id=@review AND p.portal_environment=@environment COLLATE Latin1_General_100_BIN2
      AND p.requested_date>=CONVERT(date,DATEADD(hour,-5,@now)) AND r.reviewed_at<=@now AND r.expires_at>@now;
    IF @key IS NULL THROW 58005,N''The reviewed draft does not match this schedule version.'',1;

    DECLARE @pins table(link_id uniqueidentifier PRIMARY KEY, target_kind varchar(8),target_id uniqueidentifier,
      client_key bigint,domain_key bigint,database_key bigint NULL,included bit,valid_until datetime2(3));
    INSERT @pins
    SELECT l.link_id,l.target_kind,t.target_id,l.client_key,l.domain_key,l.database_key,x.included,physical.valid_until
    FROM scheduling.catalog_schedule_draft_proposal_links x WITH (HOLDLOCK)
    JOIN core.catalog_operational_links l WITH (HOLDLOCK) ON l.link_id=x.link_id AND l.target_kind=x.kind
      AND l.portal_environment=@environment AND l.retired_at IS NULL
      AND (@targetEnv=''all'' OR l.link_environment=@targetEnv)
    JOIN core.catalog_operational_owners owner_row WITH (HOLDLOCK) ON owner_row.owner_key=l.owner_key
      AND owner_row.client_key=l.client_key AND owner_row.portal_environment=l.portal_environment AND owner_row.retired_at IS NULL
    JOIN core.catalog_customer_ids customer_id WITH (HOLDLOCK) ON customer_id.catalog_customer_key=owner_row.catalog_customer_key
    JOIN core.domains domain_row WITH (HOLDLOCK) ON domain_row.domain_key=l.domain_key AND domain_row.client_key=l.client_key
      AND domain_row.status=''active'' AND domain_row.deleted_at IS NULL
    CROSS APPLY (SELECT LOWER(LTRIM(RTRIM(domain_row.domain_name)) COLLATE Latin1_General_100_BIN2) AS display) trimmed
    CROSS APPLY (SELECT CASE WHEN LEFT(trimmed.display,8)=N''https://'' THEN SUBSTRING(trimmed.display,9,500)
      ELSE trimmed.display END AS host) scheme
    CROSS APPLY (SELECT CASE WHEN RIGHT(scheme.host,1)=N''/'' THEN LEFT(scheme.host,LEN(scheme.host)-1)
      ELSE scheme.host END AS host) hostname
    JOIN core.catalog_physical_targets t WITH (HOLDLOCK) ON t.target_id=x.target_id AND t.target_kind=x.kind
      AND t.portal_environment=@environment
    JOIN core.catalog_physical_target_links physical WITH (HOLDLOCK)
      ON physical.physical_target_key=t.physical_target_key AND physical.target_kind=l.target_kind
      AND physical.portal_environment=l.portal_environment AND physical.client_key=l.client_key AND physical.domain_key=l.domain_key
      AND (physical.database_key=l.database_key OR (physical.database_key IS NULL AND l.database_key IS NULL))
      AND physical.retired_at IS NULL AND physical.verified_at<=@now AND physical.valid_until>@now
    WHERE x.proposal_id=@proposal AND (@target=''both'' OR x.kind=@target)
      AND (@mode=''licensing'' OR (customer_id.customer_id=@catalogCustomer
        AND (@domainChoice IS NULL OR @domainChoice=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),
          CONCAT(N''catalog-schedule-choice:domain:'',LOWER(CONVERT(char(36),@catalogCustomer)),N'':'',hostname.host,N'':'',l.link_environment))))));
    IF (SELECT COUNT(*) FROM @pins)<>(SELECT COUNT(*) FROM scheduling.catalog_schedule_draft_proposal_links WHERE proposal_id=@proposal)
      OR NOT EXISTS(SELECT 1 FROM @pins WHERE included=1)
      OR EXISTS(SELECT 1 FROM @pins omitted JOIN @pins kept ON kept.target_kind=omitted.target_kind AND kept.included=1
        AND ((kept.target_kind=''domain'' AND kept.domain_key=omitted.domain_key) OR kept.database_key=omitted.database_key)
        WHERE omitted.included=0)
      THROW 58006,N''A reviewed link expired or the exclusion would overlap a selected destination.'',1;
    DECLARE @owner bigint,@parent bigint;
    SELECT TOP(1) @owner=client_key,@parent=domain_key FROM @pins WHERE included=1
      ORDER BY LOWER(CONVERT(char(36),link_id)) COLLATE Latin1_General_100_BIN2;
    IF NOT EXISTS(SELECT 1 FROM scheduling.update_schedules s WITH (HOLDLOCK)
      JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=s.client_key AND c.status=''active'' AND c.deleted_at IS NULL
      JOIN core.domains d WITH (HOLDLOCK) ON d.domain_key=s.domain_key AND d.client_key=s.client_key AND d.status=''active'' AND d.deleted_at IS NULL
      WHERE s.schedule_key=@key AND s.client_key=@owner AND s.domain_key=@parent
        AND s.client_name_snapshot COLLATE Latin1_General_100_BIN2=c.name COLLATE Latin1_General_100_BIN2
        AND s.domain_name_snapshot COLLATE Latin1_General_100_BIN2=d.domain_name COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(s.client_name_snapshot)=DATALENGTH(c.name) AND DATALENGTH(s.domain_name_snapshot)=DATALENGTH(d.domain_name))
      OR EXISTS(SELECT 1 FROM scheduling.schedule_targets WITH (HOLDLOCK) WHERE schedule_key=@key)
      OR EXISTS(SELECT 1 FROM scheduling.scope_groups WITH (HOLDLOCK) WHERE schedule_key=@key)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_reminder_settings WITH (HOLDLOCK) WHERE schedule_key=@key)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_reminder_days WITH (HOLDLOCK) WHERE schedule_key=@key)
      OR EXISTS(SELECT 1 FROM scheduling.schedule_reminder_emails WITH (HOLDLOCK) WHERE schedule_key=@key)
      OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_snapshots WITH (HOLDLOCK) WHERE schedule_key=@key)
      OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents WITH (HOLDLOCK) WHERE copy_schedule_key=@key)
      THROW 58007,N''Unexpected owner, ancillary data, or schedule origin.'',1;

    DECLARE @days table(kind varchar(20),weekday tinyint,PRIMARY KEY(kind,weekday));
    INSERT @days SELECT CASE @frequency WHEN ''weekly'' THEN ''weekly'' ELSE ''preferred'' END,weekday
      FROM scheduling.catalog_schedule_draft_proposal_weekdays WITH (HOLDLOCK) WHERE proposal_id=@proposal;
    DECLARE @users table(kind varchar(20),user_key bigint,PRIMARY KEY(kind,user_key));
    INSERT @users SELECT CASE kind WHEN ''domain'' THEN ''general'' ELSE ''database'' END,user_key
      FROM scheduling.catalog_schedule_draft_proposal_assignees WITH (HOLDLOCK) WHERE proposal_id=@proposal;
    IF EXISTS(SELECT kind,weekday FROM @days EXCEPT SELECT kind,weekday FROM scheduling.schedule_weekdays WHERE schedule_key=@key)
      OR EXISTS(SELECT kind,weekday FROM scheduling.schedule_weekdays WHERE schedule_key=@key EXCEPT SELECT kind,weekday FROM @days)
      OR EXISTS(SELECT kind,user_key FROM @users EXCEPT SELECT assignment_kind,user_key FROM scheduling.schedule_assignees WHERE schedule_key=@key)
      OR EXISTS(SELECT assignment_kind,user_key FROM scheduling.schedule_assignees WHERE schedule_key=@key EXCEPT SELECT kind,user_key FROM @users)
      OR EXISTS(SELECT 1 FROM @users u LEFT JOIN security.users active_user WITH (HOLDLOCK) ON active_user.user_key=u.user_key AND active_user.active=1
        WHERE active_user.user_key IS NULL)
      OR (@assignment=''role'' AND EXISTS(SELECT 1 FROM @users))
      OR (@assignment=''users'' AND ((@domainRole IS NOT NULL AND NOT EXISTS(SELECT 1 FROM @users WHERE kind=''general''))
        OR (@databaseRole IS NOT NULL AND NOT EXISTS(SELECT 1 FROM @users WHERE kind=''database''))))
      OR EXISTS(SELECT 1 FROM (VALUES (@domainRole,''domain''),(@databaseRole,''database'')) lanes(role_id,kind)
        WHERE lanes.role_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM security.roles role_row WITH (HOLDLOCK)
          WHERE role_row.role_id COLLATE Latin1_General_100_BIN2=lanes.role_id COLLATE Latin1_General_100_BIN2
            AND DATALENGTH(role_row.role_id)=DATALENGTH(lanes.role_id) AND role_row.active=1
            AND (@assignment=''users'' OR role_row.role_id=N''super_admin''
              OR ((CASE lanes.kind WHEN ''domain'' THEN role_row.domain_task_visibility ELSE role_row.database_task_visibility END) IN (''assigned'',''all'')
                AND EXISTS(SELECT 1 FROM security.role_permissions rp WITH (HOLDLOCK)
                  JOIN security.permissions p WITH (HOLDLOCK) ON p.permission_key=rp.permission_key AND p.active=1
                  WHERE rp.role_id=role_row.role_id AND rp.permission_key=N''updates.tasks.view'')))))
      THROW 58008,N''Frequency or responsible users no longer match the reviewed proposal.'',1;

    IF (@mode=''manual'' AND (EXISTS(SELECT 1 FROM @pins WHERE included=0)
        OR EXISTS(SELECT 1 FROM scheduling.licensing_scope WHERE schedule_key=@key)))
      OR (@mode=''licensing'' AND (
        NOT EXISTS(SELECT 1 FROM scheduling.licensing_scope
          WHERE schedule_key=@key AND license_match_mode=''all'' AND active_only=1 AND target_types=@types
            AND COALESCE(environment_id,''all'')=@targetEnv)
        OR NOT EXISTS(SELECT 1 FROM scheduling.licensing_scope_modules m WITH (HOLDLOCK)
          JOIN licensing.license_modules active_module WITH (HOLDLOCK) ON active_module.module_key=m.module_key
            AND active_module.status=''active'' AND active_module.deleted_at IS NULL
          WHERE m.schedule_key=@key AND m.module_key=@module)
        OR (SELECT COUNT(*) FROM scheduling.licensing_scope_modules WHERE schedule_key=@key)<>1
        OR EXISTS(SELECT domain_key FROM @pins WHERE included=0 AND target_kind=''domain''
          EXCEPT SELECT domain_key FROM scheduling.licensing_excluded_domains WHERE schedule_key=@key)
        OR EXISTS(SELECT domain_key FROM scheduling.licensing_excluded_domains WHERE schedule_key=@key
          EXCEPT SELECT domain_key FROM @pins WHERE included=0 AND target_kind=''domain'')
        OR EXISTS(SELECT database_key FROM @pins WHERE included=0 AND target_kind=''database''
          EXCEPT SELECT database_key FROM scheduling.licensing_excluded_databases WHERE schedule_key=@key)
        OR EXISTS(SELECT database_key FROM scheduling.licensing_excluded_databases WHERE schedule_key=@key
          EXCEPT SELECT database_key FROM @pins WHERE included=0 AND target_kind=''database'')))
      THROW 58009,N''The licensing rule or exclusions do not match the exact review.'',1;

    SELECT @until=MIN(d.value) FROM (SELECT @until AS value UNION ALL SELECT valid_until FROM @pins) d;
    IF @until<=SYSUTCDATETIME() THROW 58010,N''Draft approval proof expired.'',1;
    INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
    VALUES (@environment,@key,@version,@operation,@reviewer);
    SELECT @approvedAt=approved_at FROM scheduling.catalog_schedule_operation_approvals
      WHERE portal_environment=@environment AND schedule_key=@key AND schedule_version=@version
        AND operation_id=@operation AND approved_by=@reviewer AND retired_at IS NULL;
    IF @approvedAt IS NULL OR @approvedAt>=@until OR @requestedDate<CONVERT(date,DATEADD(hour,-5,@approvedAt))
      THROW 58010,N''The SQL approval did not land inside the reviewed window.'',1;
    INSERT migration.catalog_schedule_draft_uses(proposal_id,review_id,schedule_key,schedule_version,portal_environment,approved_at,manual_selection)
      VALUES(@proposal,@review,@key,@version,@environment,@approvedAt,CONVERT(bit,CASE WHEN @mode=''manual'' THEN 1 ELSE 0 END));
    IF @mode=''manual''
      INSERT migration.catalog_schedule_draft_manual_pins(schedule_key,link_id,target_kind,verified_target_id)
        SELECT @key,link_id,target_kind,target_id FROM @pins WHERE included=1;
    SELECT @approvedAt AS approvedAt,@until AS validUntil,@operation AS operationId;
  END;';

  -- The runtime is not granted execution in this migration. The historical reader
  -- and same-day snapshot transaction must be wired before enabling the consumer.
  IF EXISTS(SELECT 1 FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
    WHERE o.object_id IN (OBJECT_ID(N'settings.materialize_catalog_schedule_draft_review',N'P'),
      OBJECT_ID(N'migration.catalog_schedule_draft_uses',N'U'),OBJECT_ID(N'migration.catalog_schedule_draft_manual_pins',N'U'),
      OBJECT_ID(N'scheduling.v_catalog_schedule_draft_approval',N'V'),OBJECT_ID(N'scheduling.v_catalog_schedule_draft_pins',N'V'))
      AND COALESCE(o.principal_id,s.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 58011,N'Expected static dbo ownership for draft materialization.',1;
  IF @owns080=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns080=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
