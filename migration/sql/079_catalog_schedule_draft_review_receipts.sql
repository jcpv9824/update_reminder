/* Independent, expiring review of a new schedule proposal. No runnable writes or grants. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns079 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns079=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
    OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS (SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150 AND is_read_only=0)
    THROW 57900,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock079 int;
  EXEC @lock079=sys.sp_getapplock @Resource=N'portal-sag:migration:079:draft-review',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock079<0 THROW 57901,N'Could not reserve the draft review migration lock.',1;
  IF OBJECT_ID(N'scheduling.catalog_schedule_draft_proposals',N'U') IS NULL
    OR NOT EXISTS(SELECT 1 FROM sys.database_permissions p WHERE p.class=3 AND p.major_id=SCHEMA_ID(N'migration')
      AND p.permission_name=N'INSERT' AND p.state='D' AND p.grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime'))
    THROW 57902,N'Expected the draft ledger and existing migration-schema denial.',1;

  IF OBJECT_ID(N'migration.catalog_schedule_draft_review_receipts',N'U') IS NULL
    CREATE TABLE migration.catalog_schedule_draft_review_receipts (
      review_id uniqueidentifier NOT NULL PRIMARY KEY,
      proposal_id uniqueidentifier NOT NULL REFERENCES scheduling.catalog_schedule_draft_proposals(proposal_id),
      proposal_sha256 binary(32) NOT NULL,
      reviewed_state_sha256 binary(32) NOT NULL,
      operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
      reviewer_key bigint NOT NULL REFERENCES security.users(user_key),
      reviewed_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
      expires_at datetime2(3) NOT NULL DEFAULT DATEADD(minute,10,SYSUTCDATETIME()),
      review_sql_login nvarchar(128) NOT NULL DEFAULT ORIGINAL_LOGIN(),
      CONSTRAINT CK_draft_review_operation CHECK(operation_id LIKE N'[A-Za-z0-9]%'
        AND REPLACE(operation_id,N'-',N'') NOT LIKE N'%[^A-Za-z0-9._:]%' AND DATALENGTH(operation_id)=2*LEN(operation_id)),
      CONSTRAINT CK_draft_review_expiry CHECK(expires_at>reviewed_at AND expires_at<=DATEADD(minute,10,reviewed_at))
    );

  -- Seal the SQL identities and entire normalized proposal, including omissions.
  -- A bounded array plus an exact count fails closed on excess appended rows.
  EXEC sys.sp_executesql N'CREATE OR ALTER VIEW migration.v_catalog_schedule_draft_review_state AS
    SELECT p.proposal_id,CONVERT(binary(32),HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),
      CONCAT(N''portal-sag:draft-review-state:v1|'',details.shape)))) AS reviewed_state_sha256
    FROM scheduling.catalog_schedule_draft_proposals p
    CROSS APPLY (SELECT (SELECT
      p.proposal_id,p.portal_environment,p.requester_source_id,p.name,p.requested_date,p.selection_mode,p.target_type,
      p.target_environment,p.catalog_customer_id,p.domain_choice_hash,p.license_module_key,
      p.assignment_mode,p.frequency_type,p.end_date,p.every_n_weeks,p.interval_days,p.day_of_month,p.domain_role,p.database_role,
      p.proposal_sha256,p.created_at,
      JSON_QUERY((SELECT TOP (5000) ln.link_id,ln.target_id,ln.kind,ln.included
        FROM scheduling.catalog_schedule_draft_proposal_links ln WHERE ln.proposal_id=p.proposal_id
        ORDER BY ln.link_id FOR JSON PATH)) AS links,
      JSON_QUERY((SELECT TOP (200) a.kind,a.user_key
        FROM scheduling.catalog_schedule_draft_proposal_assignees a WHERE a.proposal_id=p.proposal_id
        ORDER BY a.kind,a.user_key FOR JSON PATH)) AS assignees,
      JSON_QUERY((SELECT d.weekday FROM scheduling.catalog_schedule_draft_proposal_weekdays d
        WHERE d.proposal_id=p.proposal_id ORDER BY d.weekday FOR JSON PATH)) AS weekdays
      FOR JSON PATH,INCLUDE_NULL_VALUES,WITHOUT_ARRAY_WRAPPER) AS shape) details
    WHERE (SELECT COUNT_BIG(*) FROM scheduling.catalog_schedule_draft_proposal_links ln WHERE ln.proposal_id=p.proposal_id) BETWEEN 1 AND 5000
      AND (SELECT COUNT_BIG(*) FROM scheduling.catalog_schedule_draft_proposal_assignees a WHERE a.proposal_id=p.proposal_id)<=200
      AND EXISTS (SELECT 1 FROM scheduling.catalog_schedule_draft_proposal_links ln
        WHERE ln.proposal_id=p.proposal_id AND ln.included=1);';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER migration.TR_catalog_schedule_draft_review_stamp
    ON migration.catalog_schedule_draft_review_receipts INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @now datetime2(3)=SYSUTCDATETIME();
      IF ISNULL(IS_ROLEMEMBER(N''portal_runtime''),0)<>0
        OR ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>0
        OR (@@OPTIONS & 2)<>0
        OR NOT EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
        OR (SELECT COUNT(*) FROM inserted)<>1
        THROW 57903,N''Expected an independently authorized serializable review transaction.'',1;
      IF NOT EXISTS(
        SELECT 1 FROM inserted i
        JOIN scheduling.catalog_schedule_draft_proposals p WITH (HOLDLOCK)
          ON p.proposal_id=i.proposal_id AND p.proposal_sha256=i.proposal_sha256
        JOIN migration.v_catalog_schedule_draft_review_state proof
          ON proof.proposal_id=p.proposal_id AND proof.reviewed_state_sha256=i.reviewed_state_sha256
        JOIN security.users reviewer WITH (HOLDLOCK) ON reviewer.user_key=i.reviewer_key AND reviewer.active=1
        JOIN security.users requester WITH (HOLDLOCK) ON requester.active=1 AND requester.user_key<>reviewer.user_key
          AND requester.source_id COLLATE Latin1_General_100_BIN2=p.requester_source_id
          AND DATALENGTH(requester.source_id)=DATALENGTH(p.requester_source_id)
        JOIN security.user_roles membership WITH (HOLDLOCK)
          ON membership.user_key=reviewer.user_key AND membership.role_id=N''super_admin''
        JOIN security.roles role_row WITH (HOLDLOCK) ON role_row.role_id=membership.role_id
          AND role_row.active=1 AND role_row.system_role=1 AND role_row.protected_role=1
        WHERE p.requested_date>=CONVERT(date,DATEADD(hour,-5,@now)) AND p.created_at<=@now
          AND ((DB_NAME()=N''PortalSAGWeb-TEST'' AND p.portal_environment=''qa'')
            OR (DB_NAME()=N''PortalSAGWeb'' AND p.portal_environment=''production'')))
        THROW 57904,N''The exact draft and independent reviewer could not be verified.'',1;
      INSERT migration.catalog_schedule_draft_review_receipts
        (review_id,proposal_id,proposal_sha256,reviewed_state_sha256,operation_id,reviewer_key,reviewed_at,expires_at,review_sql_login)
      SELECT review_id,proposal_id,proposal_sha256,reviewed_state_sha256,operation_id,reviewer_key,@now,
        DATEADD(minute,10,@now),ORIGINAL_LOGIN() FROM inserted;
    END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER migration.TR_catalog_schedule_draft_review_immutable
    ON migration.catalog_schedule_draft_review_receipts AFTER UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted) THROW 57905,N''Draft review receipts are append-only.'',1;
    END;';

  IF (SELECT COUNT(*) FROM sys.triggers WHERE is_disabled=0
    AND parent_id=OBJECT_ID(N'migration.catalog_schedule_draft_review_receipts',N'U') AND object_id IN (
    OBJECT_ID(N'migration.TR_catalog_schedule_draft_review_stamp',N'TR'),
    OBJECT_ID(N'migration.TR_catalog_schedule_draft_review_immutable',N'TR')))<>2
    THROW 57906,N'Expected both enabled draft review guards.',1;
  IF @owns079=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns079=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
