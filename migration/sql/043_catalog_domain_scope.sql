/*
  Logical domain uniqueness is per client, operational environment and
  normalized route. This migration replaces only the legacy uniqueness
  index; it does not rewrite domain rows, IDs, relationships or physical proof.
  Schedule an appropriate DDL lock window; the replacement is built before
  removing the old index, within one transaction.

  Rollback compatibility: once a shared route is saved, the legacy global
  index can only be recreated when this read-only preflight finds no rows:
    SELECT 1 FROM core.domains WHERE status<>'deleted'
    GROUP BY domain_name_normalized HAVING COUNT_BIG(*)>1;
  If conflicts exist, preserve all rows and IDs. Rehearse restoring a
  pre-change QA backup or prepare a separately approved recovery plan;
  do not merge, rename, delete or deactivate rows to force rollback.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;

DECLARE @owns043Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns043Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock043 int;
  EXEC @lock043=sys.sp_getapplock @Resource=N'portal-sag:migration:043:domain-scope',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock043<0 THROW 54300,N'Could not reserve the domain scope migration lock.',1;

  DECLARE @domains043 int=OBJECT_ID(N'core.domains',N'U');
  IF @domains043 IS NULL
    OR COL_LENGTH(N'core.domains',N'client_key') IS NULL OR COL_LENGTH(N'core.domains',N'environment_id') IS NULL
    OR COL_LENGTH(N'core.domains',N'domain_name_normalized') IS NULL OR COL_LENGTH(N'core.domains',N'status') IS NULL
    THROW 54301,N'Install the operational domain schema before changing route scope.',1;

  DECLARE @legacy043 int,@scoped043 int;
  SELECT @legacy043=index_id FROM sys.indexes WHERE object_id=@domains043 AND name=N'UX_domains_name_active';
  SELECT @scoped043=index_id FROM sys.indexes WHERE object_id=@domains043 AND name=N'UX_domains_client_environment_name_active';
  IF @legacy043 IS NULL AND @scoped043 IS NULL
    THROW 54302,N'Neither the expected legacy index nor its scoped replacement exists.',1;

  -- A matching name alone is insufficient: do not drop unknown schema.
  IF @legacy043 IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sys.indexes i
    WHERE i.object_id=@domains043 AND i.index_id=@legacy043 AND i.type=2 AND i.is_unique=1
      AND i.is_unique_constraint=0 AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.ignore_dup_key=0 AND i.has_filter=1
      AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(i.filter_definition,N'[',N''),N']',N''),N'(',N''),N')',N''),N' ',N''))
        =N'status<>''deleted'''
      AND (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0)=1
      AND EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id
        AND ic.key_ordinal=1 AND ic.column_id=COLUMNPROPERTY(@domains043,N'domain_name_normalized',N'ColumnId'))
  )
    THROW 54303,N'The legacy domain route index does not match the reviewed definition.',1;

  IF @scoped043 IS NULL
  BEGIN
    CREATE UNIQUE NONCLUSTERED INDEX UX_domains_client_environment_name_active
      ON core.domains(client_key,environment_id,domain_name_normalized) WHERE status<>'deleted';
    SELECT @scoped043=index_id FROM sys.indexes
      WHERE object_id=@domains043 AND name=N'UX_domains_client_environment_name_active';
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes i
    WHERE i.object_id=@domains043 AND i.index_id=@scoped043 AND i.type=2 AND i.is_unique=1
      AND i.is_unique_constraint=0 AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.ignore_dup_key=0 AND i.has_filter=1
      AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(i.filter_definition,N'[',N''),N']',N''),N'(',N''),N')',N''),N' ',N''))
        =N'status<>''deleted'''
      AND (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0)=3
      AND EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id
        AND ic.key_ordinal=1 AND ic.column_id=COLUMNPROPERTY(@domains043,N'client_key',N'ColumnId'))
      AND EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id
        AND ic.key_ordinal=2 AND ic.column_id=COLUMNPROPERTY(@domains043,N'environment_id',N'ColumnId'))
      AND EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id
        AND ic.key_ordinal=3 AND ic.column_id=COLUMNPROPERTY(@domains043,N'domain_name_normalized',N'ColumnId'))
  )
    THROW 54304,N'The scoped domain route index does not match the reviewed definition.',1;

  IF @legacy043 IS NOT NULL DROP INDEX UX_domains_name_active ON core.domains;
  IF @owns043Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns043Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
