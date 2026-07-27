/*
  Portal SAG Web - SQL Server 2019 / 026
  Add the Portal-native Ayudas SAG Web / Constructor de guías domain.

  Object bytes remain in private object storage. content.files is populated
  only after the worker verifies the uploaded source bytes and SHA-256.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52600,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52601,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='025' AND succeeded=1
)
  THROW 52602,N'Migration 025 must be recorded before migration 026.',1;
IF OBJECT_ID(N'content.files',N'U') IS NULL
   OR OBJECT_ID(N'security.users',N'U') IS NULL
   OR OBJECT_ID(N'security.permissions',N'U') IS NULL
  THROW 52603,N'The guide-builder prerequisites are missing.',1;

BEGIN TRANSACTION;

IF OBJECT_ID(N'content.guide_sessions',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_sessions
  (
    guide_session_key          BIGINT IDENTITY(1,1) NOT NULL,
    source_id                  NVARCHAR(150) NOT NULL,
    owner_user_key             BIGINT NOT NULL,
    title                      NVARCHAR(240) NULL,
    original_video_name        NVARCHAR(260) NOT NULL,
    declared_mime_type         NVARCHAR(160) NOT NULL,
    declared_byte_count        BIGINT NOT NULL,
    upload_storage_provider    VARCHAR(30) NULL,
    upload_storage_container   NVARCHAR(100) NULL,
    upload_blob_name           NVARCHAR(1024) NULL,
    upload_storage_bucket      NVARCHAR(255) NULL,
    upload_object_key          NVARCHAR(1024) NULL,
    upload_object_etag         NVARCHAR(200) NULL,
    source_file_key            BIGINT NULL,
    status                     VARCHAR(30) NOT NULL,
    current_stage              VARCHAR(30) NOT NULL,
    latest_draft_no            INT NOT NULL CONSTRAINT DF_guide_sessions_draft DEFAULT (0),
    answered_round_count       INT NOT NULL CONSTRAINT DF_guide_sessions_rounds DEFAULT (0),
    finalized_draft_no         INT NULL,
    create_idempotency_key     NVARCHAR(200) NOT NULL,
    upload_complete_idempotency_key NVARCHAR(200) NULL,
    last_regenerate_idempotency_key NVARCHAR(200) NULL,
    last_finalize_idempotency_key NVARCHAR(200) NULL,
    cancel_idempotency_key     NVARCHAR(200) NULL,
    failure_code               NVARCHAR(80) NULL,
    failure_summary            NVARCHAR(1000) NULL,
    created_at                 DATETIME2(3) NOT NULL,
    created_by                 NVARCHAR(150) NOT NULL,
    updated_at                 DATETIME2(3) NOT NULL,
    updated_by                 NVARCHAR(150) NOT NULL,
    completed_at               DATETIME2(3) NULL,
    cancelled_at               DATETIME2(3) NULL,
    deleted_at                 DATETIME2(3) NULL,
    row_version                ROWVERSION NOT NULL,
    CONSTRAINT PK_guide_sessions PRIMARY KEY CLUSTERED (guide_session_key),
    CONSTRAINT UQ_guide_sessions_source_id UNIQUE (source_id),
    CONSTRAINT UQ_guide_sessions_owner_idempotency UNIQUE (owner_user_key,create_idempotency_key),
    CONSTRAINT FK_guide_sessions_owner FOREIGN KEY (owner_user_key) REFERENCES security.users(user_key),
    CONSTRAINT FK_guide_sessions_source_file FOREIGN KEY (source_file_key) REFERENCES content.files(file_key),
    CONSTRAINT CK_guide_sessions_declared_size CHECK (declared_byte_count BETWEEN 1 AND 100000000),
    CONSTRAINT CK_guide_sessions_status CHECK
      (status IN ('upload_pending','queued','processing','review','finalizing','completed','failed','cancelled','deleted')),
    CONSTRAINT CK_guide_sessions_stage CHECK
      (current_stage IN ('ingest','transcription','frame_extraction','vision','draft','questions','reprocess','finalize','completed')),
    CONSTRAINT CK_guide_sessions_counts CHECK
      (latest_draft_no>=0 AND answered_round_count>=0 AND (finalized_draft_no IS NULL OR finalized_draft_no>=1)),
    CONSTRAINT CK_guide_sessions_upload_locator CHECK
    (
      (upload_storage_provider IS NULL AND upload_storage_container IS NULL AND upload_blob_name IS NULL
        AND upload_storage_bucket IS NULL AND upload_object_key IS NULL)
      OR
      (upload_storage_provider='azure_blob' AND upload_storage_container IS NOT NULL AND upload_blob_name IS NOT NULL
        AND upload_storage_bucket IS NULL AND upload_object_key IS NULL)
      OR
      (upload_storage_provider='s3' AND upload_storage_bucket IS NOT NULL AND upload_object_key IS NOT NULL
        AND upload_storage_container IS NULL AND upload_blob_name IS NULL)
    ),
    CONSTRAINT CK_guide_sessions_terminal_dates CHECK
    (
      (status='completed' AND completed_at IS NOT NULL)
      OR (status='deleted')
      OR (status NOT IN ('completed','deleted') AND completed_at IS NULL)
    ),
    CONSTRAINT CK_guide_sessions_cancelled CHECK
    (
      (status='cancelled' AND cancelled_at IS NOT NULL)
      OR (status='deleted')
      OR (status NOT IN ('cancelled','deleted') AND cancelled_at IS NULL)
    ),
    CONSTRAINT CK_guide_sessions_deleted CHECK
    (
      (status='deleted' AND deleted_at IS NOT NULL)
      OR (status<>'deleted' AND deleted_at IS NULL)
    ),
    CONSTRAINT CK_guide_sessions_timestamps CHECK
      (updated_at>=created_at AND (completed_at IS NULL OR completed_at>=created_at)
        AND (cancelled_at IS NULL OR cancelled_at>=created_at) AND (deleted_at IS NULL OR deleted_at>=created_at))
  );
END;

IF COL_LENGTH(N'content.guide_sessions',N'last_regenerate_idempotency_key') IS NULL
  ALTER TABLE content.guide_sessions ADD last_regenerate_idempotency_key NVARCHAR(200) NULL;
IF COL_LENGTH(N'content.guide_sessions',N'last_finalize_idempotency_key') IS NULL
  ALTER TABLE content.guide_sessions ADD last_finalize_idempotency_key NVARCHAR(200) NULL;
IF COL_LENGTH(N'content.guide_sessions',N'cancel_idempotency_key') IS NULL
  ALTER TABLE content.guide_sessions ADD cancel_idempotency_key NVARCHAR(200) NULL;

IF OBJECT_ID(N'content.guide_artifacts',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_artifacts
  (
    guide_artifact_key         BIGINT IDENTITY(1,1) NOT NULL,
    source_id                  NVARCHAR(150) NOT NULL,
    guide_session_key          BIGINT NOT NULL,
    artifact_kind              VARCHAR(40) NOT NULL,
    artifact_version           INT NOT NULL,
    ordinal_no                 INT NOT NULL CONSTRAINT DF_guide_artifacts_ordinal DEFAULT (0),
    file_key                   BIGINT NOT NULL,
    is_current                 BIT NOT NULL,
    technical_metadata_json    NVARCHAR(MAX) NULL,
    created_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_guide_artifacts_created DEFAULT SYSUTCDATETIME(),
    created_by                 NVARCHAR(150) NOT NULL,
    CONSTRAINT PK_guide_artifacts PRIMARY KEY CLUSTERED (guide_artifact_key),
    CONSTRAINT UQ_guide_artifacts_source_id UNIQUE (source_id),
    CONSTRAINT UQ_guide_artifacts_version UNIQUE (guide_session_key,artifact_kind,artifact_version,ordinal_no),
    CONSTRAINT FK_guide_artifacts_session FOREIGN KEY (guide_session_key) REFERENCES content.guide_sessions(guide_session_key),
    CONSTRAINT FK_guide_artifacts_file FOREIGN KEY (file_key) REFERENCES content.files(file_key),
    CONSTRAINT CK_guide_artifacts_kind CHECK
      (artifact_kind IN ('source_video','audio','transcript_json','transcript_text','frame','frame_reading',
        'evidence_bundle','cited_schema','draft_markdown','verification','final_markdown')),
    CONSTRAINT CK_guide_artifacts_numbers CHECK (artifact_version>=1 AND ordinal_no>=0),
    CONSTRAINT CK_guide_artifacts_metadata CHECK (technical_metadata_json IS NULL OR ISJSON(technical_metadata_json)=1)
  );
  CREATE UNIQUE INDEX UX_guide_artifacts_current
    ON content.guide_artifacts(guide_session_key,artifact_kind,ordinal_no)
    WHERE is_current=1;
END;

IF OBJECT_ID(N'content.object_deletion_claims',N'U') IS NULL
BEGIN
  CREATE TABLE content.object_deletion_claims
  (
    object_deletion_claim_key BIGINT IDENTITY(1,1) NOT NULL,
    storage_provider          VARCHAR(30) NOT NULL,
    storage_container         NVARCHAR(100) NULL,
    blob_name                 NVARCHAR(1024) NULL,
    storage_bucket            NVARCHAR(255) NULL,
    object_key                NVARCHAR(1024) NULL,
    claimed_at                DATETIME2(3) NOT NULL
      CONSTRAINT DF_object_deletion_claims_claimed_at DEFAULT SYSUTCDATETIME(),
    claimed_by                NVARCHAR(150) NOT NULL,
    CONSTRAINT PK_object_deletion_claims
      PRIMARY KEY CLUSTERED(object_deletion_claim_key),
    CONSTRAINT CK_object_deletion_claims_provider
      CHECK
      (
        (storage_provider='azure_blob' AND storage_container IS NOT NULL AND blob_name IS NOT NULL
          AND storage_bucket IS NULL AND object_key IS NULL)
        OR
        (storage_provider='s3' AND storage_bucket IS NOT NULL AND object_key IS NOT NULL
          AND storage_container IS NULL AND blob_name IS NULL)
      )
  );
  CREATE UNIQUE INDEX UX_object_deletion_claims_azure
    ON content.object_deletion_claims(storage_container,blob_name)
    WHERE storage_provider='azure_blob';
  CREATE UNIQUE INDEX UX_object_deletion_claims_s3
    ON content.object_deletion_claims(storage_bucket,object_key)
    WHERE storage_provider='s3';
END;

IF OBJECT_ID(N'content.guide_questions',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_questions
  (
    guide_question_key         BIGINT IDENTITY(1,1) NOT NULL,
    source_id                  NVARCHAR(150) NOT NULL,
    guide_session_key          BIGINT NOT NULL,
    round_no                   INT NOT NULL,
    question_no                INT NOT NULL,
    target_field               NVARCHAR(120) NOT NULL,
    question_text              NVARCHAR(2000) NOT NULL,
    question_status            VARCHAR(20) NOT NULL,
    created_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_guide_questions_created DEFAULT SYSUTCDATETIME(),
    created_by                 NVARCHAR(150) NOT NULL,
    CONSTRAINT PK_guide_questions PRIMARY KEY CLUSTERED (guide_question_key),
    CONSTRAINT UQ_guide_questions_source_id UNIQUE (source_id),
    CONSTRAINT UQ_guide_questions_round UNIQUE (guide_session_key,round_no,question_no),
    CONSTRAINT UQ_guide_questions_session_key UNIQUE (guide_session_key,guide_question_key),
    CONSTRAINT FK_guide_questions_session FOREIGN KEY (guide_session_key) REFERENCES content.guide_sessions(guide_session_key),
    CONSTRAINT CK_guide_questions_numbers CHECK (round_no>=1 AND question_no>=1),
    CONSTRAINT CK_guide_questions_status CHECK (question_status IN ('open','answered','superseded'))
  );
END;

IF OBJECT_ID(N'content.guide_answers',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_answers
  (
    guide_answer_key           BIGINT IDENTITY(1,1) NOT NULL,
    source_id                  NVARCHAR(150) NOT NULL,
    guide_session_key          BIGINT NOT NULL,
    guide_question_key         BIGINT NOT NULL,
    answer_round_no            INT NOT NULL,
    answer_text                NVARCHAR(4000) NOT NULL,
    answered_by_user_key       BIGINT NOT NULL,
    answered_at                DATETIME2(3) NOT NULL CONSTRAINT DF_guide_answers_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_guide_answers PRIMARY KEY CLUSTERED (guide_answer_key),
    CONSTRAINT UQ_guide_answers_source_id UNIQUE (source_id),
    CONSTRAINT UQ_guide_answers_round UNIQUE (guide_session_key,answer_round_no,guide_question_key),
    CONSTRAINT FK_guide_answers_question FOREIGN KEY (guide_session_key,guide_question_key)
      REFERENCES content.guide_questions(guide_session_key,guide_question_key),
    CONSTRAINT FK_guide_answers_user FOREIGN KEY (answered_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_guide_answers_round CHECK (answer_round_no>=1 AND LEN(LTRIM(RTRIM(answer_text)))>0)
  );
END;

IF OBJECT_ID(N'content.guide_jobs',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_jobs
  (
    guide_job_key              BIGINT IDENTITY(1,1) NOT NULL,
    source_id                  NVARCHAR(150) NOT NULL,
    guide_session_key          BIGINT NOT NULL,
    job_type                   VARCHAR(30) NOT NULL,
    input_version              INT NOT NULL,
    idempotency_key            NVARCHAR(300) NOT NULL,
    job_status                 VARCHAR(20) NOT NULL,
    active_slot                TINYINT NULL,
    priority                   SMALLINT NOT NULL CONSTRAINT DF_guide_jobs_priority DEFAULT (100),
    attempt_count              INT NOT NULL CONSTRAINT DF_guide_jobs_attempts DEFAULT (0),
    max_attempts               INT NOT NULL CONSTRAINT DF_guide_jobs_max_attempts DEFAULT (5),
    next_attempt_at            DATETIME2(3) NULL,
    claimed_by                 NVARCHAR(150) NULL,
    claim_expires_at           DATETIME2(3) NULL,
    heartbeat_at               DATETIME2(3) NULL,
    failure_code               NVARCHAR(80) NULL,
    failure_summary            NVARCHAR(1000) NULL,
    created_at                 DATETIME2(3) NOT NULL,
    created_by                 NVARCHAR(150) NOT NULL,
    updated_at                 DATETIME2(3) NOT NULL,
    updated_by                 NVARCHAR(150) NOT NULL,
    completed_at               DATETIME2(3) NULL,
    row_version                ROWVERSION NOT NULL,
    CONSTRAINT PK_guide_jobs PRIMARY KEY CLUSTERED (guide_job_key),
    CONSTRAINT UQ_guide_jobs_source_id UNIQUE (source_id),
    CONSTRAINT UQ_guide_jobs_idempotency UNIQUE (idempotency_key),
    CONSTRAINT FK_guide_jobs_session FOREIGN KEY (guide_session_key) REFERENCES content.guide_sessions(guide_session_key),
    CONSTRAINT CK_guide_jobs_type CHECK (job_type IN ('initial_process','reprocess','finalize')),
    CONSTRAINT CK_guide_jobs_status CHECK (job_status IN ('pending','processing','succeeded','failed','cancelled')),
    CONSTRAINT CK_guide_jobs_active CHECK
      ((job_status IN ('pending','processing') AND active_slot=1)
        OR (job_status NOT IN ('pending','processing') AND active_slot IS NULL)),
    CONSTRAINT CK_guide_jobs_attempts CHECK
      (input_version>=0 AND attempt_count>=0 AND max_attempts BETWEEN 1 AND 10 AND attempt_count<=max_attempts)
  );
  CREATE UNIQUE INDEX UX_guide_jobs_one_active
    ON content.guide_jobs(guide_session_key,active_slot)
    WHERE active_slot=1;
END;

IF OBJECT_ID(N'content.guide_job_attempts',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_job_attempts
  (
    guide_job_key              BIGINT NOT NULL,
    attempt_no                 INT NOT NULL,
    worker_id                  NVARCHAR(150) NOT NULL,
    started_at                 DATETIME2(3) NOT NULL,
    completed_at               DATETIME2(3) NULL,
    attempt_status             VARCHAR(20) NOT NULL,
    error_code                 NVARCHAR(80) NULL,
    error_summary              NVARCHAR(1000) NULL,
    metrics_json               NVARCHAR(MAX) NULL,
    CONSTRAINT PK_guide_job_attempts PRIMARY KEY CLUSTERED (guide_job_key,attempt_no),
    CONSTRAINT FK_guide_job_attempts_job FOREIGN KEY (guide_job_key) REFERENCES content.guide_jobs(guide_job_key),
    CONSTRAINT CK_guide_job_attempts_status CHECK (attempt_status IN ('processing','succeeded','failed')),
    CONSTRAINT CK_guide_job_attempts_dates CHECK (completed_at IS NULL OR completed_at>=started_at),
    CONSTRAINT CK_guide_job_attempts_metrics CHECK (metrics_json IS NULL OR ISJSON(metrics_json)=1)
  );
END;

IF OBJECT_ID(N'content.guide_status_events',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_status_events
  (
    guide_status_event_key     BIGINT IDENTITY(1,1) NOT NULL,
    guide_session_key          BIGINT NOT NULL,
    event_no                   INT NOT NULL,
    from_status                VARCHAR(30) NULL,
    to_status                  VARCHAR(30) NOT NULL,
    stage                      VARCHAR(30) NOT NULL,
    reason_code                NVARCHAR(80) NULL,
    occurred_at                DATETIME2(3) NOT NULL CONSTRAINT DF_guide_events_created DEFAULT SYSUTCDATETIME(),
    occurred_by                NVARCHAR(150) NOT NULL,
    CONSTRAINT PK_guide_status_events PRIMARY KEY CLUSTERED (guide_status_event_key),
    CONSTRAINT UQ_guide_status_events_number UNIQUE (guide_session_key,event_no),
    CONSTRAINT FK_guide_status_events_session FOREIGN KEY (guide_session_key) REFERENCES content.guide_sessions(guide_session_key)
  );
END;

IF OBJECT_ID(N'content.guide_ai_runs',N'U') IS NULL
BEGIN
  CREATE TABLE content.guide_ai_runs
  (
    guide_ai_run_key           BIGINT IDENTITY(1,1) NOT NULL,
    guide_session_key          BIGINT NOT NULL,
    guide_job_key              BIGINT NULL,
    operation                  VARCHAR(30) NOT NULL,
    model_id                   NVARCHAR(100) NOT NULL,
    provider_request_id_hash   BINARY(32) NULL,
    run_status                 VARCHAR(20) NOT NULL,
    input_tokens               INT NULL,
    cached_input_tokens        INT NULL,
    output_tokens              INT NULL,
    reasoning_tokens           INT NULL,
    duration_ms                INT NOT NULL,
    error_code                 NVARCHAR(80) NULL,
    created_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_guide_ai_runs_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_guide_ai_runs PRIMARY KEY CLUSTERED (guide_ai_run_key),
    CONSTRAINT FK_guide_ai_runs_session FOREIGN KEY (guide_session_key) REFERENCES content.guide_sessions(guide_session_key),
    CONSTRAINT FK_guide_ai_runs_job FOREIGN KEY (guide_job_key) REFERENCES content.guide_jobs(guide_job_key),
    CONSTRAINT CK_guide_ai_runs_operation CHECK
      (operation IN ('transcription','vision','draft','questions','reprocess','finalize')),
    CONSTRAINT CK_guide_ai_runs_status CHECK (run_status IN ('succeeded','failed')),
    CONSTRAINT CK_guide_ai_runs_metrics CHECK
      (duration_ms>=0 AND (input_tokens IS NULL OR input_tokens>=0)
        AND (cached_input_tokens IS NULL OR cached_input_tokens>=0)
        AND (output_tokens IS NULL OR output_tokens>=0)
        AND (reasoning_tokens IS NULL OR reasoning_tokens>=0))
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'content.guide_sessions') AND name=N'IX_guide_sessions_owner_status')
  CREATE INDEX IX_guide_sessions_owner_status
    ON content.guide_sessions(owner_user_key,status,updated_at DESC,guide_session_key DESC)
    INCLUDE(source_id,title,current_stage,latest_draft_no,answered_round_count);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'content.guide_artifacts') AND name=N'IX_guide_artifacts_lookup')
  CREATE INDEX IX_guide_artifacts_lookup
    ON content.guide_artifacts(guide_session_key,artifact_kind,is_current,artifact_version DESC,ordinal_no)
    INCLUDE(file_key,source_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'content.guide_questions') AND name=N'IX_guide_questions_round')
  CREATE INDEX IX_guide_questions_round
    ON content.guide_questions(guide_session_key,round_no DESC,question_no)
    INCLUDE(source_id,target_field,question_status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'content.guide_jobs') AND name=N'IX_guide_jobs_claim')
  CREATE INDEX IX_guide_jobs_claim
    ON content.guide_jobs(job_status,next_attempt_at,priority,created_at,guide_job_key)
    INCLUDE(guide_session_key,job_type,attempt_count,max_attempts,claim_expires_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'content.guide_status_events') AND name=N'IX_guide_events_session')
  CREATE INDEX IX_guide_events_session
    ON content.guide_status_events(guide_session_key,event_no DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'content.guide_ai_runs') AND name=N'IX_guide_ai_runs_session')
  CREATE INDEX IX_guide_ai_runs_session
    ON content.guide_ai_runs(guide_session_key,created_at DESC,guide_ai_run_key DESC);

DECLARE @guide_permissions TABLE
(
  permission_key NVARCHAR(160) NOT NULL,
  action_key NVARCHAR(80) NOT NULL,
  label NVARCHAR(200) NOT NULL
);
INSERT @guide_permissions(permission_key,action_key,label)
VALUES
  (N'help.guide_builder.view',N'view',N'Ver'),
  (N'help.guide_builder.create',N'create',N'Crear guía'),
  (N'help.guide_builder.download_transcript',N'download_transcript',N'Descargar transcripción'),
  (N'help.guide_builder.regenerate',N'regenerate',N'Regenerar borrador'),
  (N'help.guide_builder.finalize',N'finalize',N'Finalizar guía'),
  (N'help.guide_builder.download_manual',N'download_manual',N'Descargar manual'),
  (N'help.guide_builder.cancel',N'cancel',N'Cancelar'),
  (N'help.guide_builder.view_all',N'view_all',N'Ver todas las sesiones');

UPDATE permission_record
SET module_key=N'help',option_key=N'guide_builder',action_key=source_record.action_key,
    label=source_record.label,description=N'Constructor de guías / '+source_record.label,active=1
FROM security.permissions AS permission_record
JOIN @guide_permissions AS source_record ON source_record.permission_key=permission_record.permission_key;

INSERT security.permissions(permission_key,module_key,option_key,action_key,label,description,active)
SELECT permission_key,N'help',N'guide_builder',action_key,label,N'Constructor de guías / '+label,1
FROM @guide_permissions AS source_record
WHERE NOT EXISTS
(
  SELECT 1 FROM security.permissions AS permission_record
  WHERE permission_record.permission_key=source_record.permission_key
);

INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
SELECT N'super_admin',permission_key,SYSUTCDATETIME(),N'migration_026'
FROM @guide_permissions AS source_record
WHERE NOT EXISTS
(
  SELECT 1 FROM security.role_permissions AS role_permission
  WHERE role_permission.role_id=N'super_admin' AND role_permission.permission_key=source_record.permission_key
);

DENY UPDATE, DELETE ON OBJECT::content.guide_status_events TO portal_runtime;

IF (SELECT COUNT(*) FROM security.permissions WHERE module_key=N'help' AND option_key=N'guide_builder' AND active=1)<>8
  THROW 52604,N'The guide-builder permission contract is incomplete.',1;
IF EXISTS
(
  SELECT 1 FROM @guide_permissions AS expected
  WHERE NOT EXISTS
  (
    SELECT 1 FROM security.role_permissions
    WHERE role_id=N'super_admin' AND permission_key=expected.permission_key
  )
)
  THROW 52605,N'Super Administrador is missing a guide-builder permission.',1;

COMMIT TRANSACTION;

PRINT N'026 complete: guide-builder sessions, artifacts, jobs, history, AI usage, and permissions are available.';
GO
