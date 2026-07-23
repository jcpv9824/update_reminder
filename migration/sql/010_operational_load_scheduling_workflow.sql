/*
  Portal SAG Web - Gate D / 010
  Transactional scheduling/workflow operational load for SQL Server 2019.

  Prerequisite: phase 009 completed for the same migration run. This script
  creates the procedure only; it never executes a migration run by itself.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51140, N'Wrong database.', 1;
IF OBJECT_ID(N'migration.usp_load_operational_security_core_licensing',N'P') IS NULL
  THROW 51141, N'Run 009 first.', 1;
GO

CREATE OR ALTER PROCEDURE migration.usp_load_operational_scheduling_workflow
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  DECLARE @phase_code VARCHAR(60)='scheduling_workflow';
  DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
  DECLARE @source_count BIGINT;
  DECLARE @target_count BIGINT;

  EXEC migration.usp_assert_operational_load_ready @run_key;

  IF NOT EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='security_core_licensing' AND status='completed'
  )
    THROW 51142, N'Phase 009 security/core/licensing must complete first.', 1;

  IF EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code=@phase_code AND status='completed'
  )
  BEGIN
    SELECT run_key,phase_code,status,source_count,target_count,completed_at
    FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code=@phase_code;
    RETURN;
  END;

  IF EXISTS (SELECT 1 FROM scheduling.update_schedules)
     OR EXISTS (SELECT 1 FROM workflow.update_tasks)
    THROW 51143, N'Scheduling/workflow phase requires empty target aggregates.', 1;

  SELECT @source_count=COUNT_BIG(*)
  FROM migration.raw_documents
  WHERE run_key=@run_key AND source_container IN (N'updateSchedules',N'updateTasks');

  IF EXISTS (SELECT 1 FROM migration.operational_load_phases WHERE run_key=@run_key AND phase_code=@phase_code)
    UPDATE migration.operational_load_phases
    SET status='running',started_at=@now,completed_at=NULL,source_count=@source_count,
        target_count=NULL,details=N'Transactional retry started.',executed_by=ORIGINAL_LOGIN()
    WHERE run_key=@run_key AND phase_code=@phase_code;
  ELSE
    INSERT migration.operational_load_phases(run_key,phase_code,status,started_at,source_count,details)
    VALUES(@run_key,@phase_code,'running',@now,@source_count,N'Transactional scheduling/workflow load started.');

  BEGIN TRY
    BEGIN TRANSACTION;

    INSERT scheduling.update_schedules
      (source_id,client_key,client_name_snapshot,domain_key,domain_name_snapshot,name,
       target_type,frequency_type,every_n_weeks,interval_days,day_of_month,start_date,end_date,
       timezone,assigned_role,domain_assigned_role,database_assigned_role,
       database_reminder_recipients_mode,selection_mode,manual_target_types,assignment_mode,
       origin,active,completed_at,completed_reason,notes,created_at,created_by,updated_at,
       updated_by,deleted_at,deleted_by)
    SELECT s.source_id,client.client_key,COALESCE(JSON_VALUE(r.raw_json,'$.clientName'),client.name),
      domain_record.domain_key,COALESCE(JSON_VALUE(r.raw_json,'$.domainName'),domain_record.domain_name),
      COALESCE(NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.name'))),N''),N'Actualización programada'),
      s.target_type,s.frequency_type,
      CASE WHEN s.frequency_type='weekly' THEN COALESCE(TRY_CONVERT(SMALLINT,JSON_VALUE(r.raw_json,'$.everyNWeeks')),1)
        ELSE TRY_CONVERT(SMALLINT,JSON_VALUE(r.raw_json,'$.everyNWeeks')) END,
      TRY_CONVERT(INT,JSON_VALUE(r.raw_json,'$.intervalDays')),
      TRY_CONVERT(TINYINT,JSON_VALUE(r.raw_json,'$.dayOfMonth')),
      s.start_date,s.end_date,COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.timezone'),N''),N'America/Bogota'),
      CASE COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.assignedRole'),N''),
             CASE WHEN s.target_type='domain' THEN N'domain_updater' ELSE N'database_updater' END)
        WHEN N'admin' THEN N'super_admin'
        WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
        WHEN N'client_manager' THEN N'client_operations_manager'
        WHEN N'viewer' THEN N'audit_viewer'
        WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
        ELSE COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.assignedRole'),N''),
             CASE WHEN s.target_type='domain' THEN N'domain_updater' ELSE N'database_updater' END) END,
      CASE JSON_VALUE(r.raw_json,'$.domainAssignedRole')
        WHEN N'admin' THEN N'super_admin' WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
        WHEN N'client_manager' THEN N'client_operations_manager' WHEN N'viewer' THEN N'audit_viewer'
        WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
        ELSE NULLIF(JSON_VALUE(r.raw_json,'$.domainAssignedRole'),N'') END,
      CASE JSON_VALUE(r.raw_json,'$.databaseAssignedRole')
        WHEN N'admin' THEN N'super_admin' WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
        WHEN N'client_manager' THEN N'client_operations_manager' WHEN N'viewer' THEN N'audit_viewer'
        WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
        ELSE NULLIF(JSON_VALUE(r.raw_json,'$.databaseAssignedRole'),N'') END,
      JSON_VALUE(r.raw_json,'$.databaseReminderRecipientsMode'),
      COALESCE(s.selection_mode,CASE WHEN s.scope_groups_json IS NOT NULL THEN 'manual'
        WHEN s.licensing_scope_json IS NOT NULL THEN 'licensing' END),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.manualTargetTypes'),N''),
        CASE WHEN s.scope_groups_json IS NOT NULL THEN 'domains_and_databases' END),
      CASE WHEN JSON_VALUE(r.raw_json,'$.assignmentMode') IN ('role','users')
        THEN JSON_VALUE(r.raw_json,'$.assignmentMode') ELSE 'role' END,
      JSON_VALUE(r.raw_json,'$.origin'),COALESCE(s.active,1),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.completedAt'),127),
      JSON_VALUE(r.raw_json,'$.completedReason'),NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.notes'))),N''),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
                         TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now)
                     < COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now)
        THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now)
        ELSE COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
                      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN COALESCE(s.active,1)=0 THEN TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      CASE WHEN COALESCE(s.active,1)=0 THEN JSON_VALUE(r.raw_json,'$.deletedBy') END
    FROM migration.stage_update_schedules AS s
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'updateSchedules' AND r.source_id=s.source_id
    JOIN core.clients AS client ON client.source_id=s.client_source_id
    LEFT JOIN core.domains AS domain_record
      ON domain_record.source_id=s.domain_source_id AND domain_record.client_key=client.client_key
    WHERE s.run_key=@run_key;

    ;WITH weekday_source AS
    (
      SELECT schedule_record.schedule_key,'weekly' AS kind,
        CASE UPPER(day_value.[value]) WHEN 'MONDAY' THEN 1 WHEN 'TUESDAY' THEN 2 WHEN 'WEDNESDAY' THEN 3
          WHEN 'THURSDAY' THEN 4 WHEN 'FRIDAY' THEN 5 WHEN 'SATURDAY' THEN 6 WHEN 'SUNDAY' THEN 7 END AS weekday
      FROM migration.stage_update_schedules AS s
      JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
      CROSS APPLY OPENJSON(COALESCE(s.weekdays_json,N'[]')) AS day_value
      WHERE s.run_key=@run_key
      UNION ALL
      SELECT schedule_record.schedule_key,'preferred',
        CASE UPPER(day_value.[value]) WHEN 'MONDAY' THEN 1 WHEN 'TUESDAY' THEN 2 WHEN 'WEDNESDAY' THEN 3
          WHEN 'THURSDAY' THEN 4 WHEN 'FRIDAY' THEN 5 WHEN 'SATURDAY' THEN 6 WHEN 'SUNDAY' THEN 7 END
      FROM migration.stage_update_schedules AS s
      JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
      CROSS APPLY OPENJSON(COALESCE(s.preferred_weekdays_json,N'[]')) AS day_value
      WHERE s.run_key=@run_key
    )
    INSERT scheduling.schedule_weekdays(schedule_key,kind,weekday)
    SELECT DISTINCT schedule_key,kind,weekday FROM weekday_source WHERE weekday IS NOT NULL;

    INSERT scheduling.schedule_targets(schedule_key,client_key,target_type,domain_key,database_key)
    SELECT DISTINCT schedule_record.schedule_key,schedule_record.client_key,s.target_type,
      CASE WHEN s.target_type='domain' THEN domain_record.domain_key END,
      CASE WHEN s.target_type='database' THEN database_record.database_key END
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(s.target_ids_json,N'[]')) WITH (target_source_id NVARCHAR(150) '$') AS target
    LEFT JOIN core.domains AS domain_record
      ON s.target_type='domain' AND domain_record.source_id=target.target_source_id
        AND domain_record.client_key=schedule_record.client_key
    LEFT JOIN core.databases AS database_record
      ON s.target_type='database' AND database_record.source_id=target.target_source_id
        AND database_record.client_key=schedule_record.client_key
    WHERE s.run_key=@run_key AND (domain_record.domain_key IS NOT NULL OR database_record.database_key IS NOT NULL);

    ;WITH schedule_assignee_source AS
    (
      SELECT schedule_record.schedule_key,'general' AS assignment_kind,user_value.user_source_id
      FROM migration.stage_update_schedules AS s
      JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
      CROSS APPLY OPENJSON(COALESCE(s.assigned_user_ids_json,N'[]')) WITH (user_source_id NVARCHAR(150) '$') AS user_value
      WHERE s.run_key=@run_key
      UNION ALL
      SELECT schedule_record.schedule_key,'database',user_value.user_source_id
      FROM migration.stage_update_schedules AS s
      JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
      CROSS APPLY OPENJSON(COALESCE(s.database_assigned_user_ids_json,N'[]')) WITH (user_source_id NVARCHAR(150) '$') AS user_value
      WHERE s.run_key=@run_key
    )
    INSERT scheduling.schedule_assignees(schedule_key,assignment_kind,user_key)
    SELECT DISTINCT source_assignee.schedule_key,source_assignee.assignment_kind,user_record.user_key
    FROM schedule_assignee_source AS source_assignee
    JOIN security.users AS user_record ON user_record.source_id=source_assignee.user_source_id;

    INSERT scheduling.schedule_reminder_settings
      (schedule_key,reminders_enabled,reminder_time,reminder_recipients_mode)
    SELECT schedule_record.schedule_key,
      CASE JSON_VALUE(s.reminders_json,'$.remindersEnabled') WHEN 'true' THEN 1 ELSE 0 END,
      TRY_CONVERT(TIME(0),JSON_VALUE(s.reminders_json,'$.reminderTime')),
      JSON_VALUE(s.reminders_json,'$.reminderRecipientsMode')
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    WHERE s.run_key=@run_key AND s.reminders_json IS NOT NULL;

    INSERT scheduling.schedule_reminder_days(schedule_key,days_before)
    SELECT DISTINCT schedule_record.schedule_key,TRY_CONVERT(SMALLINT,day_value.[value])
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.reminders_json,'$.reminderDaysBefore'),N'[]')) AS day_value
    WHERE s.run_key=@run_key AND TRY_CONVERT(SMALLINT,day_value.[value])>=0;

    INSERT scheduling.schedule_reminder_emails(schedule_key,email_normalized)
    SELECT DISTINCT schedule_record.schedule_key,LOWER(LTRIM(RTRIM(email_value.[value])))
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.reminders_json,'$.customReminderEmails'),N'[]')) AS email_value
    WHERE s.run_key=@run_key AND NULLIF(LTRIM(RTRIM(email_value.[value])),N'') IS NOT NULL;

    INSERT scheduling.scope_groups(schedule_key,ordinal,client_key,include_all_domains)
    SELECT schedule_record.schedule_key,TRY_CONVERT(INT,group_json.[key]),client.client_key,
      CASE JSON_VALUE(group_json.[value],'$.includeAllDomains') WHEN 'true' THEN 1 ELSE 0 END
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(s.scope_groups_json,N'[]')) AS group_json
    JOIN core.clients AS client ON client.source_id=JSON_VALUE(group_json.[value],'$.clientId')
    WHERE s.run_key=@run_key;

    INSERT scheduling.scope_domains(scope_group_key,ordinal,client_key,domain_key,include_all_databases)
    SELECT scope_group.scope_group_key,TRY_CONVERT(INT,domain_json.[key]),scope_group.client_key,domain_record.domain_key,
      CASE JSON_VALUE(domain_json.[value],'$.includeAllDatabases') WHEN 'true' THEN 1 ELSE 0 END
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(s.scope_groups_json,N'[]')) AS group_json
    JOIN scheduling.scope_groups AS scope_group
      ON scope_group.schedule_key=schedule_record.schedule_key AND scope_group.ordinal=TRY_CONVERT(INT,group_json.[key])
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(group_json.[value],'$.domains'),N'[]')) AS domain_json
    JOIN core.domains AS domain_record
      ON domain_record.source_id=JSON_VALUE(domain_json.[value],'$.domainId')
        AND domain_record.client_key=scope_group.client_key
    WHERE s.run_key=@run_key;

    INSERT scheduling.scope_databases(scope_domain_key,domain_key,client_key,database_key)
    SELECT DISTINCT scope_domain.scope_domain_key,scope_domain.domain_key,scope_domain.client_key,database_record.database_key
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(s.scope_groups_json,N'[]')) AS group_json
    JOIN scheduling.scope_groups AS scope_group
      ON scope_group.schedule_key=schedule_record.schedule_key AND scope_group.ordinal=TRY_CONVERT(INT,group_json.[key])
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(group_json.[value],'$.domains'),N'[]')) AS domain_json
    JOIN scheduling.scope_domains AS scope_domain
      ON scope_domain.scope_group_key=scope_group.scope_group_key AND scope_domain.ordinal=TRY_CONVERT(INT,domain_json.[key])
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(domain_json.[value],'$.databaseIds'),N'[]'))
      WITH (database_source_id NVARCHAR(150) '$') AS database_value
    JOIN core.databases AS database_record
      ON database_record.source_id=database_value.database_source_id
        AND database_record.domain_key=scope_domain.domain_key
        AND database_record.client_key=scope_domain.client_key
    WHERE s.run_key=@run_key;

    INSERT scheduling.licensing_scope(schedule_key,license_match_mode,environment_id,target_types,active_only)
    SELECT schedule_record.schedule_key,
      COALESCE(NULLIF(JSON_VALUE(s.licensing_scope_json,'$.licenseMatchMode'),N''),'any'),
      NULLIF(JSON_VALUE(s.licensing_scope_json,'$.environment'),'all'),
      COALESCE(NULLIF(JSON_VALUE(s.licensing_scope_json,'$.targetTypes'),N''),'domains_and_databases'),
      CASE JSON_VALUE(s.licensing_scope_json,'$.activeOnly') WHEN 'false' THEN 0 ELSE 1 END
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    WHERE s.run_key=@run_key AND s.licensing_scope_json IS NOT NULL;

    INSERT scheduling.licensing_scope_modules(schedule_key,module_key)
    SELECT DISTINCT schedule_record.schedule_key,module_record.module_key
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.licensing_scope_json,'$.licenseModuleIds'),N'[]'))
      WITH (module_source_id NVARCHAR(150) '$') AS module_value
    JOIN licensing.license_modules AS module_record ON module_record.source_id=module_value.module_source_id
    WHERE s.run_key=@run_key;

    INSERT scheduling.licensing_excluded_domains(schedule_key,domain_key)
    SELECT DISTINCT schedule_record.schedule_key,domain_record.domain_key
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.licensing_scope_json,'$.excludedDomainIds'),N'[]'))
      WITH (domain_source_id NVARCHAR(150) '$') AS domain_value
    JOIN core.domains AS domain_record ON domain_record.source_id=domain_value.domain_source_id
    WHERE s.run_key=@run_key;

    INSERT scheduling.licensing_excluded_databases(schedule_key,database_key)
    SELECT DISTINCT schedule_record.schedule_key,database_record.database_key
    FROM migration.stage_update_schedules AS s
    JOIN scheduling.update_schedules AS schedule_record ON schedule_record.source_id=s.source_id
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.licensing_scope_json,'$.excludedDatabaseIds'),N'[]'))
      WITH (database_source_id NVARCHAR(150) '$') AS database_value
    JOIN core.databases AS database_record ON database_record.source_id=database_value.database_source_id
    WHERE s.run_key=@run_key;

    /* Rank all physical source tasks into logical target/date groups. */
    SELECT s.source_id,s.dedupe_key,s.task_date,s.task_bucket,s.client_source_id,s.domain_source_id,
      s.target_type,s.target_source_id,s.legacy_schedule_id,s.root_schedule_source_id,s.status,s.result,
      s.assigned_user_ids_json,s.sources_json,s.reminders_sent_json,s.overdue_alert_dates_json,r.raw_json,
      ROW_NUMBER() OVER
      (
        PARTITION BY s.target_type,s.target_source_id,s.task_date
        ORDER BY CASE WHEN s.status='cancelled' AND s.result=N'obsolete' THEN 0 ELSE 1 END DESC,
          COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),CONVERT(DATETIME2(3),'19000101')) DESC,
          COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),CONVERT(DATETIME2(3),'19000101')) DESC,
          s.source_id ASC
      ) AS canonical_rank
    INTO #task_ranked
    FROM migration.stage_update_tasks AS s
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'updateTasks' AND r.source_id=s.source_id
    WHERE s.run_key=@run_key;

    SELECT ranked.*,canonical.source_id AS canonical_source_id
    INTO #task_plan
    FROM #task_ranked AS ranked
    JOIN #task_ranked AS canonical
      ON canonical.target_type=ranked.target_type
      AND canonical.target_source_id=ranked.target_source_id
      AND canonical.task_date=ranked.task_date
      AND canonical.canonical_rank=1;

    IF EXISTS
    (
      SELECT 1
      FROM #task_plan AS p
      LEFT JOIN core.domains AS target_domain
        ON p.target_type='domain' AND target_domain.source_id=p.target_source_id
      LEFT JOIN core.databases AS target_database
        ON p.target_type='database' AND target_database.source_id=p.target_source_id
      WHERE p.canonical_rank=1
        AND target_domain.domain_key IS NULL AND target_database.database_key IS NULL
        AND p.status NOT IN ('completed','cancelled')
    )
      THROW 51144, N'An active logical task has no operational target.', 1;

    INSERT workflow.update_tasks
      (source_id,dedupe_key,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,
       domain_key,domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,
       database_key,primary_schedule_source_id,primary_schedule_key,is_historical_orphan,assigned_role,
       status,result,notes,completed_at,completed_by,completed_with_problems,problem_note,completion_note,
       blocked_at,blocked_by,block_reason,resolved_at,resolved_by,resolution_comment,reopened_at,reopened_by,
       reopen_reason,created_at,created_by,updated_at,updated_by)
    SELECT p.source_id,COALESCE(NULLIF(p.dedupe_key,N''),
        CONCAT(p.target_type,N':',p.target_source_id,N':',CONVERT(CHAR(10),p.task_date,23))),
      p.task_date,COALESCE(NULLIF(p.task_bucket,N''),CONVERT(CHAR(7),p.task_date,126)),
      client.client_key,COALESCE(NULLIF(p.client_source_id,N''),N'historical'),
      COALESCE(JSON_VALUE(p.raw_json,'$.clientName'),client.name,p.client_source_id,N'Histórico'),
      CASE WHEN p.target_type='domain' THEN target_domain.domain_key ELSE domain_record.domain_key END,
      COALESCE(NULLIF(p.domain_source_id,N''),N'historical'),
      COALESCE(JSON_VALUE(p.raw_json,'$.domainName'),target_domain.domain_name,domain_record.domain_name,p.domain_source_id,N'Histórico'),
      p.target_type,p.target_source_id,
      COALESCE(JSON_VALUE(p.raw_json,'$.targetName'),target_domain.domain_name,database_record.company_name,p.target_source_id),
      CASE WHEN p.target_type='database' THEN database_record.database_key END,
      root_source.primary_schedule_source_id,schedule_record.schedule_key,
      CASE WHEN p.target_type='domain' AND target_domain.domain_key IS NULL THEN 1
           WHEN p.target_type='database' AND database_record.database_key IS NULL THEN 1 ELSE 0 END,
      CASE COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.assignedRole'),N''),
             CASE WHEN p.target_type='domain' THEN N'domain_updater' ELSE N'database_updater' END)
        WHEN N'admin' THEN N'super_admin'
        WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
        WHEN N'client_manager' THEN N'client_operations_manager'
        WHEN N'viewer' THEN N'audit_viewer'
        WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
        ELSE COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.assignedRole'),N''),
             CASE WHEN p.target_type='domain' THEN N'domain_updater' ELSE N'database_updater' END) END,
      CASE WHEN p.status IN ('pending','in_progress','completed','failed','blocked','cancelled','reopened') THEN p.status ELSE 'pending' END,
      p.result,NULLIF(LTRIM(RTRIM(JSON_VALUE(p.raw_json,'$.notes'))),N''),
      CASE WHEN p.status='completed' THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.completedAt'),127),
        TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.updatedAt'),127),@now)
        ELSE TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.completedAt'),127) END,
      JSON_VALUE(p.raw_json,'$.completedBy'),
      CASE JSON_VALUE(p.raw_json,'$.completedWithProblems') WHEN 'true' THEN 1 ELSE 0 END,
      JSON_VALUE(p.raw_json,'$.problemNote'),JSON_VALUE(p.raw_json,'$.completionNote'),
      CASE WHEN p.status='blocked' THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.blockedAt'),127),
        TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.updatedAt'),127),@now)
        ELSE TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.blockedAt'),127) END,
      JSON_VALUE(p.raw_json,'$.blockedBy'),JSON_VALUE(p.raw_json,'$.blockReason'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.resolvedAt'),127),JSON_VALUE(p.raw_json,'$.resolvedBy'),
      JSON_VALUE(p.raw_json,'$.resolutionComment'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.reopenedAt'),127),JSON_VALUE(p.raw_json,'$.reopenedBy'),
      JSON_VALUE(p.raw_json,'$.reopenReason'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.updatedAt'),127),
                         TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),@now)
                     < COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),@now)
        THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),@now)
        ELSE COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.updatedAt'),127),
                      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),@now) END,
      COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(p.raw_json,'$.createdBy'),N''),N'migration')
    FROM #task_plan AS p
    LEFT JOIN core.clients AS client ON client.source_id=p.client_source_id
    LEFT JOIN core.domains AS domain_record ON domain_record.source_id=p.domain_source_id
    LEFT JOIN core.domains AS target_domain ON p.target_type='domain' AND target_domain.source_id=p.target_source_id
    LEFT JOIN core.databases AS database_record ON p.target_type='database' AND database_record.source_id=p.target_source_id
    OUTER APPLY
    (
      SELECT NULLIF(COALESCE(NULLIF(p.root_schedule_source_id,N''),
        CASE WHEN NULLIF(p.legacy_schedule_id,N'') IS NOT NULL
          THEN LEFT(p.legacy_schedule_id,CHARINDEX(N'__',p.legacy_schedule_id+N'__')-1) END),N'') AS primary_schedule_source_id
    ) AS root_source
    LEFT JOIN scheduling.update_schedules AS schedule_record
      ON schedule_record.source_id=root_source.primary_schedule_source_id
    WHERE p.canonical_rank=1;

    INSERT workflow.task_source_aliases
      (alias_source_id,task_key,original_status,original_result,original_created_at,original_updated_at,consolidated_at)
    SELECT p.source_id,task_record.task_key,p.status,p.result,
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.updatedAt'),127),@now
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    WHERE p.canonical_rank>1;

    SELECT DISTINCT task_record.task_key,user_record.user_key
    INTO #task_assignee_plan
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    CROSS APPLY OPENJSON(COALESCE(p.assigned_user_ids_json,N'[]')) WITH (user_source_id NVARCHAR(150) '$') AS assignee
    JOIN security.users AS user_record ON user_record.source_id=assignee.user_source_id;

    INSERT workflow.task_assignees(task_key,user_key)
    SELECT task_key,user_key FROM #task_assignee_plan;

    ;WITH source_rows AS
    (
      SELECT task_record.task_key,task_record.primary_schedule_source_id,
        JSON_VALUE(source_json.[value],'$.scheduleId') AS schedule_source_id,
        JSON_VALUE(source_json.[value],'$.scheduleType') AS schedule_type,
        JSON_VALUE(source_json.[value],'$.reason') AS reason,
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(source_json.[value],'$.createdAt'),127),
                 TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),@now) AS created_at
      FROM #task_plan AS p
      JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
      CROSS APPLY OPENJSON(COALESCE(p.sources_json,N'[]')) AS source_json
      WHERE NULLIF(JSON_VALUE(source_json.[value],'$.scheduleId'),N'') IS NOT NULL
    ), distinct_sources AS
    (
      SELECT task_key,primary_schedule_source_id,schedule_source_id,schedule_type,
        MIN(reason) AS reason,MIN(created_at) AS created_at
      FROM source_rows
      GROUP BY task_key,primary_schedule_source_id,schedule_source_id,schedule_type
    )
    SELECT distinct_sources.*,
      ROW_NUMBER() OVER
      (
        PARTITION BY task_key
        ORDER BY CASE WHEN schedule_source_id=primary_schedule_source_id THEN 0 ELSE 1 END,
          created_at,schedule_source_id,COALESCE(schedule_type,N'')
      ) AS primary_rank
    INTO #task_source_plan
    FROM distinct_sources;

    INSERT workflow.task_sources
      (task_key,schedule_source_id,schedule_key,schedule_type,reason,created_at,is_primary)
    SELECT source_plan.task_key,source_plan.schedule_source_id,schedule_record.schedule_key,
      source_plan.schedule_type,source_plan.reason,source_plan.created_at,
      CASE WHEN source_plan.schedule_source_id=source_plan.primary_schedule_source_id
             AND source_plan.primary_rank=1 THEN 1 ELSE 0 END
    FROM #task_source_plan AS source_plan
    LEFT JOIN scheduling.update_schedules AS schedule_record
      ON schedule_record.source_id=source_plan.schedule_source_id;

    SELECT DISTINCT task_record.task_key,
      COALESCE(NULLIF(JSON_VALUE(reminder_json.[value],'$.type'),N''),N'legacy') AS reminder_type,
      TRY_CONVERT(SMALLINT,JSON_VALUE(reminder_json.[value],'$.daysBefore')) AS days_before,
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(reminder_json.[value],'$.sentAt'),127) AS sent_at
    INTO #task_reminder_plan
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    CROSS APPLY OPENJSON(COALESCE(p.reminders_sent_json,N'[]')) AS reminder_json
    WHERE TRY_CONVERT(DATETIME2(3),JSON_VALUE(reminder_json.[value],'$.sentAt'),127) IS NOT NULL;

    INSERT workflow.task_reminders(task_key,reminder_type,days_before,sent_at)
    SELECT task_key,reminder_type,days_before,sent_at FROM #task_reminder_plan;

    SELECT DISTINCT task_record.task_key,
      COALESCE(NULLIF(JSON_VALUE(reminder_json.[value],'$.type'),N''),N'legacy') AS reminder_type,
      TRY_CONVERT(SMALLINT,JSON_VALUE(reminder_json.[value],'$.daysBefore')) AS days_before,
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(reminder_json.[value],'$.sentAt'),127) AS sent_at,
      LOWER(LTRIM(RTRIM(recipient_value.[value]))) AS email_normalized
    INTO #task_reminder_recipient_plan
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    CROSS APPLY OPENJSON(COALESCE(p.reminders_sent_json,N'[]')) AS reminder_json
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(reminder_json.[value],'$.recipients'),N'[]')) AS recipient_value
    WHERE TRY_CONVERT(DATETIME2(3),JSON_VALUE(reminder_json.[value],'$.sentAt'),127) IS NOT NULL
      AND NULLIF(LTRIM(RTRIM(recipient_value.[value])),N'') IS NOT NULL;

    INSERT workflow.task_reminder_recipients(task_reminder_key,email_normalized)
    SELECT DISTINCT reminder.task_reminder_key,recipient.email_normalized
    FROM #task_reminder_recipient_plan AS recipient
    JOIN workflow.task_reminders AS reminder
      ON reminder.task_key=recipient.task_key AND reminder.reminder_type=recipient.reminder_type
        AND (reminder.days_before=recipient.days_before OR reminder.days_before IS NULL AND recipient.days_before IS NULL)
        AND reminder.sent_at=recipient.sent_at;

    SELECT DISTINCT task_record.task_key,TRY_CONVERT(DATE,date_value.[value],23) AS sent_date
    INTO #task_overdue_plan
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    CROSS APPLY OPENJSON(COALESCE(p.overdue_alert_dates_json,N'[]')) AS date_value
    WHERE TRY_CONVERT(DATE,date_value.[value],23) IS NOT NULL;

    INSERT workflow.task_overdue_alerts(task_key,sent_date)
    SELECT task_key,sent_date FROM #task_overdue_plan;

    INSERT workflow.task_status_history
      (task_key,previous_status,new_status,action,comment,performed_by,performed_at,is_inferred)
    SELECT task_record.task_key,NULL,p.status,
      CASE WHEN p.canonical_rank=1 THEN N'task_imported' ELSE N'task_source_consolidated' END,
      CASE WHEN p.canonical_rank>1 THEN p.result END,
      COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.createdBy'),N''),N'migration'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.createdAt'),127),@now),1
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id;

    INSERT workflow.task_status_history
      (task_key,previous_status,new_status,action,comment,performed_by,performed_at,is_inferred)
    SELECT task_record.task_key,'unknown','completed',N'task_completed',
      COALESCE(JSON_VALUE(p.raw_json,'$.completionNote'),JSON_VALUE(p.raw_json,'$.problemNote')),
      COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.completedBy'),N''),NULLIF(JSON_VALUE(p.raw_json,'$.updatedBy'),N''),N'migration'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.completedAt'),127),1
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    WHERE TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.completedAt'),127) IS NOT NULL
    UNION ALL
    SELECT task_record.task_key,'unknown','blocked',N'task_blocked',JSON_VALUE(p.raw_json,'$.blockReason'),
      COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.blockedBy'),N''),NULLIF(JSON_VALUE(p.raw_json,'$.updatedBy'),N''),N'migration'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.blockedAt'),127),1
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    WHERE TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.blockedAt'),127) IS NOT NULL
    UNION ALL
    SELECT task_record.task_key,'blocked',p.status,N'task_block_resolved',JSON_VALUE(p.raw_json,'$.resolutionComment'),
      COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.resolvedBy'),N''),NULLIF(JSON_VALUE(p.raw_json,'$.updatedBy'),N''),N'migration'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.resolvedAt'),127),1
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    WHERE TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.resolvedAt'),127) IS NOT NULL
    UNION ALL
    SELECT task_record.task_key,'completed',p.status,N'task_reopened',JSON_VALUE(p.raw_json,'$.reopenReason'),
      COALESCE(NULLIF(JSON_VALUE(p.raw_json,'$.reopenedBy'),N''),NULLIF(JSON_VALUE(p.raw_json,'$.updatedBy'),N''),N'migration'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.reopenedAt'),127),1
    FROM #task_plan AS p
    JOIN workflow.update_tasks AS task_record ON task_record.source_id=p.canonical_source_id
    WHERE TRY_CONVERT(DATETIME2(3),JSON_VALUE(p.raw_json,'$.reopenedAt'),127) IS NOT NULL;

    UPDATE migration.raw_documents
    SET processing_status='loaded',processing_error_code=NULL
    WHERE run_key=@run_key AND source_container IN (N'updateSchedules',N'updateTasks');

    DELETE FROM migration.reconciliation_counts
    WHERE run_key=@run_key AND reconciliation_code LIKE N'operational_workflow:%';

    INSERT migration.reconciliation_counts(run_key,reconciliation_code,source_count,target_count)
    SELECT @run_key,N'operational_workflow:update_schedules',
      (SELECT COUNT_BIG(*) FROM migration.stage_update_schedules WHERE run_key=@run_key),
      (SELECT COUNT_BIG(*) FROM scheduling.update_schedules)
    UNION ALL SELECT @run_key,N'operational_workflow:schedule_weekdays',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT s.source_id,'weekly' AS kind,UPPER(day_value.[value]) AS weekday
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(s.weekdays_json,N'[]')) AS day_value
         WHERE s.run_key=@run_key AND UPPER(day_value.[value]) IN
           ('MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY')
         GROUP BY s.source_id,UPPER(day_value.[value])
         UNION ALL
         SELECT s.source_id,'preferred',UPPER(day_value.[value])
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(s.preferred_weekdays_json,N'[]')) AS day_value
         WHERE s.run_key=@run_key AND UPPER(day_value.[value]) IN
           ('MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY')
         GROUP BY s.source_id,UPPER(day_value.[value])
       ) AS expected),
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_weekdays)
    UNION ALL SELECT @run_key,N'operational_workflow:schedule_targets',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT s.source_id,s.target_type,target.target_source_id
         FROM migration.stage_update_schedules AS s
         JOIN core.clients AS client ON client.source_id=s.client_source_id
         CROSS APPLY OPENJSON(COALESCE(s.target_ids_json,N'[]')) WITH (target_source_id NVARCHAR(150) '$') AS target
         LEFT JOIN core.domains AS domain_record
           ON s.target_type='domain' AND domain_record.source_id=target.target_source_id
             AND domain_record.client_key=client.client_key
         LEFT JOIN core.databases AS database_record
           ON s.target_type='database' AND database_record.source_id=target.target_source_id
             AND database_record.client_key=client.client_key
         WHERE s.run_key=@run_key AND (domain_record.domain_key IS NOT NULL OR database_record.database_key IS NOT NULL)
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.schedule_targets)
    UNION ALL SELECT @run_key,N'operational_workflow:schedule_assignees',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT source_assignee.source_id,source_assignee.assignment_kind,user_record.user_key
         FROM
         (
           SELECT s.source_id,'general' AS assignment_kind,user_value.user_source_id
           FROM migration.stage_update_schedules AS s
           CROSS APPLY OPENJSON(COALESCE(s.assigned_user_ids_json,N'[]')) WITH (user_source_id NVARCHAR(150) '$') AS user_value
           WHERE s.run_key=@run_key
           UNION ALL
           SELECT s.source_id,'database',user_value.user_source_id
           FROM migration.stage_update_schedules AS s
           CROSS APPLY OPENJSON(COALESCE(s.database_assigned_user_ids_json,N'[]')) WITH (user_source_id NVARCHAR(150) '$') AS user_value
           WHERE s.run_key=@run_key
         ) AS source_assignee
         JOIN security.users AS user_record ON user_record.source_id=source_assignee.user_source_id
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.schedule_assignees)
    UNION ALL SELECT @run_key,N'operational_workflow:schedule_reminder_settings',
      (SELECT COUNT_BIG(*) FROM migration.stage_update_schedules WHERE run_key=@run_key AND reminders_json IS NOT NULL),
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_reminder_settings)
    UNION ALL SELECT @run_key,N'operational_workflow:schedule_reminder_days',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT s.source_id,TRY_CONVERT(SMALLINT,day_value.[value]) AS days_before
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.reminders_json,'$.reminderDaysBefore'),N'[]')) AS day_value
         WHERE s.run_key=@run_key AND TRY_CONVERT(SMALLINT,day_value.[value])>=0
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.schedule_reminder_days)
    UNION ALL SELECT @run_key,N'operational_workflow:schedule_reminder_emails',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT s.source_id,LOWER(LTRIM(RTRIM(email_value.[value]))) AS email_normalized
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.reminders_json,'$.customReminderEmails'),N'[]')) AS email_value
         WHERE s.run_key=@run_key AND NULLIF(LTRIM(RTRIM(email_value.[value])),N'') IS NOT NULL
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.schedule_reminder_emails)
    UNION ALL SELECT @run_key,N'operational_workflow:scope_groups',
      (SELECT COUNT_BIG(*)
       FROM migration.stage_update_schedules AS s
       CROSS APPLY OPENJSON(COALESCE(s.scope_groups_json,N'[]')) AS group_json
       JOIN core.clients AS client ON client.source_id=JSON_VALUE(group_json.[value],'$.clientId')
       WHERE s.run_key=@run_key),(SELECT COUNT_BIG(*) FROM scheduling.scope_groups)
    UNION ALL SELECT @run_key,N'operational_workflow:scope_domains',
      (SELECT COUNT_BIG(*)
       FROM migration.stage_update_schedules AS s
       CROSS APPLY OPENJSON(COALESCE(s.scope_groups_json,N'[]')) AS group_json
       JOIN core.clients AS client ON client.source_id=JSON_VALUE(group_json.[value],'$.clientId')
       CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(group_json.[value],'$.domains'),N'[]')) AS domain_json
       JOIN core.domains AS domain_record
         ON domain_record.source_id=JSON_VALUE(domain_json.[value],'$.domainId') AND domain_record.client_key=client.client_key
       WHERE s.run_key=@run_key),(SELECT COUNT_BIG(*) FROM scheduling.scope_domains)
    UNION ALL SELECT @run_key,N'operational_workflow:scope_databases',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT s.source_id,JSON_VALUE(domain_json.[value],'$.domainId') AS domain_source_id,
           database_value.database_source_id
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(s.scope_groups_json,N'[]')) AS group_json
         JOIN core.clients AS client ON client.source_id=JSON_VALUE(group_json.[value],'$.clientId')
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(group_json.[value],'$.domains'),N'[]')) AS domain_json
         JOIN core.domains AS domain_record
           ON domain_record.source_id=JSON_VALUE(domain_json.[value],'$.domainId') AND domain_record.client_key=client.client_key
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(domain_json.[value],'$.databaseIds'),N'[]'))
           WITH (database_source_id NVARCHAR(150) '$') AS database_value
         JOIN core.databases AS database_record
           ON database_record.source_id=database_value.database_source_id
             AND database_record.domain_key=domain_record.domain_key AND database_record.client_key=client.client_key
         WHERE s.run_key=@run_key
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.scope_databases)
    UNION ALL SELECT @run_key,N'operational_workflow:licensing_scope',
      (SELECT COUNT_BIG(*) FROM migration.stage_update_schedules WHERE run_key=@run_key AND licensing_scope_json IS NOT NULL),
      (SELECT COUNT_BIG(*) FROM scheduling.licensing_scope)
    UNION ALL SELECT @run_key,N'operational_workflow:licensing_scope_modules',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT s.source_id,module_record.module_key
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.licensing_scope_json,'$.licenseModuleIds'),N'[]'))
           WITH (module_source_id NVARCHAR(150) '$') AS module_value
         JOIN licensing.license_modules AS module_record ON module_record.source_id=module_value.module_source_id
         WHERE s.run_key=@run_key
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.licensing_scope_modules)
    UNION ALL SELECT @run_key,N'operational_workflow:licensing_excluded_domains',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT s.source_id,domain_record.domain_key
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.licensing_scope_json,'$.excludedDomainIds'),N'[]'))
           WITH (domain_source_id NVARCHAR(150) '$') AS domain_value
         JOIN core.domains AS domain_record ON domain_record.source_id=domain_value.domain_source_id
         WHERE s.run_key=@run_key
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.licensing_excluded_domains)
    UNION ALL SELECT @run_key,N'operational_workflow:licensing_excluded_databases',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT s.source_id,database_record.database_key
         FROM migration.stage_update_schedules AS s
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.licensing_scope_json,'$.excludedDatabaseIds'),N'[]'))
           WITH (database_source_id NVARCHAR(150) '$') AS database_value
         JOIN core.databases AS database_record ON database_record.source_id=database_value.database_source_id
         WHERE s.run_key=@run_key
       ) AS expected),(SELECT COUNT_BIG(*) FROM scheduling.licensing_excluded_databases)
    UNION ALL SELECT @run_key,N'operational_workflow:update_tasks',
      (SELECT COUNT_BIG(*) FROM #task_plan WHERE canonical_rank=1),(SELECT COUNT_BIG(*) FROM workflow.update_tasks)
    UNION ALL SELECT @run_key,N'operational_workflow:task_source_aliases',
      (SELECT COUNT_BIG(*) FROM #task_plan WHERE canonical_rank>1),(SELECT COUNT_BIG(*) FROM workflow.task_source_aliases)
    UNION ALL SELECT @run_key,N'operational_workflow:task_assignees',
      (SELECT COUNT_BIG(*) FROM #task_assignee_plan),(SELECT COUNT_BIG(*) FROM workflow.task_assignees)
    UNION ALL SELECT @run_key,N'operational_workflow:task_sources',
      (SELECT COUNT_BIG(*) FROM #task_source_plan),(SELECT COUNT_BIG(*) FROM workflow.task_sources)
    UNION ALL SELECT @run_key,N'operational_workflow:task_reminders',
      (SELECT COUNT_BIG(*) FROM #task_reminder_plan),(SELECT COUNT_BIG(*) FROM workflow.task_reminders)
    UNION ALL SELECT @run_key,N'operational_workflow:task_reminder_recipients',
      (SELECT COUNT_BIG(*) FROM #task_reminder_recipient_plan),(SELECT COUNT_BIG(*) FROM workflow.task_reminder_recipients)
    UNION ALL SELECT @run_key,N'operational_workflow:task_overdue_alerts',
      (SELECT COUNT_BIG(*) FROM #task_overdue_plan),(SELECT COUNT_BIG(*) FROM workflow.task_overdue_alerts)
    UNION ALL SELECT @run_key,N'operational_workflow:task_status_history',
      (SELECT COUNT_BIG(*)
       +COALESCE(SUM(CASE WHEN JSON_VALUE(raw_json,'$.completedAt') IS NOT NULL THEN 1 ELSE 0 END),0)
       +COALESCE(SUM(CASE WHEN JSON_VALUE(raw_json,'$.blockedAt') IS NOT NULL THEN 1 ELSE 0 END),0)
       +COALESCE(SUM(CASE WHEN JSON_VALUE(raw_json,'$.resolvedAt') IS NOT NULL THEN 1 ELSE 0 END),0)
       +COALESCE(SUM(CASE WHEN JSON_VALUE(raw_json,'$.reopenedAt') IS NOT NULL THEN 1 ELSE 0 END),0)
       FROM #task_plan),
      (SELECT COUNT_BIG(*) FROM workflow.task_status_history);

    IF EXISTS
    (
      SELECT 1 FROM migration.reconciliation_counts
      WHERE run_key=@run_key AND reconciliation_code LIKE N'operational_workflow:%' AND reconciled=0
    )
      THROW 51145, N'Scheduling/workflow reconciliation failed.', 1;

    SELECT @target_count=
      (SELECT COUNT_BIG(*) FROM scheduling.update_schedules)+
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_weekdays)+
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_targets)+
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_assignees)+
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_reminder_settings)+
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_reminder_days)+
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_reminder_emails)+
      (SELECT COUNT_BIG(*) FROM scheduling.scope_groups)+
      (SELECT COUNT_BIG(*) FROM scheduling.scope_domains)+
      (SELECT COUNT_BIG(*) FROM scheduling.scope_databases)+
      (SELECT COUNT_BIG(*) FROM scheduling.licensing_scope)+
      (SELECT COUNT_BIG(*) FROM scheduling.licensing_scope_modules)+
      (SELECT COUNT_BIG(*) FROM scheduling.licensing_excluded_domains)+
      (SELECT COUNT_BIG(*) FROM scheduling.licensing_excluded_databases)+
      (SELECT COUNT_BIG(*) FROM workflow.update_tasks)+
      (SELECT COUNT_BIG(*) FROM workflow.task_source_aliases)+
      (SELECT COUNT_BIG(*) FROM workflow.task_assignees)+
      (SELECT COUNT_BIG(*) FROM workflow.task_sources)+
      (SELECT COUNT_BIG(*) FROM workflow.task_reminders)+
      (SELECT COUNT_BIG(*) FROM workflow.task_reminder_recipients)+
      (SELECT COUNT_BIG(*) FROM workflow.task_overdue_alerts)+
      (SELECT COUNT_BIG(*) FROM workflow.task_status_history);

    UPDATE migration.operational_load_phases
    SET status='completed',completed_at=SYSUTCDATETIME(),target_count=@target_count,
        details=N'Schedules, consolidated logical tasks and normalized children loaded and reconciled.'
    WHERE run_key=@run_key AND phase_code=@phase_code;

    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    UPDATE migration.operational_load_phases
    SET status='failed',completed_at=SYSUTCDATETIME(),details=LEFT(ERROR_MESSAGE(),2000)
    WHERE run_key=@run_key AND phase_code=@phase_code;
    THROW;
  END CATCH;

  SELECT run_key,phase_code,status,source_count,target_count,completed_at
  FROM migration.operational_load_phases
  WHERE run_key=@run_key AND phase_code=@phase_code;
END;
GO

PRINT N'010 complete: transactional scheduling/workflow loader created.';
GO
