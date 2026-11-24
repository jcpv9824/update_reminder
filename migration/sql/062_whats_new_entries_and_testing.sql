/* Portal SAG Web - SQL Server 2019 / 062 — DRAFT, NOT APPLIED
   Qué hay de nuevo: entradas, rutas escritas a mano, acciones requeridas,
   adjuntos y archivos (solo localizadores; los bytes viven en SeaweedFS),
   revisiones, rondas de prueba, checklist, notas, hallazgos, anulaciones,
   participantes, bitácora, texto para clientes e idempotencia.

   - La historia es de solo inserción: disparadores con THROW (efectivos aunque
     el usuario sea db_owner) más DENY UPDATE, DELETE a portal_runtime.
   - El desarrollador de la entrada es siempre quien la creó: un disparador
     impide cambiarlo.
   - Crea objetos vacíos; no modifica tablas existentes. Reejecutable. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 53300,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 53301,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
  THROW 53305,N'Compatibility level 150 is required.',1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL
  THROW 53302,N'Migration history is missing.',1;
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='061' AND succeeded=1)
  THROW 53303,N'Run migration 061 first.',1;
IF SCHEMA_ID(N'whats_new') IS NULL OR OBJECT_ID(N'whats_new.action_catalog',N'U') IS NULL
   OR OBJECT_ID(N'content.files',N'U') IS NULL OR OBJECT_ID(N'security.users',N'U') IS NULL
  THROW 53304,N'The whats_new prerequisites are missing.',1;
GO

IF OBJECT_ID(N'whats_new.entry_number_seq',N'SO') IS NULL
  CREATE SEQUENCE whats_new.entry_number_seq AS INT START WITH 1 INCREMENT BY 1 NO CYCLE CACHE 20;
GO

BEGIN TRY
BEGIN TRANSACTION;

IF OBJECT_ID(N'whats_new.entries',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entries
  (
    entry_key                BIGINT IDENTITY(1,1) NOT NULL,
    source_id                NVARCHAR(150) NOT NULL,
    entry_number             INT NOT NULL CONSTRAINT DF_entries_number DEFAULT (NEXT VALUE FOR whats_new.entry_number_seq),
    status                   VARCHAR(20) NOT NULL,
    entry_type               VARCHAR(20) NULL,
    system_code              VARCHAR(20) NULL,
    what_changed_json        NVARCHAR(MAX) NULL,
    what_changed_text        NVARCHAR(MAX) NULL,
    what_changed_summary     NVARCHAR(300) NULL,
    primary_route_text       NVARCHAR(700) NULL,
    route_search_text        NVARCHAR(4000) NULL,
    client_name_text         NVARCHAR(200) NULL,
    initial_tester_user_key  BIGINT NULL,
    developer_user_key       BIGINT NOT NULL,
    last_edited_by_user_key  BIGINT NOT NULL,
    current_revision_no      INT NOT NULL CONSTRAINT DF_entries_revision DEFAULT (0),
    current_round_no         INT NOT NULL CONSTRAINT DF_entries_round DEFAULT (0),
    last_finding_no          INT NOT NULL CONSTRAINT DF_entries_finding DEFAULT (0),
    open_findings_count      INT NOT NULL CONSTRAINT DF_entries_open_findings DEFAULT (0),
    first_published_at       DATETIME2(3) NULL,
    last_published_at        DATETIME2(3) NULL,
    result_at                DATETIME2(3) NULL,
    approved_at              DATETIME2(3) NULL,
    release_month            CHAR(7) NULL,
    archived_at              DATETIME2(3) NULL,
    deleted_at               DATETIME2(3) NULL,
    created_at               DATETIME2(3) NOT NULL,
    created_by               NVARCHAR(150) NOT NULL,
    updated_at               DATETIME2(3) NOT NULL,
    updated_by               NVARCHAR(150) NOT NULL,
    row_version              ROWVERSION NOT NULL,
    CONSTRAINT PK_entries PRIMARY KEY CLUSTERED (entry_key),
    CONSTRAINT UQ_entries_source_id UNIQUE (source_id),
    CONSTRAINT UQ_entries_number UNIQUE (entry_number),
    CONSTRAINT FK_entries_initial_tester FOREIGN KEY (initial_tester_user_key) REFERENCES security.users(user_key),
    CONSTRAINT FK_entries_developer FOREIGN KEY (developer_user_key) REFERENCES security.users(user_key),
    CONSTRAINT FK_entries_last_editor FOREIGN KEY (last_edited_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_entries_status CHECK
      (status IN ('borrador','sin_probar','en_pruebas','probado','fallida','archivada','eliminada')),
    CONSTRAINT CK_entries_type CHECK
      (entry_type IS NULL OR entry_type IN ('nuevo','mejora','regla_negocio','sp_critico','rediseno')),
    CONSTRAINT CK_entries_system CHECK (system_code IS NULL OR system_code IN ('sag_web','sag_clasico')),
    CONSTRAINT CK_entries_json CHECK (what_changed_json IS NULL OR (ISJSON(what_changed_json)=1 AND DATALENGTH(what_changed_json)<=400000)),
    CONSTRAINT CK_entries_complete CHECK
      (status IN ('borrador','eliminada')
        OR (entry_type IS NOT NULL AND system_code IS NOT NULL AND what_changed_json IS NOT NULL
            AND current_revision_no>=1 AND first_published_at IS NOT NULL AND primary_route_text IS NOT NULL)),
    CONSTRAINT CK_entries_nuevo_fields CHECK
      (entry_type='nuevo' OR (client_name_text IS NULL AND initial_tester_user_key IS NULL)),
    CONSTRAINT CK_entries_nuevo_publish CHECK
      (entry_type IS NULL OR entry_type<>'nuevo' OR status IN ('borrador','eliminada') OR initial_tester_user_key IS NOT NULL),
    CONSTRAINT CK_entries_approved CHECK
      ((status IN ('probado','archivada') AND approved_at IS NOT NULL AND release_month IS NOT NULL)
        OR (status NOT IN ('probado','archivada') AND approved_at IS NULL AND release_month IS NULL)),
    CONSTRAINT CK_entries_release_month CHECK
      (release_month IS NULL OR release_month LIKE '[2-9][0-9][0-9][0-9]-[01][0-9]'),
    CONSTRAINT CK_entries_archived CHECK
      ((status='archivada' AND archived_at IS NOT NULL) OR (status<>'archivada' AND archived_at IS NULL)),
    CONSTRAINT CK_entries_deleted CHECK
      ((status='eliminada' AND deleted_at IS NOT NULL) OR (status<>'eliminada' AND deleted_at IS NULL)),
    CONSTRAINT CK_entries_counts CHECK
      (current_revision_no>=0 AND current_round_no>=0 AND last_finding_no>=0
        AND open_findings_count BETWEEN 0 AND last_finding_no)
  );
END;

IF OBJECT_ID(N'whats_new.entry_routes',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entry_routes
  (
    entry_route_key BIGINT IDENTITY(1,1) NOT NULL,
    entry_key       BIGINT NOT NULL,
    route_no        TINYINT NOT NULL,
    via_code        VARCHAR(20) NOT NULL,
    level_count     TINYINT NOT NULL,
    display_text    NVARCHAR(700) NOT NULL,
    route_hash      BINARY(32) NOT NULL,
    CONSTRAINT PK_entry_routes PRIMARY KEY CLUSTERED (entry_route_key),
    CONSTRAINT UQ_entry_routes_number UNIQUE (entry_key,route_no),
    CONSTRAINT UQ_entry_routes_hash UNIQUE (entry_key,route_hash),
    CONSTRAINT FK_entry_routes_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT CK_entry_routes_number CHECK (route_no BETWEEN 1 AND 10),
    CONSTRAINT CK_entry_routes_via CHECK (via_code IN ('barra_navegacion','barra_lateral')),
    CONSTRAINT CK_entry_routes_levels CHECK (level_count BETWEEN 2 AND 5)
  );
END;

IF OBJECT_ID(N'whats_new.entry_route_levels',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entry_route_levels
  (
    entry_route_key BIGINT NOT NULL,
    level_no        TINYINT NOT NULL,
    level_kind      VARCHAR(10) NOT NULL,
    label           NVARCHAR(120) NOT NULL,
    CONSTRAINT PK_entry_route_levels PRIMARY KEY CLUSTERED (entry_route_key,level_no),
    CONSTRAINT FK_entry_route_levels_route FOREIGN KEY (entry_route_key) REFERENCES whats_new.entry_routes(entry_route_key),
    CONSTRAINT CK_entry_route_levels_no CHECK (level_no BETWEEN 1 AND 5),
    CONSTRAINT CK_entry_route_levels_kind CHECK
      ((level_no=1 AND level_kind='via') OR (level_no>1 AND level_kind IN ('submenu','opcion'))),
    CONSTRAINT CK_entry_route_levels_label CHECK (label NOT LIKE N'%›%' AND label NOT LIKE N'%<%' AND label NOT LIKE N'%>%')
  );
END;

IF OBJECT_ID(N'whats_new.entry_required_actions',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entry_required_actions
  (
    entry_key          BIGINT NOT NULL,
    ordinal            TINYINT NOT NULL,
    action_catalog_key BIGINT NOT NULL,
    label_snapshot     NVARCHAR(120) NOT NULL,
    detail_json        NVARCHAR(MAX) NULL,
    detail_text        NVARCHAR(4000) NULL,
    CONSTRAINT PK_entry_required_actions PRIMARY KEY CLUSTERED (entry_key,ordinal),
    CONSTRAINT UQ_entry_required_actions_action UNIQUE (entry_key,action_catalog_key),
    CONSTRAINT FK_entry_required_actions_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_required_actions_catalog FOREIGN KEY (action_catalog_key) REFERENCES whats_new.action_catalog(action_catalog_key),
    CONSTRAINT CK_entry_required_actions_ordinal CHECK (ordinal BETWEEN 1 AND 10),
    CONSTRAINT CK_entry_required_actions_json CHECK (detail_json IS NULL OR (ISJSON(detail_json)=1 AND DATALENGTH(detail_json)<=40000))
  );
END;

IF OBJECT_ID(N'whats_new.entry_files',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entry_files
  (
    entry_file_key             BIGINT IDENTITY(1,1) NOT NULL,
    public_id                  UNIQUEIDENTIFIER NOT NULL,
    entry_key                  BIGINT NOT NULL,
    target                     VARCHAR(20) NOT NULL,
    target_ref                 NVARCHAR(60) NULL,
    kind                       VARCHAR(10) NOT NULL,
    original_name              NVARCHAR(260) NOT NULL,
    mime_type                  NVARCHAR(160) NOT NULL,
    declared_byte_count        BIGINT NOT NULL,
    declared_sha256            BINARY(32) NOT NULL,
    status                     VARCHAR(20) NOT NULL,
    storage_provider           VARCHAR(30) NOT NULL CONSTRAINT DF_entry_files_provider DEFAULT ('s3'),
    storage_bucket             NVARCHAR(255) NULL,
    temp_object_key            NVARCHAR(1024) NULL,
    object_key                 NVARCHAR(1024) NULL,
    file_key                   BIGINT NULL,
    copied_from_entry_file_key BIGINT NULL,
    rejection_code             VARCHAR(40) NULL,
    uploaded_by_user_key       BIGINT NOT NULL,
    authorize_idempotency_key  NVARCHAR(200) NOT NULL,
    created_at                 DATETIME2(3) NOT NULL,
    expires_at                 DATETIME2(3) NOT NULL,
    verified_at                DATETIME2(3) NULL,
    promoted_at                DATETIME2(3) NULL,
    row_version                ROWVERSION NOT NULL,
    CONSTRAINT PK_entry_files PRIMARY KEY CLUSTERED (entry_file_key),
    CONSTRAINT UQ_entry_files_public_id UNIQUE (public_id),
    CONSTRAINT UQ_entry_files_authorize UNIQUE (uploaded_by_user_key,authorize_idempotency_key),
    CONSTRAINT FK_entry_files_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_files_file FOREIGN KEY (file_key) REFERENCES content.files(file_key),
    CONSTRAINT FK_entry_files_copied FOREIGN KEY (copied_from_entry_file_key) REFERENCES whats_new.entry_files(entry_file_key),
    CONSTRAINT FK_entry_files_uploader FOREIGN KEY (uploaded_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_entry_files_target CHECK
      (target IN ('que_cambio','accion','reglas_negocio','video','nota','hallazgo','texto_cliente')),
    CONSTRAINT CK_entry_files_kind CHECK (kind IN ('imagen','documento','video')),
    CONSTRAINT CK_entry_files_status CHECK (status IN ('pendiente','verificada','en_entrada','rechazada','vencida')),
    CONSTRAINT CK_entry_files_provider CHECK (storage_provider='s3'),
    CONSTRAINT CK_entry_files_bytes CHECK (declared_byte_count BETWEEN 1 AND 100000000),
    CONSTRAINT CK_entry_files_promoted CHECK
      ((status='en_entrada' AND file_key IS NOT NULL AND object_key IS NOT NULL AND promoted_at IS NOT NULL)
        OR (status<>'en_entrada' AND file_key IS NULL))
  );
END;

IF OBJECT_ID(N'whats_new.entry_attachments',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entry_attachments
  (
    entry_key        BIGINT NOT NULL,
    attachment_group VARCHAR(20) NOT NULL,
    ordinal          TINYINT NOT NULL,
    item_kind        VARCHAR(10) NOT NULL,
    entry_file_key   BIGINT NULL,
    link_url         NVARCHAR(2000) NULL,
    link_label       NVARCHAR(200) NULL,
    CONSTRAINT PK_entry_attachments PRIMARY KEY CLUSTERED (entry_key,attachment_group,ordinal),
    CONSTRAINT FK_entry_attachments_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_attachments_file FOREIGN KEY (entry_file_key) REFERENCES whats_new.entry_files(entry_file_key),
    CONSTRAINT CK_entry_attachments_group CHECK (attachment_group IN ('reglas_negocio','video')),
    CONSTRAINT CK_entry_attachments_ordinal CHECK (ordinal BETWEEN 1 AND 10),
    CONSTRAINT CK_entry_attachments_kind CHECK
      ((item_kind='archivo' AND entry_file_key IS NOT NULL AND link_url IS NULL)
        OR (item_kind='enlace' AND entry_file_key IS NULL AND link_url LIKE N'https://_%'))
  );
END;

IF OBJECT_ID(N'whats_new.entry_revisions',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entry_revisions
  (
    entry_revision_key     BIGINT IDENTITY(1,1) NOT NULL,
    entry_key              BIGINT NOT NULL,
    revision_no            INT NOT NULL,
    revision_kind          VARCHAR(20) NOT NULL,
    what_changed_json      NVARCHAR(MAX) NOT NULL,
    required_actions_json  NVARCHAR(MAX) NOT NULL,
    routes_json            NVARCHAR(MAX) NOT NULL,
    correction_note_json   NVARCHAR(MAX) NULL,
    correction_note_text   NVARCHAR(MAX) NULL,
    on_behalf              BIT NOT NULL CONSTRAINT DF_entry_revisions_behalf DEFAULT (0),
    published_at           DATETIME2(3) NOT NULL,
    published_by_user_key  BIGINT NOT NULL,
    CONSTRAINT PK_entry_revisions PRIMARY KEY CLUSTERED (entry_revision_key),
    CONSTRAINT UQ_entry_revisions_number UNIQUE (entry_key,revision_no),
    CONSTRAINT FK_entry_revisions_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_revisions_user FOREIGN KEY (published_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_entry_revisions_kind CHECK (revision_kind IN ('publicacion','correccion')),
    CONSTRAINT CK_entry_revisions_json CHECK
      (ISJSON(what_changed_json)=1 AND ISJSON(required_actions_json)=1 AND ISJSON(routes_json)=1
        AND (correction_note_json IS NULL OR ISJSON(correction_note_json)=1)),
    CONSTRAINT CK_entry_revisions_note CHECK (revision_kind<>'correccion' OR correction_note_json IS NOT NULL),
    CONSTRAINT CK_entry_revisions_number CHECK (revision_no>=1)
  );
END;

IF OBJECT_ID(N'whats_new.entry_contributors',N'U') IS NULL
BEGIN
  /* Quienes crearon, editaron, publicaron o corrigieron la entrada: ninguno puede probarla. */
  CREATE TABLE whats_new.entry_contributors
  (
    entry_key          BIGINT NOT NULL,
    user_key           BIGINT NOT NULL,
    first_contribution VARCHAR(20) NOT NULL,
    first_at           DATETIME2(3) NOT NULL,
    CONSTRAINT PK_entry_contributors PRIMARY KEY CLUSTERED (entry_key,user_key),
    CONSTRAINT FK_entry_contributors_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_contributors_user FOREIGN KEY (user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_entry_contributors_kind CHECK (first_contribution IN ('creo','edito','publico','corrigio'))
  );
END;

IF OBJECT_ID(N'whats_new.entry_participants',N'U') IS NULL
BEGIN
  /* Equipo de la entrada para el reporte: el desarrollador y todos los asesores
     que tomaron una ronda (incluidos quienes la soltaron o la marcaron fallida). */
  CREATE TABLE whats_new.entry_participants
  (
    entry_key        BIGINT NOT NULL,
    user_key         BIGINT NOT NULL,
    participant_role VARCHAR(20) NOT NULL,
    first_round_no   INT NULL,
    first_at         DATETIME2(3) NOT NULL,
    CONSTRAINT PK_entry_participants PRIMARY KEY CLUSTERED (entry_key,user_key,participant_role),
    CONSTRAINT FK_entry_participants_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_participants_user FOREIGN KEY (user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_entry_participants_role CHECK (participant_role IN ('desarrollador','asesor')),
    CONSTRAINT CK_entry_participants_round CHECK
      ((participant_role='asesor' AND first_round_no>=1) OR (participant_role='desarrollador' AND first_round_no IS NULL))
  );
END;

IF OBJECT_ID(N'whats_new.test_rounds',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.test_rounds
  (
    round_key           BIGINT IDENTITY(1,1) NOT NULL,
    source_id           NVARCHAR(150) NOT NULL,
    entry_key           BIGINT NOT NULL,
    round_no            INT NOT NULL,
    revision_no         INT NOT NULL,
    status              VARCHAR(10) NOT NULL,
    holder_user_key     BIGINT NOT NULL,
    taken_at            DATETIME2(3) NOT NULL,
    note_draft_json     NVARCHAR(MAX) NULL,
    closed_at           DATETIME2(3) NULL,
    closed_by_user_key  BIGINT NULL,
    close_reason        VARCHAR(20) NULL,
    close_reason_text   NVARCHAR(500) NULL,
    row_version         ROWVERSION NOT NULL,
    CONSTRAINT PK_test_rounds PRIMARY KEY CLUSTERED (round_key),
    CONSTRAINT UQ_test_rounds_source_id UNIQUE (source_id),
    CONSTRAINT UQ_test_rounds_number UNIQUE (entry_key,round_no),
    CONSTRAINT FK_test_rounds_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_test_rounds_revision FOREIGN KEY (entry_key,revision_no) REFERENCES whats_new.entry_revisions(entry_key,revision_no),
    CONSTRAINT FK_test_rounds_holder FOREIGN KEY (holder_user_key) REFERENCES security.users(user_key),
    CONSTRAINT FK_test_rounds_closer FOREIGN KEY (closed_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_test_rounds_status CHECK (status IN ('tomada','soltada','fallida','probada')),
    CONSTRAINT CK_test_rounds_note_draft CHECK (note_draft_json IS NULL OR (ISJSON(note_draft_json)=1 AND DATALENGTH(note_draft_json)<=200000)),
    CONSTRAINT CK_test_rounds_closed CHECK
      ((status='tomada' AND closed_at IS NULL AND closed_by_user_key IS NULL AND close_reason IS NULL)
        OR (status<>'tomada' AND closed_at IS NOT NULL AND closed_by_user_key IS NOT NULL AND close_reason IS NOT NULL)),
    CONSTRAINT CK_test_rounds_reason CHECK (close_reason IS NULL OR close_reason IN ('normal','forzada')),
    CONSTRAINT CK_test_rounds_forced CHECK
      (close_reason IS NULL OR close_reason<>'forzada' OR (status='soltada' AND close_reason_text IS NOT NULL))
  );
  CREATE UNIQUE INDEX UX_test_rounds_one_open ON whats_new.test_rounds(entry_key) WHERE status='tomada';
END;

IF OBJECT_ID(N'whats_new.round_checklist_items',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.round_checklist_items
  (
    round_key           BIGINT NOT NULL,
    item_no             TINYINT NOT NULL,
    label_snapshot      NVARCHAR(120) NOT NULL,
    checked             BIT NOT NULL CONSTRAINT DF_round_checklist_checked DEFAULT (0),
    checked_at          DATETIME2(3) NULL,
    checked_by_user_key BIGINT NULL,
    CONSTRAINT PK_round_checklist_items PRIMARY KEY CLUSTERED (round_key,item_no),
    CONSTRAINT FK_round_checklist_round FOREIGN KEY (round_key) REFERENCES whats_new.test_rounds(round_key),
    CONSTRAINT FK_round_checklist_user FOREIGN KEY (checked_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_round_checklist_checked CHECK
      ((checked=1 AND checked_at IS NOT NULL AND checked_by_user_key IS NOT NULL)
        OR (checked=0 AND checked_at IS NULL AND checked_by_user_key IS NULL))
  );
END;

IF OBJECT_ID(N'whats_new.round_notes',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.round_notes
  (
    round_note_key      BIGINT IDENTITY(1,1) NOT NULL,
    source_id           NVARCHAR(150) NOT NULL,
    round_key           BIGINT NOT NULL,
    entry_key           BIGINT NOT NULL,
    body_json           NVARCHAR(MAX) NOT NULL,
    body_text           NVARCHAR(MAX) NOT NULL,
    created_by_user_key BIGINT NOT NULL,
    created_at          DATETIME2(3) NOT NULL,
    CONSTRAINT PK_round_notes PRIMARY KEY CLUSTERED (round_note_key),
    CONSTRAINT UQ_round_notes_source_id UNIQUE (source_id),
    CONSTRAINT FK_round_notes_round FOREIGN KEY (round_key) REFERENCES whats_new.test_rounds(round_key),
    CONSTRAINT FK_round_notes_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_round_notes_user FOREIGN KEY (created_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_round_notes_json CHECK (ISJSON(body_json)=1 AND DATALENGTH(body_json)<=200000)
  );
END;

IF OBJECT_ID(N'whats_new.findings',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.findings
  (
    finding_key         BIGINT IDENTITY(1,1) NOT NULL,
    source_id           NVARCHAR(150) NOT NULL,
    entry_key           BIGINT NOT NULL,
    round_key           BIGINT NOT NULL,
    finding_no          INT NOT NULL,
    body_json           NVARCHAR(MAX) NOT NULL,
    body_text           NVARCHAR(MAX) NOT NULL,
    created_by_user_key BIGINT NOT NULL,
    created_at          DATETIME2(3) NOT NULL,
    CONSTRAINT PK_findings PRIMARY KEY CLUSTERED (finding_key),
    CONSTRAINT UQ_findings_source_id UNIQUE (source_id),
    CONSTRAINT UQ_findings_number UNIQUE (entry_key,finding_no),
    CONSTRAINT FK_findings_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_findings_round FOREIGN KEY (round_key) REFERENCES whats_new.test_rounds(round_key),
    CONSTRAINT FK_findings_user FOREIGN KEY (created_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_findings_json CHECK (ISJSON(body_json)=1 AND DATALENGTH(body_json)<=200000),
    CONSTRAINT CK_findings_number CHECK (finding_no>=1)
  );
END;

IF OBJECT_ID(N'whats_new.finding_annulments',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.finding_annulments
  (
    finding_key          BIGINT NOT NULL,
    reason_text          NVARCHAR(500) NOT NULL,
    annulled_by_user_key BIGINT NOT NULL,
    annulled_at          DATETIME2(3) NOT NULL,
    CONSTRAINT PK_finding_annulments PRIMARY KEY CLUSTERED (finding_key),
    CONSTRAINT FK_finding_annulments_finding FOREIGN KEY (finding_key) REFERENCES whats_new.findings(finding_key),
    CONSTRAINT FK_finding_annulments_user FOREIGN KEY (annulled_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_finding_annulments_reason CHECK (LEN(LTRIM(RTRIM(reason_text)))>=10)
  );
END;

IF OBJECT_ID(N'whats_new.entry_log',N'U') IS NULL
BEGIN
  /* Bitácora: cada acción, con quién y cuándo. Solo inserción. Sin texto enriquecido. */
  CREATE TABLE whats_new.entry_log
  (
    entry_log_key        BIGINT IDENTITY(1,1) NOT NULL,
    entry_key            BIGINT NOT NULL,
    log_no               INT NOT NULL,
    action               VARCHAR(40) NOT NULL,
    from_status          VARCHAR(20) NULL,
    to_status            VARCHAR(20) NULL,
    round_no             INT NULL,
    reason_text          NVARCHAR(500) NULL,
    detail_json          NVARCHAR(1000) NULL,
    occurred_at          DATETIME2(3) NOT NULL,
    occurred_by_user_key BIGINT NOT NULL,
    CONSTRAINT PK_entry_log PRIMARY KEY CLUSTERED (entry_log_key),
    CONSTRAINT UQ_entry_log_number UNIQUE (entry_key,log_no),
    CONSTRAINT FK_entry_log_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_log_user FOREIGN KEY (occurred_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_entry_log_action CHECK (action IN
      ('crear','editar_borrador','publicar','corregir','corregir_en_nombre','eliminar','tomar','soltar',
       'forzar_soltar','checklist','registrar_nota','registrar_hallazgo','anular_hallazgo','marcar_probado',
       'marcar_fallida','texto_clientes','archivar','reporte_enviado')),
    CONSTRAINT CK_entry_log_detail CHECK (detail_json IS NULL OR ISJSON(detail_json)=1)
  );
END;

IF OBJECT_ID(N'whats_new.entry_client_texts',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.entry_client_texts
  (
    entry_key           BIGINT NOT NULL,
    public_id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_entry_client_texts_public DEFAULT NEWID(),
    show_to_clients     BIT NOT NULL CONSTRAINT DF_entry_client_texts_show DEFAULT (0),
    title               NVARCHAR(120) NULL,
    body_json           NVARCHAR(MAX) NULL,
    body_text           NVARCHAR(MAX) NULL,
    first_shown_at      DATETIME2(3) NULL,
    updated_at          DATETIME2(3) NOT NULL,
    updated_by_user_key BIGINT NOT NULL,
    row_version         ROWVERSION NOT NULL,
    CONSTRAINT PK_entry_client_texts PRIMARY KEY CLUSTERED (entry_key),
    CONSTRAINT UQ_entry_client_texts_public UNIQUE (public_id),
    CONSTRAINT FK_entry_client_texts_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT FK_entry_client_texts_user FOREIGN KEY (updated_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_entry_client_texts_json CHECK (body_json IS NULL OR (ISJSON(body_json)=1 AND DATALENGTH(body_json)<=100000)),
    CONSTRAINT CK_entry_client_texts_complete CHECK
      (show_to_clients=0 OR (title IS NOT NULL AND LEN(LTRIM(RTRIM(title)))>0 AND body_json IS NOT NULL))
  );
END;

IF OBJECT_ID(N'whats_new.idempotency_keys',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.idempotency_keys
  (
    idempotency_record_key BIGINT IDENTITY(1,1) NOT NULL,
    actor_user_key         BIGINT NOT NULL,
    operation              VARCHAR(40) NOT NULL,
    idempotency_key        NVARCHAR(200) NOT NULL,
    request_sha256         BINARY(32) NOT NULL,
    entry_key              BIGINT NULL,
    response_status        SMALLINT NOT NULL,
    response_json          NVARCHAR(MAX) NOT NULL,
    created_at             DATETIME2(3) NOT NULL,
    expires_at             DATETIME2(3) NOT NULL,
    CONSTRAINT PK_whats_new_idempotency PRIMARY KEY CLUSTERED (idempotency_record_key),
    CONSTRAINT UQ_whats_new_idempotency UNIQUE (actor_user_key,operation,idempotency_key),
    CONSTRAINT FK_whats_new_idempotency_actor FOREIGN KEY (actor_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_whats_new_idempotency_json CHECK (ISJSON(response_json)=1),
    CONSTRAINT CK_whats_new_idempotency_expiry CHECK (expires_at>created_at)
  );
END;

/* Índices para las pestañas, Mis entradas y la búsqueda. */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.entries') AND name=N'IX_entries_queue')
  CREATE INDEX IX_entries_queue ON whats_new.entries(status,last_published_at DESC,entry_key DESC)
    INCLUDE(entry_type,system_code,entry_number,developer_user_key,initial_tester_user_key,open_findings_count,
            what_changed_summary,primary_route_text,source_id,result_at)
    WHERE status IN ('sin_probar','en_pruebas','probado','fallida','archivada');
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.entries') AND name=N'IX_entries_result')
  CREATE INDEX IX_entries_result ON whats_new.entries(status,result_at DESC,entry_key DESC)
    INCLUDE(entry_type,system_code,source_id,approved_at,release_month)
    WHERE result_at IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.entries') AND name=N'IX_entries_developer')
  CREATE INDEX IX_entries_developer ON whats_new.entries(developer_user_key,status,updated_at DESC,entry_key DESC)
    INCLUDE(entry_type,system_code,what_changed_summary,open_findings_count,current_revision_no,primary_route_text);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.entries') AND name=N'IX_entries_initial_tester')
  CREATE INDEX IX_entries_initial_tester ON whats_new.entries(initial_tester_user_key,status)
    WHERE initial_tester_user_key IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.test_rounds') AND name=N'IX_test_rounds_holder')
  CREATE INDEX IX_test_rounds_holder ON whats_new.test_rounds(holder_user_key,status) INCLUDE(entry_key,round_no);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.findings') AND name=N'IX_findings_round')
  CREATE INDEX IX_findings_round ON whats_new.findings(round_key,finding_no);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.round_notes') AND name=N'IX_round_notes_round')
  CREATE INDEX IX_round_notes_round ON whats_new.round_notes(round_key,created_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.entry_files') AND name=N'IX_entry_files_entry')
  CREATE INDEX IX_entry_files_entry ON whats_new.entry_files(entry_key,target,status) INCLUDE(public_id,kind,file_key);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.entry_files') AND name=N'IX_entry_files_sweep')
  CREATE INDEX IX_entry_files_sweep ON whats_new.entry_files(status,expires_at)
    INCLUDE(temp_object_key,storage_bucket) WHERE status IN ('pendiente','verificada');
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.entry_participants') AND name=N'IX_entry_participants_user')
  CREATE INDEX IX_entry_participants_user ON whats_new.entry_participants(user_key,participant_role) INCLUDE(entry_key);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.idempotency_keys') AND name=N'IX_whats_new_idempotency_expiry')
  CREATE INDEX IX_whats_new_idempotency_expiry ON whats_new.idempotency_keys(expires_at);

DENY UPDATE, DELETE ON OBJECT::whats_new.entry_revisions     TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.entry_contributors  TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.entry_participants  TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.round_notes         TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.findings            TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.finding_annulments  TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.entry_log           TO portal_runtime;
DENY DELETE         ON OBJECT::whats_new.entries             TO portal_runtime;
DENY DELETE         ON OBJECT::whats_new.test_rounds         TO portal_runtime;
COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

/* ---------- Disparadores de historia (cada uno en su propio lote) ---------- */
CREATE OR ALTER TRIGGER whats_new.TR_entries_developer_immutable
ON whats_new.entries
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM deleted AS previous_row LEFT JOIN inserted AS current_row
               ON current_row.entry_key=previous_row.entry_key WHERE current_row.entry_key IS NULL)
    THROW 53320,N'whats_new.entries are never deleted; use the eliminada status.',1;
  IF EXISTS (SELECT 1 FROM deleted AS previous_row JOIN inserted AS current_row
               ON current_row.entry_key=previous_row.entry_key
             WHERE current_row.developer_user_key<>previous_row.developer_user_key
                OR current_row.source_id<>previous_row.source_id
                OR current_row.entry_number<>previous_row.entry_number
                OR current_row.created_at<>previous_row.created_at)
    THROW 53321,N'The developer of an entry is always its author and cannot change.',1;
END;
GO

CREATE OR ALTER TRIGGER whats_new.TR_entry_revisions_append_only
ON whats_new.entry_revisions AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53322,N'whats_new.entry_revisions is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_entry_contributors_append_only
ON whats_new.entry_contributors AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53323,N'whats_new.entry_contributors is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_entry_participants_append_only
ON whats_new.entry_participants AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53324,N'whats_new.entry_participants is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_round_notes_append_only
ON whats_new.round_notes AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53325,N'whats_new.round_notes is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_findings_append_only
ON whats_new.findings AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53326,N'whats_new.findings is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_finding_annulments_append_only
ON whats_new.finding_annulments AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53327,N'whats_new.finding_annulments is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_entry_log_append_only
ON whats_new.entry_log AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53328,N'whats_new.entry_log is append-only.',1; END;
GO

/* Una ronda cerrada (soltada, fallida o probada) es inmutable: así la ronda
   soltada conserva su checklist y sus notas (H-10). */
CREATE OR ALTER TRIGGER whats_new.TR_test_rounds_closed_immutable
ON whats_new.test_rounds
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM deleted WHERE status<>'tomada')
    THROW 53330,N'A closed test round is immutable.',1;
  IF EXISTS (SELECT 1 FROM deleted AS previous_row LEFT JOIN inserted AS current_row
               ON current_row.round_key=previous_row.round_key WHERE current_row.round_key IS NULL)
    THROW 53331,N'Test rounds are never deleted.',1;
  IF EXISTS (SELECT 1 FROM deleted AS previous_row JOIN inserted AS current_row
               ON current_row.round_key=previous_row.round_key
             WHERE current_row.holder_user_key<>previous_row.holder_user_key
                OR current_row.round_no<>previous_row.round_no
                OR current_row.entry_key<>previous_row.entry_key)
    THROW 53332,N'The holder and number of a round cannot change.',1;
END;
GO

CREATE OR ALTER TRIGGER whats_new.TR_round_checklist_round_open
ON whats_new.round_checklist_items
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS
  (
    SELECT 1 FROM (SELECT round_key FROM inserted UNION SELECT round_key FROM deleted) AS touched
    JOIN whats_new.test_rounds AS round_row ON round_row.round_key=touched.round_key
    WHERE round_row.status<>'tomada'
  )
    THROW 53333,N'The checklist of a closed round cannot change.',1;
END;
GO

/* SP crítico nunca se muestra a clientes (H-05). */
CREATE OR ALTER TRIGGER whats_new.TR_entry_client_texts_rules
ON whats_new.entry_client_texts
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS
  (
    SELECT 1 FROM inserted AS current_row
    JOIN whats_new.entries AS entry_row ON entry_row.entry_key=current_row.entry_key
    WHERE current_row.show_to_clients=1 AND entry_row.entry_type='sp_critico'
  )
    THROW 53340,N'SP crítico entries are never shown to clients.',1;
  IF EXISTS (SELECT 1 FROM deleted AS previous_row JOIN inserted AS current_row
               ON current_row.entry_key=previous_row.entry_key
             WHERE current_row.public_id<>previous_row.public_id)
    THROW 53341,N'The public identifier of an entry cannot change.',1;
END;
GO

/* ---------- Verificación ---------- */
IF EXISTS
(
  SELECT 1 FROM (VALUES
    (N'whats_new.TR_entries_developer_immutable'),(N'whats_new.TR_entry_revisions_append_only'),
    (N'whats_new.TR_entry_contributors_append_only'),(N'whats_new.TR_entry_participants_append_only'),
    (N'whats_new.TR_round_notes_append_only'),(N'whats_new.TR_findings_append_only'),
    (N'whats_new.TR_finding_annulments_append_only'),(N'whats_new.TR_entry_log_append_only'),
    (N'whats_new.TR_test_rounds_closed_immutable'),(N'whats_new.TR_round_checklist_round_open'),
    (N'whats_new.TR_entry_client_texts_rules')
  ) AS expected(name)
  LEFT JOIN sys.triggers AS trigger_row ON trigger_row.object_id=OBJECT_ID(expected.name)
  WHERE trigger_row.object_id IS NULL OR trigger_row.is_disabled=1
)
  THROW 53305,N'A whats_new history trigger is missing or disabled.',1;
IF EXISTS
(
  SELECT 1 FROM sys.check_constraints
  WHERE SCHEMA_NAME(schema_id)=N'whats_new' AND (is_disabled=1 OR is_not_trusted=1)
)
  THROW 53306,N'A whats_new check constraint is disabled or untrusted.',1;

PRINT N'062 complete: whats_new entries, routes, testing rounds, participants and log are available.';
GO
