import { catalogDomainRouteFingerprintSql } from "./catalogPhysicalTargetIdentity";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

/** Missing/invalid configuration disables catalog eligibility, never legacy reads. */
export function catalogWorkflowEnvironment(): CatalogEnvironment | null {
  const value = process.env.PORTAL_SAG_ENVIRONMENT?.trim();
  return value === "qa" || value === "production" ? value : null;
}

/**
 * Internal constant-template predicate, not a SQL builder for request input.
 * Callers declare @now with SYSUTCDATETIME and bind the trusted environment.
 * Evidence is current, not merely the historical state stored on the alias.
 */
export function catalogTaskCurrentLinkSql(executionAlias: string, linkAlias: string, environmentSql: string): string {
  if (!["e", "catalog_execution"].includes(executionAlias)
    || !["link", "catalog_link", "visible_link"].includes(linkAlias)
    || !["@environment", "@portalEnvironment"].includes(environmentSql)) {
    throw new Error("catalog_task_sql_template_invalid");
  }
  const e = executionAlias, l = linkAlias, env = environmentSql;
  const routeFingerprint = catalogDomainRouteFingerprintSql.replace(/\bd\./g, "current_domain.");
  return `(${env} IS NOT NULL AND ${e}.retired_at IS NULL
    AND (${e}.cutoff_at>@now OR ${e}.cutoff_evaluated_at IS NOT NULL)
    AND ${l}.catalog_execution_key=${e}.catalog_execution_key AND ${l}.execution_kind=${e}.execution_kind
    AND ${l}.link_state='active' AND ${l}.retired_at IS NULL
    AND ((${l}.catalog_source_key IS NULL AND NOT EXISTS (
      SELECT 1 FROM core.catalog_operational_links AS known_external
      WHERE known_external.link_id=TRY_CONVERT(uniqueidentifier,${l}.link_id)
    )) OR (${l}.catalog_source_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM core.catalog_operational_link_evidence AS current_bridge
      JOIN core.catalog_customer_source_revisions AS current_revision
        ON current_revision.revision_key=current_bridge.revision_key AND current_revision.observed_at<=@now
      WHERE current_bridge.link_id=TRY_CONVERT(uniqueidentifier,${l}.link_id) AND DATALENGTH(${l}.link_id)=72
        AND current_bridge.portal_environment COLLATE Latin1_General_100_BIN2=${env} COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(current_bridge.portal_environment)=DATALENGTH(${env})
        AND current_bridge.client_key=${l}.client_key AND current_bridge.domain_key=${l}.domain_key
        AND (( ${e}.execution_kind='domain' AND current_bridge.database_key IS NULL AND ${l}.database_key IS NULL)
          OR (${e}.execution_kind='database' AND current_bridge.database_key=${l}.database_key))
        AND current_bridge.target_kind=${e}.execution_kind COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(current_bridge.target_kind)=DATALENGTH(${e}.execution_kind)
        AND current_bridge.link_environment=${l}.link_environment COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(current_bridge.link_environment)=DATALENGTH(${l}.link_environment)
        AND current_bridge.catalog_source_key=${l}.catalog_source_key
        AND current_bridge.source_record_id=TRY_CONVERT(int,${l}.catalog_record_id)
        AND CONVERT(nvarchar(11),current_bridge.source_record_id) COLLATE Latin1_General_100_BIN2=${l}.catalog_record_id COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(CONVERT(nvarchar(11),current_bridge.source_record_id))=DATALENGTH(${l}.catalog_record_id)
        AND current_bridge.retired_at IS NULL AND current_bridge.owner_retired_at IS NULL
        AND current_bridge.evidence_state='verified' AND current_bridge.verified_until>@now
    )))
    AND EXISTS (
      SELECT 1 FROM core.clients AS current_client
      JOIN core.domains AS current_domain ON current_domain.client_key=current_client.client_key
        AND current_domain.domain_key=${l}.domain_key AND current_domain.status='active'
      LEFT JOIN core.databases AS current_db ON current_db.database_key=${l}.database_key
        AND current_db.client_key=current_client.client_key AND current_db.domain_key=current_domain.domain_key
        AND current_db.status='active'
      LEFT JOIN core.database_access_profiles AS current_profile
        ON current_profile.access_profile_key=current_db.access_profile_key AND current_profile.active=1
      JOIN core.catalog_physical_target_links AS current_physical
        ON current_physical.client_key=current_client.client_key AND current_physical.domain_key=current_domain.domain_key
        AND current_physical.portal_environment=${env} COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(current_physical.portal_environment)=DATALENGTH(${env})
        AND current_physical.target_kind=${e}.execution_kind COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(current_physical.target_kind)=DATALENGTH(${e}.execution_kind)
        AND current_physical.retired_at IS NULL AND current_physical.verified_at<=@now AND current_physical.valid_until>@now
      JOIN core.catalog_physical_targets AS current_target
        ON current_target.physical_target_key=current_physical.physical_target_key
        AND current_target.portal_environment=current_physical.portal_environment
        AND current_target.target_kind=current_physical.target_kind
        AND current_target.target_id=TRY_CONVERT(uniqueidentifier,${e}.verified_target_id)
        AND DATALENGTH(${e}.verified_target_id)=72
      WHERE current_client.client_key=${l}.client_key AND current_client.status='active'
        AND ((${e}.execution_kind='domain' AND ${l}.database_key IS NULL AND current_physical.database_key IS NULL
          AND current_domain.environment_id COLLATE Latin1_General_100_BIN2=${l}.link_environment COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(current_domain.environment_id)=DATALENGTH(${l}.link_environment)
          AND current_physical.domain_route_fingerprint=${routeFingerprint})
        OR (${e}.execution_kind='database' AND current_physical.database_key=current_db.database_key
          AND current_db.environment_id COLLATE Latin1_General_100_BIN2=${l}.link_environment COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(current_db.environment_id)=DATALENGTH(${l}.link_environment)
          AND current_physical.access_profile_key=current_profile.access_profile_key
          AND current_physical.access_profile_version=current_profile.row_version
          AND current_target.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),current_profile.initial_catalog))))
    ))`;
}

/** Constant SQL fragments; repository callers alias workflow.update_tasks as task. */
export const catalogTaskIsLegacySql = `NOT EXISTS (
  SELECT 1 FROM workflow.catalog_task_executions catalog_execution
  WHERE catalog_execution.task_key=task.task_key
)`;

/** Completed history keeps its immutable target environment, not expiring live evidence. */
export const catalogTaskHistoryEnvironmentSql = `(${catalogTaskIsLegacySql} OR EXISTS (
  SELECT 1 FROM workflow.catalog_task_executions history_execution
  JOIN core.catalog_physical_targets history_target
    ON history_target.target_id=TRY_CONVERT(uniqueidentifier,history_execution.verified_target_id)
    AND DATALENGTH(history_execution.verified_target_id)=72
    AND history_target.target_kind=history_execution.execution_kind COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(history_target.target_kind)=DATALENGTH(history_execution.execution_kind)
  WHERE history_execution.task_key=task.task_key
    AND history_target.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(history_target.portal_environment)=DATALENGTH(@portalEnvironment)
))`;

// Reuse the evaluated projection; do not repeat the evidence joins for open rows.
export const catalogTaskHasVisibleLinkSql = `(${catalogTaskIsLegacySql}
  OR active_catalog_link.catalog_execution_link_key IS NOT NULL)`;

/** Legacy mutation paths act on the stored representative, not on alternate visible links. */
export const catalogTaskHasActiveRepresentativeSql = `NOT EXISTS (
  SELECT 1 FROM workflow.catalog_task_executions catalog_execution
  WHERE catalog_execution.task_key=task.task_key
    AND (catalog_execution.retired_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM workflow.catalog_task_execution_links catalog_link
      WHERE catalog_link.catalog_execution_key=catalog_execution.catalog_execution_key
        AND ${catalogTaskCurrentLinkSql("catalog_execution", "catalog_link", "@portalEnvironment")}
        AND catalog_link.client_key=task.client_key
        AND catalog_link.domain_key=task.domain_key
        AND (task.target_type='domain' OR catalog_link.database_key=task.database_key)
    ))
)`;

/** Read-only projection: keep an open task represented by an active link, not a hidden predecessor. */
export const catalogTaskActiveLinkProjectionSql = `OUTER APPLY (
  SELECT TOP (1) link.catalog_execution_link_key,
    MAX(CASE WHEN (@clientId IS NULL OR client.source_id=@clientId)
      AND (@domainId IS NULL OR domain_row.source_id=@domainId) THEN 1 ELSE 0 END) OVER () AS matches_filters,
    CASE WHEN task.status<>'cancelled' THEN client.source_id END AS client_id,
    CASE WHEN task.status<>'cancelled' THEN client.name END AS client_name,
    CASE WHEN task.status<>'cancelled' THEN domain_row.source_id END AS domain_id,
    CASE WHEN task.status<>'cancelled' THEN domain_row.domain_name END AS domain_name,
    CASE WHEN task.status='cancelled' THEN NULL WHEN task.target_type='database' THEN db.source_id ELSE domain_row.source_id END AS target_id,
    CASE WHEN task.status='cancelled' THEN NULL WHEN task.target_type='database' THEN db.company_name ELSE domain_row.domain_name END AS target_name
  FROM workflow.catalog_task_executions e
  JOIN workflow.catalog_task_execution_links link ON link.catalog_execution_key=e.catalog_execution_key
  JOIN core.clients client ON client.client_key=link.client_key
  JOIN core.domains domain_row ON domain_row.domain_key=link.domain_key AND domain_row.client_key=link.client_key
  LEFT JOIN core.databases db ON db.database_key=link.database_key AND db.domain_key=link.domain_key
    AND db.client_key=link.client_key
  WHERE e.task_key=task.task_key AND task.status<>'completed'
    AND ${catalogTaskCurrentLinkSql("e", "link", "@portalEnvironment")}
  ORDER BY CASE WHEN link.client_key=task.client_key AND link.domain_key=task.domain_key
                      AND (task.target_type='domain' OR link.database_key=task.database_key) THEN 0 ELSE 1 END,
    link.catalog_execution_link_key
) AS active_catalog_link`;
