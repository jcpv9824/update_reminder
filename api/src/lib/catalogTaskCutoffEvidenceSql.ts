import { catalogDomainRouteFingerprintSql } from "./catalogPhysicalTargetIdentity";

/** Fixed internal query: current visibility before cutoff, immutable source-head history thereafter. */
export const catalogTaskCutoffEvidenceSql = `
    DECLARE @checkedAt datetime2(3)=SYSUTCDATETIME();
    SELECT l.link_id AS linkId, @checkedAt AS checkedAt, boundary.as_of AS effectiveAt, proof.valid_until AS validUntil
    FROM workflow.catalog_task_executions e
    JOIN core.catalog_physical_targets target ON target.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id)
      AND target.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2 AND target.portal_environment=@env
    JOIN workflow.catalog_task_execution_links l ON l.catalog_execution_key=e.catalog_execution_key
    CROSS APPLY (VALUES(CASE WHEN e.cutoff_at<@checkedAt THEN e.cutoff_at ELSE @checkedAt END)) boundary(as_of)
    JOIN core.clients c ON c.client_key=l.client_key
    JOIN core.domains d ON d.domain_key=l.domain_key AND d.client_key=l.client_key
    LEFT JOIN core.databases db ON db.database_key=l.database_key AND db.client_key=l.client_key AND db.domain_key=l.domain_key
    LEFT JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key
    OUTER APPLY (
      -- Current state controls pre-cutoff visibility. At/after cutoff use
      -- the latest recorded state at that boundary, including negative states.
      SELECT r.verified_until AS valid_until
      FROM core.catalog_operational_links bridge
      JOIN core.catalog_operational_owners owner ON owner.owner_key=bridge.owner_key
        AND owner.portal_environment=bridge.portal_environment AND owner.client_key=bridge.client_key
      JOIN settings.catalog_source_bindings b ON b.catalog_source_key=bridge.catalog_source_key
      JOIN settings.external_database_connections profile ON profile.external_database_connection_key=b.external_database_connection_key
      CROSS APPLY (
        SELECT head.revision_key,head.attempt_ordinal,
          head.attempt_status COLLATE Latin1_General_100_BIN2 AS attempt_status,head.attempted_at
        FROM settings.catalog_customer_revision_heads head
        WHERE e.cutoff_at>@checkedAt AND head.catalog_source_key=b.catalog_source_key
        UNION ALL
        SELECT history.revision_key,history.attempt_ordinal,history.attempt_status,history.attempted_at
        FROM (
          SELECT TOP (1) event.revision_key,event.attempt_ordinal,event.attempt_status,event.attempted_at
          FROM settings.catalog_source_head_events event
          WHERE e.cutoff_at<=@checkedAt AND event.catalog_source_key=b.catalog_source_key
            AND event.recorded_at<=boundary.as_of
          ORDER BY event.head_event_key DESC
        ) history
      ) h
      JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
        AND r.source_role=b.source_role AND r.attempt_ordinal=h.attempt_ordinal
      JOIN core.catalog_operational_link_approvals a ON a.link_key=bridge.link_key
        AND a.binding_version=r.binding_version AND a.profile_version=r.profile_version
      JOIN core.catalog_customer_revision_rows data ON data.revision_key=r.revision_key
        AND data.source_record_id=bridge.source_record_id AND data.catalog_customer_key=owner.catalog_customer_key
      WHERE bridge.link_id=TRY_CONVERT(uniqueidentifier,l.link_id) AND DATALENGTH(l.link_id)=72
        AND bridge.portal_environment=@env AND bridge.catalog_source_key=l.catalog_source_key
        AND bridge.client_key=l.client_key AND bridge.domain_key=l.domain_key
        AND (bridge.database_key=l.database_key OR (bridge.database_key IS NULL AND l.database_key IS NULL))
        AND bridge.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2
        AND bridge.link_environment=l.link_environment COLLATE Latin1_General_100_BIN2
        AND bridge.source_record_id=TRY_CONVERT(int,l.catalog_record_id)
        AND CONVERT(nvarchar(11),bridge.source_record_id) COLLATE Latin1_General_100_BIN2=l.catalog_record_id
        AND DATALENGTH(CONVERT(nvarchar(11),bridge.source_record_id))=DATALENGTH(l.catalog_record_id)
        AND (bridge.retired_at IS NULL OR bridge.retired_at>boundary.as_of)
        AND (owner.retired_at IS NULL OR owner.retired_at>boundary.as_of)
        AND bridge.registered_at<=boundary.as_of AND owner.registered_at<=boundary.as_of
        AND a.approved_at<=boundary.as_of AND a.revision_key<=r.revision_key
        AND data.active_code='S' AND b.source_role='erp-customers' AND b.contract_version='erp_v1'
        AND b.portal_environment=@env AND b.source_state='active'
        AND b.validated_at<=boundary.as_of AND b.validated_profile_version=profile.row_version
        AND profile.status='active' AND profile.active=1 AND profile.encrypt_connection=1 AND profile.password_configured=1
        AND h.attempt_status='succeeded' AND h.attempted_at<=boundary.as_of
        AND r.sealed_at<=boundary.as_of AND r.observed_at<=boundary.as_of AND r.verified_until>boundary.as_of
        AND r.binding_version=b.row_version AND r.profile_version=profile.row_version
    ) externalProof
    OUTER APPLY (
      SELECT TOP (1)
        CASE WHEN externalProof.valid_until<t.valid_until THEN externalProof.valid_until ELSE t.valid_until END AS valid_until
      FROM core.catalog_physical_target_links t
      WHERE t.portal_environment=@env AND t.physical_target_key=target.physical_target_key
        AND t.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2
        AND t.client_key=l.client_key AND t.domain_key=l.domain_key AND t.verified_at<=boundary.as_of
        AND t.registered_at<=boundary.as_of AND target.created_at<=boundary.as_of AND t.valid_until>boundary.as_of
        AND t.retired_at IS NULL AND l.created_at<=boundary.as_of AND c.status='active' AND d.status='active'
        AND EXISTS (
          SELECT 1 FROM workflow.catalog_task_execution_sources provenance
          JOIN scheduling.update_schedules source_schedule ON source_schedule.schedule_key=provenance.schedule_key
          WHERE provenance.catalog_execution_link_key=l.catalog_execution_link_key
            AND provenance.attached_at<=boundary.as_of
            AND (provenance.detached_at IS NULL OR provenance.detached_at>boundary.as_of)
            AND (source_schedule.deleted_at IS NULL OR source_schedule.deleted_at>boundary.as_of)
        )
        AND ((e.execution_kind='domain' AND t.database_key IS NULL AND d.environment_id=l.link_environment
          AND t.domain_route_fingerprint=${catalogDomainRouteFingerprintSql})
          OR (e.execution_kind='database' AND t.database_key=l.database_key AND db.status='active'
            AND db.environment_id=l.link_environment AND p.active=1 AND t.access_profile_key=p.access_profile_key
            AND t.access_profile_version=p.row_version
            AND target.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.initial_catalog))))
        AND ((l.catalog_source_key IS NOT NULL AND externalProof.valid_until IS NOT NULL)
          OR (l.catalog_source_key IS NULL AND NOT EXISTS (
            SELECT 1 FROM core.catalog_operational_links known
            WHERE known.link_id=TRY_CONVERT(uniqueidentifier,l.link_id)
          )))
      ORDER BY t.registered_at DESC,t.physical_target_link_key DESC
    ) proof
    WHERE e.execution_key=@execution;`.trim();
