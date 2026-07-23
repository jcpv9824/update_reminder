/*
  Portal SAG Web - Gate D / 011
  Final transactional operational load for settings, content metadata,
  notification idempotency and append-only audit on SQL Server 2019.

  File payloads must already exist in private Blob Storage and every ledger
  row must be byte/hash verified. This script creates the procedure only.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51160, N'Wrong database.', 1;
IF OBJECT_ID(N'migration.usp_load_operational_scheduling_workflow',N'P') IS NULL
  THROW 51161, N'Run 010 first.', 1;
GO

CREATE OR ALTER PROCEDURE migration.usp_load_operational_settings_content_notifications_audit
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  DECLARE @phase_code VARCHAR(60)='settings_content_notifications_audit';
  DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
  DECLARE @source_count BIGINT;
  DECLARE @target_count BIGINT;
  DECLARE @expected_file_count BIGINT;

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

  EXEC migration.usp_assert_operational_load_ready @run_key;

  IF NOT EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='scheduling_workflow' AND status='completed'
  )
    THROW 51162, N'Phase 010 scheduling/workflow must complete first.', 1;

  IF EXISTS (SELECT 1 FROM settings.email_settings)
     OR EXISTS (SELECT 1 FROM settings.default_reminder_days)
     OR EXISTS (SELECT 1 FROM settings.alert_recipient_roles)
     OR EXISTS (SELECT 1 FROM settings.alert_recipient_emails)
     OR EXISTS (SELECT 1 FROM settings.overdue_alert_weekdays)
     OR EXISTS (SELECT 1 FROM settings.blocked_reminder_days)
     OR EXISTS (SELECT 1 FROM settings.administrative_reminders)
     OR EXISTS (SELECT 1 FROM settings.administrative_reminder_recipients)
     OR EXISTS (SELECT 1 FROM content.files)
     OR EXISTS (SELECT 1 FROM content.print_format_sources)
     OR EXISTS (SELECT 1 FROM content.print_formats)
     OR EXISTS (SELECT 1 FROM content.public_download_sections)
     OR EXISTS (SELECT 1 FROM content.public_download_documents)
     OR EXISTS (SELECT 1 FROM notifications.email_notifications)
     OR EXISTS (SELECT 1 FROM audit.audit_logs)
    THROW 51163, N'Final operational phase requires empty target aggregates.', 1;

  IF (SELECT COUNT_BIG(*) FROM migration.stage_app_settings WHERE run_key=@run_key)<>1
     OR NOT EXISTS
       (SELECT 1 FROM migration.stage_app_settings WHERE run_key=@run_key AND source_id=N'email-alerts')
    THROW 51164, N'Exactly one email-alerts settings document is required.', 1;

  IF EXISTS
  (
    SELECT 1 FROM migration.stage_app_settings
    WHERE run_key=@run_key
      AND (JSON_VALUE(settings_json,'$.smtpPassword') IS NOT NULL
        OR JSON_VALUE(settings_json,'$.password') IS NOT NULL
        OR JSON_VALUE(settings_json,'$.connectionString') IS NOT NULL)
  )
    THROW 51165, N'Plaintext settings secrets are prohibited.', 1;

  IF EXISTS
  (
    SELECT 1 FROM migration.stage_app_settings AS s
    WHERE s.run_key=@run_key AND
    (
      (JSON_VALUE(s.settings_json,'$.emailProvider') IS NOT NULL
        AND JSON_VALUE(s.settings_json,'$.emailProvider') NOT IN ('mock','smtp','sendgrid','acs'))
      OR (JSON_VALUE(s.settings_json,'$.smtpPort') IS NOT NULL
        AND (TRY_CONVERT(INT,JSON_VALUE(s.settings_json,'$.smtpPort')) IS NULL
          OR TRY_CONVERT(INT,JSON_VALUE(s.settings_json,'$.smtpPort')) NOT BETWEEN 1 AND 65535))
      OR (JSON_VALUE(s.settings_json,'$.overdueAlertRecipientsMode') IS NOT NULL
        AND JSON_VALUE(s.settings_json,'$.overdueAlertRecipientsMode') NOT IN
          ('admins','adminsAndClientManagers','customEmails'))
      OR (JSON_VALUE(s.settings_json,'$.overdueAlertFrequency') IS NOT NULL
        AND JSON_VALUE(s.settings_json,'$.overdueAlertFrequency') NOT IN ('daily','weekly'))
      OR (JSON_VALUE(s.settings_json,'$.defaultReminderTime') IS NOT NULL
        AND TRY_CONVERT(TIME(0),JSON_VALUE(s.settings_json,'$.defaultReminderTime')) IS NULL)
      OR (JSON_VALUE(s.settings_json,'$.overdueAlertTime') IS NOT NULL
        AND TRY_CONVERT(TIME(0),JSON_VALUE(s.settings_json,'$.overdueAlertTime')) IS NULL)
      OR (JSON_VALUE(s.settings_json,'$.blockedReminderTime') IS NOT NULL
        AND TRY_CONVERT(TIME(0),JSON_VALUE(s.settings_json,'$.blockedReminderTime')) IS NULL)
    )
  )
    THROW 51176, N'Email settings contain an invalid provider, port, mode, frequency or time.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_app_settings AS s
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.defaultReminderDaysBefore'),N'[]')) AS j
    WHERE s.run_key=@run_key AND (TRY_CONVERT(SMALLINT,j.[value]) IS NULL OR TRY_CONVERT(SMALLINT,j.[value])<0)
  ) OR EXISTS
  (
    SELECT 1
    FROM migration.stage_app_settings AS s
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedReminderDaysAfter'),N'[]')) AS j
    WHERE s.run_key=@run_key AND (TRY_CONVERT(SMALLINT,j.[value]) IS NULL OR TRY_CONVERT(SMALLINT,j.[value])<0)
  ) OR EXISTS
  (
    SELECT 1
    FROM migration.stage_app_settings AS s
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertWeekdays'),N'[]')) AS j
    WHERE s.run_key=@run_key AND UPPER(j.[value]) NOT IN
      ('MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY')
  )
    THROW 51177, N'Email settings contain an invalid day or weekday.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_app_settings AS s
    CROSS APPLY
    (
      VALUES
        (JSON_QUERY(s.settings_json,'$.administrativeReminders.sagWebVersionReminder')),
        (JSON_QUERY(s.settings_json,'$.administrativeReminders.whatsNewReminder'))
    ) AS reminder(reminder_json)
    WHERE s.run_key=@run_key AND reminder.reminder_json IS NOT NULL
      AND
      (
        (JSON_VALUE(reminder.reminder_json,'$.sendRule') IS NOT NULL
          AND JSON_VALUE(reminder.reminder_json,'$.sendRule') NOT IN
            ('first_day','last_day','last_business_day','fixed_day'))
        OR (JSON_VALUE(reminder.reminder_json,'$.dayOfMonth') IS NOT NULL
          AND (TRY_CONVERT(TINYINT,JSON_VALUE(reminder.reminder_json,'$.dayOfMonth')) IS NULL
            OR TRY_CONVERT(TINYINT,JSON_VALUE(reminder.reminder_json,'$.dayOfMonth')) NOT BETWEEN 1 AND 28))
        OR (JSON_VALUE(reminder.reminder_json,'$.time') IS NOT NULL
          AND TRY_CONVERT(TIME(0),JSON_VALUE(reminder.reminder_json,'$.time')) IS NULL)
      )
  )
    THROW 51178, N'An administrative reminder contains an invalid rule, day or time.', 1;

  IF EXISTS
  (
    SELECT 1 FROM migration.stage_email_notifications
    WHERE run_key=@run_key
      AND (notification_type IS NULL OR notification_type NOT IN
        ('administrative_reminder','blocked_task_reminder','task_reminder','overdue_alert','password_notification')
      )
  )
    THROW 51166, N'Unknown notification type.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_email_notifications AS n
    JOIN migration.raw_documents AS r
      ON r.run_key=n.run_key AND r.source_container=N'emailNotifications' AND r.source_id=n.source_id
    WHERE n.run_key=@run_key
      AND ((JSON_VALUE(r.raw_json,'$.sendDate') IS NOT NULL AND n.send_date IS NULL)
        OR (JSON_VALUE(r.raw_json,'$.sentAt') IS NOT NULL AND n.sent_at IS NULL))
  )
    THROW 51179, N'An email-notification date is invalid.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM
    (
      SELECT CASE role_value.role_id
          WHEN N'admin' THEN N'super_admin'
          WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
          WHEN N'client_manager' THEN N'client_operations_manager'
          WHEN N'viewer' THEN N'audit_viewer'
          WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
          ELSE role_value.role_id END AS role_id
      FROM migration.stage_app_settings AS s
      CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertRecipientRoleIds'),N'[]'))
        WITH (role_id NVARCHAR(80) '$') AS role_value
      WHERE s.run_key=@run_key
      UNION ALL
      SELECT CASE role_value.role_id
          WHEN N'admin' THEN N'super_admin'
          WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
          WHEN N'client_manager' THEN N'client_operations_manager'
          WHEN N'viewer' THEN N'audit_viewer'
          WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
          ELSE role_value.role_id END
      FROM migration.stage_app_settings AS s
      CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedAlertRecipientRoleIds'),N'[]'))
        WITH (role_id NVARCHAR(80) '$') AS role_value
      WHERE s.run_key=@run_key
    ) AS role_reference
    LEFT JOIN security.roles AS role_record ON role_record.role_id=role_reference.role_id
    WHERE role_record.role_id IS NULL
  )
    THROW 51167, N'An alert-recipient role does not exist.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_print_formats AS f
    LEFT JOIN migration.stage_print_format_sources AS s
      ON s.run_key=f.run_key AND s.source_id=f.print_format_source_id
    LEFT JOIN licensing.license_modules AS m ON m.source_id=f.module_source_id
    WHERE f.run_key=@run_key
      AND (s.source_id IS NULL OR (COALESCE(f.requires_license,0)=1 AND m.module_key IS NULL)
        OR f.format_size NOT IN ('carta','oficio','a4','legal','personalizado')
        OR (f.format_size='personalizado'
          AND NULLIF(LTRIM(RTRIM(JSON_VALUE((SELECT raw_json FROM migration.raw_documents
              WHERE run_key=f.run_key AND source_container=N'formatosImpresion' AND source_id=f.source_id),
            '$.tamanoFormatoPersonalizado'))),N'') IS NULL))
  )
    THROW 51168, N'A print format has an invalid source, license or size.', 1;

  IF EXISTS
  (
    SELECT 1 FROM migration.stage_public_downloads AS d
    LEFT JOIN migration.stage_public_downloads AS section_record
      ON section_record.run_key=d.run_key AND section_record.source_id=d.section_source_id
        AND section_record.record_type='section'
    WHERE d.run_key=@run_key
      AND (d.record_type IS NULL OR d.record_type NOT IN ('section','document')
        OR (d.record_type='document' AND section_record.source_id IS NULL))
  )
    THROW 51169, N'A public download has an invalid type or section.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_audit_logs AS a
    CROSS APPLY
    (
      SELECT [key] FROM OPENJSON(COALESCE(a.before_json,N'{}'))
      UNION ALL SELECT [key] FROM OPENJSON(COALESCE(a.after_json,N'{}'))
      UNION ALL SELECT [key] FROM OPENJSON(COALESCE(a.metadata_json,N'{}'))
    ) AS json_field
    WHERE a.run_key=@run_key
      AND LOWER(json_field.[key]) IN
        ('password','passwordhash','smtppassword','token','refreshtoken','authorization',
         'cookie','connectionstring','apikey','secret','mfasecretname')
  )
    THROW 51170, N'Audit JSON contains a prohibited top-level field.', 1;

  SELECT @expected_file_count=
      (SELECT COUNT_BIG(*) FROM migration.stage_print_formats WHERE run_key=@run_key)
    + (SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key AND record_type='document');

  IF (SELECT COUNT_BIG(*) FROM migration.file_transfers
      WHERE run_key=@run_key AND source_container IN (N'formatosImpresion',N'publicDownloads'))<>@expected_file_count
    THROW 51171, N'Every content document requires exactly one file-transfer plan.', 1;

  IF EXISTS
  (
    SELECT 1 FROM migration.file_transfers
    WHERE run_key=@run_key AND source_container IN (N'formatosImpresion',N'publicDownloads')
      AND status<>'verified'
  )
    THROW 51172, N'All private Blob objects must be verified before content is linked.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_print_formats AS f
    LEFT JOIN migration.file_transfers AS t
      ON t.run_key=f.run_key AND t.source_container=N'formatosImpresion'
        AND t.source_id=f.source_id AND t.file_slot='pdf'
    WHERE f.run_key=@run_key
      AND (t.source_id IS NULL OR f.pdf_byte_count IS NULL OR f.pdf_sha256 IS NULL
        OR f.pdf_byte_count<>t.expected_byte_count OR f.pdf_sha256<>t.expected_sha256)
  )
    THROW 51173, N'A print-format file ledger does not match staging.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_public_downloads AS d
    LEFT JOIN migration.file_transfers AS t
      ON t.run_key=d.run_key AND t.source_container=N'publicDownloads'
        AND t.source_id=d.source_id AND t.file_slot='document'
    WHERE d.run_key=@run_key AND d.record_type='document'
      AND (t.source_id IS NULL OR d.file_byte_count IS NULL OR d.file_sha256 IS NULL
        OR d.file_byte_count<>t.expected_byte_count OR d.file_sha256<>t.expected_sha256)
  )
    THROW 51174, N'A public-download file ledger does not match staging.', 1;

  SELECT @source_count=COUNT_BIG(*)
  FROM migration.raw_documents
  WHERE run_key=@run_key AND source_container IN
    (N'appSettings',N'emailNotifications',N'fuentesFormatos',N'formatosImpresion',N'publicDownloads',N'auditLogs');

  IF EXISTS (SELECT 1 FROM migration.operational_load_phases WHERE run_key=@run_key AND phase_code=@phase_code)
    UPDATE migration.operational_load_phases
    SET status='running',started_at=@now,completed_at=NULL,source_count=@source_count,
        target_count=NULL,details=N'Transactional retry started.',executed_by=ORIGINAL_LOGIN()
    WHERE run_key=@run_key AND phase_code=@phase_code;
  ELSE
    INSERT migration.operational_load_phases(run_key,phase_code,status,started_at,source_count,details)
    VALUES(@run_key,@phase_code,'running',@now,@source_count,N'Transactional final operational load started.');

  BEGIN TRY
    BEGIN TRANSACTION;

    INSERT settings.email_settings
      (settings_key,source_id,email_provider,email_from,email_from_name,frontend_base_url,
       smtp_host,smtp_port,smtp_secure,smtp_user,smtp_password_secret_name,smtp_password_configured,
       reminders_enabled,default_reminder_time,default_timezone,overdue_alerts_enabled,
       overdue_alert_time,overdue_alert_timezone,legacy_overdue_recipient_mode,
       overdue_alert_frequency,overdue_alert_last_sent_period,blocked_alerts_enabled,
       blocked_alert_send_immediately,blocked_alert_include_overdue,blocked_reminder_enabled,
       blocked_reminder_time,blocked_reminder_timezone,password_notification_enabled,
       send_temporary_password_by_email,created_at,created_by,updated_at,updated_by)
    SELECT 1,s.source_id,
      CASE WHEN JSON_VALUE(s.settings_json,'$.emailProvider') IN ('mock','smtp','sendgrid','acs')
        THEN JSON_VALUE(s.settings_json,'$.emailProvider') ELSE 'mock' END,
      COALESCE(NULLIF(LTRIM(RTRIM(JSON_VALUE(s.settings_json,'$.emailFrom'))),N''),N'info@pya.com.co'),
      COALESCE(NULLIF(LTRIM(RTRIM(JSON_VALUE(s.settings_json,'$.emailFromName'))),N''),N'Portal SAG Web'),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(s.settings_json,'$.frontendBaseUrl'))),N''),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(s.settings_json,'$.smtpHost'))),N''),
      COALESCE(TRY_CONVERT(INT,JSON_VALUE(s.settings_json,'$.smtpPort')),587),
      CASE JSON_VALUE(s.settings_json,'$.smtpSecure') WHEN 'true' THEN 1 ELSE 0 END,
      NULLIF(LTRIM(RTRIM(JSON_VALUE(s.settings_json,'$.smtpUser'))),N''),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(s.settings_json,'$.smtpPasswordSecretName'))),N''),
      CASE JSON_VALUE(s.settings_json,'$.smtpPasswordConfigured') WHEN 'true' THEN 1 ELSE 0 END,
      CASE JSON_VALUE(s.settings_json,'$.remindersEnabled') WHEN 'false' THEN 0 ELSE 1 END,
      COALESCE(TRY_CONVERT(TIME(0),JSON_VALUE(s.settings_json,'$.defaultReminderTime')),CONVERT(TIME(0),'08:00')),
      COALESCE(NULLIF(JSON_VALUE(s.settings_json,'$.defaultTimezone'),N''),N'America/Bogota'),
      CASE JSON_VALUE(s.settings_json,'$.overdueAlertsEnabled') WHEN 'false' THEN 0 ELSE 1 END,
      COALESCE(TRY_CONVERT(TIME(0),JSON_VALUE(s.settings_json,'$.overdueAlertTime')),CONVERT(TIME(0),'08:00')),
      COALESCE(NULLIF(JSON_VALUE(s.settings_json,'$.overdueAlertTimezone'),N''),N'America/Bogota'),
      CASE WHEN JSON_VALUE(s.settings_json,'$.overdueAlertRecipientsMode') IN
          ('admins','adminsAndClientManagers','customEmails')
        THEN JSON_VALUE(s.settings_json,'$.overdueAlertRecipientsMode') ELSE 'admins' END,
      CASE WHEN JSON_VALUE(s.settings_json,'$.overdueAlertFrequency') IN ('daily','weekly')
        THEN JSON_VALUE(s.settings_json,'$.overdueAlertFrequency') ELSE 'daily' END,
      NULLIF(JSON_VALUE(s.settings_json,'$.overdueAlertLastSentPeriod'),N''),
      CASE JSON_VALUE(s.settings_json,'$.blockedAlertsEnabled') WHEN 'false' THEN 0 ELSE 1 END,
      CASE JSON_VALUE(s.settings_json,'$.blockedAlertSendImmediately') WHEN 'false' THEN 0 ELSE 1 END,
      CASE JSON_VALUE(s.settings_json,'$.blockedAlertIncludeInOverdueSummary') WHEN 'false' THEN 0 ELSE 1 END,
      CASE JSON_VALUE(s.settings_json,'$.blockedReminderEnabled') WHEN 'true' THEN 1 ELSE 0 END,
      COALESCE(TRY_CONVERT(TIME(0),JSON_VALUE(s.settings_json,'$.blockedReminderTime')),CONVERT(TIME(0),'08:00')),
      COALESCE(NULLIF(JSON_VALUE(s.settings_json,'$.blockedReminderTimezone'),N''),N'America/Bogota'),
      CASE JSON_VALUE(s.settings_json,'$.passwordNotificationEnabled') WHEN 'false' THEN 0 ELSE 1 END,
      CASE JSON_VALUE(s.settings_json,'$.sendTemporaryPasswordByEmail') WHEN 'true' THEN 1 ELSE 0 END,
      timestamp_value.created_at,
      COALESCE(NULLIF(JSON_VALUE(s.settings_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN timestamp_value.updated_candidate<timestamp_value.created_at
        THEN timestamp_value.created_at ELSE timestamp_value.updated_candidate END,
      COALESCE(NULLIF(JSON_VALUE(s.settings_json,'$.updatedBy'),N''),
        NULLIF(JSON_VALUE(s.settings_json,'$.createdBy'),N''),N'migration')
    FROM migration.stage_app_settings AS s
    CROSS APPLY
    (
      SELECT
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(s.settings_json,'$.createdAt'),127),@now) AS created_at,
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(s.settings_json,'$.updatedAt'),127),
          TRY_CONVERT(DATETIME2(3),JSON_VALUE(s.settings_json,'$.createdAt'),127),@now) AS updated_candidate
    ) AS timestamp_value
    WHERE s.run_key=@run_key;

    INSERT settings.default_reminder_days(days_before)
    SELECT DISTINCT TRY_CONVERT(SMALLINT,day_value.[value])
    FROM migration.stage_app_settings AS s
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.defaultReminderDaysBefore'),N'[]')) AS day_value
    WHERE s.run_key=@run_key AND TRY_CONVERT(SMALLINT,day_value.[value])>=0;

    INSERT settings.alert_recipient_roles(alert_kind,role_id)
    SELECT DISTINCT role_source.alert_kind,role_record.role_id
    FROM
    (
      SELECT 'overdue' AS alert_kind,role_value.role_id
      FROM migration.stage_app_settings AS s
      CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertRecipientRoleIds'),N'[]'))
        WITH (role_id NVARCHAR(80) '$') AS role_value WHERE s.run_key=@run_key
      UNION ALL
      SELECT 'blocked',role_value.role_id
      FROM migration.stage_app_settings AS s
      CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedAlertRecipientRoleIds'),N'[]'))
        WITH (role_id NVARCHAR(80) '$') AS role_value WHERE s.run_key=@run_key
    ) AS original_role
    CROSS APPLY
    (
      SELECT CASE original_role.role_id
        WHEN N'admin' THEN N'super_admin'
        WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
        WHEN N'client_manager' THEN N'client_operations_manager'
        WHEN N'viewer' THEN N'audit_viewer'
        WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
        ELSE original_role.role_id END AS role_id,original_role.alert_kind
    ) AS role_source
    JOIN security.roles AS role_record ON role_record.role_id=role_source.role_id;

    INSERT settings.alert_recipient_emails(alert_kind,email_normalized,source_kind)
    SELECT DISTINCT email_source.alert_kind,email_source.email_normalized,email_source.source_kind
    FROM
    (
      SELECT 'overdue' AS alert_kind,LOWER(LTRIM(RTRIM(email_value.[value]))) AS email_normalized,'current' AS source_kind
      FROM migration.stage_app_settings AS s
      CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertCustomEmails'),N'[]')) AS email_value
      WHERE s.run_key=@run_key
      UNION ALL
      SELECT 'blocked',LOWER(LTRIM(RTRIM(email_value.[value]))),'current'
      FROM migration.stage_app_settings AS s
      CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedAlertCustomEmails'),N'[]')) AS email_value
      WHERE s.run_key=@run_key
      UNION ALL
      SELECT 'overdue',LOWER(LTRIM(RTRIM(email_value.[value]))),'legacy'
      FROM migration.stage_app_settings AS s
      CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.customAdminAlertEmails'),N'[]')) AS email_value
      WHERE s.run_key=@run_key
    ) AS email_source
    WHERE NULLIF(email_source.email_normalized,N'') IS NOT NULL;

    INSERT settings.overdue_alert_weekdays(weekday)
    SELECT DISTINCT weekday_value.weekday
    FROM migration.stage_app_settings AS s
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertWeekdays'),N'[]')) AS day_value
    CROSS APPLY
    (
      SELECT CASE UPPER(day_value.[value])
        WHEN 'MONDAY' THEN 1 WHEN 'TUESDAY' THEN 2 WHEN 'WEDNESDAY' THEN 3
        WHEN 'THURSDAY' THEN 4 WHEN 'FRIDAY' THEN 5 WHEN 'SATURDAY' THEN 6 WHEN 'SUNDAY' THEN 7 END AS weekday
    ) AS weekday_value
    WHERE s.run_key=@run_key AND weekday_value.weekday IS NOT NULL;

    INSERT settings.blocked_reminder_days(days_after)
    SELECT DISTINCT TRY_CONVERT(SMALLINT,day_value.[value])
    FROM migration.stage_app_settings AS s
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedReminderDaysAfter'),N'[]')) AS day_value
    WHERE s.run_key=@run_key AND TRY_CONVERT(SMALLINT,day_value.[value])>=0;

    INSERT settings.administrative_reminders
      (reminder_kind,enabled,send_rule,day_of_month,reminder_time,timezone,subject)
    SELECT reminder.reminder_kind,
      CASE JSON_VALUE(reminder.reminder_json,'$.enabled') WHEN 'true' THEN 1 ELSE 0 END,
      CASE WHEN JSON_VALUE(reminder.reminder_json,'$.sendRule') IN
          ('first_day','last_day','last_business_day','fixed_day')
        THEN JSON_VALUE(reminder.reminder_json,'$.sendRule') ELSE 'last_business_day' END,
      CASE WHEN TRY_CONVERT(TINYINT,JSON_VALUE(reminder.reminder_json,'$.dayOfMonth')) BETWEEN 1 AND 28
        THEN TRY_CONVERT(TINYINT,JSON_VALUE(reminder.reminder_json,'$.dayOfMonth')) ELSE 1 END,
      COALESCE(TRY_CONVERT(TIME(0),JSON_VALUE(reminder.reminder_json,'$.time')),CONVERT(TIME(0),'08:00')),
      COALESCE(NULLIF(JSON_VALUE(reminder.reminder_json,'$.timezone'),N''),N'America/Bogota'),
      COALESCE(NULLIF(LTRIM(RTRIM(JSON_VALUE(reminder.reminder_json,'$.subject'))),N''),
        CASE reminder.reminder_kind WHEN 'sag_web_version'
          THEN N'Recordatorio: guardar la última versión mensual de SAG Web'
          ELSE N'Recordatorio: crear documento ¿Qué hay de nuevo en SAG Web?' END)
    FROM migration.stage_app_settings AS s
    CROSS APPLY
    (
      VALUES
        ('sag_web_version',JSON_QUERY(s.settings_json,'$.administrativeReminders.sagWebVersionReminder')),
        ('whats_new',JSON_QUERY(s.settings_json,'$.administrativeReminders.whatsNewReminder'))
    ) AS reminder(reminder_kind,reminder_json)
    WHERE s.run_key=@run_key AND reminder.reminder_json IS NOT NULL;

    INSERT settings.administrative_reminder_recipients(reminder_kind,email_normalized)
    SELECT DISTINCT reminder.reminder_kind,LOWER(LTRIM(RTRIM(email_value.[value])))
    FROM migration.stage_app_settings AS s
    CROSS APPLY
    (
      VALUES
        ('sag_web_version',JSON_QUERY(s.settings_json,'$.administrativeReminders.sagWebVersionReminder.recipients')),
        ('whats_new',JSON_QUERY(s.settings_json,'$.administrativeReminders.whatsNewReminder.recipients'))
    ) AS reminder(reminder_kind,recipients_json)
    CROSS APPLY OPENJSON(COALESCE(reminder.recipients_json,N'[]')) AS email_value
    WHERE s.run_key=@run_key AND NULLIF(LTRIM(RTRIM(email_value.[value])),N'') IS NOT NULL;

    INSERT content.files
      (storage_provider,storage_container,blob_name,original_name,mime_type,byte_count,
       content_sha256,created_at,created_by)
    SELECT 'azure_blob',t.blob_container,t.blob_name,t.original_name,t.mime_type,
      t.expected_byte_count,t.expected_sha256,
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),t.planned_at),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration')
    FROM migration.file_transfers AS t
    JOIN migration.raw_documents AS r
      ON r.run_key=t.run_key AND r.source_container=t.source_container AND r.source_id=t.source_id
    WHERE t.run_key=@run_key AND t.source_container IN (N'formatosImpresion',N'publicDownloads')
      AND t.status='verified';

    INSERT content.print_format_sources
      (source_id,name,name_normalized,description,active,status,created_at,created_by,
       updated_at,updated_by,deleted_at,deleted_by)
    SELECT s.source_id,LTRIM(RTRIM(s.name)),LOWER(LTRIM(RTRIM(s.name))),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.descripcion'))),N''),
      CASE state.entity_status WHEN 'active' THEN 1 ELSE 0 END,state.entity_status,
      timestamp_value.created_at,COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN timestamp_value.updated_candidate<timestamp_value.created_at
        THEN timestamp_value.created_at ELSE timestamp_value.updated_candidate END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN state.entity_status='deleted' THEN TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      CASE WHEN state.entity_status='deleted' THEN JSON_VALUE(r.raw_json,'$.deletedBy') END
    FROM migration.stage_print_format_sources AS s
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'fuentesFormatos' AND r.source_id=s.source_id
    CROSS APPLY (SELECT CASE WHEN s.status IN ('active','inactive','deleted') THEN s.status
      WHEN s.active=0 THEN 'inactive' ELSE 'active' END AS entity_status) AS state
    CROSS APPLY
    (
      SELECT COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS created_at,
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
          TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS updated_candidate
    ) AS timestamp_value
    WHERE s.run_key=@run_key;

    INSERT content.print_formats
      (source_id,print_format_source_key,name,name_normalized,description,format_size,
       custom_format_size,requires_license,module_key,legacy_import_code,legacy_import_status,
       legacy_variant,active,status,created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT f.source_id,source_record.print_format_source_key,LTRIM(RTRIM(f.name)),LOWER(LTRIM(RTRIM(f.name))),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.descripcion'))),N''),f.format_size,
      CASE WHEN f.format_size='personalizado'
        THEN NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.tamanoFormatoPersonalizado'))),N'') END,
      COALESCE(f.requires_license,0),CASE WHEN COALESCE(f.requires_license,0)=1 THEN module_record.module_key END,
      f.legacy_import_code,f.legacy_import_status,f.legacy_variant,
      CASE state.entity_status WHEN 'active' THEN 1 ELSE 0 END,state.entity_status,
      timestamp_value.created_at,COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN timestamp_value.updated_candidate<timestamp_value.created_at
        THEN timestamp_value.created_at ELSE timestamp_value.updated_candidate END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN state.entity_status='deleted' THEN TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      CASE WHEN state.entity_status='deleted' THEN JSON_VALUE(r.raw_json,'$.deletedBy') END
    FROM migration.stage_print_formats AS f
    JOIN migration.raw_documents AS r
      ON r.run_key=f.run_key AND r.source_container=N'formatosImpresion' AND r.source_id=f.source_id
    JOIN content.print_format_sources AS source_record ON source_record.source_id=f.print_format_source_id
    LEFT JOIN licensing.license_modules AS module_record ON module_record.source_id=f.module_source_id
    CROSS APPLY (SELECT CASE WHEN f.status IN ('active','inactive','deleted') THEN f.status
      WHEN f.active=0 THEN 'inactive' ELSE 'active' END AS entity_status) AS state
    CROSS APPLY
    (
      SELECT COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS created_at,
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
          TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS updated_candidate
    ) AS timestamp_value
    WHERE f.run_key=@run_key;

    INSERT content.print_format_files(print_format_key,version_no,file_key,is_current,created_at,created_by)
    SELECT format_record.print_format_key,1,file_record.file_key,1,file_record.created_at,file_record.created_by
    FROM migration.stage_print_formats AS f
    JOIN content.print_formats AS format_record ON format_record.source_id=f.source_id
    JOIN migration.file_transfers AS t
      ON t.run_key=f.run_key AND t.source_container=N'formatosImpresion' AND t.source_id=f.source_id AND t.file_slot='pdf'
    JOIN content.files AS file_record
      ON file_record.storage_provider='azure_blob' AND file_record.storage_container=t.blob_container
        AND file_record.blob_name=t.blob_name
    WHERE f.run_key=@run_key;

    INSERT content.public_download_sections
      (source_id,name,name_normalized,slug,slug_normalized,description,active,status,
       created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT d.source_id,LTRIM(RTRIM(d.name_or_title)),LOWER(LTRIM(RTRIM(d.name_or_title))),
      LTRIM(RTRIM(d.slug)),LOWER(LTRIM(RTRIM(d.slug))),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.descripcion'))),N''),
      CASE state.entity_status WHEN 'active' THEN 1 ELSE 0 END,state.entity_status,
      timestamp_value.created_at,COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN timestamp_value.updated_candidate<timestamp_value.created_at
        THEN timestamp_value.created_at ELSE timestamp_value.updated_candidate END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN state.entity_status='deleted' THEN TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      CASE WHEN state.entity_status='deleted' THEN JSON_VALUE(r.raw_json,'$.deletedBy') END
    FROM migration.stage_public_downloads AS d
    JOIN migration.raw_documents AS r
      ON r.run_key=d.run_key AND r.source_container=N'publicDownloads' AND r.source_id=d.source_id
    CROSS APPLY (SELECT CASE WHEN d.status IN ('active','inactive','deleted') THEN d.status
      WHEN d.active=0 THEN 'inactive' ELSE 'active' END AS entity_status) AS state
    CROSS APPLY
    (
      SELECT COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS created_at,
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
          TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS updated_candidate
    ) AS timestamp_value
    WHERE d.run_key=@run_key AND d.record_type='section';

    INSERT content.public_download_documents
      (source_id,section_key,title,slug,slug_normalized,description,active,status,
       created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT d.source_id,section_record.section_key,LTRIM(RTRIM(d.name_or_title)),LTRIM(RTRIM(d.slug)),
      LOWER(LTRIM(RTRIM(d.slug))),NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.descripcion'))),N''),
      CASE state.entity_status WHEN 'active' THEN 1 ELSE 0 END,state.entity_status,
      timestamp_value.created_at,COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN timestamp_value.updated_candidate<timestamp_value.created_at
        THEN timestamp_value.created_at ELSE timestamp_value.updated_candidate END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN state.entity_status='deleted' THEN TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      CASE WHEN state.entity_status='deleted' THEN JSON_VALUE(r.raw_json,'$.deletedBy') END
    FROM migration.stage_public_downloads AS d
    JOIN migration.raw_documents AS r
      ON r.run_key=d.run_key AND r.source_container=N'publicDownloads' AND r.source_id=d.source_id
    JOIN content.public_download_sections AS section_record ON section_record.source_id=d.section_source_id
    CROSS APPLY (SELECT CASE WHEN d.status IN ('active','inactive','deleted') THEN d.status
      WHEN d.active=0 THEN 'inactive' ELSE 'active' END AS entity_status) AS state
    CROSS APPLY
    (
      SELECT COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS created_at,
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
          TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS updated_candidate
    ) AS timestamp_value
    WHERE d.run_key=@run_key AND d.record_type='document';

    INSERT content.public_download_files(document_key,version_no,file_key,is_current,created_at,created_by)
    SELECT document_record.document_key,1,file_record.file_key,1,file_record.created_at,file_record.created_by
    FROM migration.stage_public_downloads AS d
    JOIN content.public_download_documents AS document_record ON document_record.source_id=d.source_id
    JOIN migration.file_transfers AS t
      ON t.run_key=d.run_key AND t.source_container=N'publicDownloads' AND t.source_id=d.source_id AND t.file_slot='document'
    JOIN content.files AS file_record
      ON file_record.storage_provider='azure_blob' AND file_record.storage_container=t.blob_container
        AND file_record.blob_name=t.blob_name
    WHERE d.run_key=@run_key AND d.record_type='document';

    INSERT notifications.email_notifications
      (source_id,notification_type,entity_type,entity_source_id,task_key,idempotency_key,
       period,send_date,subject,status,attempt_count,sent_at,metadata_json,
       created_at,created_by,updated_at,updated_by)
    SELECT n.source_id,n.notification_type,
      CASE n.notification_type WHEN 'administrative_reminder' THEN N'administrative_reminder'
        WHEN 'blocked_task_reminder' THEN N'task' WHEN 'task_reminder' THEN N'task'
        WHEN 'overdue_alert' THEN N'task' WHEN 'password_notification' THEN N'user' END,
      n.entity_source_id,COALESCE(task_record.task_key,task_alias.task_key),n.source_id,
      n.period,n.send_date,NULLIF(JSON_VALUE(r.raw_json,'$.subject'),N''),
      CASE WHEN n.sent_at IS NOT NULL THEN 'sent' ELSE 'pending' END,
      CASE WHEN n.sent_at IS NOT NULL THEN 1 ELSE 0 END,n.sent_at,
      CASE WHEN n.days_after IS NULL THEN NULL
        ELSE CONCAT(N'{"daysAfter":',CONVERT(NVARCHAR(10),n.days_after),N'}') END,
      timestamp_value.created_at,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN timestamp_value.updated_candidate<timestamp_value.created_at
        THEN timestamp_value.created_at ELSE timestamp_value.updated_candidate END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration')
    FROM migration.stage_email_notifications AS n
    JOIN migration.raw_documents AS r
      ON r.run_key=n.run_key AND r.source_container=N'emailNotifications' AND r.source_id=n.source_id
    LEFT JOIN workflow.update_tasks AS task_record ON task_record.source_id=n.entity_source_id
    LEFT JOIN workflow.task_source_aliases AS task_alias ON task_alias.alias_source_id=n.entity_source_id
    CROSS APPLY
    (
      SELECT COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),n.sent_at,@now) AS created_at,
        COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),n.sent_at,
          TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) AS updated_candidate
    ) AS timestamp_value
    WHERE n.run_key=@run_key;

    INSERT notifications.email_notification_recipients
      (notification_key,email,email_normalized,recipient_type,delivery_status)
    SELECT notification.notification_key,MIN(LTRIM(RTRIM(email_value.[value]))),
      LOWER(LTRIM(RTRIM(email_value.[value]))),'to',
      CASE notification.status WHEN 'sent' THEN 'sent' ELSE 'pending' END
    FROM migration.stage_email_notifications AS n
    JOIN notifications.email_notifications AS notification ON notification.source_id=n.source_id
    CROSS APPLY OPENJSON(COALESCE(n.recipients_json,N'[]')) AS email_value
    WHERE n.run_key=@run_key AND NULLIF(LTRIM(RTRIM(email_value.[value])),N'') IS NOT NULL
    GROUP BY notification.notification_key,LOWER(LTRIM(RTRIM(email_value.[value]))),notification.status;

    INSERT audit.audit_logs
      (source_id,entity_type,entity_source_id,client_key,client_name_snapshot,
       domain_key,domain_name_snapshot,company_name_snapshot,action,performed_by,
       performed_by_email,performed_at,before_json,after_json,metadata_json,
       schema_version,data_classification)
    SELECT a.source_id,COALESCE(NULLIF(a.entity_type,N''),N'unknown'),
      COALESCE(NULLIF(a.entity_source_id,N''),N'unknown'),client.client_key,
      NULLIF(JSON_VALUE(r.raw_json,'$.clientName'),N''),domain_record.domain_key,
      NULLIF(JSON_VALUE(r.raw_json,'$.domainName'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.companyName'),N''),
      COALESCE(NULLIF(a.action,N''),N'unknown'),COALESCE(NULLIF(a.performed_by,N''),N'system'),
      NULLIF(JSON_VALUE(r.raw_json,'$.performedByEmail'),N''),COALESCE(a.performed_at,@now),
      a.before_json,a.after_json,a.metadata_json,1,'internal'
    FROM migration.stage_audit_logs AS a
    JOIN migration.raw_documents AS r
      ON r.run_key=a.run_key AND r.source_container=N'auditLogs' AND r.source_id=a.source_id
    LEFT JOIN core.clients AS client ON client.source_id=a.client_source_id
    LEFT JOIN core.domains AS domain_record ON domain_record.source_id=a.domain_source_id
      AND (client.client_key IS NULL OR domain_record.client_key=client.client_key)
    WHERE a.run_key=@run_key;

    UPDATE migration.file_transfers
    SET status='linked',linked_at=SYSUTCDATETIME(),last_error=NULL
    WHERE run_key=@run_key AND source_container IN (N'formatosImpresion',N'publicDownloads') AND status='verified';

    DELETE FROM migration.reconciliation_counts
    WHERE run_key=@run_key AND reconciliation_code LIKE N'operational_final:%';

    INSERT migration.reconciliation_counts(run_key,reconciliation_code,source_count,target_count)
    SELECT @run_key,N'operational_final:email_settings',
      (SELECT COUNT_BIG(*) FROM migration.stage_app_settings WHERE run_key=@run_key),
      (SELECT COUNT_BIG(*) FROM settings.email_settings)
    UNION ALL SELECT @run_key,N'operational_final:default_reminder_days',
      (SELECT COUNT_BIG(*) FROM (SELECT DISTINCT TRY_CONVERT(SMALLINT,j.[value]) AS value
        FROM migration.stage_app_settings AS s CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.defaultReminderDaysBefore'),N'[]')) AS j
        WHERE s.run_key=@run_key AND TRY_CONVERT(SMALLINT,j.[value])>=0) AS expected),
      (SELECT COUNT_BIG(*) FROM settings.default_reminder_days)
    UNION ALL SELECT @run_key,N'operational_final:alert_recipient_roles',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT original_role.alert_kind,
           CASE original_role.role_id
             WHEN N'admin' THEN N'super_admin'
             WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
             WHEN N'client_manager' THEN N'client_operations_manager'
             WHEN N'viewer' THEN N'audit_viewer'
             WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
             ELSE original_role.role_id END AS role_id
         FROM
         (
           SELECT 'overdue' AS alert_kind,role_value.role_id
           FROM migration.stage_app_settings AS s
           CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertRecipientRoleIds'),N'[]'))
             WITH (role_id NVARCHAR(80) '$') AS role_value WHERE s.run_key=@run_key
           UNION ALL
           SELECT 'blocked',role_value.role_id
           FROM migration.stage_app_settings AS s
           CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedAlertRecipientRoleIds'),N'[]'))
             WITH (role_id NVARCHAR(80) '$') AS role_value WHERE s.run_key=@run_key
         ) AS original_role
       ) AS expected),(SELECT COUNT_BIG(*) FROM settings.alert_recipient_roles)
    UNION ALL SELECT @run_key,N'operational_final:alert_recipient_emails',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT email_source.alert_kind,email_source.email_normalized,email_source.source_kind
         FROM
         (
           SELECT 'overdue' AS alert_kind,LOWER(LTRIM(RTRIM(j.[value]))) AS email_normalized,'current' AS source_kind
           FROM migration.stage_app_settings AS s
           CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertCustomEmails'),N'[]')) AS j
           WHERE s.run_key=@run_key
           UNION ALL
           SELECT 'blocked',LOWER(LTRIM(RTRIM(j.[value]))),'current'
           FROM migration.stage_app_settings AS s
           CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedAlertCustomEmails'),N'[]')) AS j
           WHERE s.run_key=@run_key
           UNION ALL
           SELECT 'overdue',LOWER(LTRIM(RTRIM(j.[value]))),'legacy'
           FROM migration.stage_app_settings AS s
           CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.customAdminAlertEmails'),N'[]')) AS j
           WHERE s.run_key=@run_key
         ) AS email_source
         WHERE NULLIF(email_source.email_normalized,N'') IS NOT NULL
       ) AS expected),(SELECT COUNT_BIG(*) FROM settings.alert_recipient_emails)
    UNION ALL SELECT @run_key,N'operational_final:overdue_alert_weekdays',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT CASE UPPER(j.[value])
           WHEN 'MONDAY' THEN 1 WHEN 'TUESDAY' THEN 2 WHEN 'WEDNESDAY' THEN 3
           WHEN 'THURSDAY' THEN 4 WHEN 'FRIDAY' THEN 5 WHEN 'SATURDAY' THEN 6 WHEN 'SUNDAY' THEN 7 END AS weekday
         FROM migration.stage_app_settings AS s
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.overdueAlertWeekdays'),N'[]')) AS j
         WHERE s.run_key=@run_key
       ) AS expected WHERE weekday IS NOT NULL),(SELECT COUNT_BIG(*) FROM settings.overdue_alert_weekdays)
    UNION ALL SELECT @run_key,N'operational_final:blocked_reminder_days',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT TRY_CONVERT(SMALLINT,j.[value]) AS days_after
         FROM migration.stage_app_settings AS s
         CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(s.settings_json,'$.blockedReminderDaysAfter'),N'[]')) AS j
         WHERE s.run_key=@run_key AND TRY_CONVERT(SMALLINT,j.[value])>=0
       ) AS expected),(SELECT COUNT_BIG(*) FROM settings.blocked_reminder_days)
    UNION ALL SELECT @run_key,N'operational_final:administrative_reminders',
      (SELECT COUNT_BIG(*)
       FROM migration.stage_app_settings AS s
       CROSS APPLY
       (
         VALUES
           (JSON_QUERY(s.settings_json,'$.administrativeReminders.sagWebVersionReminder')),
           (JSON_QUERY(s.settings_json,'$.administrativeReminders.whatsNewReminder'))
       ) AS reminder(reminder_json)
       WHERE s.run_key=@run_key AND reminder.reminder_json IS NOT NULL),
      (SELECT COUNT_BIG(*) FROM settings.administrative_reminders)
    UNION ALL SELECT @run_key,N'operational_final:administrative_reminder_recipients',
      (SELECT COUNT_BIG(*) FROM
       (
         SELECT DISTINCT reminder.reminder_kind,LOWER(LTRIM(RTRIM(j.[value]))) AS email_normalized
         FROM migration.stage_app_settings AS s
         CROSS APPLY
         (
           VALUES
             ('sag_web_version',JSON_QUERY(s.settings_json,'$.administrativeReminders.sagWebVersionReminder.recipients')),
             ('whats_new',JSON_QUERY(s.settings_json,'$.administrativeReminders.whatsNewReminder.recipients'))
         ) AS reminder(reminder_kind,recipients_json)
         CROSS APPLY OPENJSON(COALESCE(reminder.recipients_json,N'[]')) AS j
         WHERE s.run_key=@run_key AND NULLIF(LTRIM(RTRIM(j.[value])),N'') IS NOT NULL
       ) AS expected),(SELECT COUNT_BIG(*) FROM settings.administrative_reminder_recipients)
    UNION ALL SELECT @run_key,N'operational_final:files',@expected_file_count,(SELECT COUNT_BIG(*) FROM content.files)
    UNION ALL SELECT @run_key,N'operational_final:print_format_sources',
      (SELECT COUNT_BIG(*) FROM migration.stage_print_format_sources WHERE run_key=@run_key),(SELECT COUNT_BIG(*) FROM content.print_format_sources)
    UNION ALL SELECT @run_key,N'operational_final:print_formats',
      (SELECT COUNT_BIG(*) FROM migration.stage_print_formats WHERE run_key=@run_key),(SELECT COUNT_BIG(*) FROM content.print_formats)
    UNION ALL SELECT @run_key,N'operational_final:print_format_files',
      (SELECT COUNT_BIG(*) FROM migration.stage_print_formats WHERE run_key=@run_key),(SELECT COUNT_BIG(*) FROM content.print_format_files)
    UNION ALL SELECT @run_key,N'operational_final:public_download_sections',
      (SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key AND record_type='section'),
      (SELECT COUNT_BIG(*) FROM content.public_download_sections)
    UNION ALL SELECT @run_key,N'operational_final:public_download_documents',
      (SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key AND record_type='document'),
      (SELECT COUNT_BIG(*) FROM content.public_download_documents)
    UNION ALL SELECT @run_key,N'operational_final:public_download_files',
      (SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key AND record_type='document'),
      (SELECT COUNT_BIG(*) FROM content.public_download_files)
    UNION ALL SELECT @run_key,N'operational_final:email_notifications',
      (SELECT COUNT_BIG(*) FROM migration.stage_email_notifications WHERE run_key=@run_key),(SELECT COUNT_BIG(*) FROM notifications.email_notifications)
    UNION ALL SELECT @run_key,N'operational_final:email_notification_recipients',
      (SELECT COUNT_BIG(*) FROM (SELECT DISTINCT n.source_id,LOWER(LTRIM(RTRIM(j.[value]))) AS email
        FROM migration.stage_email_notifications AS n CROSS APPLY OPENJSON(COALESCE(n.recipients_json,N'[]')) AS j
        WHERE n.run_key=@run_key AND NULLIF(LTRIM(RTRIM(j.[value])),N'') IS NOT NULL) AS expected),
      (SELECT COUNT_BIG(*) FROM notifications.email_notification_recipients)
    UNION ALL SELECT @run_key,N'operational_final:email_notification_attempts',0,(SELECT COUNT_BIG(*) FROM notifications.email_notification_attempts)
    UNION ALL SELECT @run_key,N'operational_final:audit_logs',
      (SELECT COUNT_BIG(*) FROM migration.stage_audit_logs WHERE run_key=@run_key),(SELECT COUNT_BIG(*) FROM audit.audit_logs)
    UNION ALL SELECT @run_key,N'operational_final:linked_file_transfers',@expected_file_count,
      (SELECT COUNT_BIG(*) FROM migration.file_transfers WHERE run_key=@run_key
        AND source_container IN (N'formatosImpresion',N'publicDownloads') AND status='linked');

    IF EXISTS
    (
      SELECT 1 FROM migration.reconciliation_counts
      WHERE run_key=@run_key AND reconciliation_code LIKE N'operational_final:%' AND reconciled=0
    )
      THROW 51175, N'Final operational reconciliation failed.', 1;

    UPDATE migration.raw_documents
    SET processing_status='loaded'
    WHERE run_key=@run_key AND source_container IN
      (N'appSettings',N'emailNotifications',N'fuentesFormatos',N'formatosImpresion',N'publicDownloads',N'auditLogs');

    UPDATE migration.stage_app_settings SET transform_status='loaded' WHERE run_key=@run_key;
    UPDATE migration.stage_email_notifications SET transform_status='loaded' WHERE run_key=@run_key;
    UPDATE migration.stage_print_format_sources SET transform_status='loaded' WHERE run_key=@run_key;
    UPDATE migration.stage_print_formats SET transform_status='loaded' WHERE run_key=@run_key;
    UPDATE migration.stage_public_downloads SET transform_status='loaded' WHERE run_key=@run_key;
    UPDATE migration.stage_audit_logs SET transform_status='loaded' WHERE run_key=@run_key;

    SELECT @target_count=
      (SELECT COUNT_BIG(*) FROM settings.email_settings)+
      (SELECT COUNT_BIG(*) FROM settings.default_reminder_days)+
      (SELECT COUNT_BIG(*) FROM settings.alert_recipient_roles)+
      (SELECT COUNT_BIG(*) FROM settings.alert_recipient_emails)+
      (SELECT COUNT_BIG(*) FROM settings.overdue_alert_weekdays)+
      (SELECT COUNT_BIG(*) FROM settings.blocked_reminder_days)+
      (SELECT COUNT_BIG(*) FROM settings.administrative_reminders)+
      (SELECT COUNT_BIG(*) FROM settings.administrative_reminder_recipients)+
      (SELECT COUNT_BIG(*) FROM content.files)+
      (SELECT COUNT_BIG(*) FROM content.print_format_sources)+
      (SELECT COUNT_BIG(*) FROM content.print_formats)+
      (SELECT COUNT_BIG(*) FROM content.print_format_files)+
      (SELECT COUNT_BIG(*) FROM content.public_download_sections)+
      (SELECT COUNT_BIG(*) FROM content.public_download_documents)+
      (SELECT COUNT_BIG(*) FROM content.public_download_files)+
      (SELECT COUNT_BIG(*) FROM notifications.email_notifications)+
      (SELECT COUNT_BIG(*) FROM notifications.email_notification_recipients)+
      (SELECT COUNT_BIG(*) FROM notifications.email_notification_attempts)+
      (SELECT COUNT_BIG(*) FROM audit.audit_logs);

    UPDATE migration.operational_load_phases
    SET status='completed',completed_at=SYSUTCDATETIME(),target_count=@target_count,
        details=N'Settings, verified content links, notification idempotency and append-only audit loaded and reconciled.'
    WHERE run_key=@run_key AND phase_code=@phase_code;

    UPDATE migration.migration_runs
    SET status='completed',completed_at=SYSUTCDATETIME(),
        loaded_record_count=(SELECT SUM(COALESCE(target_count,0)) FROM migration.operational_load_phases WHERE run_key=@run_key)
    WHERE run_key=@run_key;

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

PRINT N'011 complete: final settings/content/notifications/audit loader created.';
GO
