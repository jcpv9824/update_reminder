/* QA-only rehearsal. Synthetic Portal rows, no commits, no source or mail access. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15 OR @@TRANCOUNT<>0
  OR COL_LENGTH(N'scheduling.catalog_schedule_activation_snapshots',N'sealed_at')<>7
  OR NOT EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='082' AND succeeded=1)
  THROW 58290,N'Expected the migrated SQL Server 2019 Portal QA database.',1;

DECLARE @scenario int=1,@passed int=0,@expected int,@caught int,@dbLock int,@domainLock int,
  @tag nvarchar(80)=N'qa-closure-seal-'+LOWER(CONVERT(char(36),NEWID())),
  @stamp datetime2(3)=SYSUTCDATETIME(),@activation datetime2(3),@day date,@dayText char(10),
  @client bigint,@schedule bigint,@version binary(8),@link uniqueidentifier,@target uniqueidentifier,@sealed datetime2(3),
  @beforeSeal datetime2(3),@afterSeal datetime2(3),@minDate datetime2(3);
-- Historical synthetic day, outside the live generation window.
SET @day=DATEADD(day,-70,CONVERT(date,DATEADD(hour,-5,@stamp)));
SET @dayText=CONVERT(char(10),@day,23);
SET @activation=DATEADD(hour,5,CONVERT(datetime2(3),@day));
SET @minDate=DATEADD(day,-7,@activation);
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRY
  WHILE @scenario<=8
  BEGIN
    SET @expected=NULL;
    BEGIN TRY
      BEGIN TRANSACTION;
      DECLARE @dbResource nvarchar(255)=N'portal.catalog-task.v1:database:'+@dayText,
        @domainResource nvarchar(255)=N'portal.catalog-task.v1:domain:'+@dayText;
      SET @dbLock=0;
      IF @scenario<>2 EXEC @dbLock=sys.sp_getapplock @Resource=@dbResource,@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=3000;
      EXEC @domainLock=sys.sp_getapplock @Resource=@domainResource,@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=3000;
      IF @dbLock<0 OR @domainLock<0 THROW 58291,N'Could not reserve the synthetic QA occurrence.',1;

      INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
        VALUES(@tag,@tag,@tag,'active',@minDate,N'qa-fixture',@minDate,N'qa-fixture');
      SET @client=SCOPE_IDENTITY();
      INSERT scheduling.update_schedules(source_id,client_key,name,target_type,frequency_type,start_date,
        timezone,assigned_role,created_at,created_by,updated_at,updated_by,catalog_activation_enabled)
        VALUES(@tag,@client,N'Synthetic activation seal','domain','once',@day,N'America/Bogota',N'super_admin',
        @minDate,N'qa-fixture',@minDate,N'qa-fixture',1);
      SET @schedule=SCOPE_IDENTITY();
      SELECT @version=row_version FROM scheduling.update_schedules WHERE schedule_key=@schedule;
      SET @link=NEWID();
      SET @target=NEWID();
      IF @scenario=8
      BEGIN
        SET @expected=58204;
        INSERT scheduling.catalog_schedule_activation_snapshots
          (schedule_key,definition_version,portal_environment,activation_at,evidence_at,activation_state,sealed_at)
          VALUES(@schedule,@version,'qa',@activation,@activation,'frozen',SYSUTCDATETIME());
      END
      ELSE
        INSERT scheduling.catalog_schedule_activation_snapshots
          (schedule_key,definition_version,portal_environment,activation_at,evidence_at,activation_state)
          VALUES(@schedule,@version,'qa',@activation,@activation,'frozen');

      INSERT scheduling.catalog_schedule_activation_targets(schedule_key,link_id,client_source_id,client_name_snapshot,
        domain_source_id,domain_name_snapshot,target_source_id,target_name_snapshot,verified_target_id,target_kind,target_environment,evidence_state)
        VALUES(@schedule,@link,@tag,N'Synthetic customer',@tag,N'synthetic.example.invalid',@tag,
          N'synthetic.example.invalid',@target,'domain','test','eligible');
      IF @scenario<>3
        INSERT scheduling.catalog_schedule_activation_responsibles(schedule_key,target_kind,principal_kind,principal_source_id)
          VALUES(@schedule,'domain','role',N'super_admin');
      IF @scenario IN (2,3) SET @expected=58206;
      SET @beforeSeal=SYSUTCDATETIME();
      -- The caller proposes an intentionally wrong time; SQL must stamp its own.
      UPDATE scheduling.catalog_schedule_activation_snapshots SET sealed_at=@minDate WHERE schedule_key=@schedule;
      SET @afterSeal=SYSUTCDATETIME();
      SELECT @sealed=sealed_at FROM scheduling.catalog_schedule_activation_snapshots WHERE schedule_key=@schedule;
      IF @sealed IS NULL OR @sealed NOT BETWEEN @beforeSeal AND @afterSeal OR @sealed=@minDate
        THROW 58292,N'SQL did not stamp the seal after writing the fixture scope.',1;
      IF @scenario=4
      BEGIN
        SET @expected=58207;
        INSERT scheduling.catalog_schedule_activation_targets(schedule_key,link_id,client_source_id,client_name_snapshot,
          domain_source_id,domain_name_snapshot,target_source_id,target_name_snapshot,verified_target_id,target_kind,target_environment,evidence_state)
          VALUES(@schedule,NEWID(),@tag,N'Synthetic customer',@tag,N'synthetic.example.invalid',@tag,
            N'synthetic.example.invalid',@target,'domain','test','eligible');
      END;
      IF @scenario=5
      BEGIN
        SET @expected=58208;
        INSERT scheduling.catalog_schedule_activation_responsibles(schedule_key,target_kind,principal_kind,principal_source_id)
          VALUES(@schedule,'domain','user',N'synthetic-user');
      END;
      IF @scenario=6
      BEGIN
        SET @expected=58205;
        UPDATE scheduling.catalog_schedule_activation_snapshots SET sealed_at=SYSUTCDATETIME() WHERE schedule_key=@schedule;
      END;
      IF @scenario=7
      BEGIN
        SET @expected=58207;
        DELETE FROM scheduling.catalog_schedule_activation_targets WHERE schedule_key=@schedule;
      END;
      IF @expected IS NOT NULL THROW 58293,N'The expected seal rejection did not occur.',1;
      ROLLBACK TRANSACTION;
      SET @passed+=1;
    END TRY
    BEGIN CATCH
      SET @caught=ERROR_NUMBER();
      IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
      IF @expected IS NULL OR @caught<>@expected THROW;
      SET @passed+=1;
    END CATCH;
    IF EXISTS(SELECT 1 FROM core.clients WHERE source_id=@tag)
      OR EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE source_id=@tag)
      THROW 58294,N'An unexpected synthetic fixture survived rollback.',1;
    SET @scenario+=1;
  END;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  THROW;
END CATCH;
SELECT @passed AS passed,CONVERT(bit,1) AS rolledBack,DB_NAME() AS targetDatabase;
