import { catalogDomainRouteFingerprintSql } from "./catalogPhysicalTargetIdentity";

export const catalogOnceLatestCompletionSql = `CROSS APPLY (
    SELECT TOP (1) hist.new_status,hist.action,hist.performed_at,hist.performed_by,hist.metadata_json,hist.is_inferred
    FROM workflow.task_status_history hist WITH (HOLDLOCK)
    WHERE hist.task_key=t.task_key
    ORDER BY hist.task_status_history_key DESC
  ) completion`;

export const catalogOnceExplicitCompletionSql = `completion.new_status='completed'
    AND completion.action=N'task_completed' AND completion.is_inferred=0
    AND completion.performed_at=t.completed_at
    AND completion.performed_by COLLATE Latin1_General_100_BIN2=t.completed_by COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(completion.performed_by)=DATALENGTH(t.completed_by)
    AND EXISTS (
      SELECT 1 FROM OPENJSON(CASE WHEN ISJSON(completion.metadata_json)=1 THEN completion.metadata_json ELSE N'{}' END) evidence
      WHERE evidence.[key] COLLATE Latin1_General_100_BIN2=N'explicitCompletionSuccess' AND DATALENGTH(evidence.[key])=50
      HAVING COUNT_BIG(*)=1 AND MAX(CASE WHEN evidence.[type]=3
        AND evidence.[value] COLLATE Latin1_General_100_BIN2=N'true' THEN 1 ELSE 0 END)=1
    )`;

/**
 * Lifecycle: the exact frozen link set is the denominator. The later catalog
 * is neither needed to close completed work nor allowed to add obligations.
 * Caller owns both transaction-scoped day locks through the versioned update.
 */
export const readCatalogFrozenOnceClosureProofSql = `
SET NOCOUNT ON;
DECLARE @now datetime2(7)=SYSUTCDATETIME(),@dateText char(10)=CONVERT(char(10),@taskDate,23);
DECLARE @dayStart datetime2(3)=DATEADD(hour,5,CONVERT(datetime2(3),@taskDate)),@cutoffAt datetime2(3);
SET @cutoffAt=DATEADD(day,1,@dayStart);
IF @@TRANCOUNT=0 OR XACT_STATE()<>1 OR @now<@cutoffAt
  OR ISNULL(APPLOCK_MODE(N'public',N'portal.catalog-task.v1:database:'+@dateText,N'Transaction'),N'NoLock')<>N'Exclusive'
  OR ISNULL(APPLOCK_MODE(N'public',N'portal.catalog-task.v1:domain:'+@dateText,N'Transaction'),N'NoLock')<>N'Exclusive'
BEGIN
  SELECT CONVERT(nvarchar(150),NULL) AS scheduleId,CONVERT(char(16),NULL) AS scheduleVersion,
    CONVERT(nvarchar(150),NULL) AS clientId WHERE 1=0;
  RETURN;
END;
SELECT s.source_id AS scheduleId,LOWER(CONVERT(char(16),s.row_version,2)) AS scheduleVersion,c.source_id AS clientId
FROM scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=s.client_key
JOIN scheduling.catalog_schedule_activation_snapshots frozen WITH (HOLDLOCK)
  ON frozen.schedule_key=s.schedule_key AND frozen.definition_version=s.row_version AND frozen.portal_environment=@portalEnvironment
  AND frozen.activation_state='frozen' AND frozen.activation_at>=@dayStart AND frozen.activation_at<@cutoffAt
  AND frozen.sealed_at<@cutoffAt AND frozen.recorded_at<@cutoffAt AND frozen.evidence_at=frozen.activation_at
JOIN scheduling.catalog_schedule_operation_approvals approved WITH (HOLDLOCK)
  ON approved.schedule_key=s.schedule_key AND approved.schedule_version=s.row_version
  AND approved.portal_environment=frozen.portal_environment AND approved.retired_at IS NULL AND approved.approved_at<=frozen.activation_at
WHERE s.schedule_key=CONVERT(bigint,@scheduleKey) AND s.active=1 AND s.deleted_at IS NULL AND s.completed_at IS NULL
  AND s.catalog_activation_enabled=1 AND s.frequency_type='once' AND s.start_date=@taskDate
  AND s.timezone COLLATE Latin1_General_100_BIN2=N'America/Bogota' AND DATALENGTH(s.timezone)=28
  AND (SELECT COUNT_BIG(*) FROM scheduling.catalog_schedule_activation_targets held_count WITH (HOLDLOCK)
    WHERE held_count.schedule_key=s.schedule_key AND held_count.evidence_state='eligible') BETWEEN 1 AND 5000
  AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_targets uncertain WITH (HOLDLOCK)
    WHERE uncertain.schedule_key=s.schedule_key AND uncertain.evidence_state='unverifiable')
  AND NOT EXISTS(
    SELECT 1 FROM scheduling.catalog_schedule_activation_targets f WITH (HOLDLOCK)
    WHERE f.schedule_key=s.schedule_key AND f.evidence_state='eligible' AND NOT EXISTS (
      SELECT 1 FROM workflow.catalog_task_execution_sources a WITH (HOLDLOCK)
      JOIN workflow.catalog_task_execution_links x WITH (HOLDLOCK) ON x.catalog_execution_link_key=a.catalog_execution_link_key
        AND x.link_id=LOWER(CONVERT(nvarchar(36),f.link_id)) COLLATE Latin1_General_100_BIN2 AND DATALENGTH(x.link_id)=72
        AND x.execution_kind COLLATE Latin1_General_100_BIN2=f.target_kind
        AND x.link_environment COLLATE Latin1_General_100_BIN2=f.target_environment
        AND DATALENGTH(x.link_environment)=DATALENGTH(f.target_environment)
        AND x.link_state='active' AND x.retired_at IS NULL AND x.created_at<@cutoffAt
      JOIN workflow.catalog_task_executions e WITH (HOLDLOCK) ON e.catalog_execution_key=x.catalog_execution_key
        AND e.execution_kind COLLATE Latin1_General_100_BIN2=f.target_kind AND e.retired_at IS NULL AND e.cutoff_at=@cutoffAt
        AND e.occurrence_id=CONVERT(nvarchar(10),@dateText) AND DATALENGTH(e.occurrence_id)=20
        AND e.operation_id=approved.operation_id AND DATALENGTH(e.operation_id)=DATALENGTH(approved.operation_id)
        AND TRY_CONVERT(uniqueidentifier,e.verified_target_id)=f.verified_target_id AND DATALENGTH(e.verified_target_id)=72
        AND e.created_at<@cutoffAt
      JOIN workflow.update_tasks t WITH (HOLDLOCK) ON t.task_key=e.task_key AND t.target_type=e.execution_kind AND t.task_date=@taskDate
        AND t.source_id COLLATE Latin1_General_100_BIN2=CONCAT(N'catalog-',LOWER(CONVERT(char(64),e.execution_key,2)))
        AND DATALENGTH(t.source_id)=144 AND t.is_historical_orphan=0 AND t.created_at<@cutoffAt
        AND t.status='completed' AND t.completed_with_problems=0
        AND t.result COLLATE Latin1_General_100_BIN2=N'success' AND DATALENGTH(t.result)=14
        AND t.completed_at>=a.attached_at AND t.completed_at>=t.created_at AND t.completed_at<=@now
        AND (t.reopened_at IS NULL OR t.completed_at>t.reopened_at)
      ${catalogOnceLatestCompletionSql}
      WHERE a.schedule_key=s.schedule_key AND a.detached_at IS NULL
        AND a.attached_at>=frozen.activation_at AND a.attached_at<@cutoffAt
        AND ${catalogOnceExplicitCompletionSql}
    )
  );`.trim();

/**
 * Internal only; caller holds both catalog day locks in its SERIALIZABLE
 * transaction through any subsequent versioned closure and audit. This read
 * neither mutates a schedule nor authorizes a worker to run.
 */
export const readCatalogOnceClosureProofSql = `
SET NOCOUNT ON;

DECLARE @now datetime2(7)=SYSUTCDATETIME();
DECLARE @dateText char(10)=CONVERT(char(10),@taskDate,23);
DECLARE @dayStart datetime2(3), @cutoffAt datetime2(3);
IF @taskDate BETWEEN '00010101' AND '99991230'
BEGIN
  SET @dayStart=DATEADD(hour,5,CONVERT(datetime2(3),@taskDate));
  SET @cutoffAt=DATEADD(day,1,@dayStart);
END;
IF @@TRANCOUNT=0 OR XACT_STATE()<>1 OR @cutoffAt IS NULL OR @now<@cutoffAt
  OR @observationKey IS NULL OR @observationKey<=0
  OR @portalEnvironment IS NULL OR NOT (
    (@portalEnvironment COLLATE Latin1_General_100_BIN2='qa' AND DATALENGTH(@portalEnvironment)=2)
    OR (@portalEnvironment COLLATE Latin1_General_100_BIN2='production' AND DATALENGTH(@portalEnvironment)=10))
  OR ISNULL(APPLOCK_MODE(N'public',N'portal.catalog-task.v1:database:'+@dateText,N'Transaction'),N'NoLock')<>N'Exclusive'
  OR ISNULL(APPLOCK_MODE(N'public',N'portal.catalog-task.v1:domain:'+@dateText,N'Transaction'),N'NoLock')<>N'Exclusive'
BEGIN
  SELECT CONVERT(nvarchar(150),NULL) AS scheduleId,CONVERT(char(16),NULL) AS scheduleVersion,
    CONVERT(nvarchar(150),NULL) AS clientId WHERE 1=0;
  RETURN;
END;

-- Each bounded stage is evaluated once. Reusing recursive CTEs here caused
-- optimizer expansion even for an observation with no source witnesses.

DECLARE @candidate TABLE(
  observation_key bigint PRIMARY KEY,schedule_key bigint NOT NULL,schedule_version binary(8) NOT NULL,
  operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,population_id uniqueidentifier NOT NULL,
  source_fence binary(32) NOT NULL,pair_count int NOT NULL
);
INSERT @candidate
  SELECT o.observation_key,o.schedule_key,o.schedule_version,o.operation_id,o.population_id,o.source_fence,o.pair_count
  FROM scheduling.catalog_once_observations o WITH (HOLDLOCK)
  WHERE o.observation_key=@observationKey AND o.portal_environment=@portalEnvironment AND o.task_date=@taskDate
    AND o.observed_at<@cutoffAt AND o.cutoff_at=@cutoffAt AND o.valid_until>@cutoffAt
    AND o.pair_count BETWEEN 1 AND 5000
    AND NOT EXISTS (
      SELECT 1 FROM scheduling.catalog_once_observations newer WITH (HOLDLOCK)
      WHERE newer.portal_environment=o.portal_environment AND newer.task_date=o.task_date
        AND newer.schedule_key=o.schedule_key AND newer.schedule_version=o.schedule_version
        AND newer.observation_key>o.observation_key
    );

-- Old observations are not evidence for a schedule later enrolled in 071.
DECLARE @candidateSchedule bigint=(SELECT schedule_key FROM @candidate),@enrolled bit=0;
IF @candidateSchedule IS NOT NULL AND COL_LENGTH(N'scheduling.update_schedules',N'catalog_activation_enabled')=1
  EXEC sys.sp_executesql N'SELECT @flag=catalog_activation_enabled FROM scheduling.update_schedules WITH (HOLDLOCK)
    WHERE schedule_key=@key;',N'@key bigint,@flag bit OUTPUT',@candidateSchedule,@enrolled OUTPUT;
IF @enrolled=1 OR @candidateSchedule IS NULL
BEGIN
  SELECT CONVERT(nvarchar(150),NULL) AS scheduleId,CONVERT(char(16),NULL) AS scheduleVersion,
    CONVERT(nvarchar(150),NULL) AS clientId WHERE 1=0;
  RETURN;
END;

DECLARE @populationLinks TABLE(
  link_key bigint PRIMARY KEY,link_id char(36) COLLATE DATABASE_DEFAULT NOT NULL
);
INSERT @populationLinks
  SELECT TOP (5001) l.link_key,LOWER(CONVERT(char(36),l.link_id)) AS link_id
  FROM core.catalog_operational_links l WITH (HOLDLOCK)
  JOIN core.catalog_operational_owners ow WITH (HOLDLOCK) ON ow.owner_key=l.owner_key
  JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=l.catalog_source_key
  WHERE l.portal_environment=@portalEnvironment AND l.retired_at IS NULL AND ow.retired_at IS NULL
  ORDER BY l.link_key;

DECLARE @manifest TABLE(
  link_count bigint NOT NULL,link_json varchar(max) COLLATE DATABASE_DEFAULT NULL
);
INSERT @manifest
  SELECT COUNT_BIG(*) AS link_count,
    STRING_AGG(CONVERT(varchar(max),CONCAT('"',link_id,'"')),',')
      WITHIN GROUP (ORDER BY link_id COLLATE Latin1_General_100_BIN2) AS link_json
  FROM @populationLinks;

DECLARE @cutoffHeads TABLE(
  catalog_source_key bigint PRIMARY KEY,source_role varchar(15) COLLATE DATABASE_DEFAULT NOT NULL,
  revision_key bigint NOT NULL,binding_version binary(8) NOT NULL,profile_version binary(8) NOT NULL,
  attempt_ordinal bigint NOT NULL,attempt_status varchar(10) COLLATE DATABASE_DEFAULT NOT NULL,
  external_database_connection_key bigint NOT NULL,source_id char(36) COLLATE Latin1_General_100_BIN2 NOT NULL
);
INSERT @cutoffHeads
  -- Reconstruct the exact witnessed state at the original cutoff. A normal
  -- later refresh cannot erase it; a failed/new attempt BEFORE cutoff does.
  SELECT b.catalog_source_key,b.source_role,r.revision_key,r.binding_version,r.profile_version,
    h.attempt_ordinal,h.attempt_status COLLATE DATABASE_DEFAULT AS attempt_status,b.external_database_connection_key,
    LOWER(CONVERT(char(36),b.source_id)) COLLATE Latin1_General_100_BIN2 AS source_id
  FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
  JOIN settings.external_database_connections p WITH (HOLDLOCK)
    ON p.external_database_connection_key=b.external_database_connection_key AND p.active=1 AND p.status='active'
    AND p.encrypt_connection=1 AND p.password_configured=1 AND b.validated_profile_version=p.row_version
  JOIN settings.catalog_match_key_registry mk WITH (HOLDLOCK)
    ON mk.portal_environment=@portalEnvironment AND mk.enrolled_at<=@cutoffAt
  JOIN scheduling.catalog_once_source_witnesses w WITH (HOLDLOCK)
    ON w.observation_key=@observationKey AND w.catalog_source_key=b.catalog_source_key
    AND w.source_role=b.source_role COLLATE Latin1_General_100_BIN2 AND w.binding_version=b.row_version AND w.profile_version=p.row_version
    AND w.match_key_version=mk.match_key_version AND w.captured_at<=@cutoffAt
  JOIN settings.catalog_source_head_events h WITH (HOLDLOCK)
    ON h.head_event_key=w.head_event_key AND h.catalog_source_key=w.catalog_source_key
    AND h.attempt_status='succeeded' AND h.attempted_at<=@cutoffAt AND h.recorded_at<=@cutoffAt
  CROSS APPLY (
    SELECT TOP (1) event.revision_key,event.attempt_ordinal,event.attempt_status,event.attempted_at
    FROM settings.catalog_source_head_events event WITH (HOLDLOCK)
    WHERE event.catalog_source_key=b.catalog_source_key AND event.recorded_at<=@cutoffAt
    ORDER BY event.head_event_key DESC
  ) latest
  JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
    ON r.catalog_source_key=b.catalog_source_key AND r.source_role=b.source_role AND r.revision_key=h.revision_key
    AND r.attempt_ordinal=h.attempt_ordinal AND r.profile_version=p.row_version AND r.binding_version=b.row_version
    AND r.match_key_version=mk.match_key_version AND r.observed_at<=@cutoffAt AND r.sealed_at<=@cutoffAt
    AND r.verified_until>@cutoffAt
  WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=@portalEnvironment
    AND DATALENGTH(b.portal_environment)=DATALENGTH(@portalEnvironment)
    AND b.source_state='active' AND b.validated_at<=@cutoffAt
    AND latest.revision_key=h.revision_key AND latest.attempt_ordinal=h.attempt_ordinal
    AND latest.attempt_status=h.attempt_status AND latest.attempted_at=h.attempted_at
    AND ((b.source_role='erp-customers' AND b.contract_version='erp_v1')
      OR (b.source_role='sag-admin' AND b.contract_version='sag_admin_v1' AND r.has_sag_inventory_evidence=1));

DECLARE @witnessFence TABLE(
  source_fence binary(32) NULL
);
INSERT @witnessFence
  SELECT CONVERT(binary(32),HASHBYTES('SHA2_256',CONCAT('portal-sag:once-source-fence:v1|',@portalEnvironment,'|',
    STRING_AGG(CONVERT(varchar(max),CONCAT(catalog_source_key,':',source_role,':',external_database_connection_key,':',
      CONVERT(char(16),binding_version,2),':',CONVERT(char(16),profile_version,2),':',
      CONVERT(varchar(20),attempt_ordinal),':',attempt_status,':',CONVERT(varchar(20),revision_key))),'|')
      WITHIN GROUP (ORDER BY source_id)))) AS source_fence FROM @cutoffHeads;

DECLARE @validPairs TABLE(
  observation_key bigint NOT NULL,link_key bigint NOT NULL,schedule_key bigint NOT NULL,
  target_kind varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,client_key bigint NOT NULL,
  domain_key bigint NOT NULL,database_key bigint NULL,link_environment varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
  domain_name nvarchar(500) COLLATE DATABASE_DEFAULT NOT NULL,issuer char(2) COLLATE Latin1_General_100_BIN2 NULL,
  document_type varchar(32) COLLATE Latin1_General_100_BIN2 NULL,document_number_token binary(32) NULL
);
INSERT @validPairs
  SELECT q.observation_key,q.link_key,o.schedule_key,l.target_kind,l.client_key,l.domain_key,l.database_key,l.link_environment,
    d.domain_name,rr.issuer,rr.document_type,rr.document_number_token
  FROM @candidate o
  JOIN scheduling.catalog_once_observation_pairs q WITH (HOLDLOCK)
    ON q.observation_key=o.observation_key AND q.schedule_key=o.schedule_key
  JOIN workflow.catalog_task_executions e WITH (HOLDLOCK)
    ON e.catalog_execution_key=q.catalog_execution_key AND e.retired_at IS NULL AND e.cutoff_at=@cutoffAt
    AND e.occurrence_id=CONVERT(nvarchar(10),@dateText) AND DATALENGTH(e.occurrence_id)=20
    AND e.created_at<=@cutoffAt AND e.operation_id=o.operation_id AND DATALENGTH(e.operation_id)=DATALENGTH(o.operation_id)
  JOIN workflow.update_tasks t WITH (HOLDLOCK)
    ON t.task_key=e.task_key AND t.target_type=e.execution_kind AND t.task_date=@taskDate
    AND t.source_id COLLATE Latin1_General_100_BIN2=CONCAT(N'catalog-',LOWER(CONVERT(char(64),e.execution_key,2)))
    AND DATALENGTH(t.source_id)=144 AND t.is_historical_orphan=0 AND t.created_at<=@cutoffAt
    AND t.status='completed' AND t.completed_with_problems=0
    AND t.result COLLATE Latin1_General_100_BIN2=N'success' AND DATALENGTH(t.result)=14
    AND t.completed_at>=@dayStart AND t.completed_at>=t.created_at AND t.completed_at<=@now
    AND (t.reopened_at IS NULL OR t.completed_at>t.reopened_at)
  ${catalogOnceLatestCompletionSql}
  JOIN workflow.catalog_task_execution_links x WITH (HOLDLOCK)
    ON x.catalog_execution_key=e.catalog_execution_key AND x.catalog_execution_link_key=q.catalog_execution_link_key
    AND x.execution_kind=e.execution_kind AND x.link_state='active' AND x.retired_at IS NULL AND x.created_at<=@cutoffAt
  JOIN workflow.catalog_task_execution_sources ae WITH (HOLDLOCK)
    ON ae.catalog_execution_link_key=x.catalog_execution_link_key AND ae.schedule_key=o.schedule_key
    AND ae.detached_at IS NULL AND ae.attached_at<=@cutoffAt
  JOIN core.catalog_operational_links l WITH (HOLDLOCK)
    ON l.link_key=q.link_key AND l.portal_environment=@portalEnvironment AND l.retired_at IS NULL
    AND l.registered_at<=@cutoffAt AND l.target_kind=x.execution_kind COLLATE Latin1_General_100_BIN2
    AND x.link_id=LOWER(CONVERT(nvarchar(36),l.link_id)) AND DATALENGTH(x.link_id)=72
    AND x.catalog_source_key=l.catalog_source_key AND x.catalog_record_id=CONVERT(nvarchar(11),l.source_record_id)
    AND DATALENGTH(x.catalog_record_id)=DATALENGTH(CONVERT(nvarchar(11),l.source_record_id))
    AND x.client_key=l.client_key AND x.domain_key=l.domain_key
    AND x.link_environment COLLATE Latin1_General_100_BIN2=l.link_environment
    AND (x.database_key=l.database_key OR (x.database_key IS NULL AND l.database_key IS NULL))
  JOIN core.catalog_operational_owners ow WITH (HOLDLOCK)
    ON ow.owner_key=l.owner_key AND ow.portal_environment=l.portal_environment AND ow.client_key=l.client_key
    AND ow.retired_at IS NULL AND ow.registered_at<=@cutoffAt
  JOIN @cutoffHeads h ON h.catalog_source_key=l.catalog_source_key AND h.source_role='erp-customers'
  JOIN core.catalog_operational_link_approvals a WITH (HOLDLOCK)
    ON a.link_key=l.link_key AND a.binding_version=h.binding_version AND a.profile_version=h.profile_version
    AND a.approved_at<=@cutoffAt AND a.revision_key<=h.revision_key
  JOIN core.catalog_customer_revision_rows rr WITH (HOLDLOCK)
    ON rr.revision_key=h.revision_key AND rr.source_record_id=l.source_record_id
    AND rr.catalog_customer_key=ow.catalog_customer_key AND rr.active_code='S'
  JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.status='active'
  JOIN core.domains d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=l.client_key AND d.status='active'
  LEFT JOIN core.databases db WITH (HOLDLOCK)
    ON db.database_key=l.database_key AND db.domain_key=l.domain_key AND db.client_key=l.client_key AND db.status='active'
  LEFT JOIN core.database_access_profiles dp WITH (HOLDLOCK) ON dp.access_profile_key=db.access_profile_key AND dp.active=1
  JOIN core.catalog_physical_targets pt WITH (HOLDLOCK)
    ON pt.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id) AND DATALENGTH(e.verified_target_id)=72
    AND pt.portal_environment=@portalEnvironment AND pt.target_kind=l.target_kind
  JOIN core.catalog_physical_target_links fl WITH (HOLDLOCK)
    ON fl.physical_target_key=pt.physical_target_key AND fl.portal_environment=pt.portal_environment
    AND fl.target_kind=pt.target_kind AND fl.client_key=l.client_key AND fl.domain_key=l.domain_key
    AND (fl.database_key=l.database_key OR (fl.database_key IS NULL AND l.database_key IS NULL))
    AND fl.retired_at IS NULL AND fl.registered_at<=@cutoffAt AND fl.verified_at<=@cutoffAt AND fl.valid_until>@cutoffAt
  WHERE ${catalogOnceExplicitCompletionSql}
    AND ((l.target_kind='domain' AND d.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment
      AND fl.domain_route_fingerprint=${catalogDomainRouteFingerprintSql})
    OR (l.target_kind='database' AND db.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment
      AND fl.access_profile_key=dp.access_profile_key AND fl.access_profile_version=dp.row_version
      AND pt.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),dp.initial_catalog))));

DECLARE @licenseContexts TABLE(
  observation_key bigint NOT NULL,link_key bigint NOT NULL,schedule_key bigint NOT NULL,
  target_kind varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,client_key bigint NOT NULL,
  domain_key bigint NOT NULL,database_key bigint NULL,link_environment varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
  domain_name nvarchar(500) COLLATE DATABASE_DEFAULT NOT NULL,issuer char(2) COLLATE Latin1_General_100_BIN2 NULL,
  document_type varchar(32) COLLATE Latin1_General_100_BIN2 NULL,document_number_token binary(32) NULL,
  license_match_mode varchar(10) COLLATE DATABASE_DEFAULT NOT NULL,hostname nvarchar(253) COLLATE DATABASE_DEFAULT NOT NULL,
  sag_source_key bigint NOT NULL,sag_revision bigint NOT NULL,sag_binding binary(8) NOT NULL,sag_profile binary(8) NOT NULL
);
INSERT @licenseContexts
  SELECT p.*,ls.license_match_mode,host.hostname,sag.catalog_source_key AS sag_source_key,
    sag.revision_key AS sag_revision,sag.binding_version AS sag_binding,sag.profile_version AS sag_profile
  FROM @validPairs p
  JOIN scheduling.update_schedules schedule WITH (HOLDLOCK) ON schedule.schedule_key=p.schedule_key AND schedule.selection_mode='licensing'
  JOIN scheduling.licensing_scope ls WITH (HOLDLOCK) ON ls.schedule_key=p.schedule_key
  JOIN @cutoffHeads sag ON sag.source_role='sag-admin'
  CROSS APPLY (VALUES(SUBSTRING(p.domain_name,9,500))) raw(authority)
  CROSS APPLY (VALUES(LOWER(CASE WHEN RIGHT(raw.authority,1)=N'/'
    THEN LEFT(raw.authority,LEN(raw.authority)-1) ELSE raw.authority END))) host(hostname)
  WHERE ls.license_match_mode IN ('any','all') AND p.issuer IS NOT NULL AND p.document_type IS NOT NULL
    AND p.document_number_token IS NOT NULL
    AND LEFT(p.domain_name,8) COLLATE Latin1_General_100_BIN2=N'https://'
    AND DATALENGTH(p.domain_name)=2*LEN(p.domain_name) AND LEN(host.hostname) BETWEEN 3 AND 253
    AND REPLACE(host.hostname,N'-',N'') COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^a-z0-9.]%'
    AND host.hostname LIKE N'%.%' AND host.hostname NOT LIKE N'%..%'
    AND LEFT(host.hostname,1)<>N'.' AND RIGHT(host.hostname,1)<>N'.'
    AND CASE WHEN CHARINDEX(N'.',REVERSE(host.hostname))>0
      THEN RIGHT(host.hostname,CHARINDEX(N'.',REVERSE(host.hostname))-1) ELSE N'' END COLLATE Latin1_General_100_BIN2 LIKE N'%[a-z]%'
    AND NOT EXISTS(SELECT 1 FROM STRING_SPLIT(host.hostname,N'.') label
      WHERE LEN(label.[value]) NOT BETWEEN 1 AND 63 OR LEFT(label.[value],1)=N'-' OR RIGHT(label.[value],1)=N'-')
    AND (ls.environment_id IS NULL OR (ls.environment_id COLLATE Latin1_General_100_BIN2=p.link_environment
      AND DATALENGTH(ls.environment_id)=DATALENGTH(p.link_environment)))
    AND (ls.target_types='domains_and_databases' OR (p.target_kind='domain' AND ls.target_types='domains_only')
      OR (p.target_kind='database' AND ls.target_types='databases_only'))
    AND NOT EXISTS(SELECT 1 FROM scheduling.scope_groups WITH (HOLDLOCK) WHERE schedule_key=p.schedule_key)
    AND NOT EXISTS(SELECT 1 FROM scheduling.licensing_excluded_domains WITH (HOLDLOCK)
      WHERE schedule_key=p.schedule_key AND domain_key=p.domain_key AND p.target_kind='domain')
    AND NOT EXISTS(SELECT 1 FROM scheduling.licensing_excluded_databases WITH (HOLDLOCK)
      WHERE schedule_key=p.schedule_key AND database_key=p.database_key AND p.target_kind='database')
    AND (p.target_kind='domain' OR EXISTS(
      SELECT 1 FROM core.catalog_operational_links parent WITH (HOLDLOCK)
      JOIN core.catalog_operational_owners owner WITH (HOLDLOCK) ON owner.owner_key=parent.owner_key
        AND owner.client_key=parent.client_key AND owner.portal_environment=parent.portal_environment
      JOIN @cutoffHeads source ON source.catalog_source_key=parent.catalog_source_key AND source.source_role='erp-customers'
      JOIN core.catalog_operational_link_approvals approval WITH (HOLDLOCK) ON approval.link_key=parent.link_key
        AND approval.binding_version=source.binding_version AND approval.profile_version=source.profile_version
        AND approval.revision_key<=source.revision_key AND approval.approved_at<=@cutoffAt
      JOIN core.catalog_customer_revision_rows customer WITH (HOLDLOCK) ON customer.revision_key=source.revision_key
        AND customer.source_record_id=parent.source_record_id AND customer.catalog_customer_key=owner.catalog_customer_key
        AND customer.active_code='S' AND customer.issuer=p.issuer AND customer.document_type=p.document_type
        AND customer.document_number_token=p.document_number_token
      WHERE parent.portal_environment=@portalEnvironment AND parent.client_key=p.client_key AND parent.domain_key=p.domain_key
        AND parent.database_key IS NULL AND parent.target_kind='domain' AND parent.link_environment=p.link_environment
        AND parent.retired_at IS NULL AND owner.retired_at IS NULL AND parent.registered_at<=@cutoffAt AND owner.registered_at<=@cutoffAt));

DECLARE @licenseClaims TABLE(
  link_key bigint NOT NULL,sag_revision bigint NOT NULL,source_record_id int NOT NULL,
  domain_candidate varchar(253) COLLATE Latin1_General_100_BIN2 NULL,
  environment_kind varchar(10) COLLATE Latin1_General_100_BIN2 NULL,license_codes varchar(25) COLLATE Latin1_General_100_BIN2 NULL
);
INSERT @licenseClaims
  SELECT p.link_key,p.sag_revision,r.source_record_id,detail.domain_candidate,detail.environment_kind,detail.license_codes
  FROM @licenseContexts p
  JOIN core.catalog_customer_revision_rows r WITH (HOLDLOCK) ON r.revision_key=p.sag_revision
    AND r.issuer=p.issuer AND r.document_type=p.document_type AND r.document_number_token=p.document_number_token
  LEFT JOIN core.catalog_sag_revision_evidence detail WITH (HOLDLOCK)
    ON detail.revision_key=r.revision_key AND detail.source_record_id=r.source_record_id;

DECLARE @numbers TABLE(
  n int PRIMARY KEY
);
INSERT @numbers
  SELECT n FROM (VALUES(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18),(19),(20),(21),(22),(23),(24),(25)) list(n);

DECLARE @licenseCodes TABLE(
  link_key bigint NOT NULL,code varchar(1) COLLATE Latin1_General_100_BIN2 NOT NULL
);
INSERT @licenseCodes
  SELECT p.link_key,SUBSTRING(c.license_codes,n.n,1) COLLATE Latin1_General_100_BIN2 AS code
  FROM @licenseContexts p JOIN @licenseClaims c ON c.link_key=p.link_key
    AND CONVERT(nvarchar(253),c.domain_candidate) COLLATE Latin1_General_100_BIN2=p.hostname
    AND DATALENGTH(CONVERT(nvarchar(253),c.domain_candidate))=DATALENGTH(p.hostname)
    AND c.environment_kind=p.link_environment AND DATALENGTH(c.environment_kind)=DATALENGTH(p.link_environment)
  JOIN @numbers n ON n.n<=DATALENGTH(c.license_codes);

DECLARE @licenseModules TABLE(
  link_key bigint NOT NULL,module_key bigint NOT NULL,PRIMARY KEY(link_key,module_key)
);
INSERT @licenseModules
  SELECT DISTINCT p.link_key,m.module_key FROM @licenseContexts p JOIN @licenseCodes code ON code.link_key=p.link_key
  JOIN settings.catalog_sag_license_module_approvals approval WITH (HOLDLOCK)
    ON approval.catalog_source_key=p.sag_source_key AND approval.binding_version=p.sag_binding
    AND approval.profile_version=p.sag_profile AND approval.sag_code=code.code AND approval.approved_at<=@cutoffAt
  JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=approval.module_key AND m.status='active' AND m.deleted_at IS NULL;

DECLARE @licensedPairs TABLE(
  link_key bigint NOT NULL
);
INSERT @licensedPairs
  SELECT p.link_key FROM @licenseContexts p
  WHERE NOT EXISTS(SELECT 1 FROM core.catalog_customer_revision_rows unknownIssuer WITH (HOLDLOCK)
    WHERE unknownIssuer.revision_key=p.sag_revision AND unknownIssuer.document_number_token=p.document_number_token AND unknownIssuer.issuer IS NULL)
    AND (SELECT COUNT_BIG(*) FROM @licenseClaims c WHERE c.link_key=p.link_key)<=128
    AND NOT EXISTS(SELECT 1 FROM @licenseClaims c WHERE c.link_key=p.link_key AND (c.environment_kind IS NULL
      OR c.environment_kind='unknown' OR (c.environment_kind=p.link_environment AND c.domain_candidate IS NULL)
      OR (c.environment_kind=p.link_environment AND CONVERT(nvarchar(253),c.domain_candidate) COLLATE Latin1_General_100_BIN2=p.hostname
        AND c.license_codes IS NULL)))
    AND NOT EXISTS(SELECT 1 FROM @licenseClaims c WHERE c.link_key=p.link_key
      GROUP BY c.domain_candidate,c.environment_kind HAVING COUNT_BIG(*)>1)
    AND (SELECT COUNT_BIG(*) FROM @licenseClaims c WHERE c.link_key=p.link_key
      AND CONVERT(nvarchar(253),c.domain_candidate) COLLATE Latin1_General_100_BIN2=p.hostname
      AND DATALENGTH(CONVERT(nvarchar(253),c.domain_candidate))=DATALENGTH(p.hostname)
      AND c.environment_kind=p.link_environment AND DATALENGTH(c.environment_kind)=DATALENGTH(p.link_environment))=1
    AND NOT EXISTS(SELECT 1 FROM @licenseCodes code WHERE code.link_key=p.link_key AND code.code NOT LIKE '[A-SU-Z]')
    AND NOT EXISTS(SELECT 1 FROM @licenseCodes code WHERE code.link_key=p.link_key GROUP BY code.code HAVING COUNT_BIG(*)>1)
    AND NOT EXISTS(SELECT 1 FROM @licenseCodes code WHERE code.link_key=p.link_key AND NOT EXISTS(
      SELECT 1 FROM settings.catalog_sag_license_module_approvals approval WITH (HOLDLOCK)
      JOIN licensing.license_modules module WITH (HOLDLOCK) ON module.module_key=approval.module_key AND module.status='active' AND module.deleted_at IS NULL
      WHERE approval.catalog_source_key=p.sag_source_key AND approval.binding_version=p.sag_binding
        AND approval.profile_version=p.sag_profile AND approval.sag_code=code.code AND approval.approved_at<=@cutoffAt))
    AND EXISTS(SELECT 1 FROM scheduling.licensing_scope_modules WITH (HOLDLOCK) WHERE schedule_key=p.schedule_key)
    AND NOT EXISTS(SELECT 1 FROM scheduling.licensing_scope_modules wanted WITH (HOLDLOCK)
      LEFT JOIN licensing.license_modules module WITH (HOLDLOCK) ON module.module_key=wanted.module_key AND module.status='active' AND module.deleted_at IS NULL
      WHERE wanted.schedule_key=p.schedule_key AND module.module_key IS NULL)
    AND ((p.license_match_mode='any' AND EXISTS(SELECT 1 FROM scheduling.licensing_scope_modules wanted WITH (HOLDLOCK)
      JOIN @licenseModules have ON have.link_key=p.link_key AND have.module_key=wanted.module_key WHERE wanted.schedule_key=p.schedule_key))
      OR (p.license_match_mode='all' AND NOT EXISTS(SELECT 1 FROM scheduling.licensing_scope_modules wanted WITH (HOLDLOCK)
        WHERE wanted.schedule_key=p.schedule_key AND NOT EXISTS(SELECT 1 FROM @licenseModules have
          WHERE have.link_key=p.link_key AND have.module_key=wanted.module_key))));

SELECT s.source_id AS scheduleId,LOWER(CONVERT(char(16),o.schedule_version,2)) AS scheduleVersion,
  c.source_id AS clientId
FROM @candidate o
JOIN scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
  ON s.schedule_key=o.schedule_key AND s.row_version=o.schedule_version AND s.active=1 AND s.deleted_at IS NULL
  AND s.frequency_type='once' AND s.start_date=@taskDate
  AND s.timezone COLLATE Latin1_General_100_BIN2=N'America/Bogota' AND DATALENGTH(s.timezone)=28
  AND (s.selection_mode IS NULL OR s.selection_mode IN ('manual','licensing'))
JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=s.client_key AND c.status='active'
JOIN scheduling.catalog_schedule_operation_approvals op WITH (HOLDLOCK)
  ON op.portal_environment=@portalEnvironment AND op.schedule_key=o.schedule_key AND op.schedule_version=o.schedule_version
  AND op.operation_id=o.operation_id AND DATALENGTH(op.operation_id)=DATALENGTH(o.operation_id)
  AND op.retired_at IS NULL AND op.approved_at<=@cutoffAt
JOIN scheduling.catalog_schedule_population_approvals pop WITH (HOLDLOCK)
  ON pop.population_id=o.population_id AND pop.portal_environment=@portalEnvironment
  AND pop.retired_at IS NULL AND pop.approved_at<=@cutoffAt AND pop.valid_until>@cutoffAt
JOIN security.users u WITH (HOLDLOCK) ON u.user_key=pop.approved_by AND u.active=1
JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key AND ur.role_id=N'super_admin'
JOIN security.roles sr WITH (HOLDLOCK)
  ON sr.role_id=ur.role_id AND sr.active=1 AND sr.system_role=1 AND sr.protected_role=1
CROSS JOIN @manifest m
CROSS JOIN @witnessFence witnessFence
CROSS APPLY scheduling.catalog_once_source_fence(@portalEnvironment) f
WHERE witnessFence.source_fence=o.source_fence AND f.source_count=pop.source_count AND f.source_count BETWEEN 2 AND 50
  AND f.all_configured=1 AND f.sag_source_count=1 AND f.latest_validated_at<=@cutoffAt
  AND f.source_count=(SELECT COUNT_BIG(*) FROM @cutoffHeads)
  AND m.link_count=pop.link_count AND m.link_count BETWEEN 1 AND 5000
  AND pop.population_sha256=HASHBYTES('SHA2_256',CONCAT(
    '["portal-sag:catalog-schedule-population:v1","',@portalEnvironment,'",[',f.population_sources,'],[',m.link_json,']]'))
  AND o.pair_count=(SELECT COUNT_BIG(*) FROM scheduling.catalog_once_observation_pairs q WITH (HOLDLOCK)
    WHERE q.observation_key=o.observation_key)
  AND o.pair_count=(SELECT COUNT_BIG(DISTINCT p.link_key) FROM @validPairs p WHERE p.observation_key=o.observation_key)
  AND (s.selection_mode IS NULL OR s.selection_mode='manual' OR (s.selection_mode='licensing'
    AND o.pair_count=(SELECT COUNT_BIG(DISTINCT licensed.link_key) FROM @licensedPairs licensed)))
  -- An attached live origin outside the durable expected set is not proof
  -- that the smaller set is complete. Receipts never enter this comparison.
  AND NOT EXISTS (
    SELECT 1
    FROM workflow.catalog_task_execution_sources ea WITH (HOLDLOCK)
    JOIN workflow.catalog_task_execution_links x WITH (HOLDLOCK)
      ON x.catalog_execution_link_key=ea.catalog_execution_link_key AND x.link_state='active' AND x.retired_at IS NULL
    JOIN workflow.catalog_task_executions e WITH (HOLDLOCK)
      ON e.catalog_execution_key=x.catalog_execution_key AND e.cutoff_at=@cutoffAt
      AND e.occurrence_id=CONVERT(nvarchar(10),@dateText) AND DATALENGTH(e.occurrence_id)=20
    JOIN core.catalog_physical_targets pt WITH (HOLDLOCK)
      ON pt.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id)
      AND pt.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2 AND pt.portal_environment=@portalEnvironment
    WHERE ea.schedule_key=o.schedule_key AND ea.detached_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM scheduling.catalog_once_observation_pairs q WITH (HOLDLOCK)
        WHERE q.observation_key=o.observation_key AND q.catalog_execution_link_key=x.catalog_execution_link_key
          AND q.catalog_execution_key=e.catalog_execution_key
      )
  );
`.trim();
