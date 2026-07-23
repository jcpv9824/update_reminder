/*
  Portal SAG Web - Gate D / 008
  Repeatable projection from immutable raw documents into typed staging tables.
  This procedure does not load operational tables and never resolves secrets.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51080, N'Wrong database.', 1;
IF OBJECT_ID(N'migration.raw_documents', N'U') IS NULL THROW 51081, N'Run 002 first.', 1;
IF OBJECT_ID(N'migration.stage_public_downloads', N'U') IS NULL THROW 51082, N'Run 006 first.', 1;
GO

CREATE OR ALTER PROCEDURE migration.usp_project_raw_to_stage
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  IF NOT EXISTS (SELECT 1 FROM migration.migration_runs WHERE run_key = @run_key)
    THROW 51083, N'The requested migration run does not exist.', 1;

  IF NOT EXISTS (SELECT 1 FROM migration.raw_documents WHERE run_key = @run_key)
    THROW 51084, N'The requested migration run has no raw documents.', 1;

  BEGIN TRANSACTION;

  UPDATE migration.migration_runs
  SET status = 'validating'
  WHERE run_key = @run_key;

  DELETE FROM migration.stage_users WHERE run_key = @run_key;
  DELETE FROM migration.stage_clients WHERE run_key = @run_key;
  DELETE FROM migration.stage_domains WHERE run_key = @run_key;
  DELETE FROM migration.stage_databases WHERE run_key = @run_key;
  DELETE FROM migration.stage_update_schedules WHERE run_key = @run_key;
  DELETE FROM migration.stage_update_tasks WHERE run_key = @run_key;
  DELETE FROM migration.stage_license_modules WHERE run_key = @run_key;
  DELETE FROM migration.stage_license_assignments WHERE run_key = @run_key;
  DELETE FROM migration.stage_audit_logs WHERE run_key = @run_key;
  DELETE FROM migration.stage_app_settings WHERE run_key = @run_key;
  DELETE FROM migration.stage_email_notifications WHERE run_key = @run_key;
  DELETE FROM migration.stage_security_rate_limits WHERE run_key = @run_key;
  DELETE FROM migration.stage_auth_sessions WHERE run_key = @run_key;
  DELETE FROM migration.stage_roles WHERE run_key = @run_key;
  DELETE FROM migration.stage_print_format_sources WHERE run_key = @run_key;
  DELETE FROM migration.stage_print_formats WHERE run_key = @run_key;
  DELETE FROM migration.stage_public_downloads WHERE run_key = @run_key;

  INSERT migration.stage_users
    (run_key, source_id, display_name, email, active, roles_json, created_at, updated_at, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.displayName'),
    JSON_VALUE(raw_json, '$.email'),
    CASE JSON_VALUE(raw_json, '$.active') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
    JSON_QUERY(raw_json, '$.roles'),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.createdAt'), 127),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.updatedAt'), 127),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'users';

  INSERT migration.stage_clients
    (run_key, source_id, external_id, name, status, license_module_ids_json, created_at, updated_at, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.externalId'),
    JSON_VALUE(raw_json, '$.name'),
    JSON_VALUE(raw_json, '$.status'),
    JSON_QUERY(raw_json, '$.licenseModuleIds'),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.createdAt'), 127),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.updatedAt'), 127),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'clients';

  INSERT migration.stage_domains
    (run_key, source_id, client_source_id, domain_name, environment_id, status, assigned_user_ids_json, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.clientId'),
    JSON_VALUE(raw_json, '$.domainName'),
    JSON_VALUE(raw_json, '$.environment'),
    JSON_VALUE(raw_json, '$.status'),
    JSON_QUERY(raw_json, '$.assignedUpdaterIds'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'domains';

  INSERT migration.stage_databases
    (run_key, source_id, client_source_id, domain_source_id, company_name, environment_id,
     server_host_port, initial_catalog, sql_user_id, password_secret_name,
     assigned_user_ids_json, status, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.clientId'),
    JSON_VALUE(raw_json, '$.domainId'),
    JSON_VALUE(raw_json, '$.companyName'),
    JSON_VALUE(raw_json, '$.environment'),
    JSON_VALUE(raw_json, '$.dbAccess.serverHostPort'),
    JSON_VALUE(raw_json, '$.dbAccess.initialCatalog'),
    JSON_VALUE(raw_json, '$.dbAccess.userId'),
    JSON_VALUE(raw_json, '$.dbAccess.passwordSecretName'),
    JSON_QUERY(raw_json, '$.assignedUpdaterIds'),
    JSON_VALUE(raw_json, '$.status'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'databases';

  INSERT migration.stage_update_schedules
    (run_key, source_id, client_source_id, domain_source_id, target_type, frequency_type,
     start_date, end_date, selection_mode, active, target_ids_json, weekdays_json,
     preferred_weekdays_json, assigned_user_ids_json, database_assigned_user_ids_json,
     reminders_json, scope_groups_json, licensing_scope_json, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.clientId'),
    JSON_VALUE(raw_json, '$.domainId'),
    JSON_VALUE(raw_json, '$.targetType'),
    JSON_VALUE(raw_json, '$.frequencyType'),
    TRY_CONVERT(DATE, JSON_VALUE(raw_json, '$.startDate'), 23),
    TRY_CONVERT(DATE, JSON_VALUE(raw_json, '$.endDate'), 23),
    JSON_VALUE(raw_json, '$.selectionMode'),
    CASE JSON_VALUE(raw_json, '$.active') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
    JSON_QUERY(raw_json, '$.targetIds'),
    JSON_QUERY(raw_json, '$.weekdays'),
    JSON_QUERY(raw_json, '$.preferredWeekdays'),
    JSON_QUERY(raw_json, '$.assignedUserIds'),
    JSON_QUERY(raw_json, '$.databaseAssignedUserIds'),
    JSON_QUERY(raw_json, '$.reminders'),
    JSON_QUERY(raw_json, '$.scopeGroups'),
    JSON_QUERY(raw_json, '$.licensingScope'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'updateSchedules';

  INSERT migration.stage_update_tasks
    (run_key, source_id, dedupe_key, task_date, task_bucket, client_source_id, domain_source_id,
     target_type, target_source_id, legacy_schedule_id, root_schedule_source_id, status, result,
     assigned_user_ids_json, sources_json, reminders_sent_json, overdue_alert_dates_json, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.dedupeKey'),
    TRY_CONVERT(DATE, JSON_VALUE(raw_json, '$.taskDate'), 23),
    JSON_VALUE(raw_json, '$.taskBucket'),
    JSON_VALUE(raw_json, '$.clientId'),
    JSON_VALUE(raw_json, '$.domainId'),
    JSON_VALUE(raw_json, '$.targetType'),
    JSON_VALUE(raw_json, '$.targetId'),
    JSON_VALUE(raw_json, '$.scheduleId'),
    JSON_VALUE(raw_json, '$.rootScheduleId'),
    JSON_VALUE(raw_json, '$.status'),
    JSON_VALUE(raw_json, '$.result'),
    JSON_QUERY(raw_json, '$.assignedUserIds'),
    JSON_QUERY(raw_json, '$.sources'),
    JSON_QUERY(raw_json, '$.remindersSent'),
    JSON_QUERY(raw_json, '$.overdueAlertSentDates'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'updateTasks';

  INSERT migration.stage_license_modules
    (run_key, source_id, name, code, status, active, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.name'),
    JSON_VALUE(raw_json, '$.code'),
    JSON_VALUE(raw_json, '$.status'),
    CASE JSON_VALUE(raw_json, '$.active') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'licenseModules';

  INSERT migration.stage_license_assignments
    (run_key, source_id, module_source_id, target_type, target_source_id, client_source_id,
     domain_source_id, database_source_id, environment_id, status, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.moduleId'),
    JSON_VALUE(raw_json, '$.targetType'),
    JSON_VALUE(raw_json, '$.targetId'),
    JSON_VALUE(raw_json, '$.clientId'),
    JSON_VALUE(raw_json, '$.domainId'),
    JSON_VALUE(raw_json, '$.databaseId'),
    NULLIF(JSON_VALUE(raw_json, '$.environment'), 'all'),
    JSON_VALUE(raw_json, '$.status'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'licenseAssignments';

  INSERT migration.stage_audit_logs
    (run_key, source_id, entity_type, entity_source_id, client_source_id, domain_source_id,
     action, performed_by, performed_at, before_json, after_json, metadata_json, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.entityType'),
    JSON_VALUE(raw_json, '$.entityId'),
    JSON_VALUE(raw_json, '$.clientId'),
    JSON_VALUE(raw_json, '$.domainId'),
    JSON_VALUE(raw_json, '$.action'),
    JSON_VALUE(raw_json, '$.performedBy'),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.performedAt'), 127),
    JSON_QUERY(raw_json, '$.before'),
    JSON_QUERY(raw_json, '$.after'),
    JSON_QUERY(raw_json, '$.metadata'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'auditLogs';

  INSERT migration.stage_app_settings
    (run_key, source_id, settings_json, source_document_sha256)
  SELECT run_key, source_id, raw_json, document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'appSettings';

  INSERT migration.stage_email_notifications
    (run_key, source_id, notification_type, entity_source_id, period, send_date, sent_at,
     days_after, recipients_json, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.type'),
    COALESCE(JSON_VALUE(raw_json, '$.taskId'), JSON_VALUE(raw_json, '$.entityId'), JSON_VALUE(raw_json, '$.key')),
    JSON_VALUE(raw_json, '$.period'),
    TRY_CONVERT(DATE, JSON_VALUE(raw_json, '$.sendDate'), 23),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.sentAt'), 127),
    TRY_CONVERT(SMALLINT, JSON_VALUE(raw_json, '$.daysAfter')),
    JSON_QUERY(raw_json, '$.recipients'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'emailNotifications';

  INSERT migration.stage_security_rate_limits
    (run_key, source_id, scope, key_type, attempt_count, window_started_at, blocked_until,
     updated_at, ttl_seconds, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.scope'),
    JSON_VALUE(raw_json, '$.keyType'),
    TRY_CONVERT(INT, JSON_VALUE(raw_json, '$.count')),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.windowStartedAt'), 127),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.blockedUntil'), 127),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.updatedAt'), 127),
    TRY_CONVERT(INT, JSON_VALUE(raw_json, '$.ttl')),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'securityRateLimits';

  INSERT migration.stage_auth_sessions
    (run_key, source_id, user_source_id, token_version, created_at, last_used_at, expires_at,
     revoked_at, ttl_seconds, has_mfa_verified_at, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.userId'),
    TRY_CONVERT(INT, JSON_VALUE(raw_json, '$.tokenVersion')),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.createdAt'), 127),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.lastUsedAt'), 127),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.expiresAt'), 127),
    TRY_CONVERT(DATETIME2(3), JSON_VALUE(raw_json, '$.revokedAt'), 127),
    TRY_CONVERT(INT, JSON_VALUE(raw_json, '$.ttl')),
    CASE WHEN JSON_VALUE(raw_json, '$.mfaVerifiedAt') IS NULL THEN 0 ELSE 1 END,
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'authSessions';

  INSERT migration.stage_roles
    (run_key, source_id, name, active, system_role, protected_role, domain_task_visibility,
     database_task_visibility, permissions_json, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.name'),
    CASE JSON_VALUE(raw_json, '$.active') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE 1 END,
    CASE JSON_VALUE(raw_json, '$.system') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE 0 END,
    CASE JSON_VALUE(raw_json, '$.protected') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE 0 END,
    JSON_VALUE(raw_json, '$.taskVisibility.domain'),
    JSON_VALUE(raw_json, '$.taskVisibility.database'),
    JSON_QUERY(raw_json, '$.permissions'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'roles';

  INSERT migration.stage_print_format_sources
    (run_key, source_id, name, active, status, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.nombre'),
    CASE JSON_VALUE(raw_json, '$.activa') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
    JSON_VALUE(raw_json, '$.status'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'fuentesFormatos';

  INSERT migration.stage_print_formats
    (run_key, source_id, print_format_source_id, name, format_size, requires_license,
     module_source_id, legacy_import_code, legacy_import_status, legacy_variant,
     pdf_original_name, pdf_mime_type, active, status, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.fuenteId'),
    JSON_VALUE(raw_json, '$.nombre'),
    JSON_VALUE(raw_json, '$.tamanoFormato'),
    CASE JSON_VALUE(raw_json, '$.requiereLicencia') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE 0 END,
    JSON_VALUE(raw_json, '$.licenciaModuloId'),
    JSON_VALUE(raw_json, '$.codigoImportacion'),
    JSON_VALUE(raw_json, '$.estadoImportacion'),
    JSON_VALUE(raw_json, '$.variante'),
    JSON_VALUE(raw_json, '$.pdfNombreOriginal'),
    JSON_VALUE(raw_json, '$.pdfMimeType'),
    CASE JSON_VALUE(raw_json, '$.activo') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
    JSON_VALUE(raw_json, '$.status'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'formatosImpresion';

  INSERT migration.stage_public_downloads
    (run_key, source_id, record_type, section_source_id, name_or_title, slug,
     file_original_name, file_mime_type, file_byte_count, active, status, source_document_sha256)
  SELECT
    run_key, source_id,
    JSON_VALUE(raw_json, '$.type'),
    JSON_VALUE(raw_json, '$.sectionId'),
    COALESCE(JSON_VALUE(raw_json, '$.nombre'), JSON_VALUE(raw_json, '$.titulo')),
    JSON_VALUE(raw_json, '$.slug'),
    JSON_VALUE(raw_json, '$.archivoNombreOriginal'),
    JSON_VALUE(raw_json, '$.archivoMimeType'),
    TRY_CONVERT(BIGINT, JSON_VALUE(raw_json, '$.archivoBytes')),
    CASE COALESCE(JSON_VALUE(raw_json, '$.activa'), JSON_VALUE(raw_json, '$.activo'))
      WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
    JSON_VALUE(raw_json, '$.status'),
    document_sha256
  FROM migration.raw_documents
  WHERE run_key = @run_key AND source_container = N'publicDownloads';

  DELETE FROM migration.reconciliation_counts
  WHERE run_key = @run_key AND reconciliation_code LIKE N'stage_count:%';

  INSERT migration.reconciliation_counts
    (run_key, reconciliation_code, source_count, target_count)
  SELECT @run_key, N'stage_count:users',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'users'),
    (SELECT COUNT_BIG(*) FROM migration.stage_users WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:clients',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'clients'),
    (SELECT COUNT_BIG(*) FROM migration.stage_clients WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:domains',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'domains'),
    (SELECT COUNT_BIG(*) FROM migration.stage_domains WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:databases',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'databases'),
    (SELECT COUNT_BIG(*) FROM migration.stage_databases WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:updateSchedules',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'updateSchedules'),
    (SELECT COUNT_BIG(*) FROM migration.stage_update_schedules WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:updateTasks',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'updateTasks'),
    (SELECT COUNT_BIG(*) FROM migration.stage_update_tasks WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:licenseModules',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'licenseModules'),
    (SELECT COUNT_BIG(*) FROM migration.stage_license_modules WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:licenseAssignments',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'licenseAssignments'),
    (SELECT COUNT_BIG(*) FROM migration.stage_license_assignments WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:auditLogs',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'auditLogs'),
    (SELECT COUNT_BIG(*) FROM migration.stage_audit_logs WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:appSettings',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'appSettings'),
    (SELECT COUNT_BIG(*) FROM migration.stage_app_settings WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:emailNotifications',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'emailNotifications'),
    (SELECT COUNT_BIG(*) FROM migration.stage_email_notifications WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:securityRateLimits',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'securityRateLimits'),
    (SELECT COUNT_BIG(*) FROM migration.stage_security_rate_limits WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:authSessions',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'authSessions'),
    (SELECT COUNT_BIG(*) FROM migration.stage_auth_sessions WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:roles',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'roles'),
    (SELECT COUNT_BIG(*) FROM migration.stage_roles WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:fuentesFormatos',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'fuentesFormatos'),
    (SELECT COUNT_BIG(*) FROM migration.stage_print_format_sources WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:formatosImpresion',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'formatosImpresion'),
    (SELECT COUNT_BIG(*) FROM migration.stage_print_formats WHERE run_key=@run_key)
  UNION ALL SELECT @run_key, N'stage_count:publicDownloads',
    (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=N'publicDownloads'),
    (SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key);

  IF EXISTS
  (
    SELECT 1
    FROM migration.reconciliation_counts
    WHERE run_key = @run_key
      AND reconciliation_code LIKE N'stage_count:%'
      AND source_count <> target_count
  )
    THROW 51085, N'Raw-to-stage count reconciliation failed.', 1;

  UPDATE migration.raw_documents
  SET processing_status = 'validated', processing_error_code = NULL
  WHERE run_key = @run_key;

  UPDATE migration.migration_runs
  SET
    status = 'validated',
    staged_document_count = (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key = @run_key),
    critical_error_count = 0,
    completed_at = SYSUTCDATETIME()
  WHERE run_key = @run_key;

  COMMIT TRANSACTION;
END;
GO

PRINT N'008 complete: repeatable raw-to-stage projection procedure created.';
GO
