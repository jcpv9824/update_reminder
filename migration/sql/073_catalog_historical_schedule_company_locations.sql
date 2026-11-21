/*
  Read-only historical Company/location certification for approved schedules.
  No source writes, no persisted evidence or data grants.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns073 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns073=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND is_read_only=0 AND collation_name COLLATE Latin1_General_100_BIN2=N'Modern_Spanish_CI_AS')
    THROW 57300,N'Expected a writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock073 int;
  EXEC @lock073=sys.sp_getapplock @Resource=N'portal-sag:migration:073:historical-company-location',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock073<0 THROW 57301,N'Could not reserve the historical Company evidence migration.',1;
  IF (SELECT COUNT(*) FROM sys.database_principals WHERE [type]='R' AND name IN (N'portal_runtime',N'portal_catalog_v2_publisher'))<>2
    OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NULL
    OR EXISTS(SELECT 1 FROM (VALUES
      (OBJECT_ID(N'settings.TR_catalog_source_heads_record_event',N'TR')),
      (OBJECT_ID(N'settings.TR_catalog_source_head_events_append_only',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sag_company_revision_seal',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sag_company_location_observations_guard',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_stamp',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_immutable',N'TR')),
      (OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_intents_immutable',N'TR')),
      (OBJECT_ID(N'scheduling.TR_catalog_schedule_copy_links_guard',N'TR')))
      required(object_id) LEFT JOIN sys.triggers t ON t.object_id=required.object_id
      WHERE t.object_id IS NULL OR t.is_disabled=1)
    THROW 57302,N'Install historical source, sealed Company and schedule-copy prerequisites first.',1;

  -- Empty compatible views until 080 is installed. Replaying 073 never replaces
  -- the real definitions. DISTINCT keeps these schema-readable projections non-updatable.
  IF OBJECT_ID(N'scheduling.v_catalog_schedule_draft_approval',N'V') IS NULL
    EXEC sys.sp_executesql N'CREATE VIEW scheduling.v_catalog_schedule_draft_approval AS
      SELECT DISTINCT CONVERT(bigint,NULL) AS schedule_key,CONVERT(binary(8),NULL) AS schedule_version,
        CONVERT(varchar(10),NULL) COLLATE Latin1_General_100_BIN2 AS portal_environment,
        CONVERT(uniqueidentifier,NULL) AS proposal_id,CONVERT(datetime2(3),NULL) AS approved_at,
        CONVERT(bit,NULL) AS manual_selection,CONVERT(nvarchar(200),NULL) COLLATE Latin1_General_100_BIN2 AS operation_id WHERE 1=0;';
  IF OBJECT_ID(N'scheduling.v_catalog_schedule_draft_pins',N'V') IS NULL
    EXEC sys.sp_executesql N'CREATE VIEW scheduling.v_catalog_schedule_draft_pins AS
      SELECT DISTINCT CONVERT(bigint,NULL) AS schedule_key,CONVERT(uniqueidentifier,NULL) AS link_id,
        CONVERT(varchar(8),NULL) COLLATE Latin1_General_100_BIN2 AS target_kind,
        CONVERT(uniqueidentifier,NULL) AS verified_target_id WHERE 1=0;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.verify_catalog_historical_schedule_company_locations
  @environment varchar(10), @scheduleKey varchar(20), @asOf datetime2(3),
  @matchKeyVersion smallint, @claims nvarchar(max)
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @key bigint=TRY_CONVERT(bigint,@scheduleKey);
  DECLARE @zero uniqueidentifier=''00000000-0000-0000-0000-000000000000'';
  DECLARE @dynamic bit=0,@copy bit=0,@draft bit=0,@draftManual bit=0;
  -- No table permission, module impersonation, or nested transaction is needed.
  IF ISNULL(IS_ROLEMEMBER(N''portal_runtime''),0)<>1 OR ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>0
    OR @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
    OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
    OR @environment IS NULL OR NOT (
        (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
          AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
        OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
          AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
    OR @key IS NULL OR @key<=0 OR @scheduleKey<>CONVERT(varchar(20),@key)
    OR DATALENGTH(@scheduleKey)<>DATALENGTH(CONVERT(varchar(20),@key))
    OR @asOf IS NULL OR @asOf>SYSUTCDATETIME() OR @matchKeyVersion IS NULL OR @matchKeyVersion<=0
    OR @claims IS NULL OR DATALENGTH(@claims)>41943040 OR LEFT(@claims,1)<>N''['' OR ISJSON(@claims)<>1
    BEGIN
      SELECT CONVERT(char(36),NULL) AS linkId,CONVERT(int,NULL) AS matchCount WHERE 1=0;
      RETURN;
    END;

  -- An ambiguous or proofless exact origin must never fall back to dynamic scope.
  SELECT @copy=CASE WHEN EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents WITH (HOLDLOCK)
    WHERE copy_schedule_key=@key) THEN 1 ELSE 0 END;
  SELECT @draft=1,@draftManual=manual_selection FROM scheduling.v_catalog_schedule_draft_approval WITH (HOLDLOCK)
    WHERE schedule_key=@key;
  IF @copy=0 AND @draftManual=0 SET @dynamic=1;
  -- Normally the real boundary is max(Bogotá midnight, creation). For a new
  -- reviewed definition on its start day, only its own real approval can fix it.
  IF NOT EXISTS (
    SELECT 1 FROM scheduling.update_schedules s WITH (HOLDLOCK)
    JOIN scheduling.catalog_schedule_operation_approvals schedule_approval WITH (HOLDLOCK)
      ON schedule_approval.schedule_key=s.schedule_key AND schedule_approval.schedule_version=s.row_version
      AND schedule_approval.portal_environment=@environment COLLATE Latin1_General_100_BIN2
      AND schedule_approval.approved_at<=@asOf AND schedule_approval.retired_at IS NULL
    CROSS APPLY (VALUES(DATEADD(hour,5,CONVERT(datetime2(3),s.start_date)))) bogota(midnight_utc)
    WHERE s.schedule_key=@key AND s.active=1 AND s.deleted_at IS NULL AND s.catalog_activation_enabled=1
      AND s.timezone COLLATE Latin1_General_100_BIN2=N''America/Bogota'' AND DATALENGTH(s.timezone)=28
      AND s.updated_at<=@asOf AND NOT (@copy=1 AND @draft=1)
      AND (@draft=1 OR s.source_id COLLATE Latin1_General_100_BIN2 NOT LIKE N''catalog-draft-%'')
      AND (@draft=0 OR EXISTS(SELECT 1 FROM scheduling.v_catalog_schedule_draft_approval draft WITH (HOLDLOCK)
        WHERE draft.schedule_key=s.schedule_key AND draft.schedule_version=s.row_version
          AND draft.portal_environment=schedule_approval.portal_environment AND draft.operation_id=schedule_approval.operation_id
          AND draft.approved_at=schedule_approval.approved_at
          AND draft.manual_selection=CASE WHEN s.selection_mode=''manual'' THEN 1 ELSE 0 END))
      AND (@copy=0 OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents copy WITH (HOLDLOCK)
        WHERE copy.copy_schedule_key=s.schedule_key AND copy.portal_environment=schedule_approval.portal_environment
          AND copy.operation_id=schedule_approval.operation_id AND copy.created_at<=@asOf))
      AND (@asOf=CASE WHEN s.created_at>bogota.midnight_utc THEN s.created_at ELSE bogota.midnight_utc END
        OR ((@copy=1 OR @draft=1) AND s.created_at>=bogota.midnight_utc AND @asOf>=s.created_at
          AND @asOf<DATEADD(day,1,bogota.midnight_utc) AND @asOf=schedule_approval.approved_at))
      AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_snapshots x WITH (HOLDLOCK) WHERE x.schedule_key=s.schedule_key)
  )
    BEGIN
      SELECT CONVERT(char(36),NULL) AS linkId,CONVERT(int,NULL) AS matchCount WHERE 1=0;
      RETURN;
    END;

  DECLARE @cutoff_links table(id char(36) COLLATE Latin1_General_100_BIN2 PRIMARY KEY);
  IF @dynamic=1
  BEGIN
    -- All four canonical JSON fields are ASCII. Keep an identical collation
    -- for CONCAT on Modern_Spanish databases without changing the digest bytes.
    DECLARE @cutoff_sources table(source_key bigint PRIMARY KEY,id char(36) COLLATE Latin1_General_100_BIN2 UNIQUE,
      role varchar(15) COLLATE Latin1_General_100_BIN2,binding_hex char(16) COLLATE Latin1_General_100_BIN2,
      profile_hex char(16) COLLATE Latin1_General_100_BIN2);
    INSERT @cutoff_sources
    SELECT TOP (51) b.catalog_source_key,LOWER(CONVERT(char(36),b.source_id)),b.source_role,
      LOWER(CONVERT(char(16),b.row_version,2)),LOWER(CONVERT(char(16),p.row_version,2))
    FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
    JOIN settings.external_database_connections p WITH (HOLDLOCK)
      ON p.external_database_connection_key=b.external_database_connection_key
      AND p.active=1 AND p.status=''active'' AND p.encrypt_connection=1 AND p.password_configured=1
      AND p.row_version=b.validated_profile_version AND p.updated_at<=@asOf
    CROSS APPLY (SELECT TOP (1) e.revision_key,e.attempt_ordinal,e.attempted_at,e.attempt_status
      FROM settings.catalog_source_head_events e WITH (HOLDLOCK)
      WHERE e.catalog_source_key=b.catalog_source_key AND e.recorded_at<=@asOf ORDER BY e.head_event_key DESC) head
    JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
      ON r.catalog_source_key=b.catalog_source_key AND r.revision_key=head.revision_key
      AND r.source_role=b.source_role AND r.attempt_ordinal=head.attempt_ordinal
      AND r.binding_version=b.row_version AND r.profile_version=p.row_version AND r.match_key_version=@matchKeyVersion
    WHERE b.portal_environment=@environment COLLATE Latin1_General_100_BIN2 AND b.source_state=''active''
      AND b.validated_at<=@asOf AND b.updated_at<=@asOf AND head.attempt_status=''succeeded'' AND head.attempted_at<=@asOf
      AND r.observed_at<=@asOf AND r.sealed_at<=@asOf AND r.verified_until>@asOf
      AND ((b.source_role=''erp-customers'' AND b.contract_version=''erp_v1'')
        OR (b.source_role=''sag-admin'' AND b.contract_version=''sag_admin_v2'' AND r.has_sag_inventory_evidence=1
          AND r.expected_sag_company_rows IS NOT NULL
          AND (SELECT COUNT_BIG(*) FROM core.catalog_sag_customer_directory_rows d WITH (HOLDLOCK)
            WHERE d.revision_key=r.revision_key)=r.expected_rows
          AND (SELECT COUNT_BIG(*) FROM core.catalog_sag_company_revision_rows c WITH (HOLDLOCK)
            WHERE c.revision_key=r.revision_key)=r.expected_sag_company_rows))
    ORDER BY b.catalog_source_key;

    INSERT @cutoff_links
    SELECT TOP (5001) LOWER(CONVERT(char(36),l.link_id))
    FROM core.catalog_operational_links l WITH (HOLDLOCK)
    JOIN core.catalog_operational_owners o WITH (HOLDLOCK)
      ON o.owner_key=l.owner_key AND o.portal_environment=l.portal_environment AND o.client_key=l.client_key
    JOIN @cutoff_sources s ON s.source_key=l.catalog_source_key AND s.role=''erp-customers''
    WHERE l.portal_environment=@environment COLLATE Latin1_General_100_BIN2
      AND l.registered_at<=@asOf AND (l.retired_at IS NULL OR l.retired_at>@asOf)
      AND o.registered_at<=@asOf AND (o.retired_at IS NULL OR o.retired_at>@asOf)
    ORDER BY l.link_key;

    DECLARE @source_count int=(SELECT COUNT(*) FROM @cutoff_sources),@link_count int=(SELECT COUNT(*) FROM @cutoff_links);
    DECLARE @sources_json varchar(max),@links_json varchar(max),@digest binary(32);
    SELECT @sources_json=STRING_AGG(CONVERT(varchar(max),CONCAT(''["'',id,''","'',role,''","'',binding_hex,''","'',profile_hex,''"]'')), '','')
      WITHIN GROUP (ORDER BY id) FROM @cutoff_sources;
    SELECT @links_json=STRING_AGG(CONVERT(varchar(max),CONCAT(''"'',id,''"'')), '','')
      WITHIN GROUP (ORDER BY id) FROM @cutoff_links;
    SET @digest=HASHBYTES(''SHA2_256'',CONVERT(varchar(max),
      CONCAT(''["portal-sag:catalog-schedule-population:v1","'',@environment,''",['',@sources_json,''],['',@links_json,'']]'')));
    IF @source_count NOT BETWEEN 2 AND 50 OR @link_count NOT BETWEEN 1 AND 5000
      OR (SELECT COUNT(*) FROM @cutoff_sources WHERE role=''sag-admin'')<>1
      OR @source_count<>(SELECT COUNT_BIG(*) FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
        WHERE b.portal_environment=@environment COLLATE Latin1_General_100_BIN2 AND b.source_state=''active'')
      OR @link_count<>(SELECT COUNT_BIG(*) FROM core.catalog_operational_links l WITH (HOLDLOCK)
        JOIN core.catalog_operational_owners o WITH (HOLDLOCK)
          ON o.owner_key=l.owner_key AND o.client_key=l.client_key AND o.portal_environment=l.portal_environment
        WHERE l.portal_environment=@environment COLLATE Latin1_General_100_BIN2
          AND l.registered_at<=@asOf AND (l.retired_at IS NULL OR l.retired_at>@asOf)
          AND o.registered_at<=@asOf AND (o.retired_at IS NULL OR o.retired_at>@asOf))
      OR (SELECT COUNT(*) FROM settings.catalog_match_key_registry WITH (HOLDLOCK)
        WHERE portal_environment=@environment COLLATE Latin1_General_100_BIN2 AND match_key_version=@matchKeyVersion AND enrolled_at<=@asOf)<>1
      OR NOT EXISTS (
        SELECT 1 FROM scheduling.catalog_schedule_population_approvals a WITH (HOLDLOCK)
        JOIN security.users u WITH (HOLDLOCK) ON u.user_key=a.approved_by AND u.active=1
        JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key AND ur.role_id=N''super_admin''
        JOIN security.roles sr WITH (HOLDLOCK) ON sr.role_id=ur.role_id AND sr.active=1 AND sr.system_role=1 AND sr.protected_role=1
        WHERE a.portal_environment=@environment COLLATE Latin1_General_100_BIN2 AND a.approved_at<=@asOf
          AND a.valid_until>@asOf AND (a.retired_at IS NULL OR a.retired_at>@asOf)
        HAVING COUNT(*)=1 AND MAX(CASE WHEN a.source_count=@source_count AND a.link_count=@link_count
          AND a.population_sha256=@digest THEN 1 ELSE 0 END)=1)
    BEGIN
      SELECT CONVERT(char(36),NULL) AS linkId,CONVERT(int,NULL) AS matchCount WHERE 1=0;
      RETURN;
    END;
  END;

  -- Strict keys/types/widths before conversion: uniqueidentifier otherwise
  -- silently accepts an overlength prefix, and JSON_VALUE hides duplicate keys.
  DECLARE @input table(ordinal int NOT NULL PRIMARY KEY,object_json nvarchar(max) NOT NULL);
  INSERT @input SELECT TOP (40001) CONVERT(int,[key]),value FROM OPENJSON(@claims)
    WHERE [type]=5 AND DATALENGTH(value)<=1600;
  IF (SELECT COUNT(*) FROM @input) NOT BETWEEN 1 AND 40000
    OR (SELECT COUNT(*) FROM @input)<>(SELECT COUNT(*) FROM OPENJSON(@claims))
    OR EXISTS(
      SELECT 1 FROM @input i OUTER APPLY (
        SELECT COUNT(*) AS field_count,COUNT(DISTINCT p.[key] COLLATE Latin1_General_100_BIN2) AS unique_fields,
          COUNT(CASE WHEN (p.[type]=1 AND p.[key] COLLATE Latin1_General_100_BIN2 IN
            (N''linkId'',N''physicalTargetId'',N''physicalLinkId'',N''profileVersion'',N''sagSourceId'',N''sagRevisionId'',N''locationTokenHex''))
            OR (p.[type]=2 AND p.[key] COLLATE Latin1_General_100_BIN2 IN (N''sagCustomerRecordId'',N''companyRecordId'')) THEN 1 END) AS valid_fields
        FROM OPENJSON(i.object_json) p
      ) fields WHERE fields.field_count<>9 OR fields.unique_fields<>9 OR fields.valid_fields<>9)
    BEGIN
      SELECT CONVERT(char(36),NULL) AS linkId,CONVERT(int,NULL) AS matchCount WHERE 1=0;
      RETURN;
    END;

  DECLARE @parsed table(link_id uniqueidentifier NULL,physical_target_id uniqueidentifier NULL,physical_link_id uniqueidentifier NULL,
    profile_version binary(8) NULL,sag_source_id uniqueidentifier NULL,sag_revision_key bigint NULL,
    sag_customer_record_id int NULL,company_record_id int NULL,location_token binary(32) NULL,
    INDEX IX_073_claim_link_company NONCLUSTERED(link_id,company_record_id));
  INSERT @parsed
  SELECT
    CASE WHEN DATALENGTH(p.linkId)=72 AND p.linkId COLLATE Latin1_General_100_BIN2=LOWER(CONVERT(char(36),typed.link_id)) THEN typed.link_id END,
    CASE WHEN DATALENGTH(p.physicalTargetId)=72 AND p.physicalTargetId COLLATE Latin1_General_100_BIN2=LOWER(CONVERT(char(36),typed.target_id)) THEN typed.target_id END,
    CASE WHEN DATALENGTH(p.physicalLinkId)=72 AND p.physicalLinkId COLLATE Latin1_General_100_BIN2=LOWER(CONVERT(char(36),typed.physical_link_id)) THEN typed.physical_link_id END,
    CASE WHEN DATALENGTH(p.profileVersion)=32 AND p.profileVersion COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9a-f]%''
      THEN TRY_CONVERT(binary(8),p.profileVersion,2) END,
    CASE WHEN DATALENGTH(p.sagSourceId)=72 AND p.sagSourceId COLLATE Latin1_General_100_BIN2=LOWER(CONVERT(char(36),typed.source_id)) THEN typed.source_id END,
    CASE WHEN typed.revision_key>0 AND p.sagRevisionId COLLATE Latin1_General_100_BIN2=CONVERT(varchar(20),typed.revision_key)
      AND DATALENGTH(p.sagRevisionId)=2*DATALENGTH(CONVERT(varchar(20),typed.revision_key)) THEN typed.revision_key END,
    CASE WHEN p.sagCustomerRecordId COLLATE Latin1_General_100_BIN2=CONVERT(varchar(11),typed.customer_id) THEN typed.customer_id END,
    CASE WHEN p.companyRecordId COLLATE Latin1_General_100_BIN2=CONVERT(varchar(11),typed.company_id) THEN typed.company_id END,
    CASE WHEN DATALENGTH(p.locationTokenHex)=128 AND p.locationTokenHex COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9a-f]%''
      THEN TRY_CONVERT(binary(32),p.locationTokenHex,2) END
  FROM @input i
  CROSS APPLY OPENJSON(i.object_json) WITH (linkId nvarchar(max),physicalTargetId nvarchar(max),physicalLinkId nvarchar(max),
    profileVersion nvarchar(max),sagSourceId nvarchar(max),sagRevisionId nvarchar(max),sagCustomerRecordId nvarchar(max),
    companyRecordId nvarchar(max),locationTokenHex nvarchar(max)) p
  CROSS APPLY (VALUES(TRY_CONVERT(uniqueidentifier,p.linkId),TRY_CONVERT(uniqueidentifier,p.physicalTargetId),
    TRY_CONVERT(uniqueidentifier,p.physicalLinkId),TRY_CONVERT(uniqueidentifier,p.sagSourceId),TRY_CONVERT(bigint,p.sagRevisionId),
    TRY_CONVERT(int,p.sagCustomerRecordId),TRY_CONVERT(int,p.companyRecordId))) typed
      (link_id,target_id,physical_link_id,source_id,revision_key,customer_id,company_id);

  IF EXISTS(SELECT 1 FROM @parsed WHERE link_id IS NULL OR link_id=@zero OR physical_target_id IS NULL OR physical_target_id=@zero
     OR physical_link_id IS NULL OR physical_link_id=@zero OR profile_version IS NULL OR sag_source_id IS NULL OR sag_source_id=@zero
     OR sag_revision_key IS NULL OR sag_customer_record_id IS NULL OR company_record_id IS NULL OR location_token IS NULL)
    OR (SELECT COUNT(DISTINCT link_id) FROM @parsed)>5000
    OR (SELECT COUNT(DISTINCT sag_source_id) FROM @parsed)<>1
    OR (SELECT COUNT(DISTINCT sag_revision_key) FROM @parsed)<>1
    OR EXISTS (SELECT 1 FROM @parsed GROUP BY link_id HAVING COUNT(*)>8 OR COUNT(*)<>COUNT(DISTINCT company_record_id))
    OR EXISTS (SELECT 1 FROM (
        SELECT DISTINCT link_id,physical_target_id,physical_link_id,profile_version,sag_source_id,sag_revision_key,
          sag_customer_record_id FROM @parsed
      ) shapes GROUP BY link_id HAVING COUNT(*)<>1)
    BEGIN
      SELECT CONVERT(char(36),NULL) AS linkId,CONVERT(int,NULL) AS matchCount WHERE 1=0;
      RETURN;
    END;

  -- Build the sealed population once across the requested customers instead
  -- of repeatedly scanning a revision per candidate claim.
  DECLARE @cohort table(revision_key bigint NOT NULL,customer_record_id int NOT NULL,company_record_id int NOT NULL,
    PRIMARY KEY(revision_key,customer_record_id,company_record_id));
  INSERT @cohort (revision_key,customer_record_id,company_record_id)
  SELECT TOP (100001) member.revision_key,member.customer_record_id,member.company_record_id
  FROM core.catalog_sag_company_revision_rows member WITH (HOLDLOCK)
  JOIN (SELECT DISTINCT sag_revision_key,sag_customer_record_id FROM @parsed) asked
    ON asked.sag_revision_key=member.revision_key AND asked.sag_customer_record_id=member.customer_record_id
  WHERE member.is_available=1 OPTION(RECOMPILE);
  IF (SELECT COUNT(*) FROM @cohort)>100000
    BEGIN
      SELECT CONVERT(char(36),NULL) AS linkId,CONVERT(int,NULL) AS matchCount WHERE 1=0;
      RETURN;
    END;

  DECLARE @proof table(link_id uniqueidentifier NOT NULL,company_record_id int NOT NULL,is_match bit NOT NULL,
    PRIMARY KEY(link_id,company_record_id));
  INSERT @proof(link_id,company_record_id,is_match)
  SELECT claim.link_id,company.company_record_id,CASE WHEN location_observation.location_token=claim.location_token THEN 1 ELSE 0 END
  FROM @parsed claim
  LEFT JOIN scheduling.catalog_schedule_copy_links pin WITH (HOLDLOCK) ON pin.copy_schedule_key=@key AND pin.link_id=claim.link_id
    AND pin.verified_target_id=claim.physical_target_id AND pin.target_kind=''database''
  LEFT JOIN scheduling.v_catalog_schedule_draft_pins manual_pin WITH (HOLDLOCK) ON manual_pin.schedule_key=@key
    AND manual_pin.link_id=claim.link_id AND manual_pin.verified_target_id=claim.physical_target_id
    AND manual_pin.target_kind=''database''
  JOIN scheduling.update_schedules definition WITH (HOLDLOCK) ON definition.schedule_key=@key
  JOIN core.catalog_operational_links ol WITH (HOLDLOCK) ON ol.link_id=claim.link_id AND ol.portal_environment=@environment COLLATE Latin1_General_100_BIN2
    AND ol.target_kind=''database'' AND ol.registered_at<=@asOf AND (ol.retired_at IS NULL OR ol.retired_at>@asOf)
  JOIN core.catalog_operational_owners own WITH (HOLDLOCK) ON own.owner_key=ol.owner_key AND own.client_key=ol.client_key
    AND own.portal_environment=ol.portal_environment AND own.registered_at<=@asOf AND (own.retired_at IS NULL OR own.retired_at>@asOf)
  JOIN core.clients client WITH (HOLDLOCK) ON client.client_key=ol.client_key AND client.status=''active''
    AND client.created_at<=@asOf AND client.updated_at<=@asOf AND (client.deleted_at IS NULL OR client.deleted_at>@asOf)
  JOIN core.domains domain_row WITH (HOLDLOCK) ON domain_row.domain_key=ol.domain_key AND domain_row.client_key=ol.client_key
    AND domain_row.status=''active'' AND domain_row.created_at<=@asOf AND domain_row.updated_at<=@asOf
    AND (domain_row.deleted_at IS NULL OR domain_row.deleted_at>@asOf)
  JOIN core.databases db WITH (HOLDLOCK) ON db.database_key=ol.database_key AND db.domain_key=ol.domain_key
    AND db.client_key=ol.client_key AND db.status=''active'' AND db.created_at<=@asOf AND db.updated_at<=@asOf
    AND (db.deleted_at IS NULL OR db.deleted_at>@asOf)
    AND db.environment_id COLLATE Latin1_General_100_BIN2=ol.link_environment
    AND DATALENGTH(db.environment_id)=DATALENGTH(ol.link_environment)
  JOIN core.database_access_profiles access_profile WITH (HOLDLOCK) ON access_profile.access_profile_key=db.access_profile_key
    AND access_profile.active=1 AND access_profile.row_version=claim.profile_version
    AND access_profile.created_at<=@asOf AND access_profile.updated_at<=@asOf
  JOIN core.catalog_physical_target_links physical_link WITH (HOLDLOCK) ON physical_link.link_id=claim.physical_link_id
    AND physical_link.portal_environment=ol.portal_environment AND physical_link.target_kind=ol.target_kind
    AND physical_link.client_key=ol.client_key AND physical_link.domain_key=ol.domain_key AND physical_link.database_key=ol.database_key
    AND physical_link.access_profile_key=access_profile.access_profile_key AND physical_link.access_profile_version=access_profile.row_version
    AND physical_link.registered_at<=@asOf AND physical_link.verified_at<=@asOf AND physical_link.valid_until>@asOf
    AND (physical_link.retired_at IS NULL OR physical_link.retired_at>@asOf)
  JOIN core.catalog_physical_targets physical_target WITH (HOLDLOCK) ON physical_target.physical_target_key=physical_link.physical_target_key
    AND physical_target.target_id=claim.physical_target_id AND physical_target.portal_environment=ol.portal_environment
    AND physical_target.target_kind=ol.target_kind AND physical_target.created_at<=@asOf
    AND physical_target.database_name_fingerprint=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),access_profile.initial_catalog))
  JOIN settings.catalog_match_key_registry key_registry WITH (HOLDLOCK) ON key_registry.portal_environment=ol.portal_environment
    AND key_registry.match_key_version=@matchKeyVersion AND key_registry.enrolled_at<=@asOf
  JOIN settings.catalog_source_bindings erp_binding WITH (HOLDLOCK) ON erp_binding.catalog_source_key=ol.catalog_source_key
    AND erp_binding.portal_environment COLLATE Latin1_General_100_BIN2=ol.portal_environment
    AND DATALENGTH(erp_binding.portal_environment)=DATALENGTH(ol.portal_environment)
    AND erp_binding.source_role=''erp-customers'' AND erp_binding.contract_version=''erp_v1''
    AND erp_binding.source_state=''active'' AND erp_binding.validated_at<=@asOf AND erp_binding.updated_at<=@asOf
  JOIN settings.external_database_connections erp_profile WITH (HOLDLOCK) ON erp_profile.external_database_connection_key=erp_binding.external_database_connection_key
    AND erp_profile.row_version=erp_binding.validated_profile_version AND erp_profile.updated_at<=@asOf
    AND erp_profile.active=1 AND erp_profile.status=''active'' AND erp_profile.encrypt_connection=1 AND erp_profile.password_configured=1
  CROSS APPLY (
    SELECT TOP (1) event.revision_key,event.attempt_ordinal,event.attempt_status,event.attempted_at
    FROM settings.catalog_source_head_events event WITH (HOLDLOCK)
    WHERE event.catalog_source_key=erp_binding.catalog_source_key AND event.recorded_at<=@asOf
    ORDER BY event.head_event_key DESC
  ) erp_head
  JOIN core.catalog_customer_source_revisions erp_revision WITH (HOLDLOCK) ON erp_revision.revision_key=erp_head.revision_key
    AND erp_revision.catalog_source_key=erp_binding.catalog_source_key AND erp_revision.source_role=erp_binding.source_role
    AND erp_revision.attempt_ordinal=erp_head.attempt_ordinal AND erp_head.attempt_status=''succeeded'' AND erp_head.attempted_at<=@asOf
    AND erp_revision.binding_version=erp_binding.row_version AND erp_revision.profile_version=erp_profile.row_version
    AND erp_revision.match_key_version=key_registry.match_key_version AND erp_revision.observed_at<=@asOf
    AND erp_revision.sealed_at<=@asOf AND erp_revision.verified_until>@asOf
  JOIN core.catalog_operational_link_approvals approval WITH (HOLDLOCK) ON approval.link_key=ol.link_key
    AND approval.binding_version=erp_revision.binding_version AND approval.profile_version=erp_revision.profile_version
    AND approval.revision_key<=erp_revision.revision_key AND approval.approved_at BETWEEN ol.registered_at AND @asOf
  JOIN core.catalog_customer_revision_rows erp_record WITH (HOLDLOCK) ON erp_record.revision_key=erp_revision.revision_key
    AND erp_record.source_role=''erp-customers'' AND erp_record.source_record_id=ol.source_record_id
    AND erp_record.catalog_customer_key=own.catalog_customer_key AND erp_record.active_code=''S''
    AND erp_record.issuer IS NOT NULL AND erp_record.document_type IS NOT NULL AND erp_record.document_number_token IS NOT NULL
  JOIN settings.catalog_source_bindings sag_binding WITH (HOLDLOCK) ON sag_binding.source_id=claim.sag_source_id
    AND sag_binding.portal_environment COLLATE Latin1_General_100_BIN2=ol.portal_environment
    AND DATALENGTH(sag_binding.portal_environment)=DATALENGTH(ol.portal_environment)
    AND sag_binding.source_role=''sag-admin'' AND sag_binding.contract_version=''sag_admin_v2''
    AND sag_binding.source_state=''active'' AND sag_binding.validated_at<=@asOf AND sag_binding.updated_at<=@asOf
  JOIN settings.external_database_connections sag_profile WITH (HOLDLOCK) ON sag_profile.external_database_connection_key=sag_binding.external_database_connection_key
    AND sag_profile.row_version=sag_binding.validated_profile_version AND sag_profile.updated_at<=@asOf
    AND sag_profile.active=1 AND sag_profile.status=''active'' AND sag_profile.encrypt_connection=1 AND sag_profile.password_configured=1
  CROSS APPLY (
    SELECT TOP (1) event.revision_key,event.attempt_ordinal,event.attempt_status,event.attempted_at
    FROM settings.catalog_source_head_events event WITH (HOLDLOCK)
    WHERE event.catalog_source_key=sag_binding.catalog_source_key AND event.recorded_at<=@asOf
    ORDER BY event.head_event_key DESC
  ) sag_head
  JOIN core.catalog_customer_source_revisions sag_revision WITH (HOLDLOCK) ON sag_revision.revision_key=sag_head.revision_key
    AND sag_revision.revision_key=claim.sag_revision_key AND sag_revision.catalog_source_key=sag_binding.catalog_source_key
    AND sag_revision.source_role=sag_binding.source_role AND sag_revision.attempt_ordinal=sag_head.attempt_ordinal
    AND sag_head.attempt_status=''succeeded'' AND sag_head.attempted_at<=@asOf
    AND sag_revision.binding_version=sag_binding.row_version AND sag_revision.profile_version=sag_profile.row_version
    AND sag_revision.match_key_version=key_registry.match_key_version AND sag_revision.observed_at<=@asOf
    AND sag_revision.sealed_at<=@asOf AND sag_revision.verified_until>@asOf
    AND sag_revision.has_sag_inventory_evidence=1 AND sag_revision.expected_sag_company_rows>0
  JOIN core.catalog_sag_company_location_seals location_seal WITH (HOLDLOCK) ON location_seal.revision_key=sag_revision.revision_key
    AND location_seal.expected_company_rows=sag_revision.expected_sag_company_rows
    AND location_seal.sealed_at BETWEEN sag_revision.sealed_at AND @asOf
  JOIN core.catalog_customer_revision_rows sag_parent WITH (HOLDLOCK) ON sag_parent.revision_key=sag_revision.revision_key
    AND sag_parent.source_role=''sag-admin'' AND sag_parent.source_record_id=claim.sag_customer_record_id
    AND sag_parent.issuer=erp_record.issuer AND sag_parent.document_type=erp_record.document_type
    AND DATALENGTH(sag_parent.document_type)=DATALENGTH(erp_record.document_type)
    AND sag_parent.document_number_token=erp_record.document_number_token
  JOIN core.catalog_sag_revision_evidence domain_record WITH (HOLDLOCK) ON domain_record.revision_key=sag_parent.revision_key
    AND domain_record.source_record_id=sag_parent.source_record_id AND domain_record.environment_kind=ol.link_environment
    AND DATALENGTH(domain_record.environment_kind)=DATALENGTH(ol.link_environment)
  JOIN core.catalog_sag_company_revision_rows company WITH (HOLDLOCK) ON company.revision_key=sag_revision.revision_key
    AND company.customer_record_id=sag_parent.source_record_id AND company.company_record_id=claim.company_record_id
    AND company.is_available=1
  JOIN core.catalog_sag_company_location_observations location_observation WITH (HOLDLOCK)
    ON location_observation.revision_key=company.revision_key AND location_observation.company_record_id=company.company_record_id
    AND location_observation.observation_state=''candidate'' AND location_observation.format_version=1
  CROSS APPLY (VALUES(CASE WHEN LEFT(LOWER(domain_row.domain_name_normalized),8)=N''https://''
    THEN SUBSTRING(domain_row.domain_name_normalized,9,500) END)) raw_route(label)
  CROSS APPLY (VALUES(CASE WHEN RIGHT(raw_route.label,1)=N''/''
    THEN LEFT(raw_route.label,CASE WHEN LEN(raw_route.label)>0 THEN LEN(raw_route.label)-1 ELSE 0 END) ELSE raw_route.label END)) route(label)
  WHERE domain_record.domain_candidate=LOWER(route.label) COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(domain_record.domain_candidate)=LEN(route.label) AND DATALENGTH(route.label)=2*LEN(route.label)
    AND ((@copy=1 AND pin.link_id IS NOT NULL) OR (@draftManual=1 AND manual_pin.link_id IS NOT NULL)
      OR (@dynamic=1 AND EXISTS(SELECT 1 FROM @cutoff_links e WHERE e.id=LOWER(CONVERT(char(36),ol.link_id))) AND (
        (ISNULL(definition.selection_mode,''manual'')=''manual''
          AND (ISNULL(definition.manual_environment,''all'')=''all'' OR
            (definition.manual_environment=ol.link_environment
              AND definition.manual_environment=domain_row.environment_id COLLATE Latin1_General_100_BIN2))
          AND ((ISNULL(definition.manual_target_types,''domains_and_databases'') IN (''domains_and_databases'',''databases_only'')
            AND EXISTS(SELECT 1 FROM scheduling.scope_groups g WITH (HOLDLOCK)
              WHERE g.schedule_key=@key AND g.client_key=ol.client_key AND (g.include_all_domains=1 OR EXISTS(
                SELECT 1 FROM scheduling.scope_domains d WITH (HOLDLOCK)
                WHERE d.scope_group_key=g.scope_group_key AND d.client_key=ol.client_key AND d.domain_key=ol.domain_key
                  AND (d.include_all_databases=1 OR EXISTS(SELECT 1 FROM scheduling.scope_databases x WITH (HOLDLOCK)
                    WHERE x.scope_domain_key=d.scope_domain_key AND x.client_key=ol.client_key
                      AND x.domain_key=ol.domain_key AND x.database_key=ol.database_key))))))
            OR (definition.target_type=''database'' AND definition.client_key=ol.client_key
              AND (definition.domain_key IS NULL OR definition.domain_key=ol.domain_key)
              AND NOT EXISTS(SELECT 1 FROM scheduling.scope_groups g WITH (HOLDLOCK) WHERE g.schedule_key=@key)
              AND EXISTS(SELECT 1 FROM scheduling.schedule_targets st WITH (HOLDLOCK)
                WHERE st.schedule_key=@key AND st.client_key=ol.client_key AND st.target_type=''database''
                  AND st.database_key=ol.database_key AND (st.domain_key IS NULL OR st.domain_key=ol.domain_key)))))
        OR (definition.selection_mode=''licensing'' AND EXISTS (
          SELECT 1 FROM scheduling.licensing_scope ls WITH (HOLDLOCK)
          CROSS APPLY (SELECT COUNT(*) AS requested,
              COUNT(CASE WHEN m.module_key IS NOT NULL THEN 1 END) AS usable,
              COUNT(CASE WHEN a.approved=1 THEN 1 END) AS matched
            FROM scheduling.licensing_scope_modules lm WITH (HOLDLOCK)
            LEFT JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=lm.module_key
              AND m.status=''active'' AND m.deleted_at IS NULL AND m.created_at<=@asOf AND m.updated_at<=@asOf
            OUTER APPLY (SELECT TOP (1) 1 AS approved FROM settings.catalog_sag_license_module_approvals ma WITH (HOLDLOCK)
              WHERE ma.module_key=m.module_key AND ma.catalog_source_key=sag_revision.catalog_source_key
                AND ma.binding_version=sag_revision.binding_version AND ma.profile_version=sag_revision.profile_version
                AND ma.approved_at<=@asOf AND CHARINDEX(ma.sag_code,domain_record.license_codes)>0) a
            WHERE lm.schedule_key=ls.schedule_key) modules
          WHERE ls.schedule_key=@key AND ls.active_only=1 AND ls.target_types IN (''domains_and_databases'',''databases_only'')
            AND (ls.environment_id IS NULL OR (ls.environment_id COLLATE Latin1_General_100_BIN2=ol.link_environment
              AND ls.environment_id COLLATE Latin1_General_100_BIN2=domain_row.environment_id))
            AND NOT EXISTS(SELECT 1 FROM scheduling.scope_groups g WITH (HOLDLOCK) WHERE g.schedule_key=@key)
            AND NOT EXISTS(SELECT 1 FROM scheduling.schedule_targets t WITH (HOLDLOCK) WHERE t.schedule_key=@key)
            AND NOT EXISTS(SELECT 1 FROM scheduling.licensing_excluded_databases x WITH (HOLDLOCK)
              WHERE x.schedule_key=@key AND x.database_key=ol.database_key)
            AND DATALENGTH(domain_record.license_codes)=(
              SELECT COUNT(*) FROM settings.catalog_sag_license_module_approvals all_codes WITH (HOLDLOCK)
              JOIN licensing.license_modules lm WITH (HOLDLOCK)
                ON lm.module_key=all_codes.module_key AND lm.status=''active'' AND lm.deleted_at IS NULL
                AND lm.created_at<=@asOf AND lm.updated_at<=@asOf
              WHERE all_codes.catalog_source_key=sag_revision.catalog_source_key
                AND all_codes.binding_version=sag_revision.binding_version AND all_codes.profile_version=sag_revision.profile_version
                AND all_codes.approved_at<=@asOf AND CHARINDEX(all_codes.sag_code,domain_record.license_codes)>0)
            AND modules.requested BETWEEN 1 AND 25 AND modules.requested=modules.usable AND modules.matched>0
            AND (ls.license_match_mode=''any'' OR (ls.license_match_mode=''all'' AND modules.matched=modules.requested)))))))
    -- 055 location tokens are context-bound to the Company ID, so tokens
    -- are compared per Company only. The sealed available set must not have
    -- an omitted competing Company; @proof count below rejects extra claims
    -- and members that cannot be evaluated (including unverified locations).
    AND NOT EXISTS (
      SELECT 1 FROM @cohort required_company
      WHERE required_company.revision_key=sag_revision.revision_key
        AND required_company.customer_record_id=sag_parent.source_record_id
        AND NOT EXISTS(SELECT 1 FROM @parsed submitted WHERE submitted.link_id=claim.link_id
          AND submitted.company_record_id=required_company.company_record_id))
    AND NOT EXISTS (
      SELECT 1 FROM core.catalog_customer_revision_rows competing WITH (HOLDLOCK)
      WHERE competing.revision_key=erp_revision.revision_key AND competing.source_record_id<>erp_record.source_record_id
        AND ((competing.catalog_customer_key=own.catalog_customer_key
          AND (competing.issuer IS NULL OR competing.document_type IS NULL OR competing.document_number_token IS NULL
            OR competing.issuer<>erp_record.issuer OR competing.document_type<>erp_record.document_type
            OR DATALENGTH(competing.document_type)<>DATALENGTH(erp_record.document_type)
            OR competing.document_number_token<>erp_record.document_number_token))
          OR (competing.catalog_customer_key<>own.catalog_customer_key AND competing.issuer=erp_record.issuer
            AND competing.document_type=erp_record.document_type
            AND DATALENGTH(competing.document_type)=DATALENGTH(erp_record.document_type)
            AND competing.document_number_token=erp_record.document_number_token)))
    AND NOT EXISTS (
      SELECT 1 FROM core.catalog_customer_revision_rows competing WITH (HOLDLOCK)
      LEFT JOIN core.catalog_sag_revision_evidence competing_domain WITH (HOLDLOCK)
        ON competing_domain.revision_key=competing.revision_key AND competing_domain.source_record_id=competing.source_record_id
      WHERE competing.revision_key=sag_revision.revision_key AND competing.source_record_id<>sag_parent.source_record_id
        AND competing.document_number_token=erp_record.document_number_token
        AND (competing.issuer IS NULL OR (competing.issuer=erp_record.issuer AND competing.document_type=erp_record.document_type
          AND DATALENGTH(competing.document_type)=DATALENGTH(erp_record.document_type)
          AND competing_domain.environment_kind=domain_record.environment_kind
          AND competing_domain.domain_candidate=domain_record.domain_candidate)))
    AND NOT EXISTS (
      SELECT 1 FROM core.catalog_physical_target_links alternative WITH (HOLDLOCK)
      WHERE alternative.link_id<>physical_link.link_id AND alternative.portal_environment=physical_link.portal_environment
        AND alternative.target_kind=physical_link.target_kind AND alternative.client_key=physical_link.client_key
        AND alternative.domain_key=physical_link.domain_key AND alternative.database_key=physical_link.database_key
        AND alternative.access_profile_key=physical_link.access_profile_key AND alternative.access_profile_version=physical_link.access_profile_version
        AND alternative.registered_at<=@asOf AND alternative.verified_at<=@asOf AND alternative.valid_until>@asOf
        AND (alternative.retired_at IS NULL OR alternative.retired_at>@asOf))
  OPTION(RECOMPILE);

  SELECT LOWER(CONVERT(char(36),asked.link_id)) AS linkId,
    CASE WHEN COUNT(DISTINCT proof.company_record_id)=asked.claim_count
      THEN COUNT(DISTINCT CASE WHEN proof.is_match=1 THEN proof.company_record_id END) ELSE 0 END AS matchCount
  FROM (SELECT link_id,COUNT(*) AS claim_count FROM @parsed GROUP BY link_id) asked
  LEFT JOIN @proof proof ON proof.link_id=asked.link_id
  GROUP BY asked.link_id,asked.claim_count;
END;';

  DECLARE @owned073 table(object_id int NULL);
  INSERT @owned073 VALUES
    (OBJECT_ID(N'settings.verify_catalog_historical_schedule_company_locations',N'P')),
    (OBJECT_ID(N'scheduling.update_schedules',N'U')),
    (OBJECT_ID(N'scheduling.catalog_schedule_copy_intents',N'U')),
    (OBJECT_ID(N'scheduling.catalog_schedule_copy_links',N'U')),
    (OBJECT_ID(N'scheduling.v_catalog_schedule_draft_approval',N'V')),
    (OBJECT_ID(N'scheduling.v_catalog_schedule_draft_pins',N'V')),
    (OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U')),
    (OBJECT_ID(N'scheduling.catalog_schedule_population_approvals',N'U')),
    (OBJECT_ID(N'security.users',N'U')),
    (OBJECT_ID(N'security.user_roles',N'U')),
    (OBJECT_ID(N'security.roles',N'U')),
    (OBJECT_ID(N'scheduling.catalog_schedule_activation_snapshots',N'U')),
    (OBJECT_ID(N'scheduling.schedule_targets',N'U')),
    (OBJECT_ID(N'scheduling.scope_groups',N'U')),
    (OBJECT_ID(N'scheduling.scope_domains',N'U')),
    (OBJECT_ID(N'scheduling.scope_databases',N'U')),
    (OBJECT_ID(N'scheduling.licensing_scope',N'U')),
    (OBJECT_ID(N'scheduling.licensing_scope_modules',N'U')),
    (OBJECT_ID(N'scheduling.licensing_excluded_databases',N'U')),
    (OBJECT_ID(N'licensing.license_modules',N'U')),
    (OBJECT_ID(N'settings.catalog_sag_license_module_approvals',N'U')),
    (OBJECT_ID(N'core.catalog_operational_links',N'U')),
    (OBJECT_ID(N'core.catalog_operational_owners',N'U')),
    (OBJECT_ID(N'core.clients',N'U')),
    (OBJECT_ID(N'core.domains',N'U')),
    (OBJECT_ID(N'core.databases',N'U')),
    (OBJECT_ID(N'core.database_access_profiles',N'U')),
    (OBJECT_ID(N'core.catalog_physical_target_links',N'U')),
    (OBJECT_ID(N'core.catalog_physical_targets',N'U')),
    (OBJECT_ID(N'settings.catalog_match_key_registry',N'U')),
    (OBJECT_ID(N'settings.catalog_source_bindings',N'U')),
    (OBJECT_ID(N'settings.external_database_connections',N'U')),
    (OBJECT_ID(N'settings.catalog_source_head_events',N'U')),
    (OBJECT_ID(N'core.catalog_customer_source_revisions',N'U')),
    (OBJECT_ID(N'core.catalog_operational_link_approvals',N'U')),
    (OBJECT_ID(N'core.catalog_customer_revision_rows',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U')),
    (OBJECT_ID(N'core.catalog_sag_revision_evidence',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U')),
    (OBJECT_ID(N'core.catalog_sag_customer_directory_rows',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U'));
  IF EXISTS(SELECT 1 FROM @owned073 expected
    LEFT JOIN sys.objects obj ON obj.object_id=expected.object_id
    LEFT JOIN sys.schemas schem ON schem.schema_id=obj.schema_id
    WHERE obj.object_id IS NULL OR COALESCE(obj.principal_id,schem.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 57303,N'The static historical proof ownership chain is incomplete.',1;

  GRANT EXECUTE ON OBJECT::settings.verify_catalog_historical_schedule_company_locations TO portal_runtime;
  IF (SELECT COUNT(*) FROM sys.database_permissions
      WHERE class=1 AND major_id=OBJECT_ID(N'settings.verify_catalog_historical_schedule_company_locations',N'P'))<>1
    OR NOT EXISTS(SELECT 1 FROM sys.database_permissions
      WHERE class=1 AND major_id=OBJECT_ID(N'settings.verify_catalog_historical_schedule_company_locations',N'P')
        AND minor_id=0 AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime')
        AND permission_name=N'EXECUTE' AND state='G')
    THROW 57304,N'Unexpected permissions on the new historical proof module.',1;

  IF @owns073=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns073=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
