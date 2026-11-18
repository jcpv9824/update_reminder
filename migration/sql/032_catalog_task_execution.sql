/*
  Declarative, additive storage for catalog-backed task executions. No seed or
  backfill: legacy workflow tasks and their readers continue unchanged. Only a
  future workflow transaction may insert the task and its execution mapping,
  provenance, and first event together. Never create an independent
  reservation or execution which has no corresponding workflow task.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'workflow.update_tasks', N'U') IS NULL
   OR OBJECT_ID(N'core.domains', N'U') IS NULL
   OR OBJECT_ID(N'core.databases', N'U') IS NULL
   OR OBJECT_ID(N'scheduling.update_schedules', N'U') IS NULL
   OR OBJECT_ID(N'settings.catalog_source_bindings', N'U') IS NULL
  THROW 53200, N'Apply workflow and catalog source bindings before catalog task executions.', 1;

-- Same physical target kind as its corresponding workflow task. Existing task
-- uniqueness, dates, statuses, and source IDs are not changed.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'workflow.update_tasks')
  AND name=N'UX_update_tasks_key_kind_for_catalog')
  CREATE UNIQUE NONCLUSTERED INDEX UX_update_tasks_key_kind_for_catalog
    ON workflow.update_tasks(task_key, target_type);

IF OBJECT_ID(N'workflow.catalog_task_executions', N'U') IS NULL
BEGIN
  CREATE TABLE workflow.catalog_task_executions
  (
    catalog_execution_key bigint IDENTITY(1,1) NOT NULL,
    task_key bigint NOT NULL,
    execution_key binary(32) NOT NULL,
    occurrence_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
    execution_kind varchar(20) NOT NULL,
    verified_target_id nvarchar(260) COLLATE Latin1_General_100_BIN2 NOT NULL,
    operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
    initial_catalog_revision_id nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL,
    cutoff_at datetime2(3) NOT NULL,
    last_checked_at datetime2(3) NULL,
    cutoff_evaluated_at datetime2(3) NULL,
    retired_at datetime2(3) NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_task_executions_created DEFAULT SYSUTCDATETIME(),
    row_version rowversion NOT NULL,

    CONSTRAINT PK_catalog_task_executions PRIMARY KEY CLUSTERED (catalog_execution_key),
    CONSTRAINT UQ_catalog_task_executions_key UNIQUE (execution_key),
    CONSTRAINT UQ_catalog_task_executions_task UNIQUE (task_key),
    CONSTRAINT UQ_catalog_task_executions_typed_key UNIQUE (catalog_execution_key, execution_kind),
    CONSTRAINT UQ_catalog_task_executions_occurrence UNIQUE NONCLUSTERED
      (occurrence_id, execution_kind, verified_target_id),
    CONSTRAINT FK_catalog_task_executions_task FOREIGN KEY (task_key, execution_kind)
      REFERENCES workflow.update_tasks(task_key, target_type),
    CONSTRAINT CK_catalog_task_executions_kind CHECK (execution_kind IN ('domain','database')),
    CONSTRAINT CK_catalog_task_executions_identity CHECK (
      LEN(LTRIM(RTRIM(occurrence_id))) > 0 AND LEN(LTRIM(RTRIM(verified_target_id))) > 0
      AND LEN(LTRIM(RTRIM(operation_id))) > 0 AND LEN(LTRIM(RTRIM(initial_catalog_revision_id))) > 0
    ),
    CONSTRAINT CK_catalog_task_executions_cutoff CHECK (
      cutoff_evaluated_at IS NULL OR
        (last_checked_at IS NOT NULL AND cutoff_evaluated_at >= cutoff_at
         AND last_checked_at >= cutoff_evaluated_at)
    ),
    CONSTRAINT CK_catalog_task_executions_retired CHECK (
      retired_at IS NULL OR (cutoff_evaluated_at IS NOT NULL AND retired_at >= cutoff_evaluated_at)
    )
  );
END;

IF OBJECT_ID(N'workflow.catalog_task_execution_links', N'U') IS NULL
BEGIN
  CREATE TABLE workflow.catalog_task_execution_links
  (
    catalog_execution_link_key bigint IDENTITY(1,1) NOT NULL,
    catalog_execution_key bigint NOT NULL,
    execution_kind varchar(20) NOT NULL,
    link_id nvarchar(260) COLLATE Latin1_General_100_BIN2 NOT NULL,
    -- Null denotes a locally reconciled provenance which is not owned by an external binding.
    catalog_source_key bigint NULL,
    catalog_record_id nvarchar(260) COLLATE Latin1_General_100_BIN2 NOT NULL,
    client_key bigint NOT NULL,
    domain_key bigint NOT NULL,
    database_key bigint NULL,
    link_environment varchar(20) NOT NULL,
    link_state varchar(12) NOT NULL CONSTRAINT DF_catalog_task_execution_links_state DEFAULT 'active',
    state_reason varchar(20) NULL,
    last_evidence_at datetime2(3) NULL,
    retired_at datetime2(3) NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_task_execution_links_created DEFAULT SYSUTCDATETIME(),
    row_version rowversion NOT NULL,

    CONSTRAINT PK_catalog_task_execution_links PRIMARY KEY CLUSTERED (catalog_execution_link_key),
    CONSTRAINT UQ_catalog_task_execution_links_id UNIQUE (catalog_execution_key, link_id),
    CONSTRAINT UQ_catalog_task_execution_links_key UNIQUE (catalog_execution_key, catalog_execution_link_key),
    CONSTRAINT FK_catalog_task_execution_links_exec FOREIGN KEY (catalog_execution_key, execution_kind)
      REFERENCES workflow.catalog_task_executions(catalog_execution_key, execution_kind),
    CONSTRAINT FK_catalog_task_execution_links_source FOREIGN KEY (catalog_source_key)
      REFERENCES settings.catalog_source_bindings(catalog_source_key),
    CONSTRAINT FK_catalog_task_execution_links_domain FOREIGN KEY (domain_key, client_key)
      REFERENCES core.domains(domain_key, client_key),
    CONSTRAINT FK_catalog_task_execution_links_database FOREIGN KEY (database_key, domain_key, client_key)
      REFERENCES core.databases(database_key, domain_key, client_key),
    CONSTRAINT CK_catalog_task_execution_links_kind CHECK (
      (execution_kind='domain' AND database_key IS NULL) OR (execution_kind='database' AND database_key IS NOT NULL)
    ),
    CONSTRAINT CK_catalog_task_execution_links_environment CHECK (link_environment IN ('production','test','demo')),
    CONSTRAINT CK_catalog_task_execution_links_identity CHECK (
      LEN(LTRIM(RTRIM(link_id))) > 0 AND LEN(LTRIM(RTRIM(catalog_record_id))) > 0
    ),
    CONSTRAINT CK_catalog_task_execution_links_state CHECK (
      (link_state='active' AND state_reason IS NULL AND retired_at IS NULL)
      OR (link_state='hidden' AND state_reason IS NOT NULL AND state_reason IN ('not_found','unverifiable')
          AND retired_at IS NULL)
      OR (link_state='retired' AND state_reason IS NOT NULL AND state_reason IN ('not_found','unverifiable')
          AND retired_at IS NOT NULL)
    ),
    CONSTRAINT CK_catalog_task_execution_links_retired CHECK (
      retired_at IS NULL OR (last_evidence_at IS NOT NULL AND retired_at >= last_evidence_at)
    )
  );
END;

-- Multiple schedules may use the same link without duplicating link lifecycle.
-- A detached source remains available for history and replay protection.
IF OBJECT_ID(N'workflow.catalog_task_execution_sources', N'U') IS NULL
BEGIN
  CREATE TABLE workflow.catalog_task_execution_sources
  (
    catalog_execution_link_key bigint NOT NULL,
    schedule_key bigint NOT NULL,
    attached_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_task_execution_sources_attached DEFAULT SYSUTCDATETIME(),
    detached_at datetime2(3) NULL,
    row_version rowversion NOT NULL,

    CONSTRAINT PK_catalog_task_execution_sources PRIMARY KEY CLUSTERED (catalog_execution_link_key, schedule_key),
    CONSTRAINT FK_catalog_task_execution_sources_link FOREIGN KEY (catalog_execution_link_key)
      REFERENCES workflow.catalog_task_execution_links(catalog_execution_link_key),
    CONSTRAINT FK_catalog_task_execution_sources_schedule FOREIGN KEY (schedule_key)
      REFERENCES scheduling.update_schedules(schedule_key),
    CONSTRAINT CK_catalog_task_execution_sources_dates CHECK (detached_at IS NULL OR detached_at >= attached_at)
  );
END;

-- Events carry controlled reason codes and identifiers only, never connection
-- metadata, credentials, SQL, tenant URLs, or unstructured payloads.
IF OBJECT_ID(N'workflow.catalog_task_execution_events', N'U') IS NULL
BEGIN
  CREATE TABLE workflow.catalog_task_execution_events
  (
    catalog_execution_event_key bigint IDENTITY(1,1) NOT NULL,
    catalog_execution_key bigint NOT NULL,
    catalog_execution_link_key bigint NULL,
    event_token binary(32) NOT NULL,
    event_kind varchar(25) NOT NULL,
    event_reason varchar(20) NULL,
    occurred_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_task_execution_events_at DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_catalog_task_execution_events PRIMARY KEY CLUSTERED (catalog_execution_event_key),
    CONSTRAINT UQ_catalog_task_execution_events_token UNIQUE (event_token),
    CONSTRAINT FK_catalog_task_execution_events_exec FOREIGN KEY (catalog_execution_key)
      REFERENCES workflow.catalog_task_executions(catalog_execution_key),
    CONSTRAINT FK_catalog_task_execution_events_link FOREIGN KEY (catalog_execution_key, catalog_execution_link_key)
      REFERENCES workflow.catalog_task_execution_links(catalog_execution_key, catalog_execution_link_key),
    CONSTRAINT CK_catalog_task_execution_events_target CHECK (
      (catalog_execution_link_key IS NULL AND event_kind IN ('registered','cutoff_checked','occurrence_retired'))
      OR (catalog_execution_link_key IS NOT NULL AND event_kind IN ('hidden','restored','link_retired'))
    ),
    CONSTRAINT CK_catalog_task_execution_events_reason CHECK (
      (event_kind IN ('hidden','link_retired') AND event_reason IS NOT NULL
       AND event_reason IN ('not_found','unverifiable'))
      OR (event_kind NOT IN ('hidden','link_retired') AND event_reason IS NULL)
    )
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'workflow.catalog_task_execution_events')
  AND name=N'IX_catalog_task_execution_events_cursor')
  CREATE INDEX IX_catalog_task_execution_events_cursor ON workflow.catalog_task_execution_events
    (catalog_execution_key, catalog_execution_event_key)
    INCLUDE (catalog_execution_link_key, event_kind, event_reason, occurred_at);

-- Fail ordinary UPDATE/DELETE closed, including the existing owner exception.
-- Administration of DDL itself remains outside this application boundary.
IF OBJECT_ID(N'workflow.TR_catalog_task_execution_events_immutable', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER workflow.TR_catalog_task_execution_events_immutable
    ON workflow.catalog_task_execution_events
    INSTEAD OF UPDATE, DELETE
    AS
    BEGIN
      SET NOCOUNT ON;
      THROW 53201, N''Catalog task execution history is append only.'', 1;
    END;';
