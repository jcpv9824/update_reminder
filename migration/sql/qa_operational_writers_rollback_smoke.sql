/*
  Portal SAG Web - QA rollback-only operational smoke.
  Exercises representative SQL write paths without retaining synthetic data.
  This script is not a versioned migration and must never target production.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME()<>N'PortalSAGWeb-TEST'
  THROW 52900,N'This rollback-only smoke is restricted to PortalSAGWeb-TEST.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52901,N'This smoke is certified for SQL Server 2019.',1;
DECLARE @suffix NVARCHAR(32)=LOWER(REPLACE(CONVERT(NVARCHAR(36),NEWID()),N'-',N''));
DECLARE @prefix NVARCHAR(80)=N'qa_smoke_'+@suffix;
DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
DECLARE @actor NVARCHAR(150)=N'qa-rollback-smoke';
DECLARE @client_key BIGINT;
DECLARE @domain_key BIGINT;
DECLARE @access_profile_key BIGINT;
DECLARE @database_key BIGINT;
DECLARE @module_key BIGINT;
DECLARE @user_key BIGINT;
DECLARE @schedule_key BIGINT;
DECLARE @scope_group_key BIGINT;
DECLARE @scope_domain_key BIGINT;
DECLARE @task_key BIGINT;
DECLARE @notification_key BIGINT;
DECLARE @video_file_key BIGINT;
DECLARE @pdf_file_key BIGINT;
DECLARE @section_key BIGINT;
DECLARE @document_key BIGINT;
DECLARE @print_source_key BIGINT;
DECLARE @second_print_source_key BIGINT;
DECLARE @print_format_key BIGINT;

BEGIN TRANSACTION;

/* Users, roles, permissions and authentication. */
INSERT security.roles
  (role_id,name,active,system_role,protected_role,domain_task_visibility,database_task_visibility,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,N'QA rollback role',1,0,0,'assigned','assigned',@now,@actor,@now,@actor);

INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
SELECT @prefix,permission_key,@now,@actor
FROM security.permissions
WHERE permission_key IN
  (N'updates.tasks.view',N'updates.schedules.view',N'updates.schedules.generate_tasks');

IF @@ROWCOUNT<>3 THROW 52903,N'Required smoke permissions are missing.',1;

INSERT security.users
  (source_id,display_name,email,email_normalized,active,password_hash,password_updated_at,
   password_expires_at,must_change_password,token_version,last_login_at,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,N'QA rollback user',@prefix+N'@example.invalid',@prefix+N'@example.invalid',
   1,N'$2b$12$qa.rollback.only.hash',@now,DATEADD(day,90,@now),0,0,@now,
   @now,@actor,@now,@actor);
SET @user_key=SCOPE_IDENTITY();

INSERT security.user_roles(user_key,role_id,assigned_at,assigned_by)
VALUES(@user_key,@prefix,@now,@actor);

INSERT security.auth_sessions
  (source_id,user_key,refresh_token_hash,token_version,created_at,last_used_at,expires_at)
VALUES
  (@prefix,@user_key,HASHBYTES('SHA2_256',@prefix),0,@now,@now,DATEADD(hour,1,@now));

/* Client/domain/database masters and licensing. */
INSERT core.clients
  (source_id,external_id,name,name_normalized,status,notes,created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,@prefix,N'QA rollback client',@prefix,'active',NULL,@now,@actor,@now,@actor);
SET @client_key=SCOPE_IDENTITY();

INSERT core.domains
  (source_id,client_key,client_name_snapshot,domain_name,domain_name_normalized,publishable_domain,
   environment_id,current_web_version,status,notes,created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,@client_key,N'QA rollback client',N'https://'+@prefix+N'.example.invalid',
   N'https://'+@prefix+N'.example.invalid',@prefix+N'.example.invalid',
   'test',N'qa','active',NULL,@now,@actor,@now,@actor);
SET @domain_key=SCOPE_IDENTITY();

INSERT core.database_access_profiles
  (source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
   connection_fingerprint,active,created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,N'qa.invalid,1433',N'qa',N'qa_user',N'qa-smoke-secret-reference',
   HASHBYTES('SHA2_256',@prefix),1,@now,@actor,@now,@actor);
SET @access_profile_key=SCOPE_IDENTITY();

INSERT core.databases
  (source_id,client_key,client_name_snapshot,domain_key,domain_name_snapshot,access_profile_key,
   company_name,company_name_normalized,environment_id,current_db_version,status,notes,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,@client_key,N'QA rollback client',@domain_key,N'QA rollback domain',@access_profile_key,
   N'QA rollback database',@prefix,'test',N'qa','active',NULL,@now,@actor,@now,@actor);
SET @database_key=SCOPE_IDENTITY();

INSERT licensing.license_modules
  (source_id,name,name_normalized,code,code_normalized,description,status,active_legacy,notes,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,N'QA rollback module',@prefix,@prefix,@prefix,REPLICATE(N'x',2000),
   'active',1,NULL,@now,@actor,@now,@actor);
SET @module_key=SCOPE_IDENTITY();

INSERT licensing.license_assignments
  (source_id,module_key,module_name_snapshot,target_type,client_key,environment_id,status,active_legacy,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix+N'_client',@module_key,N'QA rollback module','client',@client_key,'test','active',1,
   @now,@actor,@now,@actor);

INSERT licensing.license_assignments
  (source_id,module_key,module_name_snapshot,target_type,domain_key,environment_id,status,active_legacy,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix+N'_domain',@module_key,N'QA rollback module','domain',@domain_key,'test','active',1,
   @now,@actor,@now,@actor);

INSERT licensing.license_assignments
  (source_id,module_key,module_name_snapshot,target_type,database_key,environment_id,status,active_legacy,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix+N'_database',@module_key,N'QA rollback module','database',@database_key,'test','active',1,
   @now,@actor,@now,@actor);

/* Scheduling, scope preview and automatic/manual task generation. */
INSERT scheduling.update_schedules
  (source_id,client_key,client_name_snapshot,domain_key,domain_name_snapshot,name,target_type,
   frequency_type,start_date,timezone,assigned_role,domain_assigned_role,database_assigned_role,
   selection_mode,manual_target_types,assignment_mode,origin,active,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,@client_key,N'QA rollback client',@domain_key,N'QA rollback domain',
   N'QA rollback schedule','database','manual',CONVERT(date,@now),N'America/Bogota',
   @prefix,@prefix,@prefix,'manual','databases_only','role',N'qa-smoke',1,
   @now,@actor,@now,@actor);
SET @schedule_key=SCOPE_IDENTITY();

INSERT scheduling.schedule_targets(schedule_key,client_key,target_type,domain_key,database_key)
VALUES(@schedule_key,@client_key,'database',NULL,@database_key);

INSERT scheduling.schedule_assignees(schedule_key,assignment_kind,user_key)
VALUES(@schedule_key,'general',@user_key);

INSERT scheduling.schedule_reminder_settings
  (schedule_key,reminders_enabled,reminder_time,reminder_recipients_mode)
VALUES(@schedule_key,1,CAST('08:00' AS TIME(0)),'custom');

INSERT scheduling.schedule_reminder_days(schedule_key,days_before)
VALUES(@schedule_key,1);

INSERT scheduling.schedule_reminder_emails(schedule_key,email_normalized)
VALUES(@schedule_key,@prefix+N'@example.invalid');

INSERT scheduling.scope_groups(schedule_key,ordinal,client_key,include_all_domains)
VALUES(@schedule_key,0,@client_key,0);
SET @scope_group_key=SCOPE_IDENTITY();

INSERT scheduling.scope_domains(scope_group_key,ordinal,client_key,domain_key,include_all_databases)
VALUES(@scope_group_key,0,@client_key,@domain_key,0);
SET @scope_domain_key=SCOPE_IDENTITY();

INSERT scheduling.scope_databases(scope_domain_key,domain_key,client_key,database_key)
VALUES(@scope_domain_key,@domain_key,@client_key,@database_key);

IF (SELECT COUNT(*) FROM scheduling.scope_databases WHERE scope_domain_key=@scope_domain_key)<>1
  THROW 52904,N'Schedule scope preview did not resolve the expected target.',1;

INSERT workflow.update_tasks
  (source_id,dedupe_key,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,
   domain_key,domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,
   database_key,primary_schedule_source_id,primary_schedule_key,is_historical_orphan,
   assigned_role,status,created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,@prefix,CONVERT(date,'20991231'),N'2099-12',@client_key,@prefix,N'QA rollback client',
   @domain_key,@prefix,N'QA rollback domain','database',@prefix,N'QA rollback database',
   @database_key,@prefix,@schedule_key,0,@prefix,'pending',@now,@actor,@now,@actor);
SET @task_key=SCOPE_IDENTITY();

INSERT workflow.task_assignees(task_key,user_key) VALUES(@task_key,@user_key);
INSERT workflow.task_sources
  (task_key,schedule_source_id,schedule_key,schedule_type,reason,created_at,is_primary)
VALUES(@task_key,@prefix,@schedule_key,N'manual',N'qa rollback generation',@now,1);
INSERT workflow.task_status_history
  (task_key,previous_status,new_status,action,performed_by,performed_by_email,performed_at,is_inferred,metadata_json)
VALUES(@task_key,NULL,'pending',N'task_generated',@actor,@prefix+N'@example.invalid',@now,0,N'{}');

UPDATE workflow.update_tasks
SET status='in_progress',updated_at=DATEADD(millisecond,1,@now),updated_by=@actor
WHERE task_key=@task_key;
INSERT workflow.task_status_history
  (task_key,previous_status,new_status,action,performed_by,performed_at,is_inferred,metadata_json)
VALUES(@task_key,'pending','in_progress',N'task_started',@actor,DATEADD(millisecond,1,@now),0,N'{}');

/* Durable alerts/outbox, leasing, idempotency and expired-lease recovery. */
INSERT notifications.email_notifications
  (source_id,notification_type,entity_type,entity_source_id,task_key,idempotency_key,
   subject,status,attempt_count,next_attempt_at,metadata_json,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,'task_status_notification',N'task',@prefix,@task_key,@prefix,
   N'QA rollback notification','pending',0,@now,N'{}',@now,@actor,@now,@actor);
SET @notification_key=SCOPE_IDENTITY();

INSERT notifications.email_notification_recipients
  (notification_key,email,email_normalized,recipient_type,display_name,delivery_status)
VALUES
  (@notification_key,@prefix+N'@example.invalid',@prefix+N'@example.invalid','to',
   N'QA rollback user','pending');

UPDATE notifications.email_notifications
SET status='processing',claimed_by=N'qa-worker-1',claim_expires_at=DATEADD(second,-1,@now),
    attempt_count=attempt_count+1,last_attempted_at=@now,updated_at=@now,updated_by=N'qa-worker-1'
WHERE notification_key=@notification_key AND status='pending';

INSERT notifications.email_notification_attempts
  (notification_key,attempt_no,started_at,attempt_status)
VALUES(@notification_key,1,@now,'processing');

UPDATE notifications.email_notification_attempts
SET completed_at=DATEADD(second,1,@now),attempt_status='failed',error_message=N'expired lease'
WHERE notification_key=@notification_key AND attempt_no=1;

UPDATE notifications.email_notifications
SET status='processing',claimed_by=N'qa-worker-2',claim_expires_at=DATEADD(minute,2,@now),
    attempt_count=attempt_count+1,last_attempted_at=DATEADD(second,1,@now),
    updated_at=DATEADD(second,1,@now),updated_by=N'qa-worker-2'
WHERE notification_key=@notification_key
  AND status='processing' AND claim_expires_at<=@now;

IF @@ROWCOUNT<>1 THROW 52905,N'Expired outbox lease was not recoverable.',1;

INSERT notifications.email_notification_attempts
  (notification_key,attempt_no,started_at,attempt_status)
VALUES(@notification_key,2,DATEADD(second,1,@now),'processing');

UPDATE notifications.email_notifications
SET status='sent',claimed_by=NULL,claim_expires_at=NULL,next_attempt_at=NULL,
    sent_at=DATEADD(second,2,@now),updated_at=DATEADD(second,2,@now),updated_by=N'qa-worker-2'
WHERE notification_key=@notification_key;
UPDATE notifications.email_notification_attempts
SET completed_at=DATEADD(second,2,@now),attempt_status='sent'
WHERE notification_key=@notification_key AND attempt_no=2;
UPDATE notifications.email_notification_recipients
SET delivery_status='sent' WHERE notification_key=@notification_key;

INSERT notifications.email_notifications
  (source_id,notification_type,entity_type,entity_source_id,idempotency_key,
   subject,status,attempt_count,next_attempt_at,metadata_json,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix+N'_test_email','test_email',N'settings',@prefix,@prefix+N'_test_email',
   N'QA rollback test email','pending',0,@now,N'{}',@now,@actor,@now,@actor);

/* Public video and print-format file metadata; bytes remain outside SQL. */
INSERT content.files
  (storage_provider,storage_container,blob_name,original_name,mime_type,byte_count,content_sha256,created_at,created_by)
VALUES
  ('azure_blob',N'qa-rollback',@prefix+N'/video.mp4',N'video.mp4',N'video/mp4',1,
   HASHBYTES('SHA2_256',@prefix+N'_video'),@now,@actor);
SET @video_file_key=SCOPE_IDENTITY();

INSERT content.files
  (storage_provider,storage_container,blob_name,original_name,mime_type,byte_count,content_sha256,created_at,created_by)
VALUES
  ('azure_blob',N'qa-rollback',@prefix+N'/format.pdf',N'format.pdf',N'application/pdf',1,
   HASHBYTES('SHA2_256',@prefix+N'_pdf'),@now,@actor);
SET @pdf_file_key=SCOPE_IDENTITY();

INSERT content.public_download_sections
  (source_id,name,name_normalized,slug,slug_normalized,description,active,status,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,N'QA rollback section',@prefix,@prefix,@prefix,NULL,1,'active',
   @now,@actor,@now,@actor);
SET @section_key=SCOPE_IDENTITY();

INSERT content.public_download_documents
  (source_id,section_key,asset_kind,title,slug,slug_normalized,description,active,status,
   created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,@section_key,'video',N'QA rollback video',@prefix,@prefix,NULL,1,'active',
   @now,@actor,@now,@actor);
SET @document_key=SCOPE_IDENTITY();

INSERT content.public_download_files(document_key,version_no,file_key,is_current,created_at,created_by)
VALUES(@document_key,1,@video_file_key,1,@now,@actor);

IF NOT EXISTS
(
  SELECT 1 FROM content.v_public_download_assets
  WHERE asset_key=@document_key AND asset_kind='video' AND file_key=@video_file_key
)
  THROW 52906,N'Public video projection failed.',1;

INSERT content.print_format_sources
  (source_id,name,name_normalized,active,status,created_at,created_by,updated_at,updated_by)
VALUES(@prefix,N'QA source one',@prefix,1,'active',@now,@actor,@now,@actor);
SET @print_source_key=SCOPE_IDENTITY();

INSERT content.print_format_sources
  (source_id,name,name_normalized,active,status,created_at,created_by,updated_at,updated_by)
VALUES(@prefix+N'_2',N'QA source two',@prefix+N'_2',1,'active',@now,@actor,@now,@actor);
SET @second_print_source_key=SCOPE_IDENTITY();

INSERT content.print_formats
  (source_id,print_format_source_key,name,name_normalized,description,format_size,
   requires_license,module_key,active,status,created_at,created_by,updated_at,updated_by)
VALUES
  (@prefix,@print_source_key,N'QA rollback format',@prefix,NULL,'carta',
   0,NULL,1,'active',@now,@actor,@now,@actor);
SET @print_format_key=SCOPE_IDENTITY();

INSERT content.print_format_source_assignments
  (print_format_key,print_format_source_key,display_order,assigned_at,assigned_by)
VALUES
  (@print_format_key,@print_source_key,0,@now,@actor),
  (@print_format_key,@second_print_source_key,1,@now,@actor);

INSERT content.print_format_files(print_format_key,version_no,file_key,is_current,created_at,created_by)
VALUES(@print_format_key,1,@pdf_file_key,1,@now,@actor);

IF (SELECT COUNT(*) FROM content.v_print_format_source_links WHERE print_format_key=@print_format_key)<>2
  THROW 52907,N'Multiple print-format source projection failed.',1;

/* Client/domain/database cascade semantics. */
UPDATE scheduling.update_schedules
SET active=0,deleted_at=@now,deleted_by=@actor,updated_at=@now,updated_by=@actor
WHERE schedule_key=@schedule_key;
UPDATE core.databases
SET status='deleted',deleted_at=@now,deleted_by=@actor,updated_at=@now,updated_by=@actor
WHERE database_key=@database_key;
UPDATE core.domains
SET status='deleted',deleted_at=@now,deleted_by=@actor,updated_at=@now,updated_by=@actor
WHERE domain_key=@domain_key;
UPDATE core.clients
SET status='deleted',deleted_at=@now,deleted_by=@actor,updated_at=@now,updated_by=@actor
WHERE client_key=@client_key;
UPDATE licensing.license_assignments
SET status='deleted',active_legacy=0,deleted_at=@now,deleted_by=@actor,updated_at=@now,updated_by=@actor
WHERE source_id LIKE @prefix+N'%';

IF (SELECT COUNT(*) FROM licensing.license_assignments WHERE source_id LIKE @prefix+N'%' AND status='deleted')<>3
  THROW 52908,N'License cascade did not affect every synthetic assignment.',1;

ROLLBACK TRANSACTION;

DECLARE @persisted BIGINT=
  (SELECT COUNT_BIG(*) FROM security.users WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM security.roles WHERE role_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM core.clients WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM core.domains WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM core.databases WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM licensing.license_modules WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM scheduling.update_schedules WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM workflow.update_tasks WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM notifications.email_notifications WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM content.public_download_documents WHERE source_id LIKE @prefix+N'%')
 +(SELECT COUNT_BIG(*) FROM content.print_formats WHERE source_id LIKE @prefix+N'%');

IF @persisted<>0 THROW 52909,N'Rollback-only smoke left synthetic rows behind.',1;

SELECT
  CAST(1 AS BIT) AS operational_writers_passed,
  @persisted AS persisted_synthetic_rows,
  CAST(1 AS BIT) AS security_auth_passed,
  CAST(1 AS BIT) AS scheduling_scope_passed,
  CAST(1 AS BIT) AS task_generation_transition_passed,
  CAST(1 AS BIT) AS outbox_recovery_passed,
  CAST(1 AS BIT) AS public_video_passed,
  CAST(1 AS BIT) AS print_multi_source_passed,
  CAST(1 AS BIT) AS cascade_passed;
GO
