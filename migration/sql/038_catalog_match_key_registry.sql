/*
  Immutable enrollment for the catalog comparison key. The registry holds
  the pinned vault version identifier and a verifier, never the key itself.
  Enrollment is allowed only before publishing the first revision in an
  environment; numeric version equality cannot certify older evidence.
  No assignments, grants, or external changes are included.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'settings.catalog_source_bindings', N'U') IS NULL
  OR OBJECT_ID(N'core.catalog_customer_source_revisions', N'U') IS NULL
  THROW 53800, N'Install catalog source bindings and revision history before match key enrollment.', 1;

IF OBJECT_ID(N'settings.catalog_match_key_registry', N'U') IS NULL
BEGIN
  CREATE TABLE settings.catalog_match_key_registry
  (
    portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
    match_key_version smallint NOT NULL,
    vault_secret_version binary(16) NOT NULL,
    key_verifier binary(32) NOT NULL,
    enrolled_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_match_key_registry_enrolled DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_catalog_match_key_registry PRIMARY KEY CLUSTERED(portal_environment),
    CONSTRAINT CK_catalog_match_key_registry_environment CHECK (
      (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
      OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
    CONSTRAINT CK_catalog_match_key_registry_version CHECK (match_key_version>0)
  );
END;

IF OBJECT_ID(N'settings.TR_catalog_match_key_registry_immutable', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER settings.TR_catalog_match_key_registry_immutable
    ON settings.catalog_match_key_registry AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted)
        THROW 53801, N''An enrolled catalog match key is immutable.'', 1;

      -- The caller must take the same exclusive transaction lock as the
      -- publisher before writing registry or history rows.
      IF EXISTS (SELECT 1 FROM inserted AS n WHERE
        ISNULL(APPLOCK_MODE(N''public'',N''portal-sag:catalog-customer-publication:''+n.portal_environment,N''Transaction''),N''NoLock'')
          <>N''Exclusive'')
        THROW 53803, N''Catalog match key enrollment requires the publication lock.'', 1;

      -- Lock the checked history while enrolling. Include every source and
      -- revision (even retired bindings or unfinished revisions), not just heads.
      IF EXISTS (
        SELECT 1
        FROM inserted AS n
        JOIN settings.catalog_source_bindings AS b WITH (UPDLOCK,HOLDLOCK)
          ON LOWER(RTRIM(b.portal_environment)) COLLATE Latin1_General_100_BIN2=n.portal_environment
        JOIN core.catalog_customer_source_revisions AS r WITH (UPDLOCK,HOLDLOCK)
          ON r.catalog_source_key=b.catalog_source_key
      )
        THROW 53802, N''Catalog match key enrollment is unavailable after any revision exists in this environment.'', 1;
    END;';

IF OBJECT_ID(N'core.TR_catalog_customer_revision_requires_match_key', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_customer_revision_requires_match_key
    ON core.catalog_customer_source_revisions AFTER INSERT, UPDATE AS
    BEGIN
      SET NOCOUNT ON;
      -- Validate updates too: an unsealed revision cannot be retagged
      -- after passing the initial insert check. Existing history is not enrolled.
      IF EXISTS (
        SELECT 1 FROM inserted AS n
        JOIN settings.catalog_source_bindings AS b WITH (HOLDLOCK) ON b.catalog_source_key=n.catalog_source_key
        LEFT JOIN settings.catalog_match_key_registry AS k WITH (HOLDLOCK)
          ON k.portal_environment=b.portal_environment COLLATE Latin1_General_100_BIN2
        WHERE k.portal_environment IS NULL OR n.match_key_version<>k.match_key_version
          OR DATALENGTH(b.portal_environment)<>DATALENGTH(k.portal_environment)
          OR ISNULL(APPLOCK_MODE(N''public'',N''portal-sag:catalog-customer-publication:''+k.portal_environment,N''Transaction''),N''NoLock'')
            <>N''Exclusive''
      )
        THROW 53804, N''A catalog revision requires the enrolled match key version and publication lock.'', 1;
    END;';
