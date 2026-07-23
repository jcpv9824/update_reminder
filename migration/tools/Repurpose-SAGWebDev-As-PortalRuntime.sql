/* Portal SAG Web - replace the temporary migration owner membership with the runtime role. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51901, N'Wrong database.', 1;
IF USER_ID(N'SAGWebDev') IS NULL THROW 51902, N'SAGWebDev database user does not exist.', 1;
IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL THROW 51903, N'portal_runtime role does not exist.', 1;
IF SUSER_SNAME((SELECT owner_sid FROM sys.databases WHERE database_id=DB_ID())) = N'SAGWebDev'
  THROW 51904, N'SAGWebDev owns the database and cannot be converted safely.', 1;
IF EXISTS
(
  SELECT 1
  FROM sys.database_permissions AS permission
  WHERE permission.grantee_principal_id=USER_ID(N'SAGWebDev')
    AND permission.state IN ('G','W')
    AND permission.permission_name IN
      (N'CONTROL',N'ALTER',N'ALTER ANY USER',N'ALTER ANY ROLE',N'ALTER ANY SCHEMA')
)
  THROW 51905, N'SAGWebDev has a direct elevated grant that must be reviewed separately.', 1;

BEGIN TRANSACTION;

IF NOT EXISTS
(
  SELECT 1 FROM sys.database_role_members
  WHERE role_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime')
    AND member_principal_id=USER_ID(N'SAGWebDev')
)
  ALTER ROLE [portal_runtime] ADD MEMBER [SAGWebDev];

DECLARE @role_name sysname;
DECLARE elevated_roles CURSOR LOCAL FAST_FORWARD FOR
  SELECT rolep.name
  FROM sys.database_role_members AS membership
  INNER JOIN sys.database_principals AS rolep ON rolep.principal_id=membership.role_principal_id
  WHERE membership.member_principal_id=USER_ID(N'SAGWebDev')
    AND rolep.name IN
      (N'db_owner',N'db_ddladmin',N'db_securityadmin',N'db_accessadmin',N'portal_migrator');
OPEN elevated_roles;
FETCH NEXT FROM elevated_roles INTO @role_name;
WHILE @@FETCH_STATUS=0
BEGIN
  DECLARE @drop_role_sql nvarchar(500)=N'ALTER ROLE ' + QUOTENAME(@role_name) + N' DROP MEMBER [SAGWebDev];';
  EXEC sys.sp_executesql @drop_role_sql;
  FETCH NEXT FROM elevated_roles INTO @role_name;
END;
CLOSE elevated_roles;
DEALLOCATE elevated_roles;

IF NOT EXISTS
(
  SELECT 1 FROM sys.database_role_members
  WHERE role_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime')
    AND member_principal_id=USER_ID(N'SAGWebDev')
)
  THROW 51906, N'portal_runtime membership was not applied.', 1;
IF EXISTS
(
  SELECT 1
  FROM sys.database_role_members AS membership
  INNER JOIN sys.database_principals AS rolep ON rolep.principal_id=membership.role_principal_id
  WHERE membership.member_principal_id=USER_ID(N'SAGWebDev')
    AND rolep.name IN
      (N'db_owner',N'db_ddladmin',N'db_securityadmin',N'db_accessadmin',N'portal_migrator')
)
  THROW 51907, N'An elevated database role remains.', 1;

INSERT audit.audit_logs
(
  source_id,entity_type,entity_source_id,action,performed_by,performed_by_email,
  performed_at,before_json,after_json,schema_version,data_classification
)
VALUES
(
  N'audit_' + CONVERT(nvarchar(36),NEWID()),N'security_principal',N'SAGWebDev',
  N'runtime_principal_restricted',N'SAGWebDev',NULL,SYSUTCDATETIME(),
  N'{"databaseRole":"db_owner"}',N'{"databaseRole":"portal_runtime"}',1,N'internal'
);

COMMIT TRANSACTION;

SELECT
  CAST(1 AS bit) AS runtime_membership_applied,
  CAST(0 AS bit) AS elevated_membership_remaining;
