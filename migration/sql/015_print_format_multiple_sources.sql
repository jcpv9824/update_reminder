/*
  Portal SAG Web - Gate C/D / 015
  Add the approved many-to-many relationship between print formats and source
  types. content.print_formats.print_format_source_key remains the primary
  compatibility source represented by Cosmos fuenteId. Membership and public
  filtering use content.print_format_source_assignments.

  The wrapper keeps phase 011 plus source-link normalization in one outer
  transaction. No Base64 payload is copied into operational SQL.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME()<>N'PortalSAGWeb' THROW 51500,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 51501,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='014' AND succeeded=1
)
  THROW 51502,N'Migration 014 must be recorded before migration 015.',1;
IF OBJECT_ID(N'content.print_formats',N'U') IS NULL
   OR OBJECT_ID(N'content.print_format_sources',N'U') IS NULL
   OR OBJECT_ID(N'migration.usp_load_operational_settings_content_notifications_audit',N'P') IS NULL
  THROW 51503,N'Migrations 005 and 011 must be installed before migration 015.',1;

BEGIN TRANSACTION;

IF OBJECT_ID(N'content.print_format_source_assignments',N'U') IS NULL
BEGIN
  CREATE TABLE content.print_format_source_assignments
  (
    print_format_key         BIGINT NOT NULL,
    print_format_source_key  BIGINT NOT NULL,
    display_order            SMALLINT NOT NULL,
    assigned_at              DATETIME2(3) NOT NULL CONSTRAINT DF_print_format_source_assignments_at DEFAULT SYSUTCDATETIME(),
    assigned_by              NVARCHAR(150) NOT NULL,
    CONSTRAINT PK_print_format_source_assignments
      PRIMARY KEY CLUSTERED (print_format_key,print_format_source_key),
    CONSTRAINT FK_print_format_source_assignments_format
      FOREIGN KEY (print_format_key) REFERENCES content.print_formats(print_format_key),
    CONSTRAINT FK_print_format_source_assignments_source
      FOREIGN KEY (print_format_source_key) REFERENCES content.print_format_sources(print_format_source_key),
    CONSTRAINT CK_print_format_source_assignments_order CHECK (display_order BETWEEN 0 AND 49)
  );

  CREATE UNIQUE INDEX UX_print_format_source_assignments_order
    ON content.print_format_source_assignments(print_format_key,display_order);
  CREATE INDEX IX_print_format_source_assignments_source
    ON content.print_format_source_assignments(print_format_source_key,print_format_key)
    INCLUDE (display_order);
END;

/* Safe compatibility backfill when 015 is added to an already populated build. */
INSERT content.print_format_source_assignments
  (print_format_key,print_format_source_key,display_order,assigned_at,assigned_by)
SELECT f.print_format_key,f.print_format_source_key,0,f.created_at,COALESCE(NULLIF(f.created_by,N''),N'migration')
FROM content.print_formats AS f
WHERE NOT EXISTS
(
  SELECT 1 FROM content.print_format_source_assignments AS a
  WHERE a.print_format_key=f.print_format_key
);
GO

CREATE OR ALTER VIEW content.v_print_format_source_links
AS
SELECT
  f.print_format_key,
  f.source_id AS print_format_source_id,
  f.name AS print_format_name,
  f.name_normalized AS print_format_name_normalized,
  f.status AS print_format_status,
  s.print_format_source_key,
  s.source_id AS source_type_source_id,
  s.name AS source_type_name,
  s.active AS source_type_active,
  s.status AS source_type_status,
  a.display_order,
  CONVERT(BIT,CASE WHEN f.print_format_source_key=s.print_format_source_key THEN 1 ELSE 0 END) AS is_primary
FROM content.print_format_source_assignments AS a
JOIN content.print_formats AS f ON f.print_format_key=a.print_format_key
JOIN content.print_format_sources AS s ON s.print_format_source_key=a.print_format_source_key;
GO

CREATE OR ALTER VIEW content.v_public_print_formats
AS
SELECT
  f.print_format_key,
  f.source_id AS print_format_source_id,
  f.name,
  f.description,
  f.format_size,
  f.custom_format_size,
  f.requires_license,
  f.module_key,
  s.source_id AS source_type_source_id,
  s.name AS source_type_name,
  a.display_order,
  CONVERT(BIT,CASE WHEN f.print_format_source_key=s.print_format_source_key THEN 1 ELSE 0 END) AS is_primary
FROM content.print_format_source_assignments AS a
JOIN content.print_formats AS f ON f.print_format_key=a.print_format_key
JOIN content.print_format_sources AS s ON s.print_format_source_key=a.print_format_source_key
WHERE f.active=1 AND f.status='active' AND s.active=1 AND s.status='active';
GO

CREATE OR ALTER TRIGGER content.TR_print_format_source_assignments_rules
ON content.print_format_source_assignments
AFTER INSERT,UPDATE,DELETE
AS
BEGIN
  SET NOCOUNT ON;

  IF EXISTS
  (
    SELECT 1
    FROM content.print_formats AS f
    LEFT JOIN content.print_format_source_assignments AS primary_link
      ON primary_link.print_format_key=f.print_format_key
     AND primary_link.print_format_source_key=f.print_format_source_key
    WHERE primary_link.print_format_key IS NULL
  )
    THROW 51510,N'Every print format must retain its primary source assignment.',1;

  IF EXISTS
  (
    SELECT 1
    FROM content.print_format_source_assignments
    GROUP BY print_format_key
    HAVING COUNT_BIG(*)>50
  )
    THROW 51511,N'A print format cannot have more than 50 source assignments.',1;

  IF EXISTS
  (
    SELECT 1
    FROM content.print_format_source_assignments AS left_link
    JOIN content.print_formats AS left_format ON left_format.print_format_key=left_link.print_format_key
    JOIN content.print_format_source_assignments AS right_link
      ON right_link.print_format_source_key=left_link.print_format_source_key
     AND right_link.print_format_key>left_link.print_format_key
    JOIN content.print_formats AS right_format ON right_format.print_format_key=right_link.print_format_key
    WHERE left_format.status<>'deleted' AND right_format.status<>'deleted'
      AND left_format.name_normalized=right_format.name_normalized
  )
    THROW 51512,N'Print-format names must be unique within every assigned source.',1;
END;
GO

CREATE OR ALTER TRIGGER content.TR_print_formats_source_consistency
ON content.print_formats
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT (UPDATE(print_format_source_key) OR UPDATE(name_normalized) OR UPDATE(status)) RETURN;

  IF EXISTS
  (
    SELECT 1
    FROM inserted AS i
    LEFT JOIN content.print_format_source_assignments AS primary_link
      ON primary_link.print_format_key=i.print_format_key
     AND primary_link.print_format_source_key=i.print_format_source_key
    WHERE primary_link.print_format_key IS NULL
  )
    THROW 51513,N'The primary print-format source must exist in its assignment set.',1;

  IF EXISTS
  (
    SELECT 1
    FROM content.print_format_source_assignments AS left_link
    JOIN content.print_formats AS left_format ON left_format.print_format_key=left_link.print_format_key
    JOIN content.print_format_source_assignments AS right_link
      ON right_link.print_format_source_key=left_link.print_format_source_key
     AND right_link.print_format_key>left_link.print_format_key
    JOIN content.print_formats AS right_format ON right_format.print_format_key=right_link.print_format_key
    WHERE left_format.status<>'deleted' AND right_format.status<>'deleted'
      AND left_format.name_normalized=right_format.name_normalized
  )
    THROW 51514,N'Print-format names must be unique within every assigned source.',1;
END;
GO

CREATE OR ALTER PROCEDURE migration.usp_load_print_format_source_assignments
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  IF NOT EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='settings_content_notifications_audit' AND status='completed'
  )
    THROW 51520,N'The phase-011 operational content load must complete first.',1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_print_formats AS f
    JOIN migration.raw_documents AS r
      ON r.run_key=f.run_key AND r.source_container=N'formatosImpresion' AND r.source_id=f.source_id
    WHERE f.run_key=@run_key AND
    (
      f.print_format_source_id IS NULL
      OR (JSON_QUERY(r.raw_json,'$.fuenteIds') IS NOT NULL
          AND LEFT(LTRIM(JSON_QUERY(r.raw_json,'$.fuenteIds')),1)<>N'[')
      OR JSON_VALUE(r.raw_json,'$.fuenteIds') IS NOT NULL
    )
  )
    THROW 51521,N'Print-format source arrays or primary compatibility IDs are invalid.',1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_print_formats AS f
    JOIN migration.raw_documents AS r
      ON r.run_key=f.run_key AND r.source_container=N'formatosImpresion' AND r.source_id=f.source_id
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(r.raw_json,'$.fuenteIds'),N'[]')) AS j
    WHERE f.run_key=@run_key
      AND (j.[type]<>1 OR NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(4000),j.[value]))),N'') IS NULL
        OR LEN(LTRIM(RTRIM(CONVERT(NVARCHAR(4000),j.[value]))))>150)
  )
    THROW 51522,N'Print-format source arrays must contain non-empty string IDs up to 150 characters.',1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.stage_print_formats AS f
    JOIN migration.raw_documents AS r
      ON r.run_key=f.run_key AND r.source_container=N'formatosImpresion' AND r.source_id=f.source_id
    OUTER APPLY
    (
      SELECT COUNT_BIG(*) AS item_count,
        COUNT(DISTINCT LTRIM(RTRIM(CONVERT(NVARCHAR(150),j.[value])))) AS distinct_count,
        MAX(CASE WHEN j.[key]='0' THEN LTRIM(RTRIM(CONVERT(NVARCHAR(150),j.[value]))) END) AS first_source_id
      FROM OPENJSON(COALESCE(JSON_QUERY(r.raw_json,'$.fuenteIds'),N'[]')) AS j
    ) AS source_array
    WHERE f.run_key=@run_key AND
      (source_array.item_count>50 OR source_array.item_count<>source_array.distinct_count
       OR (source_array.item_count>0 AND source_array.first_source_id<>f.print_format_source_id))
  )
    THROW 51523,N'Print-format source arrays must be distinct, limited to 50, and start with fuenteId.',1;

  CREATE TABLE #format_source_plan
  (
    format_source_id NVARCHAR(150) NOT NULL,
    source_source_id NVARCHAR(150) NOT NULL,
    display_order SMALLINT NOT NULL,
    PRIMARY KEY (format_source_id,source_source_id),
    UNIQUE (format_source_id,display_order)
  );

  ;WITH source_candidates AS
  (
    SELECT f.source_id AS format_source_id,
      LTRIM(RTRIM(CONVERT(NVARCHAR(150),j.[value]))) AS source_source_id,
      TRY_CONVERT(INT,j.[key]) AS original_order
    FROM migration.stage_print_formats AS f
    JOIN migration.raw_documents AS r
      ON r.run_key=f.run_key AND r.source_container=N'formatosImpresion' AND r.source_id=f.source_id
    CROSS APPLY OPENJSON(COALESCE(JSON_QUERY(r.raw_json,'$.fuenteIds'),N'[]')) AS j
    WHERE f.run_key=@run_key AND j.[type]=1
      AND NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(150),j.[value]))),N'') IS NOT NULL

    UNION ALL

    SELECT f.source_id,f.print_format_source_id,0
    FROM migration.stage_print_formats AS f
    JOIN migration.raw_documents AS r
      ON r.run_key=f.run_key AND r.source_container=N'formatosImpresion' AND r.source_id=f.source_id
    WHERE f.run_key=@run_key AND NOT EXISTS
    (
      SELECT 1 FROM OPENJSON(COALESCE(JSON_QUERY(r.raw_json,'$.fuenteIds'),N'[]')) AS j
      WHERE j.[type]=1 AND NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(150),j.[value]))),N'') IS NOT NULL
    )
  ), ordered_candidates AS
  (
    SELECT format_source_id,source_source_id,
      CONVERT(SMALLINT,ROW_NUMBER() OVER
        (PARTITION BY format_source_id ORDER BY original_order,source_source_id)-1) AS display_order
    FROM source_candidates
  )
  INSERT #format_source_plan(format_source_id,source_source_id,display_order)
  SELECT format_source_id,source_source_id,display_order
  FROM ordered_candidates;

  IF EXISTS
  (
    SELECT 1 FROM #format_source_plan AS p
    LEFT JOIN content.print_format_sources AS s ON s.source_id=p.source_source_id
    WHERE s.print_format_source_key IS NULL
  )
    THROW 51524,N'A print-format source assignment references a missing source.',1;

  IF EXISTS (SELECT 1 FROM content.print_format_source_assignments)
  BEGIN
    IF (SELECT COUNT_BIG(*) FROM content.print_format_source_assignments)<>(SELECT COUNT_BIG(*) FROM #format_source_plan)
       OR EXISTS
       (
         SELECT 1
         FROM #format_source_plan AS p
         JOIN content.print_formats AS f ON f.source_id=p.format_source_id
         JOIN content.print_format_sources AS s ON s.source_id=p.source_source_id
         LEFT JOIN content.print_format_source_assignments AS a
           ON a.print_format_key=f.print_format_key AND a.print_format_source_key=s.print_format_source_key
              AND a.display_order=p.display_order
         WHERE a.print_format_key IS NULL
       )
      THROW 51525,N'Existing print-format source assignments do not match this migration run.',1;
  END
  ELSE
  BEGIN
    INSERT content.print_format_source_assignments
      (print_format_key,print_format_source_key,display_order,assigned_at,assigned_by)
    SELECT f.print_format_key,s.print_format_source_key,p.display_order,f.created_at,
      COALESCE(NULLIF(f.created_by,N''),N'migration')
    FROM #format_source_plan AS p
    JOIN content.print_formats AS f ON f.source_id=p.format_source_id
    JOIN content.print_format_sources AS s ON s.source_id=p.source_source_id;
  END;

  DELETE FROM migration.reconciliation_counts
  WHERE run_key=@run_key AND reconciliation_code=N'operational_final:print_format_source_assignments';

  INSERT migration.reconciliation_counts
    (run_key,reconciliation_code,source_count,target_count)
  SELECT @run_key,N'operational_final:print_format_source_assignments',
    (SELECT COUNT_BIG(*) FROM #format_source_plan),
    (SELECT COUNT_BIG(*) FROM content.print_format_source_assignments);

  IF EXISTS
  (
    SELECT 1 FROM migration.reconciliation_counts
    WHERE run_key=@run_key AND reconciliation_code=N'operational_final:print_format_source_assignments'
      AND reconciled=0
  )
    THROW 51526,N'Print-format source assignment reconciliation failed.',1;
END;
GO

CREATE OR ALTER PROCEDURE migration.usp_load_operational_final_with_print_sources
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  DECLARE @phase_result TABLE
  (
    run_key BIGINT,phase_code VARCHAR(60),status VARCHAR(20),source_count BIGINT,
    target_count BIGINT,completed_at DATETIME2(3)
  );

  BEGIN TRY
    BEGIN TRANSACTION;

    INSERT @phase_result(run_key,phase_code,status,source_count,target_count,completed_at)
    EXEC migration.usp_load_operational_settings_content_notifications_audit @run_key=@run_key;

    EXEC migration.usp_load_print_format_source_assignments @run_key=@run_key;

    UPDATE migration.operational_load_phases
    SET target_count=
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
      (SELECT COUNT_BIG(*) FROM content.print_format_source_assignments)+
      (SELECT COUNT_BIG(*) FROM content.print_format_files)+
      (SELECT COUNT_BIG(*) FROM content.public_download_sections)+
      (SELECT COUNT_BIG(*) FROM content.public_download_documents)+
      (SELECT COUNT_BIG(*) FROM content.public_download_files)+
      (SELECT COUNT_BIG(*) FROM notifications.email_notifications)+
      (SELECT COUNT_BIG(*) FROM notifications.email_notification_recipients)+
      (SELECT COUNT_BIG(*) FROM notifications.email_notification_attempts)+
      (SELECT COUNT_BIG(*) FROM audit.audit_logs),
      details=N'Settings, verified content links, multi-source print formats, notifications and audit loaded and reconciled.'
    WHERE run_key=@run_key AND phase_code='settings_content_notifications_audit';

    UPDATE migration.migration_runs
    SET loaded_record_count=
      (SELECT SUM(COALESCE(target_count,0)) FROM migration.operational_load_phases WHERE run_key=@run_key)
    WHERE run_key=@run_key;

    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;

  SELECT run_key,phase_code,status,source_count,target_count,completed_at
  FROM migration.operational_load_phases
  WHERE run_key=@run_key AND phase_code='settings_content_notifications_audit';
END;
GO

COMMIT TRANSACTION;
PRINT N'015 complete: print formats support multiple ordered source assignments.';
GO
