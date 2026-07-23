/*
  Portal SAG Web - Gate C/D / 016
  Generalize public-download documents into document/video assets while keeping
  the existing physical table and Cosmos discriminator for backward
  compatibility. Remove the unused print-format source description end to end.

  File bytes remain in private Azure Blob Storage. SQL stores the asset kind,
  immutable file metadata and version links only.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME()<>N'PortalSAGWeb' THROW 51600,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 51601,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='015' AND succeeded=1
)
  THROW 51602,N'Migration 015 must be recorded before migration 016.',1;
IF OBJECT_ID(N'content.public_download_documents',N'U') IS NULL
   OR OBJECT_ID(N'content.public_download_files',N'U') IS NULL
   OR OBJECT_ID(N'content.print_format_sources',N'U') IS NULL
   OR OBJECT_ID(N'migration.usp_load_operational_settings_content_notifications_audit',N'P') IS NULL
  THROW 51603,N'Migrations 005, 011 and 015 must be installed before migration 016.',1;

BEGIN TRANSACTION;

/* Patch the immutable-source loader before removing the obsolete column. */
IF COL_LENGTH(N'content.print_format_sources',N'description') IS NOT NULL
BEGIN
  DECLARE @loader NVARCHAR(MAX)=OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_operational_settings_content_notifications_audit'));
  DECLARE @source_insert_old NVARCHAR(2000)=N'INSERT content.print_format_sources
      (source_id,name,name_normalized,description,active,status,created_at,created_by,
       updated_at,updated_by,deleted_at,deleted_by)
    SELECT s.source_id,LTRIM(RTRIM(s.name)),LOWER(LTRIM(RTRIM(s.name))),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,''$.descripcion''))),N''''),
      CASE state.entity_status';
  DECLARE @source_insert_new NVARCHAR(2000)=N'INSERT content.print_format_sources
      (source_id,name,name_normalized,active,status,created_at,created_by,
       updated_at,updated_by,deleted_at,deleted_by)
    SELECT s.source_id,LTRIM(RTRIM(s.name)),LOWER(LTRIM(RTRIM(s.name))),
      CASE state.entity_status';

  IF @loader IS NULL
     OR CHARINDEX(@source_insert_old,@loader)=0
     OR CHARINDEX(@source_insert_old,@loader,CHARINDEX(@source_insert_old,@loader)+1)>0
    THROW 51604,N'The final loader source-description fragment is not the reviewed definition.',1;

  SET @loader=REPLACE(@loader,@source_insert_old,@source_insert_new);
  DECLARE @source_header_create_position INT=CHARINDEX(N'CREATE',UPPER(@loader));
  DECLARE @source_header_procedure_position INT=CHARINDEX(N'PROCEDURE',UPPER(@loader));
  IF @source_header_create_position NOT BETWEEN 1 AND 10
     OR @source_header_procedure_position<=@source_header_create_position
    THROW 51611,N'The final loader header is not the reviewed CREATE PROCEDURE form.',1;
  /* OBJECT_DEFINITION normalizes CREATE OR ALTER modules back to CREATE. */
  SET @loader=STUFF(@loader,@source_header_create_position,LEN(N'CREATE'),N'ALTER');
  EXEC sys.sp_executesql @loader;

  ALTER TABLE content.print_format_sources DROP COLUMN description;
END;

IF COL_LENGTH(N'content.public_download_documents',N'asset_kind') IS NULL
BEGIN
  ALTER TABLE content.public_download_documents
    ADD asset_kind VARCHAR(20) NULL;

  /* SQL Server compiles static references before the preceding ADD executes. */
  EXEC sys.sp_executesql N'
    UPDATE document_record
    SET asset_kind=CASE WHEN LOWER(COALESCE(file_record.mime_type,N'''')) LIKE N''video/%''
      THEN ''video'' ELSE ''document'' END
    FROM content.public_download_documents AS document_record
    LEFT JOIN content.public_download_files AS current_file
      ON current_file.document_key=document_record.document_key AND current_file.is_current=1
    LEFT JOIN content.files AS file_record ON file_record.file_key=current_file.file_key;

    ALTER TABLE content.public_download_documents
      ALTER COLUMN asset_kind VARCHAR(20) NOT NULL;
    ALTER TABLE content.public_download_documents
      ADD CONSTRAINT DF_public_download_documents_asset_kind DEFAULT (''document'') FOR asset_kind;
    ALTER TABLE content.public_download_documents WITH CHECK
      ADD CONSTRAINT CK_public_download_documents_asset_kind CHECK (asset_kind IN (''document'',''video''));';
END;

/* Ensure future Cosmos-to-SQL loads classify videos from their canonical MIME. */
DECLARE @asset_loader NVARCHAR(MAX)=OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_operational_settings_content_notifications_audit'));
DECLARE @asset_insert_old NVARCHAR(2000)=N'INSERT content.public_download_documents
      (source_id,section_key,title,slug,slug_normalized,description,active,status,
       created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT d.source_id,section_record.section_key,LTRIM(RTRIM(d.name_or_title)),LTRIM(RTRIM(d.slug)),';
DECLARE @asset_insert_new NVARCHAR(2000)=N'INSERT content.public_download_documents
      (source_id,section_key,asset_kind,title,slug,slug_normalized,description,active,status,
       created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT d.source_id,section_record.section_key,
      CASE WHEN LOWER(COALESCE(d.file_mime_type,N'''')) LIKE N''video/%'' THEN ''video'' ELSE ''document'' END,
      LTRIM(RTRIM(d.name_or_title)),LTRIM(RTRIM(d.slug)),';

IF @asset_loader IS NULL THROW 51605,N'The final loader definition is missing.',1;
IF CHARINDEX(@asset_insert_new,@asset_loader)=0
BEGIN
  IF CHARINDEX(@asset_insert_old,@asset_loader)=0
     OR CHARINDEX(@asset_insert_old,@asset_loader,CHARINDEX(@asset_insert_old,@asset_loader)+1)>0
    THROW 51606,N'The public-download loader fragment is not the reviewed definition.',1;
  SET @asset_loader=REPLACE(@asset_loader,@asset_insert_old,@asset_insert_new);
  DECLARE @asset_header_create_position INT=CHARINDEX(N'CREATE',UPPER(@asset_loader));
  DECLARE @asset_header_procedure_position INT=CHARINDEX(N'PROCEDURE',UPPER(@asset_loader));
  IF @asset_header_create_position NOT BETWEEN 1 AND 10
     OR @asset_header_procedure_position<=@asset_header_create_position
    THROW 51612,N'The final loader header is not the reviewed CREATE PROCEDURE form.',1;
  SET @asset_loader=STUFF(@asset_loader,@asset_header_create_position,LEN(N'CREATE'),N'ALTER');
  EXEC sys.sp_executesql @asset_loader;
END;

IF NOT EXISTS
(
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'content.public_download_documents')
    AND name=N'IX_public_download_documents_section_kind_status'
)
  EXEC sys.sp_executesql N'
    CREATE INDEX IX_public_download_documents_section_kind_status
      ON content.public_download_documents(section_key,asset_kind,status)
      INCLUDE (title,slug,active,updated_at);';

UPDATE security.permissions
SET label=CASE action_key
      WHEN N'create_document' THEN N'Crear Archivo'
      WHEN N'edit_document' THEN N'Editar Archivo'
      WHEN N'delete_document' THEN N'Eliminar Archivo'
    END,
    description=N'Descargas Públicas / '+CASE action_key
      WHEN N'create_document' THEN N'Crear Archivo'
      WHEN N'edit_document' THEN N'Editar Archivo'
      WHEN N'delete_document' THEN N'Eliminar Archivo'
    END
WHERE permission_key IN
  (N'implementation.public_downloads.create_document',
   N'implementation.public_downloads.edit_document',
   N'implementation.public_downloads.delete_document');

IF @@ROWCOUNT<>3 THROW 51610,N'The three public-file permission labels were not found.',1;
GO

CREATE OR ALTER VIEW content.v_public_download_assets
AS
SELECT
  d.document_key AS asset_key,
  d.source_id,
  d.section_key,
  d.asset_kind,
  d.title,
  d.slug,
  d.description,
  d.active,
  d.status,
  version_record.version_no,
  f.file_key,
  f.storage_provider,
  f.storage_container,
  f.blob_name,
  f.original_name,
  f.mime_type,
  f.byte_count,
  f.content_sha256 AS sha256,
  d.created_at,
  d.updated_at,
  d.row_version
FROM content.public_download_documents AS d
LEFT JOIN content.public_download_files AS version_record
  ON version_record.document_key=d.document_key AND version_record.is_current=1
LEFT JOIN content.files AS f ON f.file_key=version_record.file_key;
GO

IF COL_LENGTH(N'content.print_format_sources',N'description') IS NOT NULL
  THROW 51607,N'The obsolete print-format source description column still exists.',1;
IF COL_LENGTH(N'content.public_download_documents',N'asset_kind') IS NULL
  THROW 51608,N'The public-download asset kind was not installed.',1;
IF EXISTS
(
  SELECT 1 FROM content.public_download_documents
  WHERE asset_kind NOT IN ('document','video')
)
  THROW 51609,N'An existing public-download asset has an invalid kind.',1;

COMMIT TRANSACTION;
PRINT N'016 complete: public downloads support document/video assets; print-source descriptions removed.';
GO
