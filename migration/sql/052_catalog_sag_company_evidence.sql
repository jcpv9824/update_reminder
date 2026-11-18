/* SAG v2 discovery evidence only. No new source activation or connection metadata. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns052 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns052=1 BEGIN TRANSACTION;
  IF DB_NAME() NOT IN(N'PortalSAGWeb',N'PortalSAGWeb-TEST')
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
    THROW 55201,N'Expected Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock052 int;
  EXEC @lock052=sys.sp_getapplock @Resource=N'portal-sag:migration:052:sag-company-evidence',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock052<0 THROW 55202,N'Could not reserve migration 052.',1;
  IF OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U') IS NULL
    OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'has_sag_inventory_evidence') IS NULL
    OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    THROW 55203,N'Install the prerequisite catalog migrations and runtime role first.',1;

  IF COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NULL
    ALTER TABLE core.catalog_customer_source_revisions ADD expected_sag_company_rows int NULL;
  IF OBJECT_ID(N'core.CK_catalog_sag_company_revision_count',N'C') IS NULL
    EXEC(N'ALTER TABLE core.catalog_customer_source_revisions WITH CHECK
      ADD CONSTRAINT CK_catalog_sag_company_revision_count CHECK(expected_sag_company_rows IS NULL
        OR (source_role=''sag-admin'' AND has_sag_inventory_evidence=1 AND expected_sag_company_rows BETWEEN 0 AND 100000
          AND CONVERT(bigint,expected_rows)+expected_sag_company_rows<=100000));');

  IF OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NULL
    CREATE TABLE core.catalog_sag_company_revision_rows (
      revision_key bigint NOT NULL,
      company_record_id int NOT NULL,
      customer_record_id int NULL,
      display_name nvarchar(512) NULL,
      is_available bit NULL,
      CONSTRAINT PK_catalog_sag_company_revision_rows PRIMARY KEY CLUSTERED(revision_key,company_record_id),
      CONSTRAINT FK_catalog_sag_company_revision_parent FOREIGN KEY(revision_key)
        REFERENCES core.catalog_customer_source_revisions(revision_key)
    );

  EXEC(N'CREATE OR ALTER TRIGGER core.TR_catalog_sag_company_revision_rows_guard
    ON core.catalog_sag_company_revision_rows AFTER INSERT,UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 55204,N''Company evidence is append-only.'',1;
      IF EXISTS(SELECT 1 FROM (SELECT DISTINCT revision_key FROM inserted) x
        JOIN core.catalog_customer_source_revisions r WITH (UPDLOCK,HOLDLOCK) ON r.revision_key=x.revision_key
        WHERE r.expected_sag_company_rows IS NULL OR r.sealed_at IS NOT NULL)
        THROW 55205,N''Company evidence requires an eligible unsealed revision.'',1;
    END;');

  EXEC(N'CREATE OR ALTER TRIGGER core.TR_catalog_sag_company_revision_seal
    ON core.catalog_customer_source_revisions AFTER INSERT,UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted o LEFT JOIN inserted n ON n.revision_key=o.revision_key
        WHERE o.expected_sag_company_rows IS NOT NULL AND n.revision_key IS NULL)
        THROW 55209,N''Company-evidence revisions cannot be deleted.'',1;
      IF EXISTS(SELECT 1 FROM inserted n JOIN deleted o ON o.revision_key=n.revision_key
        WHERE n.expected_sag_company_rows<>o.expected_sag_company_rows
          OR (n.expected_sag_company_rows IS NULL AND o.expected_sag_company_rows IS NOT NULL)
          OR (n.expected_sag_company_rows IS NOT NULL AND o.expected_sag_company_rows IS NULL))
        THROW 55206,N''The company evidence count must be declared when creating a revision.'',1;
      IF EXISTS(SELECT 1 FROM inserted n
        JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=n.catalog_source_key
        CROSS APPLY (VALUES(CASE WHEN b.contract_version COLLATE Latin1_General_100_BIN2=''sag_admin_v2''
          AND DATALENGTH(b.contract_version)=12 THEN 1 ELSE 0 END)) contract(is_v2)
        WHERE (n.expected_sag_company_rows IS NOT NULL AND contract.is_v2=0)
          OR (n.sealed_at IS NOT NULL AND contract.is_v2=1 AND n.expected_sag_company_rows IS NULL))
        THROW 55207,N''The revision does not match its source contract.'',1;
      IF EXISTS(SELECT 1 FROM inserted n WHERE n.sealed_at IS NOT NULL AND n.expected_sag_company_rows IS NOT NULL
        AND n.expected_sag_company_rows<>(SELECT COUNT_BIG(*) FROM core.catalog_sag_company_revision_rows c WITH (HOLDLOCK)
          WHERE c.revision_key=n.revision_key))
        THROW 55208,N''Cannot seal incomplete company evidence.'',1;
    END;');

  DENY INSERT, UPDATE, DELETE ON OBJECT::core.catalog_sag_company_revision_rows TO portal_runtime;
  IF @owns052=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns052=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
