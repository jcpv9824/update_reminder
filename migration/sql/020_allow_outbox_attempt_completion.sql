/*
  Portal SAG Web - Gate C/E / 020
  Keep email delivery attempts immutable after completion while allowing the
  worker's single processing -> sent/failed completion transition.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52000,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52001,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='019' AND succeeded=1
)
  THROW 52002,N'Migration 019 must be recorded before migration 020.',1;
IF OBJECT_ID(N'notifications.email_notification_attempts',N'U') IS NULL
  THROW 52003,N'The notification-attempt table is missing.',1;

BEGIN TRANSACTION;
GO

CREATE OR ALTER TRIGGER notifications.TR_notification_attempts_append_only
ON notifications.email_notification_attempts
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;

  IF EXISTS
  (
    SELECT 1
    FROM deleted AS previous_attempt
    LEFT JOIN inserted AS current_attempt
      ON current_attempt.attempt_key=previous_attempt.attempt_key
    WHERE current_attempt.attempt_key IS NULL
  )
    THROW 51075,N'notifications.email_notification_attempts does not permit deletes.',1;

  IF EXISTS
  (
    SELECT 1
    FROM deleted AS previous_attempt
    JOIN inserted AS current_attempt
      ON current_attempt.attempt_key=previous_attempt.attempt_key
    WHERE previous_attempt.notification_key<>current_attempt.notification_key
       OR previous_attempt.attempt_no<>current_attempt.attempt_no
       OR previous_attempt.started_at<>current_attempt.started_at
       OR previous_attempt.attempt_status<>'processing'
       OR previous_attempt.completed_at IS NOT NULL
       OR current_attempt.attempt_status NOT IN ('sent','failed')
       OR current_attempt.completed_at IS NULL
  )
    THROW 51075,N'Notification attempts permit only one processing-to-terminal completion.',1;
END;
GO

IF OBJECT_DEFINITION(OBJECT_ID(N'notifications.TR_notification_attempts_append_only'))
     NOT LIKE N'%processing-to-terminal completion%'
  THROW 52004,N'Notification-attempt trigger verification failed.',1;

COMMIT TRANSACTION;
PRINT N'020 complete: notification attempts allow one immutable terminal completion.';
GO
