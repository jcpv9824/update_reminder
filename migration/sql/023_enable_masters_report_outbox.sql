/*
  Portal SAG Web - production SQL / 023
  Enable durable master-report email messages without changing existing rows,
  delivery history, runtime permissions, or database-role membership.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52300,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52301,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='022' AND succeeded=1
)
  THROW 52302,N'Migration 022 must be recorded before migration 023.',1;
IF OBJECT_ID(N'notifications.email_notifications',N'U') IS NULL
  THROW 52303,N'The notification outbox table is missing.',1;

BEGIN TRANSACTION;

IF OBJECT_ID(N'notifications.CK_email_notifications_type',N'C') IS NOT NULL
  ALTER TABLE notifications.email_notifications
    DROP CONSTRAINT CK_email_notifications_type;

ALTER TABLE notifications.email_notifications WITH CHECK
  ADD CONSTRAINT CK_email_notifications_type CHECK
  (
    notification_type IN
    (
      'administrative_reminder',
      'blocked_task_reminder',
      'task_reminder',
      'overdue_alert',
      'password_notification',
      'task_status_notification',
      'test_email',
      'masters_report'
    )
  );

ALTER TABLE notifications.email_notifications
  CHECK CONSTRAINT CK_email_notifications_type;

IF NOT EXISTS
(
  SELECT 1
  FROM sys.check_constraints
  WHERE parent_object_id=OBJECT_ID(N'notifications.email_notifications')
    AND name=N'CK_email_notifications_type'
    AND definition LIKE N'%masters_report%'
    AND is_disabled=0
    AND is_not_trusted=0
)
  THROW 52304,N'Master-report outbox type verification failed.',1;

COMMIT TRANSACTION;
PRINT N'023 complete: durable master-report email messages are enabled.';
GO
