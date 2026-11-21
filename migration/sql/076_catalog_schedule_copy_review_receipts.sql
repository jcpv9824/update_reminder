/* Independent review receipts. The runtime retains its existing DENY on the migration schema. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns076 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns076=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS (SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150 AND is_read_only=0)
    THROW 57600,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock076 int;
  EXEC @lock076=sys.sp_getapplock @Resource=N'portal-sag:migration:076:copy-review-receipts',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock076<0 THROW 57601,N'Could not reserve the copy review migration lock.',1;
  IF OBJECT_ID(N'scheduling.catalog_schedule_copy_proposals',N'U') IS NULL OR NOT EXISTS (
      SELECT 1 FROM sys.database_permissions p
      WHERE p.class=3 AND p.major_id=SCHEMA_ID(N'migration') AND p.permission_name=N'INSERT' AND p.state='D'
        AND p.grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime'))
    THROW 57602,N'Expected the isolated proposal ledger and runtime migration-schema denial.',1;

  IF OBJECT_ID(N'migration.catalog_schedule_copy_review_receipts',N'U') IS NULL
    CREATE TABLE migration.catalog_schedule_copy_review_receipts (
      review_id uniqueidentifier NOT NULL CONSTRAINT PK_catalog_schedule_copy_review_receipts PRIMARY KEY,
      proposal_id uniqueidentifier NOT NULL REFERENCES scheduling.catalog_schedule_copy_proposals(proposal_id),
      request_sha256 binary(32) NOT NULL,
      reviewed_state_sha256 binary(32) NOT NULL,
      reviewer_key bigint NOT NULL REFERENCES security.users(user_key),
      reviewed_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_schedule_copy_review_receipts_time DEFAULT SYSUTCDATETIME(),
      expires_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_schedule_copy_review_receipts_expiry DEFAULT DATEADD(minute,10,SYSUTCDATETIME()),
      review_sql_login nvarchar(128) NOT NULL CONSTRAINT DF_catalog_schedule_copy_review_receipts_login DEFAULT ORIGINAL_LOGIN(),
      CONSTRAINT CK_catalog_schedule_copy_review_receipts_expiry CHECK(
        expires_at>reviewed_at AND expires_at<=DATEADD(minute,10,reviewed_at))
    );

  -- The immutable receipt must bind normalized children as well as the
  -- parent rowversion. Another writer can edit children without bumping it.
  EXEC sys.sp_executesql N'CREATE OR ALTER VIEW migration.v_catalog_schedule_copy_review_state AS
    SELECT p.proposal_id,CONVERT(binary(32),HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),
      CONCAT(N''portal-sag:copy-review-state:v1|'',state.shape)))) AS reviewed_state_sha256
    FROM scheduling.catalog_schedule_copy_proposals p
    JOIN scheduling.update_schedules o ON o.schedule_key=p.original_schedule_key
    CROSS APPLY (SELECT (SELECT
      o.assigned_role AS assignedRole,o.domain_assigned_role AS domainRole,o.database_assigned_role AS databaseRole,
      o.assignment_mode AS assignmentMode,o.selection_mode AS selectionMode,o.target_type AS targetType,
      CONVERT(bit,CASE WHEN EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_links x WHERE x.copy_schedule_key=o.schedule_key)
        OR EXISTS(SELECT 1 FROM scheduling.v_catalog_schedule_draft_approval x WHERE x.schedule_key=o.schedule_key
          AND x.schedule_version=o.row_version AND x.manual_selection=1)
        OR EXISTS(SELECT 1 FROM scheduling.licensing_scope x WHERE x.schedule_key=o.schedule_key AND o.selection_mode=''licensing'')
        OR EXISTS(SELECT 1 FROM scheduling.scope_groups x WHERE x.schedule_key=o.schedule_key) THEN 1 ELSE 0 END) AS scoped,
      JSON_QUERY((SELECT TOP (301) a.assignment_kind AS lane,CONVERT(varchar(20),a.user_key) AS userKey
        FROM scheduling.schedule_assignees a WHERE a.schedule_key=o.schedule_key
        ORDER BY a.assignment_kind COLLATE Latin1_General_100_BIN2,a.user_key FOR JSON PATH)) AS assignees,
      (SELECT COUNT_BIG(*) FROM scheduling.schedule_assignees a WHERE a.schedule_key=o.schedule_key) AS assigneeCount,
      JSON_QUERY((SELECT st.client_key,st.target_type,st.domain_key,st.database_key FROM scheduling.schedule_targets st
        WHERE st.schedule_key=o.schedule_key ORDER BY st.schedule_target_key FOR JSON PATH,INCLUDE_NULL_VALUES)) AS flatTargets,
      JSON_QUERY((SELECT g.scope_group_key,g.client_key,g.include_all_domains FROM scheduling.scope_groups g
        WHERE g.schedule_key=o.schedule_key ORDER BY g.scope_group_key FOR JSON PATH)) AS manualGroups,
      JSON_QUERY((SELECT d.scope_group_key,d.scope_domain_key,d.domain_key,d.client_key,d.include_all_databases
        FROM scheduling.scope_domains d JOIN scheduling.scope_groups g ON g.scope_group_key=d.scope_group_key
        WHERE g.schedule_key=o.schedule_key ORDER BY d.scope_domain_key FOR JSON PATH)) AS manualDomains,
      JSON_QUERY((SELECT d.scope_domain_key,d.client_key,d.domain_key,db.database_key FROM scheduling.scope_databases db
        JOIN scheduling.scope_domains d ON d.scope_domain_key=db.scope_domain_key JOIN scheduling.scope_groups g ON g.scope_group_key=d.scope_group_key
        WHERE g.schedule_key=o.schedule_key ORDER BY d.scope_domain_key,db.database_key FOR JSON PATH)) AS manualDatabases,
      JSON_QUERY((SELECT ls.license_match_mode,ls.environment_id,ls.target_types,ls.active_only FROM scheduling.licensing_scope ls
        WHERE ls.schedule_key=o.schedule_key FOR JSON PATH,INCLUDE_NULL_VALUES)) AS licensedScope,
      JSON_QUERY((SELECT lm.module_key FROM scheduling.licensing_scope_modules lm
        WHERE lm.schedule_key=o.schedule_key ORDER BY lm.module_key FOR JSON PATH)) AS licenseModules,
      JSON_QUERY((SELECT x.domain_key FROM scheduling.licensing_excluded_domains x
        WHERE x.schedule_key=o.schedule_key ORDER BY x.domain_key FOR JSON PATH)) AS excludedDomains,
      JSON_QUERY((SELECT x.database_key FROM scheduling.licensing_excluded_databases x
        WHERE x.schedule_key=o.schedule_key ORDER BY x.database_key FOR JSON PATH)) AS excludedDatabases,
      JSON_QUERY((SELECT LOWER(CONVERT(char(36),x.link_id)) AS linkId,x.target_kind,LOWER(CONVERT(char(36),x.verified_target_id)) AS physicalId
        FROM scheduling.catalog_schedule_copy_links x WHERE x.copy_schedule_key=o.schedule_key ORDER BY x.link_id FOR JSON PATH)) AS originPins,
      JSON_QUERY((SELECT TOP (5001) LOWER(CONVERT(char(36),x.link_id)) AS linkId,x.target_kind,LOWER(CONVERT(char(36),x.verified_target_id)) AS physicalId
        FROM scheduling.v_catalog_schedule_draft_pins x WHERE x.schedule_key=o.schedule_key ORDER BY x.link_id FOR JSON PATH)) AS draftOriginPins,
      JSON_QUERY((SELECT TOP (5001) LOWER(CONVERT(char(36),t.link_id)) AS linkId,t.kind,
        LOWER(CONVERT(char(36),t.physical_target_id)) AS physicalId
        FROM scheduling.catalog_schedule_copy_proposal_links t WHERE t.proposal_id=p.proposal_id
        ORDER BY LOWER(CONVERT(char(36),t.link_id)) COLLATE Latin1_General_100_BIN2 FOR JSON PATH)) AS pins,
      (SELECT COUNT_BIG(*) FROM scheduling.catalog_schedule_copy_proposal_links t WHERE t.proposal_id=p.proposal_id) AS pinCount
      FOR JSON PATH,INCLUDE_NULL_VALUES,WITHOUT_ARRAY_WRAPPER) AS shape) state
    WHERE (SELECT COUNT_BIG(*) FROM scheduling.schedule_assignees a WHERE a.schedule_key=o.schedule_key)<=300
      AND (SELECT COUNT_BIG(*) FROM scheduling.v_catalog_schedule_draft_pins x WHERE x.schedule_key=o.schedule_key)<=5000
      AND (SELECT COUNT_BIG(*) FROM scheduling.catalog_schedule_copy_proposal_links t WHERE t.proposal_id=p.proposal_id) BETWEEN 1 AND 5000;';

  IF OBJECT_ID(N'migration.TR_catalog_schedule_copy_reviews_stamp',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER migration.TR_catalog_schedule_copy_reviews_stamp
      ON migration.catalog_schedule_copy_review_receipts INSTEAD OF INSERT AS
      BEGIN
        SET NOCOUNT ON;
        DECLARE @now datetime2(3)=SYSUTCDATETIME();
        IF ISNULL(IS_ROLEMEMBER(N''portal_runtime''),0)<>0
          OR ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>0
          OR NOT EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
          OR (SELECT COUNT(*) FROM inserted)<>1
          THROW 57603,N''Review requires an independent authorized SQL transaction.'',1;
        IF EXISTS (
          SELECT 1 FROM inserted i WHERE NOT EXISTS (
            SELECT 1 FROM scheduling.catalog_schedule_copy_proposals p WITH (HOLDLOCK)
            JOIN migration.v_catalog_schedule_copy_review_state proof ON proof.proposal_id=p.proposal_id
              AND proof.reviewed_state_sha256=i.reviewed_state_sha256
            JOIN security.users reviewer WITH (HOLDLOCK) ON reviewer.user_key=i.reviewer_key AND reviewer.active=1
            JOIN security.users requester WITH (HOLDLOCK) ON requester.active=1
              AND requester.source_id COLLATE Latin1_General_100_BIN2=p.requester_source_id
              AND DATALENGTH(requester.source_id)=DATALENGTH(p.requester_source_id) AND requester.user_key<>reviewer.user_key
            JOIN security.user_roles membership WITH (HOLDLOCK)
              ON membership.user_key=reviewer.user_key AND membership.role_id=N''super_admin''
            JOIN security.roles role_row WITH (HOLDLOCK) ON role_row.role_id=membership.role_id
              AND role_row.active=1 AND role_row.system_role=1 AND role_row.protected_role=1
            JOIN scheduling.update_schedules original WITH (HOLDLOCK) ON original.schedule_key=p.original_schedule_key
              AND original.row_version=p.original_definition_version AND original.active=1 AND original.deleted_at IS NULL
            JOIN scheduling.catalog_schedule_operation_approvals operation WITH (HOLDLOCK)
              ON operation.schedule_key=original.schedule_key AND operation.schedule_version=p.original_definition_version
              AND operation.portal_environment=p.portal_environment AND operation.operation_id=p.operation_id
              AND operation.retired_at IS NULL AND operation.approved_at<=@now
            WHERE p.proposal_id=i.proposal_id AND p.request_sha256=i.request_sha256
              AND p.requested_date>=CONVERT(date,DATEADD(hour,-5,@now))
              AND ((DB_NAME()=N''PortalSAGWeb-TEST'' AND p.portal_environment=''qa'')
                OR (DB_NAME()=N''PortalSAGWeb'' AND p.portal_environment=''production''))
              AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents consumed WITH (HOLDLOCK)
                WHERE consumed.intent_id=p.proposal_id)
              AND EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_proposal_links targets WITH (HOLDLOCK)
                WHERE targets.proposal_id=p.proposal_id)
          ))
          THROW 57604,N''The exact proposal cannot be independently approved.'',1;
        INSERT migration.catalog_schedule_copy_review_receipts
          (review_id,proposal_id,request_sha256,reviewed_state_sha256,reviewer_key,reviewed_at,expires_at,review_sql_login)
        SELECT review_id,proposal_id,request_sha256,reviewed_state_sha256,reviewer_key,@now,DATEADD(minute,10,@now),ORIGINAL_LOGIN() FROM inserted;
      END;';
  IF OBJECT_ID(N'migration.TR_catalog_schedule_copy_reviews_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER migration.TR_catalog_schedule_copy_reviews_immutable
      ON migration.catalog_schedule_copy_review_receipts AFTER UPDATE,DELETE AS
      BEGIN
        SET NOCOUNT ON;
        IF EXISTS(SELECT 1 FROM deleted) THROW 57605,N''Review receipts are append-only.'',1;
      END;';
  IF (SELECT COUNT(*) FROM sys.triggers WHERE is_disabled=0 AND object_id IN (
    OBJECT_ID(N'migration.TR_catalog_schedule_copy_reviews_stamp',N'TR'),
    OBJECT_ID(N'migration.TR_catalog_schedule_copy_reviews_immutable',N'TR')))<>2
    THROW 57606,N'Expected enabled independent review guards.',1;
  IF @owns076=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns076=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
