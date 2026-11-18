/*
  Additive, service-only catalog snapshots. No sources, users, credentials,
  customer data, or initial revision heads are seeded. No source SQL is changed.

  Loader contract (separate authorized principal, not the HTTP reader): buffer
  a verified consistent read; normalize issuer/type only when independently
  approved; HMAC-SHA256 the exact trimmed document number with the catalog
  environment's protected, domain-separated matching key. Never persist raw
  document values or unkeyed hashes. Reuse customer IDs across refreshes/rotation;
  assign opaque IDs independently from HMACs. Do not overwrite existing mappings.
  In a single transaction, lock the binding/current head, recheck both versions,
  insert an unsealed revision and all rows/scopes, seal against expected counts,
  then move the head. A failed refresh changes only the attempt status; never
  publishes an empty replacement. Scope rows certify complete issuer/type coverage,
  not simply the presence of one record. History retention requires a future,
  explicitly authorized archival path rather than deleting sealed rows in place.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'settings.catalog_source_bindings', N'U') IS NULL
  THROW 53300, N'Apply catalog source bindings before catalog customer snapshots.', 1;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_bindings')
  AND name=N'UX_catalog_source_bindings_typed_key')
  CREATE UNIQUE NONCLUSTERED INDEX UX_catalog_source_bindings_typed_key
    ON settings.catalog_source_bindings(catalog_source_key, source_role);

IF OBJECT_ID(N'settings.catalog_customer_attempt_sequence', N'SO') IS NULL
  CREATE SEQUENCE settings.catalog_customer_attempt_sequence AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE NO CACHE;

IF OBJECT_ID(N'core.catalog_customer_ids', N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_customer_ids
  (
    catalog_customer_key bigint IDENTITY(1,1) NOT NULL,
    customer_id uniqueidentifier NOT NULL CONSTRAINT DF_catalog_customer_ids_id DEFAULT NEWSEQUENTIALID(),
    created_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_customer_ids_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_catalog_customer_ids PRIMARY KEY CLUSTERED(catalog_customer_key),
    CONSTRAINT UQ_catalog_customer_ids_id UNIQUE(customer_id)
  );
END;

IF OBJECT_ID(N'core.catalog_customer_source_revisions', N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_customer_source_revisions
  (
    revision_key bigint IDENTITY(1,1) NOT NULL,
    catalog_source_key bigint NOT NULL,
    source_role varchar(15) NOT NULL,
    binding_version binary(8) NOT NULL,
    profile_version binary(8) NOT NULL,
    match_key_version smallint NOT NULL,
    attempt_ordinal bigint NOT NULL,
    expected_rows int NOT NULL,
    expected_scopes int NOT NULL,
    observed_at datetime2(3) NOT NULL,
    verified_until datetime2(3) NOT NULL,
    sealed_at datetime2(3) NULL,
    CONSTRAINT PK_catalog_customer_source_revisions PRIMARY KEY CLUSTERED(revision_key),
    CONSTRAINT UQ_catalog_customer_source_revisions_source UNIQUE(catalog_source_key, revision_key),
    CONSTRAINT UQ_catalog_customer_source_revisions_kind UNIQUE(revision_key, source_role),
    CONSTRAINT FK_catalog_customer_source_revisions_binding FOREIGN KEY(catalog_source_key, source_role)
      REFERENCES settings.catalog_source_bindings(catalog_source_key, source_role),
    CONSTRAINT UQ_catalog_customer_source_revisions_attempt UNIQUE(attempt_ordinal),
    CONSTRAINT CK_catalog_customer_source_revisions_bounds CHECK (match_key_version > 0 AND attempt_ordinal > 0
      AND expected_rows BETWEEN 0 AND 100000 AND expected_scopes BETWEEN 0 AND 512
      AND (source_role='sag-admin' OR expected_scopes=0)),
    CONSTRAINT CK_catalog_customer_source_revisions_times CHECK (verified_until > observed_at
      AND (sealed_at IS NULL OR sealed_at BETWEEN observed_at AND verified_until))
  );
END;

IF OBJECT_ID(N'core.catalog_customer_revision_rows', N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_customer_revision_rows
  (
    revision_key bigint NOT NULL,
    source_role varchar(15) NOT NULL,
    source_record_id int NOT NULL,
    catalog_customer_key bigint NULL,
    official_name nvarchar(512) NULL,
    active_code char(1) COLLATE Latin1_General_100_BIN2 NULL,
    issuer char(2) COLLATE Latin1_General_100_BIN2 NULL,
    document_type varchar(32) COLLATE Latin1_General_100_BIN2 NULL,
    document_number_token binary(32) NULL,
    CONSTRAINT PK_catalog_customer_revision_rows PRIMARY KEY CLUSTERED(revision_key,source_record_id),
    CONSTRAINT FK_catalog_customer_revision_rows_revision FOREIGN KEY(revision_key,source_role)
      REFERENCES core.catalog_customer_source_revisions(revision_key,source_role),
    CONSTRAINT FK_catalog_customer_revision_rows_customer FOREIGN KEY(catalog_customer_key)
      REFERENCES core.catalog_customer_ids(catalog_customer_key),
    CONSTRAINT CK_catalog_customer_revision_rows_kind CHECK ((source_role='erp-customers' AND catalog_customer_key IS NOT NULL)
           OR (source_role='sag-admin' AND catalog_customer_key IS NULL AND official_name IS NULL AND active_code IS NULL)),
    CONSTRAINT CK_catalog_customer_revision_rows_active CHECK (active_code IN ('S','N')),
    CONSTRAINT CK_catalog_customer_revision_rows_scope CHECK ((issuer IS NULL AND document_type IS NULL)
      OR (issuer IS NOT NULL AND document_type IS NOT NULL AND document_number_token IS NOT NULL
        AND issuer LIKE '[A-Z][A-Z]' AND document_type LIKE '[A-Z0-9]%' AND document_type NOT LIKE '%[^A-Z0-9_-]%')),
    CONSTRAINT CK_catalog_customer_revision_rows_erp_token CHECK (source_role<>'erp-customers'
      OR document_number_token IS NULL OR issuer IS NOT NULL)
  );
END;

IF OBJECT_ID(N'core.catalog_customer_revision_scopes', N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_customer_revision_scopes
  (
    revision_key bigint NOT NULL,
    source_role varchar(15) NOT NULL CONSTRAINT DF_catalog_customer_revision_scopes_role DEFAULT 'sag-admin',
    issuer char(2) COLLATE Latin1_General_100_BIN2 NOT NULL,
    document_type varchar(32) COLLATE Latin1_General_100_BIN2 NOT NULL,
    CONSTRAINT PK_catalog_customer_revision_scopes PRIMARY KEY CLUSTERED(revision_key,issuer,document_type),
    CONSTRAINT FK_catalog_customer_revision_scopes_revision FOREIGN KEY(revision_key,source_role)
      REFERENCES core.catalog_customer_source_revisions(revision_key,source_role),
    CONSTRAINT CK_catalog_customer_revision_scopes_role CHECK (source_role='sag-admin'),
    CONSTRAINT CK_catalog_customer_revision_scopes_labels CHECK (issuer LIKE '[A-Z][A-Z]'
      AND document_type LIKE '[A-Z0-9]%' AND document_type NOT LIKE '%[^A-Z0-9_-]%')
  );
END;

IF OBJECT_ID(N'settings.catalog_customer_revision_heads', N'U') IS NULL
BEGIN
  CREATE TABLE settings.catalog_customer_revision_heads
  (
    catalog_source_key bigint NOT NULL,
    revision_key bigint NULL,
    attempt_status varchar(10) NOT NULL CONSTRAINT DF_catalog_customer_revision_heads_status DEFAULT 'never',
    attempted_at datetime2(3) NULL,
    attempt_ordinal bigint NULL,
    row_version rowversion NOT NULL,
    CONSTRAINT PK_catalog_customer_revision_heads PRIMARY KEY CLUSTERED(catalog_source_key),
    CONSTRAINT FK_catalog_customer_revision_heads_source FOREIGN KEY(catalog_source_key)
      REFERENCES settings.catalog_source_bindings(catalog_source_key),
    CONSTRAINT FK_catalog_customer_revision_heads_revision FOREIGN KEY(catalog_source_key,revision_key)
      REFERENCES core.catalog_customer_source_revisions(catalog_source_key,revision_key),
    CONSTRAINT CK_catalog_customer_revision_heads_attempt CHECK (
       (attempt_status='never' AND revision_key IS NULL AND attempted_at IS NULL AND attempt_ordinal IS NULL)
       OR (attempt_status='failed' AND attempted_at IS NOT NULL AND attempt_ordinal IS NOT NULL AND attempt_ordinal>0)
       OR (attempt_status='succeeded' AND revision_key IS NOT NULL AND attempted_at IS NOT NULL
          AND attempt_ordinal IS NOT NULL AND attempt_ordinal>0))
  );
END;

IF OBJECT_ID(N'core.TR_catalog_customer_ids_immutable', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_customer_ids_immutable
    ON core.catalog_customer_ids AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted) THROW 53307, N''Catalog customer IDs are immutable.'', 1;
    END;';

IF OBJECT_ID(N'core.TR_catalog_customer_source_revision_seal', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_customer_source_revision_seal
    ON core.catalog_customer_source_revisions AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted WHERE sealed_at IS NOT NULL)
        THROW 53301, N''Sealed catalog revisions are immutable.'', 1;
      IF EXISTS (
        SELECT 1 FROM inserted AS n
        JOIN settings.catalog_source_bindings AS b ON b.catalog_source_key=n.catalog_source_key
        JOIN settings.external_database_connections AS p
          ON p.external_database_connection_key=b.external_database_connection_key
        WHERE n.sealed_at IS NOT NULL AND (b.source_state<>''active'' OR p.active<>1 OR p.status<>''active''
          OR p.encrypt_connection<>1 OR p.password_configured<>1 OR b.validated_profile_version IS NULL
          OR b.validated_profile_version<>p.row_version OR n.binding_version<>b.row_version OR n.profile_version<>p.row_version
          OR n.expected_rows<>(SELECT COUNT_BIG(*) FROM core.catalog_customer_revision_rows AS r WHERE r.revision_key=n.revision_key)
          OR n.expected_scopes<>(SELECT COUNT_BIG(*) FROM core.catalog_customer_revision_scopes AS s WHERE s.revision_key=n.revision_key))
      ) THROW 53302, N''Cannot seal an incomplete or uncertified catalog revision.'', 1;
    END;';

IF OBJECT_ID(N'core.TR_catalog_customer_revision_rows_sealed', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_customer_revision_rows_sealed
    ON core.catalog_customer_revision_rows AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM core.catalog_customer_source_revisions AS r WITH (UPDLOCK,HOLDLOCK)
        JOIN (SELECT revision_key FROM inserted UNION SELECT revision_key FROM deleted) AS x ON x.revision_key=r.revision_key
        WHERE r.sealed_at IS NOT NULL)
        THROW 53303, N''Rows of sealed catalog revisions are immutable.'', 1;
    END;';

IF OBJECT_ID(N'core.TR_catalog_customer_revision_scopes_sealed', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_customer_revision_scopes_sealed
    ON core.catalog_customer_revision_scopes AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM core.catalog_customer_source_revisions AS r WITH (UPDLOCK,HOLDLOCK)
        JOIN (SELECT revision_key FROM inserted UNION SELECT revision_key FROM deleted) AS x ON x.revision_key=r.revision_key
        WHERE r.sealed_at IS NOT NULL)
        THROW 53304, N''Scopes of sealed catalog revisions are immutable.'', 1;
    END;';

IF OBJECT_ID(N'settings.TR_catalog_customer_revision_heads_publish', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER settings.TR_catalog_customer_revision_heads_publish
    ON settings.catalog_customer_revision_heads AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted AS o LEFT JOIN inserted AS n ON n.catalog_source_key=o.catalog_source_key
        WHERE n.catalog_source_key IS NULL OR (o.attempt_ordinal IS NOT NULL
          AND (n.attempt_ordinal IS NULL OR n.attempt_ordinal<=o.attempt_ordinal))
          OR (o.revision_key IS NOT NULL AND (n.revision_key IS NULL OR n.revision_key<o.revision_key))
          OR (o.revision_key IS NOT NULL AND n.revision_key=o.revision_key AND n.attempt_status=''succeeded''
               AND (o.attempt_status<>''succeeded'' OR n.attempted_at<>o.attempted_at)))
        THROW 53305, N''Catalog revision heads cannot move backwards or be removed.'', 1;
      IF EXISTS (SELECT 1 FROM inserted AS n
        LEFT JOIN deleted AS o ON o.catalog_source_key=n.catalog_source_key
        JOIN core.catalog_customer_source_revisions AS r ON r.revision_key=n.revision_key
        LEFT JOIN core.catalog_customer_source_revisions AS prior ON prior.revision_key=o.revision_key
        JOIN settings.catalog_source_bindings AS b ON b.catalog_source_key=n.catalog_source_key
        JOIN settings.external_database_connections AS p
          ON p.external_database_connection_key=b.external_database_connection_key
        WHERE r.sealed_at IS NULL OR n.attempted_at<r.sealed_at OR n.attempt_ordinal<r.attempt_ordinal
          OR ((o.revision_key IS NULL OR o.revision_key<>n.revision_key) AND (n.attempt_status<>''succeeded''
            OR b.source_state<>''active'' OR p.active<>1 OR p.status<>''active'' OR p.encrypt_connection<>1
            OR p.password_configured<>1 OR b.validated_profile_version IS NULL OR b.validated_profile_version<>p.row_version
            OR r.binding_version<>b.row_version OR r.profile_version<>p.row_version
            OR n.attempt_ordinal<>r.attempt_ordinal OR (prior.attempt_ordinal IS NOT NULL AND r.attempt_ordinal<=prior.attempt_ordinal)
            OR r.verified_until<=n.attempted_at)))
        THROW 53306, N''Only sealed, current catalog revisions can be published.'', 1;
    END;';

-- HTTP reads these new tables; loading is intentionally a separately authorized role.
-- This does not change privileges on existing tables or the approved SQL owner exception.
IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
BEGIN
  DENY INSERT, UPDATE, DELETE ON OBJECT::core.catalog_customer_ids TO portal_runtime;
  DENY INSERT, UPDATE, DELETE ON OBJECT::core.catalog_customer_source_revisions TO portal_runtime;
  DENY INSERT, UPDATE, DELETE ON OBJECT::core.catalog_customer_revision_rows TO portal_runtime;
  DENY INSERT, UPDATE, DELETE ON OBJECT::core.catalog_customer_revision_scopes TO portal_runtime;
  DENY INSERT, UPDATE, DELETE ON OBJECT::settings.catalog_customer_revision_heads TO portal_runtime;
  DENY UPDATE ON OBJECT::settings.catalog_customer_attempt_sequence TO portal_runtime;
END;
