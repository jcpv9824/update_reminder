/* Portal SAG Web · Retiro lógico de Novedades y reportes privados sin correo.
   SQL Server 2019. No modifica filas históricas ni permisos existentes. */
SET XACT_ABORT ON;
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='063' AND succeeded=1)
  THROW 53501, N'083 requires the verified Novedades migration 063.', 1;
IF OBJECT_ID(N'whats_new.TR_reports_append_only',N'TR') IS NULL
   OR OBJECT_ID(N'whats_new.entries',N'U') IS NULL
  THROW 53502, N'083 requires the original entries and append-only reports.', 1;

BEGIN TRANSACTION;

IF OBJECT_ID(N'whats_new.report_withdrawals',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.report_withdrawals
  (
    report_key BIGINT NOT NULL,
    withdrawn_by_user_key BIGINT NOT NULL,
    withdrawn_at DATETIME2(3) NOT NULL,
    CONSTRAINT PK_whats_new_report_withdrawals PRIMARY KEY CLUSTERED (report_key),
    CONSTRAINT FK_whats_new_report_withdrawals_report FOREIGN KEY (report_key) REFERENCES whats_new.reports(report_key),
    CONSTRAINT FK_whats_new_report_withdrawals_actor FOREIGN KEY (withdrawn_by_user_key) REFERENCES security.users(user_key)
  );

  -- Preserve prior approval and archive facts when a visible entry is withdrawn.
  ALTER TABLE whats_new.entries DROP CONSTRAINT CK_entries_approved, CK_entries_archived;
  ALTER TABLE whats_new.entries WITH CHECK ADD CONSTRAINT CK_entries_approved CHECK
    ((status IN ('probado','archivada') AND approved_at IS NOT NULL AND release_month IS NOT NULL)
      OR (status='eliminada' AND approved_at IS NOT NULL AND release_month IS NOT NULL)
      OR (status NOT IN ('probado','archivada') AND approved_at IS NULL AND release_month IS NULL));
  ALTER TABLE whats_new.entries WITH CHECK ADD CONSTRAINT CK_entries_archived CHECK
    ((status='archivada' AND archived_at IS NOT NULL)
      OR (status='eliminada' AND archived_at IS NOT NULL AND approved_at IS NOT NULL)
      OR (status<>'archivada' AND archived_at IS NULL));

  -- A saved snapshot has no recipients. The original 1–30 range stays valid
  -- for historical reports; the outbox and all recipient rows are untouched.
  ALTER TABLE whats_new.reports DROP CONSTRAINT CK_whats_new_reports_counts;
  ALTER TABLE whats_new.reports WITH CHECK ADD CONSTRAINT CK_whats_new_reports_counts CHECK
    (entry_count BETWEEN 1 AND 200 AND approved_count>=0 AND failed_count>=0
      AND approved_count+failed_count=entry_count AND recipient_count BETWEEN 0 AND 30);
END;

EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER whats_new.TR_report_withdrawals_append_only
ON whats_new.report_withdrawals AFTER UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  THROW 53503, N''whats_new.report_withdrawals is append-only.'', 1;
END;';

IF NOT EXISTS (SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'whats_new.TR_report_withdrawals_append_only') AND is_disabled=0)
   OR (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=0 AND is_not_trusted=0
       AND ((parent_object_id=OBJECT_ID(N'whats_new.entries') AND name IN (N'CK_entries_approved',N'CK_entries_archived'))
         OR (parent_object_id=OBJECT_ID(N'whats_new.reports') AND name=N'CK_whats_new_reports_counts')))<>3
  THROW 53504, N'083 could not verify trusted retention guards.', 1;

COMMIT TRANSACTION;
PRINT N'083 complete: withdrawals are append-only and private snapshots may have zero recipients.';
