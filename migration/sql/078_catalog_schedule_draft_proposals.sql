/* Drafts for new schedules. No approval, runnable schedule, task or notice writes. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns078 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns078=1 BEGIN TRANSACTION;
  IF NOT (DB_NAME() COLLATE Latin1_General_100_BIN2 IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
      AND DATALENGTH(DB_NAME()) IN (24,34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150 AND is_read_only=0)
    THROW 57800,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock078 int;
  EXEC @lock078=sys.sp_getapplock @Resource=N'portal-sag:migration:078:catalog-draft-proposals',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock078<0 THROW 57801,N'Could not reserve the catalog proposal migration lock.',1;
  IF OBJECT_ID(N'scheduling.catalog_schedule_copy_proposals',N'U') IS NULL
    THROW 57802,N'Expected catalog proposal prerequisites.',1;

  IF OBJECT_ID(N'scheduling.catalog_schedule_draft_proposals',N'U') IS NULL
    CREATE TABLE scheduling.catalog_schedule_draft_proposals (
      proposal_id uniqueidentifier NOT NULL PRIMARY KEY,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(portal_environment IN ('qa','production')),
      requester_source_id nvarchar(150) COLLATE Latin1_General_100_BIN2 NOT NULL,
      name nvarchar(200) NOT NULL,
      requested_date date NOT NULL,
      selection_mode varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(selection_mode IN ('manual','licensing')),
      target_type varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(target_type IN ('domain','database','both')),
      target_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(target_environment IN ('all','production','test','demo')),
      catalog_customer_id uniqueidentifier NULL,
      domain_choice_hash binary(32) NULL,
      license_module_key bigint NULL REFERENCES licensing.license_modules(module_key),
      assignment_mode varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(assignment_mode IN ('role','users')),
      frequency_type varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      end_date date NULL,
      every_n_weeks smallint NULL,
      interval_days smallint NULL,
      day_of_month tinyint NULL,
      -- Historical role IDs. An unapproved draft must not prevent removing an
      -- otherwise-unused role; approval has to validate both roles again.
      domain_role nvarchar(80) NULL,
      database_role nvarchar(80) NULL,
      proposal_sha256 binary(32) NOT NULL,
      created_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_schedule_draft_proposals_created DEFAULT SYSUTCDATETIME(),
      CONSTRAINT CK_catalog_schedule_draft_proposals_roles CHECK (
        (target_type='both' AND domain_role IS NOT NULL AND database_role IS NOT NULL) OR
        (target_type='domain' AND domain_role IS NOT NULL AND database_role IS NULL) OR
        (target_type='database' AND domain_role IS NULL AND database_role IS NOT NULL)),
      CONSTRAINT CK_catalog_schedule_draft_proposals_calendar CHECK (
        (end_date IS NULL OR end_date>=requested_date) AND (
          (frequency_type='once' AND end_date IS NULL AND every_n_weeks IS NULL AND interval_days IS NULL AND day_of_month IS NULL) OR
          (frequency_type='manual' AND every_n_weeks IS NULL AND interval_days IS NULL AND day_of_month IS NULL) OR
          (frequency_type='weekly' AND every_n_weeks IS NOT NULL AND every_n_weeks>=1 AND interval_days IS NULL AND day_of_month IS NULL) OR
          (frequency_type='interval' AND every_n_weeks IS NULL AND interval_days IS NOT NULL AND interval_days>=1 AND day_of_month IS NULL) OR
          (frequency_type='monthly' AND every_n_weeks IS NULL AND interval_days IS NULL AND day_of_month IS NOT NULL AND day_of_month BETWEEN 1 AND 31))),
      CONSTRAINT CK_catalog_schedule_draft_proposals_mode CHECK (
        (selection_mode='manual' AND catalog_customer_id IS NOT NULL AND license_module_key IS NULL)
        OR (selection_mode='licensing' AND catalog_customer_id IS NULL AND domain_choice_hash IS NULL AND license_module_key IS NOT NULL))
    );
  IF OBJECT_ID(N'scheduling.catalog_schedule_draft_proposal_links',N'U') IS NULL
    CREATE TABLE scheduling.catalog_schedule_draft_proposal_links (
      proposal_id uniqueidentifier NOT NULL REFERENCES scheduling.catalog_schedule_draft_proposals(proposal_id),
      link_id uniqueidentifier NOT NULL REFERENCES core.catalog_operational_links(link_id),
      target_id uniqueidentifier NOT NULL REFERENCES core.catalog_physical_targets(target_id),
      kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(kind IN ('domain','database')),
      included bit NOT NULL,
      PRIMARY KEY(proposal_id,link_id)
    );
  IF OBJECT_ID(N'scheduling.catalog_schedule_draft_proposal_assignees',N'U') IS NULL
    CREATE TABLE scheduling.catalog_schedule_draft_proposal_assignees (
      proposal_id uniqueidentifier NOT NULL REFERENCES scheduling.catalog_schedule_draft_proposals(proposal_id),
      user_key bigint NOT NULL REFERENCES security.users(user_key),
      kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL CHECK(kind IN ('domain','database')),
      PRIMARY KEY(proposal_id,kind,user_key)
    );
  IF OBJECT_ID(N'scheduling.catalog_schedule_draft_proposal_weekdays',N'U') IS NULL
    CREATE TABLE scheduling.catalog_schedule_draft_proposal_weekdays (
      proposal_id uniqueidentifier NOT NULL REFERENCES scheduling.catalog_schedule_draft_proposals(proposal_id),
      weekday tinyint NOT NULL CHECK(weekday BETWEEN 1 AND 7),
      PRIMARY KEY(proposal_id,weekday)
    );
  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposals_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_draft_proposals_immutable
      ON scheduling.catalog_schedule_draft_proposals AFTER UPDATE,DELETE AS
      BEGIN SET NOCOUNT ON;
        IF EXISTS(SELECT 1 FROM deleted) THROW 57803,N''Catalog schedule proposals are append-only.'',1;
      END;';
  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposal_links_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_draft_proposal_links_immutable
      ON scheduling.catalog_schedule_draft_proposal_links AFTER UPDATE,DELETE AS
      BEGIN SET NOCOUNT ON;
        IF EXISTS(SELECT 1 FROM deleted) THROW 57804,N''Catalog schedule proposal links are append-only.'',1;
      END;';
  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposal_assignees_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_draft_proposal_assignees_immutable
      ON scheduling.catalog_schedule_draft_proposal_assignees AFTER UPDATE,DELETE AS
      BEGIN SET NOCOUNT ON;
        IF EXISTS(SELECT 1 FROM deleted) THROW 57806,N''Draft assignees are append-only.'',1;
      END;';
  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposal_weekdays_immutable',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_draft_proposal_weekdays_immutable
      ON scheduling.catalog_schedule_draft_proposal_weekdays AFTER UPDATE,DELETE AS
      BEGIN SET NOCOUNT ON;
        IF EXISTS(SELECT 1 FROM deleted) THROW 57807,N''Draft recurrence days are append-only.'',1;
      END;';
  IF (SELECT COUNT(*) FROM sys.triggers WHERE is_disabled=0 AND object_id IN (
    OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposals_immutable',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposal_links_immutable',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposal_assignees_immutable',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_draft_proposal_weekdays_immutable',N'TR')))<>4
    THROW 57805,N'Expected enabled draft history guards.',1;
  IF @owns078=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns078=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
