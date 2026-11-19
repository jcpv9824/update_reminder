/* Fixed operator batch body. Execute through Register-PortalSAGWeb-CatalogOperationalLink.ps1 only. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0 OR
  NOT ((@environment='qa' AND DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34)
    OR (@environment='production' AND DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24))
  OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
  THROW 54260,N'Operational link request rejected.',1;

SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @now datetime2(3)=SYSUTCDATETIME(),@lock int,@resource nvarchar(255)=N'portal-sag:operational-link-operator:'+@environment;
  EXEC @lock=sys.sp_getapplock @Resource=@resource,@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=4000;
  IF @lock<0 THROW 54260,N'Operational link request rejected.',1;
  IF (SELECT COUNT(*) FROM sys.triggers WHERE is_disabled=0 AND object_id IN (
      OBJECT_ID(N'core.TR_catalog_operational_owner_register',N'TR'),
      OBJECT_ID(N'core.TR_catalog_operational_link_register',N'TR'),
      OBJECT_ID(N'core.TR_catalog_operational_approval_stamp',N'TR'),
      OBJECT_ID(N'core.TR_catalog_operational_approval_immutable',N'TR')))<>4
    THROW 54260,N'Operational link request rejected.',1;
  IF NOT EXISTS(
    SELECT 1 FROM security.users u WITH (HOLDLOCK)
    JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key
    JOIN security.roles r WITH (HOLDLOCK) ON r.role_id=ur.role_id AND r.active=1 AND r.system_role=1 AND r.protected_role=1
    WHERE u.source_id=@actorId AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(u.source_id)=DATALENGTH(@actorId) AND u.active=1
      AND r.role_id COLLATE Latin1_General_100_BIN2=N'super_admin' AND DATALENGTH(r.role_id)=22
      AND 3=(SELECT COUNT(*) FROM (VALUES(N'configuration.integrations.view'),(N'configuration.integrations.test_database'),
        (N'configuration.integrations.edit_database')) required(permission_key)
        JOIN security.permissions p WITH (HOLDLOCK) ON p.active=1
          AND p.permission_key COLLATE Latin1_General_100_BIN2=required.permission_key COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(p.permission_key)=DATALENGTH(required.permission_key)
        JOIN security.role_permissions rp WITH (HOLDLOCK) ON rp.role_id=r.role_id AND rp.permission_key=p.permission_key))
    THROW 54260,N'Operational link request rejected.',1;

  DECLARE @client bigint,@domain bigint,@database bigint,@physicalUntil datetime2(3);
  SELECT @client=c.client_key,@domain=d.domain_key,@database=db.database_key,@physicalUntil=l.valid_until
  FROM core.catalog_physical_target_links l WITH (HOLDLOCK)
  JOIN core.catalog_physical_targets t WITH (HOLDLOCK) ON t.physical_target_key=l.physical_target_key
    AND t.portal_environment=l.portal_environment AND t.target_kind=l.target_kind
    AND t.target_id=@physicalTargetId AND t.row_version=@physicalTargetVersion AND t.created_at<=@now
  JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.status='active'
    AND c.source_id COLLATE Latin1_General_100_BIN2=@clientId COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(c.source_id)=DATALENGTH(@clientId)
  JOIN core.domains d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=c.client_key AND d.status='active'
    AND d.source_id COLLATE Latin1_General_100_BIN2=@domainId COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(d.source_id)=DATALENGTH(@domainId)
  LEFT JOIN core.databases db WITH (HOLDLOCK) ON db.database_key=l.database_key AND db.client_key=c.client_key
    AND db.domain_key=d.domain_key AND db.status='active'
    AND db.source_id COLLATE Latin1_General_100_BIN2=@databaseId COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(db.source_id)=DATALENGTH(@databaseId)
  LEFT JOIN core.database_access_profiles p WITH (HOLDLOCK) ON p.access_profile_key=db.access_profile_key
    AND p.access_profile_key=l.access_profile_key AND p.active=1 AND p.row_version=l.access_profile_version
    AND p.row_version=@operationalProfileVersion
  WHERE l.link_id=@physicalLinkId AND l.proof_id=@physicalProofId AND l.row_version=@physicalLinkVersion
    AND l.portal_environment=@environment AND l.target_kind=@targetKind AND l.retired_at IS NULL
    AND l.verified_at<=@now AND l.valid_until>@now
    AND ((@targetKind='database' AND db.database_key IS NOT NULL AND p.access_profile_key IS NOT NULL
        AND db.environment_id COLLATE Latin1_General_100_BIN2=@linkEnvironment
        AND DATALENGTH(db.environment_id)=DATALENGTH(@linkEnvironment)
        AND t.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),p.initial_catalog)))
      OR (@targetKind='domain' AND @databaseId IS NULL AND @operationalProfileVersion IS NULL AND l.database_key IS NULL
        AND d.environment_id COLLATE Latin1_General_100_BIN2=@linkEnvironment
        AND DATALENGTH(d.environment_id)=DATALENGTH(@linkEnvironment)
        AND l.domain_route_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'portal-sag:web-route:v1|')
          +CONVERT(binary(4),DATALENGTH(d.domain_name_normalized))+CONVERT(varbinary(max),d.domain_name_normalized)
          +CASE WHEN d.publishable_domain IS NULL THEN CONVERT(varbinary(max),0x00)
             ELSE CONVERT(varbinary(max),0x01)+CONVERT(binary(4),DATALENGTH(d.publishable_domain))
               +CONVERT(varbinary(max),d.publishable_domain) END)));
  IF @client IS NULL OR @domain IS NULL OR @physicalUntil IS NULL THROW 54260,N'Operational link request rejected.',1;

  DECLARE @customer bigint,@source bigint,@erpUntil datetime2(3);
  SELECT @customer=i.catalog_customer_key,@source=b.catalog_source_key,@erpUntil=r.verified_until
  FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
  JOIN settings.external_database_connections p WITH (HOLDLOCK)
    ON p.external_database_connection_key=b.external_database_connection_key AND p.row_version=@erpProfileVersion
    AND p.row_version=b.validated_profile_version AND p.active=1 AND p.status='active'
    AND p.encrypt_connection=1 AND p.password_configured=1
  JOIN settings.catalog_customer_revision_heads h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
    AND h.revision_key=@erpRevisionId AND h.attempt_status='succeeded' AND h.attempted_at<=@now
  JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK) ON r.revision_key=h.revision_key
    AND r.catalog_source_key=b.catalog_source_key AND r.source_role=b.source_role AND r.attempt_ordinal=h.attempt_ordinal
    AND r.binding_version=@bindingVersion AND r.profile_version=@erpProfileVersion AND r.observed_at<=@now
    AND r.sealed_at<=@now AND r.verified_until>@now
  JOIN settings.catalog_match_key_registry k WITH (HOLDLOCK)
    ON k.portal_environment=b.portal_environment COLLATE Latin1_General_100_BIN2
    AND k.match_key_version=r.match_key_version AND k.enrolled_at<=@now
  JOIN core.catalog_customer_revision_rows rr WITH (HOLDLOCK) ON rr.revision_key=r.revision_key
    AND rr.source_record_id=@erpRecordId AND rr.active_code='S'
    AND rr.issuer IS NOT NULL AND rr.document_type IS NOT NULL AND rr.document_number_token IS NOT NULL
  JOIN core.catalog_customer_ids i WITH (HOLDLOCK) ON i.catalog_customer_key=rr.catalog_customer_key AND i.customer_id=@catalogOwnerId
  WHERE b.source_id=@erpSourceId AND b.row_version=@bindingVersion AND b.source_state='active'
    AND b.portal_environment COLLATE Latin1_General_100_BIN2=@environment AND b.validated_at<=@now
    AND b.source_role COLLATE Latin1_General_100_BIN2='erp-customers' AND DATALENGTH(b.source_role)=13
    AND b.contract_version COLLATE Latin1_General_100_BIN2='erp_v1' AND DATALENGTH(b.contract_version)=6
    -- Keep the ERP identity and competing-row boundary identical to 056/057.
    -- A same-owner duplicate with the full same identity is not ambiguity.
    AND NOT EXISTS(SELECT 1 FROM core.catalog_customer_revision_rows competing WITH (HOLDLOCK)
      WHERE competing.revision_key=r.revision_key AND competing.source_record_id<>rr.source_record_id
        AND ((competing.catalog_customer_key=rr.catalog_customer_key
          AND (competing.issuer IS NULL OR competing.document_type IS NULL OR competing.document_number_token IS NULL
            OR competing.issuer<>rr.issuer OR competing.document_type<>rr.document_type
            OR DATALENGTH(competing.document_type)<>DATALENGTH(rr.document_type)
            OR competing.document_number_token<>rr.document_number_token))
          OR (competing.catalog_customer_key<>rr.catalog_customer_key
            AND competing.issuer=rr.issuer AND competing.document_type=rr.document_type
            AND DATALENGTH(competing.document_type)=DATALENGTH(rr.document_type)
            AND competing.document_number_token=rr.document_number_token)));
  IF @customer IS NULL OR @source IS NULL OR @erpUntil IS NULL THROW 54260,N'Operational link request rejected.',1;

  DECLARE @owner bigint,@link bigint,@linkId uniqueidentifier,@existing bit=0;
  IF EXISTS(SELECT 1 FROM core.catalog_operational_owners WITH (UPDLOCK,HOLDLOCK)
    WHERE portal_environment=@environment AND retired_at IS NULL AND
      ((catalog_customer_key=@customer AND client_key<>@client) OR (client_key=@client AND catalog_customer_key<>@customer)))
    THROW 54260,N'Operational link request rejected.',1;
  SELECT @owner=owner_key FROM core.catalog_operational_owners WITH (UPDLOCK,HOLDLOCK)
    WHERE portal_environment=@environment AND catalog_customer_key=@customer AND client_key=@client AND retired_at IS NULL;
  SELECT @link=link_key,@linkId=link_id FROM core.catalog_operational_links WITH (UPDLOCK,HOLDLOCK)
    WHERE owner_key=@owner AND portal_environment=@environment AND client_key=@client AND domain_key=@domain
      AND ((database_key IS NULL AND @database IS NULL) OR database_key=@database)
      AND catalog_source_key=@source AND source_record_id=@erpRecordId AND target_kind=@targetKind
      AND link_environment=@linkEnvironment AND retired_at IS NULL;
  IF EXISTS(SELECT 1 FROM core.catalog_operational_link_approvals WITH (UPDLOCK,HOLDLOCK)
    WHERE (approval_reference=@approvalReferenceBase OR
      (LEFT(approval_reference,LEN(@approvalReferenceBase)+1)=@approvalReferenceBase+'.'
        AND DATALENGTH(approval_reference)=DATALENGTH(@approvalReferenceBase)+44)) AND
      (approval_reference<>@approvalReference OR link_key<>ISNULL(@link,0) OR binding_version<>@bindingVersion OR profile_version<>@erpProfileVersion
        OR revision_key<>@erpRevisionId OR approved_by COLLATE Latin1_General_100_BIN2<>@actorId COLLATE Latin1_General_100_BIN2
        OR DATALENGTH(approved_by)<>DATALENGTH(@actorId)))
    THROW 54260,N'Operational link request rejected.',1;
  IF EXISTS(SELECT 1 FROM core.catalog_operational_link_approvals WITH (UPDLOCK,HOLDLOCK)
    WHERE link_key=@link AND binding_version=@bindingVersion AND profile_version=@erpProfileVersion)
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM core.catalog_operational_link_approvals WITH (HOLDLOCK)
      WHERE link_key=@link AND binding_version=@bindingVersion AND profile_version=@erpProfileVersion
        AND revision_key=@erpRevisionId AND approval_reference=@approvalReference
        AND approved_by COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(approved_by)=DATALENGTH(@actorId)) THROW 54260,N'Operational link request rejected.',1;
    SET @existing=1;
  END;

  IF @apply=1 AND @existing=0
  BEGIN
    IF @owner IS NULL
    BEGIN
      INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by)
        VALUES(@environment,@customer,@client,@actorId);
      SELECT @owner=owner_key FROM core.catalog_operational_owners
        WHERE portal_environment=@environment AND catalog_customer_key=@customer AND client_key=@client AND retired_at IS NULL;
    END;
    IF @link IS NULL
    BEGIN
      SET @linkId=NEWID();
      INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
        catalog_source_key,source_record_id,target_kind,link_environment,registered_by)
        VALUES(@linkId,@owner,@environment,@client,@domain,@database,@source,@erpRecordId,@targetKind,@linkEnvironment,@actorId);
      SELECT @link=link_key FROM core.catalog_operational_links WHERE link_id=@linkId;
    END;
    INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
      VALUES(@link,@bindingVersion,@erpProfileVersion,@erpRevisionId,@approvalReference,@actorId);
    IF NOT EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id=@linkId AND evidence_state='verified'
      AND revision_key=@erpRevisionId AND binding_version=@bindingVersion AND profile_version=@erpProfileVersion)
      THROW 54260,N'Operational link request rejected.',1;
  END;
  SET @now=SYSUTCDATETIME();
  IF @physicalUntil<=@now OR @erpUntil<=@now OR XACT_STATE()<>1 THROW 54260,N'Operational link request rejected.',1;
  IF @apply=1 COMMIT TRANSACTION; ELSE ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  SELECT CASE WHEN @apply=0 THEN 'dry-run' WHEN @existing=1 THEN 'existing' ELSE 'registered' END AS [status],
    CASE WHEN @apply=1 OR @existing=1 THEN LOWER(CONVERT(char(36),@linkId)) END AS linkId;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  THROW 54260,N'Operational link request rejected.',1;
END CATCH;
