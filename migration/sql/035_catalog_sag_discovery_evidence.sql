/*
  SAG Admin discovery evidence for the published customer revision.
  These values are catalog display facts only. A host is not a verified
  application deployment or a SQL destination. No Companies metadata,
  credentials, raw URLs, raw JSON, or source document values are stored.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'core.catalog_customer_source_revisions', N'U') IS NULL
  OR OBJECT_ID(N'core.catalog_customer_revision_rows', N'U') IS NULL
  THROW 53501, N'Catalog customer revision schema must be installed before inventory evidence.', 1;

-- Previous seals certify customer presence only; new evidence is an explicit opt-in.
IF COL_LENGTH(N'core.catalog_customer_source_revisions', N'has_sag_inventory_evidence') IS NULL
  ALTER TABLE core.catalog_customer_source_revisions ADD has_sag_inventory_evidence bit NOT NULL
    CONSTRAINT DF_catalog_customer_source_revisions_sag_evidence DEFAULT 0;

IF OBJECT_ID(N'core.catalog_sag_revision_evidence', N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_sag_revision_evidence
  (
    revision_key bigint NOT NULL,
    source_record_id int NOT NULL,
    domain_candidate varchar(253) COLLATE Latin1_General_100_BIN2 NULL,
    environment_kind varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
    license_codes varchar(25) COLLATE Latin1_General_100_BIN2 NULL,
    test_started_on date NULL,
    production_started_on date NULL,
    demo_started_on date NULL,
    CONSTRAINT PK_catalog_sag_revision_evidence PRIMARY KEY CLUSTERED(revision_key,source_record_id),
    CONSTRAINT FK_catalog_sag_revision_evidence_row FOREIGN KEY(revision_key,source_record_id)
      REFERENCES core.catalog_customer_revision_rows(revision_key,source_record_id),
    CONSTRAINT CK_catalog_sag_revision_evidence_domain CHECK (domain_candidate IS NULL
      OR (domain_candidate LIKE '%.%' AND domain_candidate LIKE '%[a-z]%'
        AND domain_candidate LIKE '[a-z0-9]%[a-z0-9]' AND domain_candidate NOT LIKE '%[^a-z0-9.-]%'
        AND domain_candidate NOT LIKE '%..%' AND domain_candidate NOT LIKE '%.-%' AND domain_candidate NOT LIKE '%-.%'
        AND DATALENGTH(domain_candidate)=LEN(domain_candidate))),
    CONSTRAINT CK_catalog_sag_revision_evidence_environment CHECK (environment_kind IN ('test','production','demo','unknown')
      AND DATALENGTH(environment_kind)=LEN(environment_kind)),
    CONSTRAINT CK_catalog_sag_revision_evidence_modules CHECK (license_codes NOT LIKE '%[^A-SU-Z]%'
      AND DATALENGTH(license_codes)=LEN(license_codes)),
    CONSTRAINT CK_catalog_sag_revision_evidence_calendar CHECK (
      (test_started_on IS NULL OR test_started_on>CONVERT(date,'00010101',112)) AND
      (production_started_on IS NULL OR production_started_on>CONVERT(date,'00010101',112)) AND
      (demo_started_on IS NULL OR demo_started_on>CONVERT(date,'00010101',112)))
  );
END;

IF OBJECT_ID(N'core.TR_catalog_sag_revision_evidence_sealed', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_sag_revision_evidence_sealed
    ON core.catalog_sag_revision_evidence AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM core.catalog_customer_source_revisions AS r WITH (UPDLOCK,HOLDLOCK)
        JOIN (SELECT revision_key FROM inserted UNION SELECT revision_key FROM deleted) AS x ON x.revision_key=r.revision_key
        WHERE r.sealed_at IS NOT NULL OR r.source_role<>''sag-admin'' OR r.has_sag_inventory_evidence<>1)
        THROW 53502, N''SAG inventory evidence may only be changed on an eligible unsealed revision.'', 1;
    END;';

IF OBJECT_ID(N'core.TR_catalog_sag_revision_evidence_assert', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_sag_revision_evidence_assert
    ON core.catalog_customer_source_revisions AFTER INSERT, UPDATE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM inserted AS n WHERE n.has_sag_inventory_evidence=1
        AND (n.source_role<>''sag-admin'' OR (n.sealed_at IS NOT NULL AND n.expected_rows<>
          (SELECT COUNT_BIG(*) FROM core.catalog_sag_revision_evidence AS e WHERE e.revision_key=n.revision_key))))
        THROW 53503, N''Cannot seal unverified or incomplete SAG inventory evidence.'', 1;
      IF EXISTS (SELECT 1 FROM inserted AS n INNER JOIN deleted AS o ON o.revision_key=n.revision_key
        WHERE o.has_sag_inventory_evidence=1 AND n.has_sag_inventory_evidence=0)
        THROW 53504, N''SAG inventory evidence assertion cannot be removed.'', 1;
    END;';

IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
  DENY INSERT, UPDATE, DELETE ON OBJECT::core.catalog_sag_revision_evidence TO portal_runtime;
