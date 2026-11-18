/* Durable cutoff witnesses. No backdated baseline and no source credentials. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns050Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns050Transaction=1 BEGIN TRANSACTION;
  IF DB_NAME() NOT IN(N'PortalSAGWeb',N'PortalSAGWeb-TEST')
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
    THROW 55001,N'This migration requires the Portal SQL Server 2019 compatibility 150 target.',1;
  DECLARE @lock050 int;
  EXEC @lock050=sys.sp_getapplock @Resource=N'portal-sag:migration:050:once-witnesses',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock050<0 THROW 55000,N'Could not reserve the once witness migration.',1;
  IF OBJECT_ID(N'scheduling.catalog_once_observations',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_customer_revision_heads',N'U') IS NULL
    OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    THROW 55001,N'Install catalog once observations and source heads first.',1;

  IF OBJECT_ID(N'settings.catalog_source_head_events',N'U') IS NULL
    CREATE TABLE settings.catalog_source_head_events (
      head_event_key bigint IDENTITY(1,1) NOT NULL,
      catalog_source_key bigint NOT NULL,
      revision_key bigint NULL,
      attempt_ordinal bigint NULL,
      attempt_status varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      attempted_at datetime2(3) NULL,
      recorded_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_head_events_recorded DEFAULT SYSUTCDATETIME(),
      CONSTRAINT PK_catalog_source_head_events PRIMARY KEY CLUSTERED(head_event_key),
      CONSTRAINT UQ_catalog_head_events_source UNIQUE(head_event_key,catalog_source_key),
      CONSTRAINT FK_catalog_head_events_source FOREIGN KEY(catalog_source_key)
        REFERENCES settings.catalog_source_bindings(catalog_source_key),
      CONSTRAINT FK_catalog_head_events_revision FOREIGN KEY(catalog_source_key,revision_key)
        REFERENCES core.catalog_customer_source_revisions(catalog_source_key,revision_key),
      CONSTRAINT CK_catalog_head_events_state CHECK (
        (attempt_status='never' AND revision_key IS NULL AND attempt_ordinal IS NULL AND attempted_at IS NULL)
        OR (attempt_status='failed' AND attempt_ordinal IS NOT NULL AND attempt_ordinal>0 AND attempted_at IS NOT NULL)
        OR (attempt_status='succeeded' AND revision_key IS NOT NULL AND attempt_ordinal IS NOT NULL AND attempt_ordinal>0 AND attempted_at IS NOT NULL))
    );
  IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_head_events')
    AND name=N'IX_catalog_head_events_cutoff')
    CREATE INDEX IX_catalog_head_events_cutoff ON settings.catalog_source_head_events(catalog_source_key,head_event_key DESC)
      INCLUDE(recorded_at,revision_key,attempt_ordinal,attempt_status,attempted_at);

  IF OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U') IS NULL
    CREATE TABLE scheduling.catalog_once_source_witnesses (
      observation_key bigint NOT NULL,
      catalog_source_key bigint NOT NULL,
      head_event_key bigint NOT NULL,
      binding_version binary(8) NOT NULL,
      profile_version binary(8) NOT NULL,
      source_role varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
      match_key_version smallint NOT NULL,
      captured_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_once_witness_captured DEFAULT SYSUTCDATETIME(),
      CONSTRAINT PK_catalog_once_source_witnesses PRIMARY KEY CLUSTERED(observation_key,catalog_source_key),
      CONSTRAINT FK_catalog_once_witness_observation FOREIGN KEY(observation_key)
        REFERENCES scheduling.catalog_once_observations(observation_key),
      CONSTRAINT FK_catalog_once_witness_event FOREIGN KEY(head_event_key,catalog_source_key)
        REFERENCES settings.catalog_source_head_events(head_event_key,catalog_source_key),
      CONSTRAINT CK_catalog_once_witness_role CHECK(source_role IN ('erp-customers','sag-admin')),
      CONSTRAINT CK_catalog_once_witness_key_version CHECK(match_key_version>0)
    );

  IF OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U') IS NULL
    CREATE TABLE scheduling.catalog_once_closure_scan_cursors (
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      last_observation_key bigint NOT NULL,
      updated_at datetime2(3) NOT NULL,
      row_version rowversion NOT NULL,
      CONSTRAINT PK_catalog_once_closure_scan_cursors PRIMARY KEY CLUSTERED(portal_environment),
      CONSTRAINT CK_catalog_once_cursor_environment CHECK(
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_once_cursor_key CHECK(last_observation_key>=0)
    );
  INSERT scheduling.catalog_once_closure_scan_cursors(portal_environment,last_observation_key,updated_at)
    SELECT env,0,SYSUTCDATETIME() FROM (VALUES('qa'),('production')) source(env)
    WHERE NOT EXISTS(SELECT 1 FROM scheduling.catalog_once_closure_scan_cursors WITH (UPDLOCK,HOLDLOCK)
      WHERE portal_environment=source.env COLLATE Latin1_General_100_BIN2);

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER settings.TR_catalog_source_heads_record_event
ON settings.catalog_customer_revision_heads AFTER INSERT,UPDATE,DELETE AS
BEGIN
  SET NOCOUNT ON;
  INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at)
    SELECT catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at FROM inserted;
  -- A removal is a negative state too, not permission to reuse the last success.
  INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at)
    SELECT d.catalog_source_key,NULL,NULL,''never'',NULL FROM deleted d
    WHERE NOT EXISTS(SELECT 1 FROM inserted i WHERE i.catalog_source_key=d.catalog_source_key);
END;';

  -- This is a baseline at installation time, never a claim about an earlier cutoff.
  INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at)
    SELECT h.catalog_source_key,h.revision_key,h.attempt_ordinal,h.attempt_status,h.attempted_at
    FROM settings.catalog_customer_revision_heads h WITH (UPDLOCK,HOLDLOCK)
    WHERE NOT EXISTS(SELECT 1 FROM settings.catalog_source_head_events e WITH (HOLDLOCK)
      WHERE e.catalog_source_key=h.catalog_source_key);

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_once_observations_capture_sources
ON scheduling.catalog_once_observations AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @capturedAt datetime2(3)=SYSUTCDATETIME();
  IF EXISTS(SELECT 1 FROM inserted WHERE cutoff_at<=@capturedAt)
    THROW 55003,N''The once source witness capture cutoff has passed.'',1;
  INSERT scheduling.catalog_once_source_witnesses(observation_key,catalog_source_key,head_event_key,
    binding_version,profile_version,source_role,match_key_version,captured_at)
  SELECT i.observation_key,b.catalog_source_key,e.head_event_key,b.row_version,p.row_version,b.source_role,mk.match_key_version,@capturedAt
  FROM inserted i
  JOIN settings.catalog_source_bindings b WITH (HOLDLOCK)
    ON b.portal_environment COLLATE Latin1_General_100_BIN2=i.portal_environment
    AND DATALENGTH(b.portal_environment)=DATALENGTH(i.portal_environment) AND b.source_state=''active''
  JOIN settings.external_database_connections p WITH (HOLDLOCK)
    ON p.external_database_connection_key=b.external_database_connection_key
  JOIN settings.catalog_match_key_registry mk WITH (HOLDLOCK)
    ON mk.portal_environment COLLATE Latin1_General_100_BIN2=i.portal_environment
  JOIN settings.catalog_customer_revision_heads h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
  CROSS APPLY (SELECT TOP (1) event.head_event_key,event.revision_key,event.attempt_ordinal,event.attempt_status,event.attempted_at
    FROM settings.catalog_source_head_events event WITH (HOLDLOCK)
    WHERE event.catalog_source_key=b.catalog_source_key AND event.recorded_at<=@capturedAt
    ORDER BY event.head_event_key DESC) e
  WHERE e.attempt_status=h.attempt_status COLLATE Latin1_General_100_BIN2
    AND (e.revision_key=h.revision_key OR (e.revision_key IS NULL AND h.revision_key IS NULL))
    AND (e.attempt_ordinal=h.attempt_ordinal OR (e.attempt_ordinal IS NULL AND h.attempt_ordinal IS NULL))
    AND (e.attempted_at=h.attempted_at OR (e.attempted_at IS NULL AND h.attempted_at IS NULL));
  IF EXISTS(SELECT 1 FROM inserted i WHERE
    (SELECT COUNT_BIG(*) FROM scheduling.catalog_once_source_witnesses w WHERE w.observation_key=i.observation_key)
    <> (SELECT COUNT_BIG(*) FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
      WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=i.portal_environment AND b.source_state=''active''))
    THROW 55003,N''The complete once source witnesses could not be captured.'',1;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER settings.TR_catalog_source_head_events_append_only
ON settings.catalog_source_head_events AFTER UPDATE,DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM deleted) THROW 55002,N''Source head events are append-only.'',1;
END;';
  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_once_source_witnesses_append_only
ON scheduling.catalog_once_source_witnesses AFTER UPDATE,DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM deleted) THROW 55002,N''Once source witnesses are append-only.'',1;
END;';

  GRANT SELECT ON OBJECT::settings.catalog_source_head_events TO portal_runtime;
  GRANT SELECT ON OBJECT::scheduling.catalog_once_source_witnesses TO portal_runtime;
  DENY INSERT,UPDATE,DELETE ON OBJECT::settings.catalog_source_head_events TO portal_runtime;
  DENY INSERT,UPDATE,DELETE ON OBJECT::scheduling.catalog_once_source_witnesses TO portal_runtime;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::scheduling.catalog_once_closure_scan_cursors TO portal_runtime;
  DENY DELETE ON OBJECT::scheduling.catalog_once_closure_scan_cursors TO portal_runtime;
  IF @owns050Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns050Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
