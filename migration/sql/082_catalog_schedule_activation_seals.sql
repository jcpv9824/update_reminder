/* Freeze activation history after the exact target and assignee rows are written. No permission changes. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns082 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns082=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
    OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150 AND is_read_only=0)
    THROW 58200,N'Expected an exact Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock082 int;
  EXEC @lock082=sys.sp_getapplock @Resource=N'portal-sag:migration:082:activation-seal',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=10000;
  IF @lock082<0 THROW 58201,N'Could not reserve the activation seal migration lock.',1;
  IF OBJECT_ID(N'scheduling.catalog_schedule_activation_snapshots',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_activation_targets',N'U') IS NULL
    OR OBJECT_ID(N'scheduling.catalog_schedule_activation_responsibles',N'U') IS NULL
    THROW 58202,N'Expected the activation history tables.',1;
  IF COL_LENGTH(N'scheduling.catalog_schedule_activation_snapshots',N'sealed_at') IS NULL
  BEGIN
    -- There were no lifecycle snapshots in the certified preflight. Never
    -- bless existing rows implicitly if a different candidate was deployed.
    IF EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_snapshots WITH (TABLOCKX,HOLDLOCK))
      THROW 58203,N'Existing snapshots require separate reconciliation before installing seals.',1;
    ALTER TABLE scheduling.catalog_schedule_activation_snapshots ADD sealed_at datetime2(3) NULL;
  END;

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_schedule_activation_snapshot_insert_delete
    ON scheduling.catalog_schedule_activation_snapshots AFTER INSERT,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM inserted WHERE sealed_at IS NOT NULL)
        THROW 58204,N''A snapshot cannot be inserted already sealed.'',1;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 58205,N''Activation snapshots cannot be deleted.'',1;
    END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_schedule_activation_snapshot_seal
    ON scheduling.catalog_schedule_activation_snapshots INSTEAD OF UPDATE AS
    BEGIN
      SET NOCOUNT ON;
      IF NOT UPDATE(sealed_at) OR (SELECT COUNT(*) FROM inserted)<>1 OR (SELECT COUNT(*) FROM deleted)<>1
        OR NOT EXISTS(SELECT 1 FROM inserted n JOIN deleted o ON o.schedule_key=n.schedule_key
          WHERE o.sealed_at IS NULL AND n.sealed_at IS NOT NULL
            AND n.definition_version=o.definition_version AND n.portal_environment=o.portal_environment
            AND n.activation_at=o.activation_at AND n.recorded_at=o.recorded_at AND n.activation_state=o.activation_state
            AND NOT EXISTS(SELECT n.evidence_at EXCEPT SELECT o.evidence_at))
        THROW 58205,N''Activation snapshots are immutable apart from their initial seal.'',1;
      DECLARE @key bigint,@date char(10),@phase varchar(10);
      SELECT @key=n.schedule_key,@date=CONVERT(char(10),s.start_date,23),@phase=n.activation_state
      FROM inserted n JOIN scheduling.update_schedules s WITH (HOLDLOCK)
        ON s.schedule_key=n.schedule_key AND s.row_version=n.definition_version
        AND s.catalog_activation_enabled=1 AND s.active=1 AND s.deleted_at IS NULL;
      IF @key IS NULL OR @phase NOT IN (''frozen'',''cancelled'')
        OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
        OR ISNULL(APPLOCK_MODE(N''public'',N''portal.catalog-task.v1:database:''+@date,N''Transaction''),N''NoLock'')<>N''Exclusive''
        OR ISNULL(APPLOCK_MODE(N''public'',N''portal.catalog-task.v1:domain:''+@date,N''Transaction''),N''NoLock'')<>N''Exclusive''
        OR (SELECT COUNT(*) FROM scheduling.catalog_schedule_activation_targets WITH (HOLDLOCK) WHERE schedule_key=@key)>5000
        OR (SELECT COUNT(*) FROM scheduling.catalog_schedule_activation_responsibles WITH (HOLDLOCK) WHERE schedule_key=@key)>200
        OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_targets WHERE schedule_key=@key AND evidence_state=''unverifiable'')
        OR (@phase=''frozen'' AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_targets WHERE schedule_key=@key AND evidence_state=''eligible''))
        OR (@phase=''cancelled'' AND EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_targets WHERE schedule_key=@key AND evidence_state=''eligible''))
        OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_targets t WHERE t.schedule_key=@key AND t.evidence_state=''eligible''
          AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_activation_responsibles p WHERE p.schedule_key=@key AND p.target_kind=t.target_kind))
        THROW 58206,N''Activation seal requires exact bounded evidence and both transaction day locks.'',1;
      -- The incoming field is intent only. The server stamps the protected
      -- transition after checking the final children, in their transaction.
      DECLARE @sealedAt datetime2(3)=SYSUTCDATETIME();
      UPDATE scheduling.catalog_schedule_activation_snapshots SET sealed_at=@sealedAt
        WHERE schedule_key=@key AND sealed_at IS NULL AND recorded_at<=@sealedAt;
      IF @@ROWCOUNT<>1 THROW 58209,N''The activation could not be sealed.'',1;
    END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_schedule_activation_targets_seal
    ON scheduling.catalog_schedule_activation_targets AFTER INSERT,UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted) OR EXISTS(SELECT 1 FROM inserted i
        JOIN scheduling.catalog_schedule_activation_snapshots s WITH (UPDLOCK,HOLDLOCK) ON s.schedule_key=i.schedule_key
        WHERE s.sealed_at IS NOT NULL)
        THROW 58207,N''Activation targets are append-only before the seal and immutable afterwards.'',1;
    END;';
  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER scheduling.TR_catalog_schedule_activation_responsibles_seal
    ON scheduling.catalog_schedule_activation_responsibles AFTER INSERT,UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted) OR EXISTS(SELECT 1 FROM inserted i
        JOIN scheduling.catalog_schedule_activation_snapshots s WITH (UPDLOCK,HOLDLOCK) ON s.schedule_key=i.schedule_key
        WHERE s.sealed_at IS NOT NULL)
        THROW 58208,N''Activation assignees are append-only before the seal and immutable afterwards.'',1;
    END;';
  IF @owns082=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns082=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
