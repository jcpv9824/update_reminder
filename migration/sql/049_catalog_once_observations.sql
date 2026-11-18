/*
  Durable observations of the exact normalized work expected by catalog once
  schedules. Zero pairs marks a blocked observation, never a completion proof.
  No backfill, runtime rollout, or schedule status changes.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns049Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns049Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock049 int;
  EXEC @lock049=sys.sp_getapplock @Resource=N'portal-sag:migration:049:once-observations',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock049<0 THROW 54900,N'Could not reserve the catalog once observation migration lock.',1;

  IF OBJECT_ID(N'scheduling.catalog_schedule_population_approvals',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
    OR OBJECT_ID(N'workflow.catalog_task_execution_sources',N'U') IS NULL
    OR OBJECT_ID(N'workflow.catalog_task_execution_links',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_operational_link_evidence',N'V') IS NULL
    OR OBJECT_ID(N'core.catalog_physical_target_links',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_customer_revision_heads',N'U') IS NULL
    OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    THROW 54901,N'Install catalog scheduling, execution, operational evidence and runtime prerequisites first.',1;

  IF OBJECT_ID(N'scheduling.catalog_once_observations',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_once_observations (
      observation_key bigint IDENTITY(1,1) NOT NULL,
      schedule_key bigint NOT NULL,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      task_date date NOT NULL,
      cutoff_at datetime2(3) NOT NULL,
      schedule_version binary(8) NOT NULL,
      operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
      population_id uniqueidentifier NOT NULL,
      observed_at datetime2(3) NOT NULL,
      valid_until datetime2(3) NOT NULL,
      pair_count int NOT NULL,
      source_fence binary(32) NOT NULL,
      CONSTRAINT PK_catalog_once_observations PRIMARY KEY CLUSTERED(observation_key),
      CONSTRAINT UQ_catalog_once_observations_schedule UNIQUE(observation_key,schedule_key),
      CONSTRAINT FK_catalog_once_observations_approval FOREIGN KEY(portal_environment,schedule_key,schedule_version)
        REFERENCES scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version),
      CONSTRAINT FK_catalog_once_observations_population FOREIGN KEY(population_id)
        REFERENCES scheduling.catalog_schedule_population_approvals(population_id),
      CONSTRAINT CK_catalog_once_observations_environment CHECK (
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_once_observations_expected CHECK (pair_count BETWEEN 0 AND 5000),
      CONSTRAINT CK_catalog_once_observations_deadline CHECK (observed_at<cutoff_at AND observed_at<valid_until)
    );
  END;

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'scheduling.catalog_once_observations',N'U')
    AND name=N'IX_catalog_once_observations_lookup')
    CREATE INDEX IX_catalog_once_observations_lookup
      ON scheduling.catalog_once_observations(portal_environment,task_date,schedule_key,schedule_version,observation_key DESC)
      INCLUDE(cutoff_at,operation_id,population_id,observed_at,valid_until,pair_count,source_fence);

  IF OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_once_observation_pairs (
      observation_key bigint NOT NULL,
      schedule_key bigint NOT NULL,
      link_key bigint NOT NULL,
      catalog_execution_key bigint NOT NULL,
      catalog_execution_link_key bigint NOT NULL,
      CONSTRAINT PK_catalog_once_observation_pairs PRIMARY KEY CLUSTERED(observation_key,link_key),
      CONSTRAINT FK_catalog_once_pairs_observation FOREIGN KEY(observation_key,schedule_key)
        REFERENCES scheduling.catalog_once_observations(observation_key,schedule_key),
      CONSTRAINT FK_catalog_once_pairs_link FOREIGN KEY(link_key)
        REFERENCES core.catalog_operational_links(link_key),
      CONSTRAINT FK_catalog_once_pairs_execution_link FOREIGN KEY(catalog_execution_key,catalog_execution_link_key)
        REFERENCES workflow.catalog_task_execution_links(catalog_execution_key,catalog_execution_link_key),
      CONSTRAINT FK_catalog_once_pairs_execution_source FOREIGN KEY(catalog_execution_link_key,schedule_key)
        REFERENCES workflow.catalog_task_execution_sources(catalog_execution_link_key,schedule_key)
    );
  END;

  -- The ordered source fence contains only internal metadata, never client or connection data.

  EXEC sys.sp_executesql N'CREATE OR ALTER FUNCTION scheduling.catalog_once_source_fence(@portalEnvironment varchar(10))
RETURNS TABLE
AS RETURN (
  WITH source_rows AS (
    SELECT LOWER(CONVERT(char(36),b.source_id)) COLLATE Latin1_General_100_BIN2 AS source_id,
      b.source_role,b.validated_at,
      CASE WHEN p.active=1 AND p.status=''active'' AND p.encrypt_connection=1 AND p.password_configured=1
        AND b.validated_profile_version=p.row_version AND b.validated_at IS NOT NULL
        AND ((b.source_role=''erp-customers'' AND b.contract_version=''erp_v1'')
          OR (b.source_role=''sag-admin'' AND b.contract_version=''sag_admin_v1'')) THEN 1 ELSE 0 END AS configured,
      CONVERT(varchar(max),CONCAT(''["'',LOWER(CONVERT(char(36),b.source_id)),''","'',b.source_role,''","'',
        LOWER(CONVERT(char(16),CONVERT(binary(8),b.row_version),2)),''","'',
        LOWER(CONVERT(char(16),CONVERT(binary(8),p.row_version),2)),''"]'')) AS population_tuple,
      CONVERT(varchar(max),CONCAT(b.catalog_source_key,'':'',b.source_role,'':'',b.external_database_connection_key,'':'',
        CONVERT(char(16),CONVERT(binary(8),b.row_version),2),'':'',CONVERT(char(16),CONVERT(binary(8),p.row_version),2),'':'',
        COALESCE(CONVERT(varchar(20),h.attempt_ordinal),''-''),'':'',COALESCE(h.attempt_status,''-''),'':'',
        COALESCE(CONVERT(varchar(20),h.revision_key),''-''))) AS head_tuple
    FROM settings.catalog_source_bindings AS b WITH (HOLDLOCK)
    JOIN settings.external_database_connections AS p WITH (HOLDLOCK)
      ON p.external_database_connection_key=b.external_database_connection_key
    LEFT JOIN settings.catalog_customer_revision_heads AS h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
    WHERE b.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(b.portal_environment)=DATALENGTH(@portalEnvironment)
      AND b.source_state=''active''
  ),
  population AS (
    SELECT COUNT_BIG(*) AS source_count,
      SUM(CONVERT(bigint,CASE WHEN source_role=''sag-admin'' THEN 1 ELSE 0 END)) AS sag_source_count,
      MIN(configured) AS all_configured,MAX(validated_at) AS latest_validated_at,
      STRING_AGG(population_tuple,'','') WITHIN GROUP (ORDER BY source_id) AS population_sources
    FROM source_rows
  ),
  heads AS (
    SELECT STRING_AGG(head_tuple,''|'') WITHIN GROUP (ORDER BY source_id) AS head_manifest
    FROM source_rows
  )
  SELECT p.source_count,p.sag_source_count,p.all_configured,p.latest_validated_at,p.population_sources,
    CONVERT(binary(32),HASHBYTES(''SHA2_256'',CONCAT(''portal-sag:once-source-fence:v1|'',@portalEnvironment,''|'',
      h.head_manifest))) AS source_fence
  FROM population p CROSS JOIN heads h
);';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_once_observations_append_only
ON scheduling.catalog_once_observations AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM deleted)
    THROW 54902,N''Catalog once observations and their pairs are append-only.'',1;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_once_observation_pairs_append_only
ON scheduling.catalog_once_observation_pairs AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM deleted)
    THROW 54902,N''Catalog once observations and their pairs are append-only.'',1;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE scheduling.record_catalog_once_observations
  @portalEnvironment varchar(32), @taskDate date, @cutoffAt datetime2(3), @validUntil datetime2(3),
  @populationId uniqueidentifier, @observations nvarchar(max)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF @@TRANCOUNT=0 OR XACT_STATE()<>1
    THROW 54903,N''A committable catalog day transaction is required.'',1;
  IF @portalEnvironment IS NULL OR NOT (
      (@portalEnvironment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@portalEnvironment)=2)
      OR (@portalEnvironment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@portalEnvironment)=10))
    OR @taskDate IS NULL OR @taskDate>''99991230'' OR @cutoffAt IS NULL OR @validUntil IS NULL
    OR @populationId IS NULL OR @populationId=''00000000-0000-0000-0000-000000000000''
    THROW 54904,N''Invalid catalog once observation context.'',1;
  DECLARE @dateText char(10)=CONVERT(char(10),@taskDate,23);
  IF @cutoffAt<>DATEADD(hour,5,DATEADD(day,1,CONVERT(datetime2(3),@taskDate)))
    THROW 54904,N''Invalid catalog once observation context.'',1;
  DECLARE @databaseLock nvarchar(255)=N''portal.catalog-task.v1:database:''+@dateText,
          @domainLock nvarchar(255)=N''portal.catalog-task.v1:domain:''+@dateText;
  IF ISNULL(APPLOCK_MODE(N''public'',@databaseLock,N''Transaction''),N''NoLock'')<>N''Exclusive''
    OR ISNULL(APPLOCK_MODE(N''public'',@domainLock,N''Transaction''),N''NoLock'')<>N''Exclusive''
    THROW 54903,N''Both transaction catalog day locks are required.'',1;

  DECLARE @checkedAt datetime2(3)=SYSUTCDATETIME();
  IF @checkedAt>=@cutoffAt OR @checkedAt>=@validUntil
    THROW 54905,N''The catalog once observation deadline has passed.'',1;
  IF @observations IS NULL OR DATALENGTH(@observations)>8388608 OR ISJSON(@observations)<>1
    OR LEFT(LTRIM(@observations),1)<>N''[''
    THROW 54906,N''Invalid catalog once observation payload.'',1;

  -- Default OPENJSON exposes the original, untruncated scalar and property type.
  -- Canonical casing, uniqueness and widths are checked before typed conversion.
  IF EXISTS(SELECT 1 FROM OPENJSON(@observations) WHERE [type]<>5)
    THROW 54906,N''Invalid catalog once observation payload.'',1;
  DECLARE @rawSchedules table (
    ordinal int NOT NULL PRIMARY KEY, schedule_id nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL,
    schedule_version nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL,
    operation_id nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL, pairs nvarchar(max) NULL,
    properties int NOT NULL, expected_properties int NOT NULL
  );
  INSERT @rawSchedules
  SELECT CONVERT(int,j.[key]),
    MAX(CASE WHEN p.[key]=N''scheduleId'' AND DATALENGTH(p.[key])=20 AND p.[type]=1 THEN p.[value] END),
    MAX(CASE WHEN p.[key]=N''scheduleVersion'' AND DATALENGTH(p.[key])=30 AND p.[type]=1 THEN p.[value] END),
    MAX(CASE WHEN p.[key]=N''operationId'' AND DATALENGTH(p.[key])=22 AND p.[type]=1 THEN p.[value] END),
    MAX(CASE WHEN p.[key]=N''pairs'' AND DATALENGTH(p.[key])=10 AND p.[type]=4 THEN p.[value] END),
    COUNT(p.[key]),SUM(CASE WHEN p.[type]=1 AND (
      (p.[key]=N''scheduleId'' AND DATALENGTH(p.[key])=20)
      OR (p.[key]=N''scheduleVersion'' AND DATALENGTH(p.[key])=30)
      OR (p.[key]=N''operationId'' AND DATALENGTH(p.[key])=22))
      OR (p.[key]=N''pairs'' AND DATALENGTH(p.[key])=10 AND p.[type] IN (0,4)) THEN 1 ELSE 0 END)
  FROM OPENJSON(@observations) j OUTER APPLY OPENJSON(j.[value]) p
  GROUP BY j.[key];
  DECLARE @submitted int=(SELECT COUNT(*) FROM @rawSchedules);
  IF @submitted NOT BETWEEN 1 AND 5000 OR EXISTS (
    SELECT 1 FROM @rawSchedules WHERE properties<>4 OR expected_properties<>4 OR schedule_id IS NULL
      OR DATALENGTH(schedule_id) NOT BETWEEN 2 AND 300
      OR DATALENGTH(LTRIM(RTRIM(schedule_id)))<>DATALENGTH(schedule_id)
      OR schedule_version IS NULL OR DATALENGTH(schedule_version)<>32 OR schedule_version LIKE N''%[^0-9a-f]%''
      OR operation_id IS NULL OR DATALENGTH(operation_id) NOT BETWEEN 2 AND 400
      OR DATALENGTH(operation_id)<>2*LEN(operation_id) OR operation_id NOT LIKE N''[A-Za-z0-9]%''
      OR REPLACE(operation_id,N''-'',N'''') LIKE N''%[^A-Za-z0-9._:]%''
  ) THROW 54906,N''Invalid catalog once observation payload.'',1;

  IF EXISTS(SELECT 1 FROM @rawSchedules GROUP BY CONVERT(nvarchar(150),schedule_id) HAVING COUNT(*)<>1)
    THROW 54906,N''Invalid catalog once observation payload.'',1;

  DECLARE @rawPairs table (
    ordinal int NOT NULL, pair_ordinal int NOT NULL,
    link_id nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL,
    execution_key nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL,
    properties int NOT NULL, expected_properties int NOT NULL,
    PRIMARY KEY(ordinal,pair_ordinal)
  );
  IF (SELECT COUNT_BIG(*) FROM @rawSchedules r CROSS APPLY OPENJSON(r.pairs) j)>20000 OR EXISTS (
    SELECT 1 FROM @rawSchedules r CROSS APPLY OPENJSON(r.pairs) j WHERE j.[type]<>5
  ) THROW 54906,N''Invalid catalog once observation payload.'',1;
  INSERT @rawPairs
  SELECT r.ordinal,CONVERT(int,j.[key]),
    MAX(CASE WHEN p.[key]=N''linkId'' AND DATALENGTH(p.[key])=12 AND p.[type]=1 THEN p.[value] END),
    MAX(CASE WHEN p.[key]=N''executionKey'' AND DATALENGTH(p.[key])=24 AND p.[type]=1 THEN p.[value] END),
    COUNT(p.[key]),SUM(CASE WHEN p.[type]=1 AND ((p.[key]=N''linkId'' AND DATALENGTH(p.[key])=12)
      OR (p.[key]=N''executionKey'' AND DATALENGTH(p.[key])=24)) THEN 1 ELSE 0 END)
  FROM @rawSchedules r CROSS APPLY OPENJSON(r.pairs) j OUTER APPLY OPENJSON(j.[value]) p
  GROUP BY r.ordinal,j.[key];
  IF EXISTS (
    SELECT 1 FROM @rawPairs WHERE properties<>2 OR expected_properties<>2 OR link_id IS NULL
      OR DATALENGTH(link_id)<>72 OR TRY_CONVERT(uniqueidentifier,CONVERT(nvarchar(36),link_id)) IS NULL
      OR link_id<>LOWER(CONVERT(nvarchar(36),TRY_CONVERT(uniqueidentifier,CONVERT(nvarchar(36),link_id))))
      OR link_id=N''00000000-0000-0000-0000-000000000000'' OR execution_key IS NULL
      OR DATALENGTH(execution_key)<>128 OR execution_key LIKE N''%[^0-9a-f]%''
  ) OR EXISTS(
    SELECT 1 FROM @rawPairs GROUP BY ordinal,TRY_CONVERT(uniqueidentifier,CONVERT(nvarchar(36),link_id)) HAVING COUNT(*)<>1
  ) OR EXISTS(
    SELECT 1 FROM @rawPairs GROUP BY ordinal HAVING COUNT(*)>5000
  ) OR EXISTS(
    SELECT 1 FROM @rawSchedules r WHERE r.pairs IS NOT NULL AND NOT EXISTS(SELECT 1 FROM @rawPairs p WHERE p.ordinal=r.ordinal)
  ) THROW 54906,N''Invalid catalog once observation payload.'',1;

  DECLARE @sourceFence binary(32), @sourceCount bigint, @linkCount int, @populationDigest binary(32),
    @populationSources varchar(max), @populationLinks varchar(max), @activeLinkCount bigint;
  SELECT @sourceFence=f.source_fence,@sourceCount=f.source_count,@populationSources=f.population_sources
  FROM scheduling.catalog_once_source_fence(@portalEnvironment) f
  WHERE f.all_configured=1 AND f.latest_validated_at<=@checkedAt AND f.sag_source_count=1 AND f.source_count BETWEEN 2 AND 50;
  SELECT @linkCount=a.link_count,@populationDigest=a.population_sha256
  FROM scheduling.catalog_schedule_population_approvals a WITH (HOLDLOCK)
  JOIN security.users u WITH (HOLDLOCK) ON u.user_key=a.approved_by AND u.active=1
  JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key AND ur.role_id=N''super_admin''
  JOIN security.roles rr WITH (HOLDLOCK) ON rr.role_id=ur.role_id AND rr.active=1 AND rr.system_role=1 AND rr.protected_role=1
  WHERE a.population_id=@populationId AND a.portal_environment=@portalEnvironment
    AND a.source_count=@sourceCount AND a.retired_at IS NULL AND a.approved_at<=@checkedAt AND a.valid_until>=@validUntil;
  IF @sourceFence IS NULL OR @linkCount IS NULL
    THROW 54907,N''Current catalog population approval is required.'',1;

  -- These canonical JSON tuples contain ASCII IDs/versions only. VARCHAR bytes
  -- therefore match the existing UTF-8 manifest on all database code pages.
  SELECT @activeLinkCount=COUNT_BIG(*),
    @populationLinks=STRING_AGG(CONVERT(varchar(max),CONCAT(''"'',wanted.link_id,''"'')),'','')
      WITHIN GROUP(ORDER BY wanted.link_id COLLATE Latin1_General_100_BIN2)
  FROM (
    SELECT TOP (5001) LOWER(CONVERT(char(36),l.link_id)) AS link_id
    FROM core.catalog_operational_links l WITH (HOLDLOCK)
    JOIN core.catalog_operational_owners o WITH (HOLDLOCK) ON o.owner_key=l.owner_key
    JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=l.catalog_source_key
    WHERE l.portal_environment=@portalEnvironment AND l.retired_at IS NULL AND o.retired_at IS NULL
    ORDER BY l.link_key
  ) AS wanted;
  IF @activeLinkCount<>@linkCount OR @populationDigest<>HASHBYTES(''SHA2_256'',CONCAT(
    ''["portal-sag:catalog-schedule-population:v1","'',@portalEnvironment,''",['',@populationSources,''],['',@populationLinks,'']]''))
    THROW 54907,N''Current catalog population approval is required.'',1;

  DECLARE @schedules table (
    ordinal int NOT NULL PRIMARY KEY, schedule_key bigint NOT NULL UNIQUE, schedule_version binary(8) NOT NULL,
    operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL, pair_count int NOT NULL,
    previous_key bigint NULL, previous_positive_key bigint NULL
  );
  INSERT @schedules(ordinal,schedule_key,schedule_version,operation_id,pair_count)
  SELECT r.ordinal,s.schedule_key,s.row_version,a.operation_id,COALESCE(p.pair_count,0)
  FROM @rawSchedules r
  JOIN scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
    ON s.source_id=CONVERT(nvarchar(150),r.schedule_id) COLLATE DATABASE_DEFAULT
    AND s.source_id COLLATE Latin1_General_100_BIN2=r.schedule_id AND DATALENGTH(s.source_id)=DATALENGTH(r.schedule_id)
    AND s.active=1 AND s.deleted_at IS NULL AND s.frequency_type=''once'' AND s.start_date=@taskDate
    AND s.timezone COLLATE Latin1_General_100_BIN2=N''America/Bogota'' AND DATALENGTH(s.timezone)=28
    AND s.row_version=TRY_CONVERT(binary(8),r.schedule_version,2)
  JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK)
    ON a.schedule_key=s.schedule_key AND a.schedule_version=s.row_version AND a.portal_environment=@portalEnvironment
    AND a.operation_id=r.operation_id AND DATALENGTH(a.operation_id)=DATALENGTH(r.operation_id)
    AND a.approved_at<=@checkedAt AND a.retired_at IS NULL
  LEFT JOIN (SELECT ordinal,COUNT(*) AS pair_count FROM @rawPairs GROUP BY ordinal) p ON p.ordinal=r.ordinal;
  IF @@ROWCOUNT<>@submitted THROW 54908,N''Current once schedule and operation approval are required.'',1;

  DECLARE @pairs table (
    ordinal int NOT NULL, link_key bigint NOT NULL, catalog_execution_key bigint NOT NULL,
    catalog_execution_link_key bigint NOT NULL, PRIMARY KEY(ordinal,link_key)
  );
  INSERT @pairs
  SELECT r.ordinal,l.link_key,e.catalog_execution_key,x.catalog_execution_link_key
  FROM @rawPairs r JOIN @schedules s ON s.ordinal=r.ordinal
  JOIN workflow.catalog_task_executions e WITH (HOLDLOCK) ON e.execution_key=TRY_CONVERT(binary(32),r.execution_key,2)
    AND e.retired_at IS NULL AND e.cutoff_at=@cutoffAt AND e.cutoff_evaluated_at IS NULL
    AND e.occurrence_id=CONVERT(nvarchar(10),@dateText) AND DATALENGTH(e.occurrence_id)=20
    AND e.operation_id=s.operation_id AND DATALENGTH(e.operation_id)=DATALENGTH(s.operation_id)
  JOIN workflow.update_tasks t WITH (HOLDLOCK) ON t.task_key=e.task_key AND t.task_date=@taskDate
    AND t.target_type=e.execution_kind AND t.status<>''cancelled''
  JOIN core.catalog_operational_link_evidence l WITH (HOLDLOCK) ON l.link_id=TRY_CONVERT(uniqueidentifier,r.link_id)
    AND l.portal_environment=@portalEnvironment AND l.retired_at IS NULL AND l.owner_retired_at IS NULL
    AND l.evidence_state=''verified'' AND l.verified_until>=@validUntil AND l.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2
  JOIN workflow.catalog_task_execution_links x WITH (HOLDLOCK) ON x.catalog_execution_key=e.catalog_execution_key
    AND x.link_id=r.link_id AND DATALENGTH(x.link_id)=72 AND x.execution_kind=e.execution_kind
    AND x.catalog_source_key=l.catalog_source_key AND x.catalog_record_id=CONVERT(nvarchar(11),l.source_record_id)
    AND DATALENGTH(x.catalog_record_id)=DATALENGTH(CONVERT(nvarchar(11),l.source_record_id))
    AND x.client_key=l.client_key AND x.domain_key=l.domain_key AND x.link_environment=l.link_environment COLLATE DATABASE_DEFAULT
    AND (x.database_key=l.database_key OR (x.database_key IS NULL AND l.database_key IS NULL))
    AND x.link_state=''active'' AND x.retired_at IS NULL
  JOIN workflow.catalog_task_execution_sources attached WITH (HOLDLOCK)
    ON attached.catalog_execution_link_key=x.catalog_execution_link_key AND attached.schedule_key=s.schedule_key
    AND attached.attached_at<=@checkedAt AND attached.detached_at IS NULL
  JOIN core.catalog_physical_targets target WITH (HOLDLOCK)
    ON target.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id) AND DATALENGTH(e.verified_target_id)=72
    AND target.portal_environment=@portalEnvironment AND target.target_kind=l.target_kind
  JOIN core.catalog_physical_target_links physical WITH (HOLDLOCK)
    ON physical.physical_target_key=target.physical_target_key AND physical.portal_environment=@portalEnvironment
    AND physical.target_kind=target.target_kind AND physical.client_key=l.client_key AND physical.domain_key=l.domain_key
    AND (physical.database_key=l.database_key OR (physical.database_key IS NULL AND l.database_key IS NULL))
    AND physical.retired_at IS NULL AND physical.verified_at<=@checkedAt AND physical.registered_at<=@checkedAt
    AND physical.valid_until>=@validUntil
  JOIN core.domains d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=l.client_key
  LEFT JOIN core.databases db WITH (HOLDLOCK) ON db.database_key=l.database_key AND db.domain_key=l.domain_key AND db.client_key=l.client_key
  LEFT JOIN core.database_access_profiles p WITH (HOLDLOCK) ON p.access_profile_key=db.access_profile_key
  WHERE (l.target_kind=''database'' AND p.active=1 AND physical.access_profile_key=p.access_profile_key
      AND physical.access_profile_version=p.row_version
      AND target.database_name_fingerprint=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),p.initial_catalog)))
    OR (l.target_kind=''domain'' AND physical.domain_route_fingerprint=HASHBYTES(''SHA2_256'',
      CONVERT(varbinary(max),N''portal-sag:web-route:v1|'')+CONVERT(binary(4),DATALENGTH(d.domain_name_normalized))
        +CONVERT(varbinary(max),d.domain_name_normalized)+CASE WHEN d.publishable_domain IS NULL THEN CONVERT(varbinary(max),0x00)
        ELSE CONVERT(varbinary(max),0x01)+CONVERT(binary(4),DATALENGTH(d.publishable_domain))
          +CONVERT(varbinary(max),d.publishable_domain) END));

  -- A prior blocked row never erases the last positive baseline. Losing or
  -- reassigning even one previously expected pair blocks the new observation.
  UPDATE s SET previous_key=prior.observation_key,previous_positive_key=positive.observation_key
  FROM @schedules s
  OUTER APPLY(SELECT TOP (1) o.observation_key FROM scheduling.catalog_once_observations o WITH (UPDLOCK,HOLDLOCK)
    WHERE o.portal_environment=@portalEnvironment AND o.task_date=@taskDate AND o.schedule_key=s.schedule_key
      AND o.schedule_version=s.schedule_version ORDER BY o.observation_key DESC) prior
  OUTER APPLY(SELECT TOP (1) o.observation_key FROM scheduling.catalog_once_observations o WITH (UPDLOCK,HOLDLOCK)
    WHERE o.portal_environment=@portalEnvironment AND o.task_date=@taskDate AND o.schedule_key=s.schedule_key
      AND o.schedule_version=s.schedule_version AND o.pair_count>0 ORDER BY o.observation_key DESC) positive;

  UPDATE s SET pair_count=0 FROM @schedules s
  WHERE s.pair_count<>(SELECT COUNT(*) FROM @pairs p WHERE p.ordinal=s.ordinal)
    OR EXISTS(
      SELECT p.link_key,p.catalog_execution_key,p.catalog_execution_link_key
      FROM scheduling.catalog_once_observation_pairs p WITH (HOLDLOCK) WHERE p.observation_key=s.previous_positive_key
      EXCEPT SELECT p.link_key,p.catalog_execution_key,p.catalog_execution_link_key FROM @pairs p WHERE p.ordinal=s.ordinal
    );

  DECLARE @observedAt datetime2(3)=SYSUTCDATETIME();
  IF @observedAt>=@cutoffAt OR @observedAt>=@validUntil
    THROW 54905,N''The catalog once observation deadline has passed.'',1;

  DECLARE @inserted table (observation_key bigint NOT NULL, schedule_key bigint NOT NULL PRIMARY KEY);
  INSERT scheduling.catalog_once_observations(schedule_key,portal_environment,task_date,cutoff_at,schedule_version,
    operation_id,population_id,observed_at,valid_until,pair_count,source_fence)
  OUTPUT inserted.observation_key,inserted.schedule_key INTO @inserted
  SELECT s.schedule_key,@portalEnvironment,@taskDate,@cutoffAt,s.schedule_version,s.operation_id,@populationId,
    @observedAt,@validUntil,s.pair_count,@sourceFence
  FROM @schedules s
  WHERE NOT EXISTS (
    SELECT 1 FROM scheduling.catalog_once_observations o WITH (HOLDLOCK)
    WHERE o.observation_key=s.previous_key AND o.pair_count=s.pair_count AND o.cutoff_at=@cutoffAt
      AND o.operation_id=s.operation_id AND o.population_id=@populationId
      AND o.valid_until=@validUntil AND o.source_fence=@sourceFence
      AND (s.pair_count=0 OR (
        NOT EXISTS (SELECT p.link_key,p.catalog_execution_key,p.catalog_execution_link_key
          FROM scheduling.catalog_once_observation_pairs p WITH (HOLDLOCK) WHERE p.observation_key=o.observation_key
          EXCEPT SELECT p.link_key,p.catalog_execution_key,p.catalog_execution_link_key FROM @pairs p WHERE p.ordinal=s.ordinal)
        AND NOT EXISTS (SELECT p.link_key,p.catalog_execution_key,p.catalog_execution_link_key FROM @pairs p WHERE p.ordinal=s.ordinal
          EXCEPT SELECT p.link_key,p.catalog_execution_key,p.catalog_execution_link_key
            FROM scheduling.catalog_once_observation_pairs p WITH (HOLDLOCK) WHERE p.observation_key=o.observation_key)
      ))
  );

  INSERT scheduling.catalog_once_observation_pairs(observation_key,schedule_key,link_key,catalog_execution_key,catalog_execution_link_key)
  SELECT i.observation_key,s.schedule_key,p.link_key,p.catalog_execution_key,p.catalog_execution_link_key
  FROM @inserted i JOIN @schedules s ON s.schedule_key=i.schedule_key AND s.pair_count>0
  JOIN @pairs p ON p.ordinal=s.ordinal;

  DECLARE @finishedAt datetime2(3)=SYSUTCDATETIME();
  IF @finishedAt>=@cutoffAt OR @finishedAt>=@validUntil
    THROW 54905,N''The catalog once observation deadline has passed.'',1;
  SELECT @submitted AS accepted;
END;';


  DENY INSERT,UPDATE,DELETE ON OBJECT::scheduling.catalog_once_observations TO portal_runtime;
  DENY INSERT,UPDATE,DELETE ON OBJECT::scheduling.catalog_once_observation_pairs TO portal_runtime;
  GRANT EXECUTE ON OBJECT::scheduling.record_catalog_once_observations TO portal_runtime;
  IF @owns049Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns049Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
