/**
 * Shared display-only graph. Parameters are @actorId, @environment,
 * @matchKeyVersion, @sourceIds (server ERP scope JSON), @selectedSourceIds
 * (nullable caller-narrowed ERP scope JSON). Never use this for operational
 * authorization, physical ownership, user linking, or task execution.
 */
export const catalogReconciledIdentitySql = `
SET NOCOUNT ON;
DECLARE @observedNow datetime2(3)=SYSUTCDATETIME(),@observedActor bigint,
  @observedIsSuper bit=0,@observedPartial bit=0,@observedSagReady bit=0;
SELECT @observedActor=u.user_key
FROM security.users u
WHERE u.active=1 AND u.source_id=@actorId
  AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(u.source_id)=DATALENGTH(@actorId);
IF EXISTS(SELECT 1 FROM security.user_roles ur JOIN security.roles role
  ON role.role_id=ur.role_id AND role.active=1 AND role.protected_role=1
  WHERE ur.user_key=@observedActor AND role.role_id COLLATE Latin1_General_100_BIN2=N'super_admin'
    AND DATALENGTH(role.role_id)=22)
  SET @observedIsSuper=1;

DECLARE @observedAllowed table(source_key bigint NOT NULL PRIMARY KEY,
  source_id char(36) COLLATE Latin1_General_100_BIN2 NOT NULL UNIQUE,label nvarchar(150) NOT NULL);
INSERT @observedAllowed
SELECT b.catalog_source_key,LOWER(CONVERT(char(36),b.source_id)),
  COALESCE(NULLIF(LTRIM(RTRIM(p.database_name)),N''),b.display_name)
FROM settings.catalog_source_bindings b
JOIN settings.external_database_connections p ON p.external_database_connection_key=b.external_database_connection_key
WHERE @observedActor IS NOT NULL AND b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
  AND b.source_role='erp-customers' AND b.source_state='active'
  AND EXISTS(SELECT 1 FROM OPENJSON(@sourceIds) ids WHERE TRY_CONVERT(uniqueidentifier,ids.[value])=b.source_id)
  AND (@observedIsSuper=1 OR EXISTS(SELECT 1 FROM security.catalog_source_readers a
    WHERE a.user_key=@observedActor AND a.catalog_source_key=b.catalog_source_key AND a.revoked_at IS NULL));

DECLARE @observedSelected table(source_key bigint NOT NULL PRIMARY KEY);
INSERT @observedSelected
SELECT source_key FROM @observedAllowed a WHERE @selectedSourceIds IS NULL OR EXISTS(
  SELECT 1 FROM OPENJSON(@selectedSourceIds) ids WHERE ids.[value] COLLATE Latin1_General_100_BIN2=a.source_id);

-- Internal collision/hold set deliberately includes ERP sources the actor
-- cannot read. No row, ID, name, source status or token from it is returned.
DECLARE @observedErpBindings table(source_key bigint NOT NULL PRIMARY KEY);
DECLARE @observedHeads table(source_key bigint NOT NULL PRIMARY KEY,revision_key bigint NOT NULL UNIQUE,
  source_role varchar(15),expected_rows int NOT NULL);
INSERT @observedErpBindings
SELECT b.catalog_source_key FROM settings.catalog_source_bindings b
WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
  AND b.source_role='erp-customers' AND b.source_state='active';
INSERT @observedHeads
SELECT b.catalog_source_key,r.revision_key,b.source_role,r.expected_rows
FROM settings.catalog_source_bindings b
JOIN settings.external_database_connections p ON p.external_database_connection_key=b.external_database_connection_key
  AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
  AND b.validated_profile_version=p.row_version
JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key
  AND h.attempt_status='succeeded' AND h.attempted_at<=@observedNow
JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
  AND r.source_role=b.source_role AND r.attempt_ordinal=h.attempt_ordinal AND r.binding_version=b.row_version
  AND r.profile_version=p.row_version AND r.match_key_version=@matchKeyVersion
  AND r.sealed_at<=@observedNow AND r.observed_at<=@observedNow AND r.verified_until>@observedNow
WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
  AND b.source_state='active' AND b.validated_at<=@observedNow
  AND ((b.source_role='erp-customers' AND b.contract_version COLLATE Latin1_General_100_BIN2='erp_v1' AND DATALENGTH(b.contract_version)=6)
    OR (b.source_role='sag-admin' AND b.contract_version COLLATE Latin1_General_100_BIN2='sag_admin_v2'
      AND DATALENGTH(b.contract_version)=12 AND r.has_sag_inventory_evidence=1 AND r.expected_sag_company_rows IS NOT NULL
      AND (SELECT COUNT_BIG(*) FROM core.catalog_sag_customer_directory_rows d WHERE d.revision_key=r.revision_key)=r.expected_rows));

IF EXISTS(SELECT 1 FROM @observedSelected s WHERE NOT EXISTS(
   SELECT 1 FROM @observedHeads h WHERE h.source_key=s.source_key AND h.source_role='erp-customers'))
  SET @observedPartial=1;
IF (SELECT COUNT(*) FROM @observedHeads WHERE source_role='sag-admin')=1
  AND (SELECT COUNT(*) FROM settings.catalog_source_bindings b
    WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
      AND b.source_role='sag-admin' AND b.source_state='active')=1
  SET @observedSagReady=1;

DECLARE @observedErp table(source_key bigint NOT NULL,source_record_id int NOT NULL,customer_key bigint NOT NULL,
  issuer char(2) COLLATE Latin1_General_100_BIN2 NULL,document_type varchar(32) COLLATE Latin1_General_100_BIN2 NULL,
  token binary(32) NULL,official_name nvarchar(512) NULL,active_code char(1) NULL,
  PRIMARY KEY(source_key,source_record_id),INDEX IX_observed_identity_token NONCLUSTERED(issuer,document_type,token),
  INDEX IX_observed_identity_customer NONCLUSTERED(customer_key));
DECLARE @observedSag table(revision_key bigint NOT NULL,source_record_id int NOT NULL,
  source_id char(36) COLLATE Latin1_General_100_BIN2 NOT NULL,
  issuer char(2) COLLATE Latin1_General_100_BIN2 NULL,document_type varchar(32) COLLATE Latin1_General_100_BIN2 NULL,
  token binary(32) NULL,normalized_token binary(32) NULL,display_name nvarchar(512) NULL,
  PRIMARY KEY(revision_key,source_record_id));
DECLARE @observedIdentity table(revision_key bigint NOT NULL,source_record_id int NOT NULL,
  customer_id char(36) COLLATE Latin1_General_100_BIN2 NOT NULL,customer_name nvarchar(512) NOT NULL,
  sag_only bit NOT NULL,customer_key bigint NULL,active_state varchar(10) NOT NULL,
  PRIMARY KEY(revision_key,source_record_id));

IF @observedActor IS NOT NULL AND @observedSagReady=1
  AND (@observedIsSuper=1 OR EXISTS(SELECT 1 FROM @observedSelected))
BEGIN
  INSERT @observedErp
  SELECT TOP (100001) h.source_key,r.source_record_id,r.catalog_customer_key,r.issuer,r.document_type,r.document_number_token,
    NULLIF(LTRIM(RTRIM(r.official_name)),N''),r.active_code
  FROM @observedHeads h JOIN core.catalog_customer_revision_rows r ON r.revision_key=h.revision_key
  WHERE h.source_role='erp-customers' AND r.source_role='erp-customers' AND r.catalog_customer_key IS NOT NULL;
  IF @@ROWCOUNT>100000 THROW 54976,N'Catalog inventory bounds exceeded.',1;

  INSERT @observedSag
  SELECT TOP (100001) h.revision_key,r.source_record_id,LOWER(CONVERT(char(36),b.source_id)),r.issuer,r.document_type,
    r.document_number_token,d.normalized_nit_token,NULLIF(LTRIM(RTRIM(d.display_name)),N'')
  FROM @observedHeads h JOIN settings.catalog_source_bindings b ON b.catalog_source_key=h.source_key
  JOIN core.catalog_customer_revision_rows r ON r.revision_key=h.revision_key AND r.source_role='sag-admin'
  JOIN core.catalog_sag_customer_directory_rows d ON d.revision_key=h.revision_key AND d.source_record_id=r.source_record_id
  WHERE h.source_role='sag-admin';
  IF @@ROWCOUNT>100000 THROW 54976,N'Catalog inventory bounds exceeded.',1;

  DECLARE @observedMatches table(revision_key bigint NOT NULL,source_record_id int NOT NULL,customer_key bigint NOT NULL,
    PRIMARY KEY(revision_key,source_record_id,customer_key));
  INSERT @observedMatches
  SELECT s.revision_key,s.source_record_id,e.customer_key
  FROM @observedSag s JOIN @observedErp e ON e.issuer=s.issuer AND e.document_type=s.document_type AND e.token=s.token
  UNION
  SELECT s.revision_key,s.source_record_id,e.customer_key
  FROM @observedSag s JOIN @observedErp e ON e.issuer='CO' AND e.document_type='NIT' AND e.token=s.normalized_token
  WHERE s.issuer='CO' AND s.document_type='NIT';

  DECLARE @observedLoneMatches table(revision_key bigint NOT NULL,source_record_id int NOT NULL,customer_key bigint NOT NULL,
    PRIMARY KEY(revision_key,source_record_id));
  INSERT @observedLoneMatches
  SELECT revision_key,source_record_id,MIN(customer_key)
  FROM @observedMatches GROUP BY revision_key,source_record_id HAVING COUNT_BIG(*)=1;

  DECLARE @observedCanonical table(customer_key bigint NOT NULL PRIMARY KEY,customer_name nvarchar(512) NOT NULL,
    active_state varchar(10) NOT NULL);
  ;WITH chosen AS (
    SELECT e.customer_key,e.official_name,
      CASE WHEN MAX(CASE WHEN e.active_code='S' THEN 1 ELSE 0 END) OVER(PARTITION BY e.customer_key)=1 THEN 'active'
        WHEN @observedPartial=0 AND MIN(CASE WHEN e.active_code='N' THEN 1 ELSE 0 END) OVER(PARTITION BY e.customer_key)=1 THEN 'inactive'
        ELSE 'unverified' END AS active_state,
      ROW_NUMBER() OVER(PARTITION BY e.customer_key ORDER BY CASE WHEN e.official_name IS NOT NULL THEN 0 ELSE 1 END,
        a.source_id,e.source_record_id) AS position
    FROM @observedErp e JOIN @observedSelected s ON s.source_key=e.source_key
    JOIN @observedAllowed a ON a.source_key=e.source_key
  )
  INSERT @observedCanonical
  SELECT n.customer_key,n.official_name,n.active_state FROM chosen n
  WHERE n.position=1 AND n.official_name IS NOT NULL;

  INSERT @observedIdentity
  SELECT s.revision_key,s.source_record_id,LOWER(CONVERT(char(36),c.customer_id)),n.customer_name,0,l.customer_key,n.active_state
  FROM @observedSag s JOIN @observedLoneMatches l ON l.revision_key=s.revision_key AND l.source_record_id=s.source_record_id
  JOIN @observedCanonical n ON n.customer_key=l.customer_key
  JOIN core.catalog_customer_ids c ON c.catalog_customer_key=l.customer_key
  WHERE NOT EXISTS(SELECT 1 FROM @observedErp e WHERE e.customer_key=l.customer_key AND (
      e.issuer IS NULL OR e.document_type IS NULL OR e.token IS NULL
      OR e.issuer<>s.issuer OR e.document_type<>s.document_type
      OR NOT ((s.token IS NOT NULL AND e.token=s.token) OR
        (s.issuer='CO' AND s.document_type='NIT' AND s.normalized_token IS NOT NULL AND e.token=s.normalized_token))))
    AND NOT EXISTS(SELECT 1 FROM @observedErp e WHERE e.customer_key=l.customer_key
      GROUP BY e.source_key HAVING COUNT_BIG(*)>1);

  -- Withheld collisions affect completeness only when the candidate intersects
  -- the visible ERP selection. Do not expose unrelated invisible collisions.
  IF EXISTS(SELECT 1 FROM @observedMatches m
    JOIN @observedErp e ON e.customer_key=m.customer_key
    JOIN @observedSelected sel ON sel.source_key=e.source_key
    WHERE NOT EXISTS(SELECT 1 FROM @observedIdentity i
      WHERE i.revision_key=m.revision_key AND i.source_record_id=m.source_record_id)) SET @observedPartial=1;

  -- A connected row outside the selected/authorized ERP set is never
  -- reclassified as a SAG-only row. Incomplete ERP also cannot prove orphanhood.
  IF @observedIsSuper=1 AND @selectedSourceIds IS NULL
    AND NOT EXISTS(SELECT 1 FROM @observedErpBindings b WHERE NOT EXISTS(
      SELECT 1 FROM @observedHeads h WHERE h.source_key=b.source_key AND h.source_role='erp-customers'))
  BEGIN
    ;WITH standalone AS (
      SELECT s.revision_key,s.source_record_id,s.display_name,hash.d AS digest
      FROM @observedSag s
      CROSS APPLY(VALUES(CONVERT(char(64),HASHBYTES('SHA2_256',CONCAT('portal-sag:observed-customer:v2:',
        @environment,':',s.source_id,':',
        CASE WHEN s.issuer IS NOT NULL AND s.document_type IS NOT NULL AND s.token IS NOT NULL THEN
          CONCAT('scoped:',s.issuer,':',s.document_type,':',
            CONVERT(char(64),s.token,2))
          ELSE CONCAT('unscoped:',s.source_record_id) END)),2))) hash(d)
      WHERE NOT EXISTS(SELECT 1 FROM @observedMatches m WHERE m.revision_key=s.revision_key AND m.source_record_id=s.source_record_id)
        AND NOT EXISTS(SELECT 1 FROM @observedErp e WHERE s.issuer IS NULL AND s.token IS NOT NULL AND e.token=s.token)
    ), named AS (
      SELECT *,FIRST_VALUE(display_name) OVER(PARTITION BY digest ORDER BY CASE WHEN display_name IS NOT NULL THEN 0 ELSE 1 END,
        source_record_id) AS representative_name FROM standalone
    )
    INSERT @observedIdentity
    SELECT revision_key,source_record_id,
      LOWER(CONCAT(SUBSTRING(digest,1,8),'-',SUBSTRING(digest,9,4),'-5',SUBSTRING(digest,14,3),
        '-8',SUBSTRING(digest,18,3),'-',SUBSTRING(digest,21,12))),
      representative_name,1,NULL,'unverified'
    FROM named WHERE representative_name IS NOT NULL;
  END;
END;
`;
