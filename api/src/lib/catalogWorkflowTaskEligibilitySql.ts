/** Constant SQL fragments; both callers use workflow.update_tasks aliased as task. */
export const catalogTaskIsLegacySql = `NOT EXISTS (
  SELECT 1 FROM workflow.catalog_task_executions catalog_execution
  WHERE catalog_execution.task_key=task.task_key
)`;

export const catalogTaskHasVisibleLinkSql = `NOT EXISTS (
  SELECT 1 FROM workflow.catalog_task_executions catalog_execution
  WHERE catalog_execution.task_key=task.task_key
    AND (catalog_execution.retired_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM workflow.catalog_task_execution_links catalog_link
      WHERE catalog_link.catalog_execution_key=catalog_execution.catalog_execution_key
        AND catalog_link.link_state='active'
    ))
)`;

/** Legacy mutation paths act on the stored representative, not on alternate visible links. */
export const catalogTaskHasActiveRepresentativeSql = `NOT EXISTS (
  SELECT 1 FROM workflow.catalog_task_executions catalog_execution
  WHERE catalog_execution.task_key=task.task_key
    AND (catalog_execution.retired_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM workflow.catalog_task_execution_links catalog_link
      WHERE catalog_link.catalog_execution_key=catalog_execution.catalog_execution_key
        AND catalog_link.link_state='active' AND catalog_link.client_key=task.client_key
        AND catalog_link.domain_key=task.domain_key
        AND (task.target_type='domain' OR catalog_link.database_key=task.database_key)
    ))
)`;

/** Read-only projection: keep an open task represented by an active link, not a hidden predecessor. */
export const catalogTaskActiveLinkProjectionSql = `OUTER APPLY (
  SELECT TOP (1) client.source_id AS client_id,client.name AS client_name,
    domain_row.source_id AS domain_id,domain_row.domain_name AS domain_name,
    CASE WHEN task.target_type='database' THEN db.source_id ELSE domain_row.source_id END AS target_id,
    CASE WHEN task.target_type='database' THEN db.company_name ELSE domain_row.domain_name END AS target_name
  FROM workflow.catalog_task_executions e
  JOIN workflow.catalog_task_execution_links link ON link.catalog_execution_key=e.catalog_execution_key
  JOIN core.clients client ON client.client_key=link.client_key
  JOIN core.domains domain_row ON domain_row.domain_key=link.domain_key AND domain_row.client_key=link.client_key
  LEFT JOIN core.databases db ON db.database_key=link.database_key AND db.domain_key=link.domain_key
    AND db.client_key=link.client_key
  WHERE e.task_key=task.task_key AND e.retired_at IS NULL AND link.link_state='active'
    AND task.status NOT IN ('completed','cancelled')
  ORDER BY CASE WHEN (@clientId IS NULL OR client.source_id=@clientId)
                      AND (@domainId IS NULL OR domain_row.source_id=@domainId) THEN 0 ELSE 1 END,
    CASE WHEN link.client_key=task.client_key AND link.domain_key=task.domain_key
                      AND (task.target_type='domain' OR link.database_key=task.database_key) THEN 0 ELSE 1 END,
    link.catalog_execution_link_key
) AS active_catalog_link`;
