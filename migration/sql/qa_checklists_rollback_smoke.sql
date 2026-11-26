/* Checklists SQL integration smoke fixture: synthetic data, QA only, rollback.
   Not an API test and not evidence of two-session race handling. */
SET NOCOUNT ON;
SET XACT_ABORT OFF; -- Expected statement errors must not doom the outer transaction.
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;

IF DB_NAME() <> N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 53560, N'Use a dedicated PortalSAGWeb-TEST session with no open transaction.', 1;
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='085' AND succeeded=1)
  THROW 53561, N'Apply and verify migration 085 first.', 1;

-- CA-30/38: seeding cannot grant a Checklists key to an ordinary role or broaden scope.
IF (SELECT COUNT(*) FROM security.role_permissions WHERE role_id=N'super_admin'
    AND permission_key IN (N'implementation.checklists.view',N'implementation.checklists.create',N'configuration.checklist_templates.view'))<>3
  OR EXISTS(SELECT 1 FROM security.role_permissions WHERE granted_by=N'migration-085' AND role_id<>N'super_admin')
  THROW 53579, N'Expected three protected grants and no automatic ordinary roles.', 1;
IF (SELECT COUNT(*) FROM sys.database_permissions AS p JOIN sys.tables AS t ON p.major_id=t.object_id
    WHERE p.grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND p.class=1 AND p.minor_id=0
      AND t.schema_id=SCHEMA_ID(N'implementation') AND t.name IN
        (N'checklist_templates',N'checklist_template_versions',N'checklist_template_points',N'implementation_checklists',
         N'implementation_checklist_points',N'implementation_checklist_evidence')
      AND ((p.state='G' AND p.permission_name IN (N'SELECT',N'INSERT',N'UPDATE')) OR (p.state='D' AND p.permission_name=N'DELETE')))<>24
  THROW 53580, N'Expected per-table SELECT, INSERT and UPDATE plus DENY DELETE for portal_runtime.', 1;

DECLARE @salt nvarchar(36)=CONVERT(nvarchar(36),NEWID()), @actor bigint,
  @client uniqueidentifier=NEWID(), @otherClient uniqueidentifier=NEWID(),
  @template uniqueidentifier=NEWID(), @other uniqueidentifier=NEWID(),
  @v1 uniqueidentifier=NEWID(), @v2 uniqueidentifier=NEWID(), @v3 uniqueidentifier=NEWID(),
  @otherVersion uniqueidentifier=NEWID(), @p1 uniqueidentifier=NEWID(), @p2 uniqueidentifier=NEWID(),
  @anotherPoint uniqueidentifier=NEWID(), @checklist uniqueidentifier=NEWID(), @next uniqueidentifier=NEWID(),
  @editToken binary(8), @now datetime2(3)=SYSUTCDATETIME();

BEGIN TRY
  BEGIN TRANSACTION;
  INSERT security.users(source_id,display_name,email,email_normalized,created_at,created_by,updated_at,updated_by)
  VALUES (@salt,N'Checklists QA',@salt+N'@example.invalid',LOWER(@salt)+N'@example.invalid',@now,N'qa',@now,N'qa');
  SET @actor=CONVERT(bigint,SCOPE_IDENTITY());
  INSERT core.catalog_customer_ids(customer_id) VALUES (@client),(@otherClient);

  INSERT implementation.checklist_templates(id,name,created_by)
  VALUES (@template,N'Migración '+@salt,@actor),(@other,N'Otra '+@salt,@actor);
  -- CA-33: accent/case cannot bypass active name uniqueness.
  BEGIN TRY
    INSERT implementation.checklist_templates(name,created_by) VALUES (N'migracion '+@salt,@actor);
    THROW 53562, N'CA-33: colliding live template name was accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER() NOT IN (2601,2627) THROW;
  END CATCH;

  INSERT implementation.checklist_template_versions(id,template_id,number,status,created_by,published_at,published_by)
  VALUES (@v1,@template,1,'current',@actor,@now,@actor),(@otherVersion,@other,1,'current',@actor,@now,@actor),
    (@v2,@template,2,'editing',@actor,NULL,NULL);
  -- CA-22/23: each live state slot can have at most one version.
  BEGIN TRY
    INSERT implementation.checklist_template_versions(template_id,number,status,created_by)
    VALUES (@template,3,'editing',@actor);
    THROW 53563, N'CA-22: multiple editing versions were accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER() NOT IN (2601,2627) THROW;
  END CATCH;
  BEGIN TRY
    INSERT implementation.checklist_template_versions(template_id,number,status,created_by,published_at,published_by)
    VALUES (@template,3,'current',@actor,@now,@actor);
    THROW 53564, N'CA-23: multiple current versions were accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER() NOT IN (2601,2627) THROW;
  END CATCH;

  -- CA-26: history is retained; repeat an active number with a distinct UUID.
  UPDATE implementation.checklist_template_versions SET deleted_at=SYSUTCDATETIME(), deleted_by=@actor WHERE id=@v2;
  INSERT implementation.checklist_template_versions(id,template_id,number,status,created_by)
  VALUES (@v3,@template,2,'editing',@actor);
  IF (SELECT COUNT(*) FROM implementation.checklist_template_versions WHERE template_id=@template AND number=2)<>2
    THROW 53565, N'CA-26: expected a retained and a replacement version row.', 1;

  INSERT implementation.checklist_template_points(id,version_id,position,title)
  VALUES (@p1,@v1,1,N'QA first'),(@p2,@v1,2,N'QA second'),(@anotherPoint,@v3,1,N'Other version');
  -- CA-28: a live point position cannot repeat in a version.
  BEGIN TRY
    INSERT implementation.checklist_template_points(version_id,position,title) VALUES (@v1,2,N'Collision');
    THROW 53566, N'CA-28: duplicate live position was accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER() NOT IN (2601,2627) THROW;
  END CATCH;

  -- CA-37: ROWVERSION is server-controlled and stale state cannot overwrite a later write.
  SELECT @editToken=row_version FROM implementation.checklist_template_versions WHERE id=@v3;
  UPDATE implementation.checklist_template_versions SET updated_at=SYSUTCDATETIME() WHERE id=@v3;
  UPDATE implementation.checklist_template_versions SET updated_at=SYSUTCDATETIME() WHERE id=@v3 AND row_version=@editToken;
  IF @@ROWCOUNT<>0 THROW 53567, N'CA-37: stale rowVersion was accepted.', 1;

  -- CA-05/06: no-environment templates persist NULL and NULL participates in uniqueness.
  INSERT implementation.implementation_checklists(id,client_id,client_name_snapshot,template_id,version_id,requires_environment,owner_user_id,created_by)
  VALUES (@checklist,@client,N'QA ERP',@template,@v1,0,@actor,@actor);
  BEGIN TRY
    INSERT implementation.implementation_checklists(client_id,client_name_snapshot,template_id,version_id,requires_environment,owner_user_id,created_by)
    VALUES (@client,N'QA ERP',@template,@v1,0,@actor,@actor);
    THROW 53568, N'CA-06: duplicate live checklist without environment was accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER() NOT IN (2601,2627) THROW;
  END CATCH;
  BEGIN TRY
    INSERT implementation.implementation_checklists(client_id,client_name_snapshot,template_id,version_id,requires_environment,environment,owner_user_id,created_by)
    VALUES (@client,N'QA ERP',@template,@v1,0,'testing',@actor,@actor);
    THROW 53569, N'CA-05: unexpected environment was accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER()<>547 THROW;
  END CATCH;

  -- CA-21: the version must belong to its template and the point to its version.
  BEGIN TRY
    INSERT implementation.implementation_checklists(client_id,client_name_snapshot,template_id,version_id,requires_environment,owner_user_id,created_by)
    VALUES (@otherClient,N'QA ERP',@template,@otherVersion,0,@actor,@actor);
    THROW 53570, N'CA-21: another template version was accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER()<>547 THROW;
  END CATCH;
  INSERT implementation.implementation_checklist_points(checklist_id,template_point_id,version_id,position)
  VALUES (@checklist,@p1,@v1,1),(@checklist,@p2,@v1,2);
  BEGIN TRY
    INSERT implementation.implementation_checklist_points(checklist_id,template_point_id,version_id,position)
    VALUES (@checklist,@anotherPoint,@v1,3);
    THROW 53571, N'CA-21: another version point was accepted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER()<>547 THROW;
  END CATCH;

  -- CA-16/17: evidence belongs to the exact checklist/point and its payload matches its kind.
  INSERT implementation.implementation_checklist_evidence(checklist_id,template_point_id,kind,[text],created_by)
  VALUES (@checklist,@p1,'text',N'Synthetic evidence',@actor);
  BEGIN TRY
    INSERT implementation.implementation_checklist_evidence(checklist_id,template_point_id,kind,[text],created_by)
    VALUES (@checklist,@anotherPoint,'text',N'Unrelated evidence',@actor);
    THROW 53575, N'Another version point accepted evidence.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER()<>547 THROW;
  END CATCH;
  BEGIN TRY
    INSERT implementation.implementation_checklist_evidence(checklist_id,template_point_id,kind,[text],created_by)
    VALUES (@checklist,@p1,'image',N'Not an object locator',@actor);
    THROW 53576, N'Image evidence accepted without private object metadata.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER()<>547 THROW;
  END CATCH;

  -- CA-17/20: only verified binaries may be saved. Never lease a saved object.
  DECLARE @binary uniqueidentifier=NEWID(), @lease uniqueidentifier=NEWID();
  INSERT implementation.implementation_checklist_evidence
    (id,checklist_id,template_point_id,kind,storage_provider,storage_container,storage_key,file_name,content_type,size_bytes,storage_sha256,created_by)
  VALUES (@binary,@checklist,@p1,'image','s3',N'synthetic-fixture',N'checklists/'+LOWER(CONVERT(nvarchar(36),@binary))+N'/payload.png',
    N'test.png',N'image/png',8,HASHBYTES('SHA2_256',N'synthetic bytes'),@actor);
  BEGIN TRY
    UPDATE implementation.implementation_checklist_evidence SET status='saved' WHERE id=@binary;
    THROW 53593, N'Unverified binary evidence was promoted.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER()<>547 THROW;
  END CATCH;
  UPDATE implementation.implementation_checklist_evidence SET status='saved',verified_at=@now WHERE id=@binary;
  BEGIN TRY
    UPDATE implementation.implementation_checklist_evidence
      SET deleted_at=@now,deleted_by=@actor,cleanup_lease_id=@lease,cleanup_lease_until=DATEADD(minute,5,@now)
      WHERE id=@binary;
    THROW 53594, N'Saved evidence could be leased for physical deletion.', 1;
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER()<>547 THROW;
  END CATCH;

  -- CA-09/31: logical deletion releases duplicate protection but retains history.
  UPDATE implementation.implementation_checklists SET deleted_at=SYSUTCDATETIME(),deleted_by=@actor WHERE id=@checklist;
  IF EXISTS(SELECT 1 FROM implementation.implementation_checklists WHERE template_id=@template AND deleted_at IS NULL)
    THROW 53572, N'CA-31: deleted checklist was still counted as a live use.', 1;
  INSERT implementation.implementation_checklists(id,client_id,client_name_snapshot,template_id,version_id,requires_environment,owner_user_id,created_by)
  VALUES (@next,@client,N'QA ERP',@template,@v1,0,@actor,@actor);
  IF (SELECT COUNT(*) FROM implementation.implementation_checklists WHERE template_id=@template)<>2
    THROW 53573, N'CA-09: expected both retained and live checklists.', 1;

  -- CA-08/21/23/31: a new environment-aware current version does not change
  -- the pinned version; both live statuses count as uses.
  UPDATE implementation.checklist_template_versions SET status='frozen' WHERE id=@v1;
  UPDATE implementation.checklist_template_versions
    SET status='current',requires_environment=1,published_at=SYSUTCDATETIME(),published_by=@actor WHERE id=@v3;
  INSERT implementation.implementation_checklists(client_id,client_name_snapshot,template_id,version_id,requires_environment,environment,owner_user_id,created_by)
  VALUES (@client,N'QA ERP',@template,@v3,1,'testing',@actor,@actor),
         (@client,N'QA ERP',@template,@v3,1,'production',@actor,@actor);
  UPDATE implementation.implementation_checklists
    SET status='completed',completed_at=SYSUTCDATETIME(),completed_by=@actor WHERE id=@next;
  IF (SELECT COUNT(*) FROM implementation.implementation_checklists WHERE template_id=@template AND deleted_at IS NULL)<>3
    OR NOT EXISTS(SELECT 1 FROM implementation.implementation_checklists
      WHERE id=@next AND version_id=@v1 AND environment IS NULL AND status='completed')
    THROW 53577, N'Expected pinned history and both live statuses in template uses.', 1;

  IF NOT EXISTS(SELECT 1 FROM implementation.implementation_checklist_evidence
    WHERE checklist_id=@checklist AND template_point_id=@p1 AND status='pending')
    THROW 53578, N'Logical checklist deletion lost the original point evidence.', 1;

  UPDATE implementation.checklist_templates SET deleted_at=SYSUTCDATETIME(),deleted_by=@actor WHERE id=@other;
  INSERT implementation.checklist_templates(name,created_by) VALUES (N'otra '+@salt,@actor);
  ROLLBACK TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

IF EXISTS(SELECT 1 FROM security.users WHERE source_id=@salt)
  OR EXISTS(SELECT 1 FROM core.catalog_customer_ids WHERE customer_id IN (@client,@otherClient))
  OR EXISTS(SELECT 1 FROM implementation.checklist_templates WHERE id=@template OR name LIKE N'%'+@salt)
  OR EXISTS(SELECT 1 FROM implementation.implementation_checklists WHERE id IN(@checklist,@next))
  THROW 53574, N'Rollback left synthetic rows behind.', 1;

SELECT CAST(1 AS bit) AS checklists_fixture_rolled_back;
