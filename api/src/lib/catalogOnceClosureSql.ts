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

;WITH candidate AS (
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
    )
), populationLinks AS (
  SELECT TOP (5001) l.link_key,LOWER(CONVERT(char(36),l.link_id)) AS link_id
  FROM core.catalog_operational_links l WITH (HOLDLOCK)
  JOIN core.catalog_operational_owners ow WITH (HOLDLOCK) ON ow.owner_key=l.owner_key
  JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=l.catalog_source_key
  WHERE l.portal_environment=@portalEnvironment AND l.retired_at IS NULL AND ow.retired_at IS NULL
  ORDER BY l.link_key
), manifest AS (
  SELECT COUNT_BIG(*) AS link_count,
    STRING_AGG(CONVERT(varchar(max),CONCAT('"',link_id,'"')),',')
      WITHIN GROUP (ORDER BY link_id COLLATE Latin1_General_100_BIN2) AS link_json
  FROM populationLinks
), cutoffHeads AS (
  -- Exact current heads only. A newer attempt cannot stand in for the head
  -- present at observation; the source fence further compares that identity.
  SELECT b.catalog_source_key,b.source_role,r.revision_key,r.binding_version,r.profile_version
  FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
  JOIN settings.external_database_connections p WITH (HOLDLOCK)
    ON p.external_database_connection_key=b.external_database_connection_key AND p.active=1 AND p.status='active'
    AND p.encrypt_connection=1 AND p.password_configured=1 AND b.validated_profile_version=p.row_version
  JOIN settings.catalog_match_key_registry mk WITH (HOLDLOCK)
    ON mk.portal_environment=@portalEnvironment AND mk.enrolled_at<=@cutoffAt
  JOIN settings.catalog_customer_revision_heads h WITH (HOLDLOCK)
    ON h.catalog_source_key=b.catalog_source_key AND h.attempt_status='succeeded' AND h.attempted_at<=@cutoffAt
  JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
    ON r.catalog_source_key=b.catalog_source_key AND r.source_role=b.source_role AND r.revision_key=h.revision_key
    AND r.attempt_ordinal=h.attempt_ordinal AND r.profile_version=p.row_version AND r.binding_version=b.row_version
    AND r.match_key_version=mk.match_key_version AND r.observed_at<=@cutoffAt AND r.sealed_at<=@cutoffAt
    AND r.verified_until>@cutoffAt
  WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=@portalEnvironment
    AND DATALENGTH(b.portal_environment)=DATALENGTH(@portalEnvironment)
    AND b.source_state='active' AND b.validated_at<=@cutoffAt
    AND ((b.source_role='erp-customers' AND b.contract_version='erp_v1')
      OR (b.source_role='sag-admin' AND b.contract_version='sag_admin_v1' AND r.has_sag_inventory_evidence=1))
), validPairs AS (
  SELECT q.observation_key,q.link_key
  FROM candidate o
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
  JOIN cutoffHeads h ON h.catalog_source_key=l.catalog_source_key AND h.source_role='erp-customers'
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
      AND pt.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),dp.initial_catalog))))
)
SELECT s.source_id AS scheduleId,LOWER(CONVERT(char(16),o.schedule_version,2)) AS scheduleVersion,
  c.source_id AS clientId
FROM candidate o
JOIN scheduling.update_schedules s WITH (UPDLOCK,HOLDLOCK)
  ON s.schedule_key=o.schedule_key AND s.row_version=o.schedule_version AND s.active=1 AND s.deleted_at IS NULL
  AND s.frequency_type='once' AND s.start_date=@taskDate
  AND s.timezone COLLATE Latin1_General_100_BIN2=N'America/Bogota' AND DATALENGTH(s.timezone)=28
  -- Licensing membership at cutoff requires a separate versioned proof.
  AND (s.selection_mode IS NULL OR s.selection_mode='manual')
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
CROSS JOIN manifest m
CROSS APPLY scheduling.catalog_once_source_fence(@portalEnvironment) f
WHERE f.source_fence=o.source_fence AND f.source_count=pop.source_count AND f.source_count BETWEEN 2 AND 50
  AND f.all_configured=1 AND f.sag_source_count=1 AND f.latest_validated_at<=@cutoffAt
  AND f.source_count=(SELECT COUNT_BIG(*) FROM cutoffHeads)
  AND m.link_count=pop.link_count AND m.link_count BETWEEN 1 AND 5000
  AND pop.population_sha256=HASHBYTES('SHA2_256',CONCAT(
    '["portal-sag:catalog-schedule-population:v1","',@portalEnvironment,'",[',f.population_sources,'],[',m.link_json,']]'))
  AND o.pair_count=(SELECT COUNT_BIG(*) FROM scheduling.catalog_once_observation_pairs q WITH (HOLDLOCK)
    WHERE q.observation_key=o.observation_key)
  AND o.pair_count=(SELECT COUNT_BIG(DISTINCT p.link_key) FROM validPairs p WHERE p.observation_key=o.observation_key)
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
