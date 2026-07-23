/*
  Portal SAG Web - Gate C/D / 017
  Align the persisted SQL domain identity with the application rule:
  trim, lowercase and remove every trailing slash.

  The display URL remains unchanged. Only the normalized uniqueness key and
  the operational loader are corrected. The migration aborts before updating
  if two active rows would collapse to the same identity.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 51700,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 51701,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='016' AND succeeded=1
)
  THROW 51702,N'Migration 016 must be recorded before migration 017.',1;
IF OBJECT_ID(N'core.domains',N'U') IS NULL
   OR OBJECT_ID(N'migration.usp_load_operational_security_core_licensing',N'P') IS NULL
  THROW 51703,N'The core domain model and operational loader must exist.',1;

BEGIN TRANSACTION;

DECLARE @loader NVARCHAR(MAX)=OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_operational_security_core_licensing'));
DECLARE @old_fragment NVARCHAR(2000)=N'LTRIM(RTRIM(s.domain_name)), LOWER(LTRIM(RTRIM(s.domain_name))), LTRIM(RTRIM(s.domain_name)),';
DECLARE @new_fragment NVARCHAR(2000)=N'LTRIM(RTRIM(s.domain_name)),
      LOWER(LEFT(LTRIM(RTRIM(s.domain_name)),LEN(LTRIM(RTRIM(s.domain_name)))-PATINDEX(N''%[^/]%'',REVERSE(LTRIM(RTRIM(s.domain_name))))+1)),
      LTRIM(RTRIM(s.domain_name)),';

IF @loader IS NULL THROW 51704,N'The security/core/licensing loader definition is missing.',1;
IF CHARINDEX(@new_fragment,@loader)=0
BEGIN
  IF CHARINDEX(@old_fragment,@loader)=0
     OR CHARINDEX(@old_fragment,@loader,CHARINDEX(@old_fragment,@loader)+1)>0
    THROW 51705,N'The domain normalization loader fragment is not the reviewed definition.',1;
  SET @loader=REPLACE(@loader,@old_fragment,@new_fragment);
  DECLARE @header_create_position INT=CHARINDEX(N'CREATE',UPPER(@loader));
  DECLARE @header_procedure_position INT=CHARINDEX(N'PROCEDURE',UPPER(@loader));
  IF @header_create_position NOT BETWEEN 1 AND 10
     OR @header_procedure_position<=@header_create_position
    THROW 51706,N'The operational loader header is not the reviewed CREATE PROCEDURE form.',1;
  SET @loader=STUFF(@loader,@header_create_position,LEN(N'CREATE'),N'ALTER');
  EXEC sys.sp_executesql @loader;
END;

DECLARE @normalized TABLE
(
  domain_key BIGINT NOT NULL PRIMARY KEY,
  normalized_url NVARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL
);

INSERT @normalized(domain_key,normalized_url,status)
SELECT domain_key,
  LOWER(LEFT(LTRIM(RTRIM(domain_name)),LEN(LTRIM(RTRIM(domain_name)))-PATINDEX(N'%[^/]%',REVERSE(LTRIM(RTRIM(domain_name))))+1)),
  status
FROM core.domains;

IF EXISTS
(
  SELECT normalized_url
  FROM @normalized
  WHERE status<>'deleted'
  GROUP BY normalized_url
  HAVING COUNT_BIG(*)>1
)
  THROW 51707,N'Existing active domains collapse to a duplicate normalized URL.',1;

UPDATE domain_record
SET domain_name_normalized=normalized.normalized_url
FROM core.domains AS domain_record
JOIN @normalized AS normalized ON normalized.domain_key=domain_record.domain_key
WHERE domain_record.domain_name_normalized<>normalized.normalized_url;

IF EXISTS
(
  SELECT 1 FROM core.domains
  WHERE RIGHT(domain_name_normalized,1)=N'/' OR domain_name_normalized<>LOWER(LTRIM(RTRIM(domain_name_normalized)))
)
  THROW 51708,N'Domain URL normalization verification failed.',1;

COMMIT TRANSACTION;
PRINT N'017 complete: domain URL identity removes trailing slashes and the operational loader matches.';
GO
