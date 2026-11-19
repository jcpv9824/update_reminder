/* Positive database-link proof only; no target registration, caller grants,
   coverage assertions, output evidence, or modifications to installed modules. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns056 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns056=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND collation_name=N'Modern_Spanish_CI_AS')
    THROW 55601,N'Expected Portal database on SQL Server 2019 compatibility level 150.',1;

  DECLARE @lock056 int;
  EXEC @lock056=sys.sp_getapplock @Resource=N'portal-sag:migration:056:sag-target-link-proof',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock056<0 THROW 55602,N'Could not reserve the SAG target link proof migration.',1;

  IF OBJECT_ID(N'core.catalog_operational_link_evidence',N'V') IS NULL
    OR OBJECT_ID(N'core.catalog_operational_link_approvals',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_physical_target_links',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U') IS NULL
    OR OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets',N'P') IS NULL
    OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NULL
    OR EXISTS (SELECT 1 FROM (VALUES
      (OBJECT_ID(N'core.TR_catalog_sag_company_revision_seal',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sag_company_location_observations_guard',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_stamp',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_immutable',N'TR'))
    ) mandatory(object_id) LEFT JOIN sys.triggers t ON t.object_id=mandatory.object_id
      WHERE t.object_id IS NULL OR t.is_disabled=1)
    THROW 55603,N'Install the reviewed operational-link, physical-target and SAG observation prerequisites first.',1;

  -- The caller authorizes the operation and supplies the location HMAC from
  -- the already approved, version-pinned 036 access profile. The existing
  -- catalog fingerprint is a drift veto only, not target identity. This seam
  -- never accepts or projects a plain locator. Reporting still needs 037;
  -- 054 only corroborates the physical instance here.
  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.verify_catalog_sag_target_link_internal
    @environment varchar(32), @purpose varchar(16),
    @operationalLinkId uniqueidentifier, @physicalLinkId uniqueidentifier, @physicalTargetId uniqueidentifier,
    @accessProfileVersion varbinary(32), @sagSourceId uniqueidentifier, @sagRevisionKey bigint,
    @sagCompanyRecordId int, @matchKeyVersion smallint, @locationToken varbinary(64),
    @reportInstanceId uniqueidentifier, @validUntil datetime2(3) OUTPUT
  AS
  BEGIN
    SET NOCOUNT ON;
    SET @validUntil=NULL;
    IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
      OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
      RETURN;

    DECLARE @zero uniqueidentifier=''00000000-0000-0000-0000-000000000000'';
    IF @environment IS NULL OR NOT (
        (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
          AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
        OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
          AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
      OR @purpose IS NULL OR NOT (
        (@purpose COLLATE Latin1_General_100_BIN2=''task'' AND DATALENGTH(@purpose)=4 AND @reportInstanceId IS NULL)
        OR (@purpose COLLATE Latin1_General_100_BIN2=''report'' AND DATALENGTH(@purpose)=6
          AND @reportInstanceId IS NOT NULL AND @reportInstanceId<>@zero))
      OR @operationalLinkId IS NULL OR @operationalLinkId=@zero
      OR @physicalLinkId IS NULL OR @physicalLinkId=@zero
      OR @physicalTargetId IS NULL OR @physicalTargetId=@zero
      OR @accessProfileVersion IS NULL OR DATALENGTH(@accessProfileVersion)<>8
      OR @sagSourceId IS NULL OR @sagSourceId=@zero
      OR @sagRevisionKey IS NULL OR @sagRevisionKey<=0 OR @sagCompanyRecordId IS NULL
      OR @matchKeyVersion IS NULL OR @matchKeyVersion<=0
      OR @locationToken IS NULL OR DATALENGTH(@locationToken)<>32
      RETURN;

    DECLARE @now datetime2(3)=SYSUTCDATETIME(),@deadline datetime2(3);
    SELECT @deadline=validity.valid_until
    FROM core.catalog_operational_links ol WITH (HOLDLOCK)
    JOIN core.catalog_operational_owners own WITH (HOLDLOCK)
      ON own.owner_key=ol.owner_key AND own.client_key=ol.client_key AND own.portal_environment=ol.portal_environment
      AND own.retired_at IS NULL AND own.registered_at<=@now
    JOIN core.clients cl WITH (HOLDLOCK) ON cl.client_key=ol.client_key AND cl.status=''active''
    JOIN core.domains dm WITH (HOLDLOCK)
      ON dm.domain_key=ol.domain_key AND dm.client_key=ol.client_key AND dm.status=''active''
    -- 036 binds the operational database key, not an environment column of
    -- its own. Check that exact database row against the 042 link environment.
    JOIN core.databases db WITH (HOLDLOCK)
      ON db.database_key=ol.database_key AND db.domain_key=ol.domain_key AND db.client_key=ol.client_key AND db.status=''active''
      AND db.environment_id COLLATE Latin1_General_100_BIN2=ol.link_environment
      AND DATALENGTH(db.environment_id)=DATALENGTH(ol.link_environment)
    JOIN core.database_access_profiles access_profile WITH (HOLDLOCK)
      ON access_profile.access_profile_key=db.access_profile_key AND access_profile.active=1
      AND access_profile.row_version=@accessProfileVersion
    JOIN core.catalog_physical_target_links physical_link WITH (HOLDLOCK)
      ON physical_link.link_id=@physicalLinkId AND physical_link.portal_environment=ol.portal_environment
      AND physical_link.target_kind=''database'' AND physical_link.client_key=ol.client_key
      AND physical_link.domain_key=ol.domain_key AND physical_link.database_key=ol.database_key
      AND physical_link.access_profile_key=access_profile.access_profile_key
      AND physical_link.access_profile_version=access_profile.row_version
      AND physical_link.retired_at IS NULL AND physical_link.verified_at<=@now AND physical_link.valid_until>@now
    JOIN core.catalog_physical_targets physical_target WITH (HOLDLOCK)
      ON physical_target.physical_target_key=physical_link.physical_target_key
      AND physical_target.target_id=@physicalTargetId AND physical_target.portal_environment=ol.portal_environment
      AND physical_target.target_kind=''database'' AND physical_target.created_at<=@now
      AND physical_target.database_name_fingerprint=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),access_profile.initial_catalog))

    JOIN settings.catalog_match_key_registry key_registry WITH (HOLDLOCK)
      ON key_registry.portal_environment=ol.portal_environment AND key_registry.match_key_version=@matchKeyVersion
      AND key_registry.enrolled_at<=@now
    JOIN settings.catalog_source_bindings erp_binding WITH (HOLDLOCK)
      ON erp_binding.catalog_source_key=ol.catalog_source_key AND erp_binding.portal_environment COLLATE Latin1_General_100_BIN2=ol.portal_environment
      AND DATALENGTH(erp_binding.portal_environment)=DATALENGTH(ol.portal_environment)
      AND erp_binding.source_role COLLATE Latin1_General_100_BIN2=''erp-customers'' AND DATALENGTH(erp_binding.source_role)=13
      AND erp_binding.contract_version COLLATE Latin1_General_100_BIN2=''erp_v1'' AND DATALENGTH(erp_binding.contract_version)=6
      AND erp_binding.source_state=''active'' AND erp_binding.validated_at<=@now
    JOIN settings.external_database_connections erp_profile WITH (HOLDLOCK)
      ON erp_profile.external_database_connection_key=erp_binding.external_database_connection_key
      AND erp_profile.row_version=erp_binding.validated_profile_version
      AND erp_profile.active=1 AND erp_profile.status=''active'' AND erp_profile.encrypt_connection=1 AND erp_profile.password_configured=1
    JOIN settings.catalog_customer_revision_heads erp_head WITH (HOLDLOCK)
      ON erp_head.catalog_source_key=erp_binding.catalog_source_key AND erp_head.attempt_status=''succeeded''
      AND erp_head.attempted_at<=@now
    JOIN core.catalog_customer_source_revisions erp_revision WITH (HOLDLOCK)
      ON erp_revision.revision_key=erp_head.revision_key AND erp_revision.attempt_ordinal=erp_head.attempt_ordinal
      AND erp_revision.catalog_source_key=erp_binding.catalog_source_key AND erp_revision.source_role=erp_binding.source_role
      AND erp_revision.binding_version=erp_binding.row_version AND erp_revision.profile_version=erp_profile.row_version
      AND erp_revision.match_key_version=key_registry.match_key_version AND erp_revision.observed_at<=@now
      AND erp_revision.sealed_at<=@now AND erp_revision.verified_until>@now
    JOIN core.catalog_operational_link_approvals approval WITH (HOLDLOCK)
      ON approval.link_key=ol.link_key AND approval.binding_version=erp_revision.binding_version
      AND approval.profile_version=erp_revision.profile_version AND approval.revision_key<=erp_revision.revision_key
      AND approval.approved_at BETWEEN ol.registered_at AND @now
    JOIN core.catalog_customer_revision_rows erp_record WITH (HOLDLOCK)
      ON erp_record.revision_key=erp_revision.revision_key AND erp_record.source_record_id=ol.source_record_id
      AND erp_record.catalog_customer_key=own.catalog_customer_key AND erp_record.active_code=''S''
      AND erp_record.issuer IS NOT NULL AND erp_record.document_type IS NOT NULL AND erp_record.document_number_token IS NOT NULL

    JOIN settings.catalog_source_bindings sag_binding WITH (HOLDLOCK)
      ON sag_binding.source_id=@sagSourceId AND sag_binding.portal_environment COLLATE Latin1_General_100_BIN2=ol.portal_environment
      AND DATALENGTH(sag_binding.portal_environment)=DATALENGTH(ol.portal_environment)
      AND sag_binding.source_role COLLATE Latin1_General_100_BIN2=''sag-admin'' AND DATALENGTH(sag_binding.source_role)=9
      AND sag_binding.contract_version COLLATE Latin1_General_100_BIN2=''sag_admin_v2'' AND DATALENGTH(sag_binding.contract_version)=12
      AND sag_binding.source_state=''active'' AND sag_binding.validated_at<=@now
    JOIN settings.external_database_connections sag_profile WITH (HOLDLOCK)
      ON sag_profile.external_database_connection_key=sag_binding.external_database_connection_key
      AND sag_profile.row_version=sag_binding.validated_profile_version
      AND sag_profile.active=1 AND sag_profile.status=''active'' AND sag_profile.encrypt_connection=1 AND sag_profile.password_configured=1
    JOIN settings.catalog_customer_revision_heads sag_head WITH (HOLDLOCK)
      ON sag_head.catalog_source_key=sag_binding.catalog_source_key AND sag_head.revision_key=@sagRevisionKey
      AND sag_head.attempt_status=''succeeded'' AND sag_head.attempted_at<=@now
    JOIN core.catalog_customer_source_revisions sag_revision WITH (HOLDLOCK)
      ON sag_revision.revision_key=sag_head.revision_key AND sag_revision.attempt_ordinal=sag_head.attempt_ordinal
      AND sag_revision.catalog_source_key=sag_binding.catalog_source_key AND sag_revision.source_role=sag_binding.source_role
      AND sag_revision.binding_version=sag_binding.row_version AND sag_revision.profile_version=sag_profile.row_version
      AND sag_revision.match_key_version=key_registry.match_key_version AND sag_revision.observed_at<=@now
      AND sag_revision.sealed_at<=@now AND sag_revision.verified_until>@now
      AND sag_revision.has_sag_inventory_evidence=1 AND sag_revision.expected_sag_company_rows>0
    JOIN core.catalog_sag_company_location_seals location_seal WITH (HOLDLOCK)
      ON location_seal.revision_key=sag_revision.revision_key
      AND location_seal.expected_company_rows=sag_revision.expected_sag_company_rows
      AND location_seal.sealed_at BETWEEN sag_revision.sealed_at AND @now
    JOIN core.catalog_sag_company_revision_rows company WITH (HOLDLOCK)
      ON company.revision_key=sag_revision.revision_key AND company.company_record_id=@sagCompanyRecordId
      AND company.is_available=1
    JOIN core.catalog_sag_company_location_observations observation WITH (HOLDLOCK)
      ON observation.revision_key=company.revision_key AND observation.company_record_id=company.company_record_id
      AND observation.observation_state=''candidate'' AND observation.format_version=1 AND observation.location_token=@locationToken
    JOIN core.catalog_customer_revision_rows sag_parent WITH (HOLDLOCK)
      ON sag_parent.revision_key=company.revision_key AND sag_parent.source_record_id=company.customer_record_id
      AND sag_parent.issuer=erp_record.issuer AND sag_parent.document_type=erp_record.document_type
      AND DATALENGTH(sag_parent.document_type)=DATALENGTH(erp_record.document_type)
      AND sag_parent.document_number_token=erp_record.document_number_token
    JOIN core.catalog_sag_revision_evidence sag_customer WITH (HOLDLOCK)
      ON sag_customer.revision_key=sag_parent.revision_key AND sag_customer.source_record_id=sag_parent.source_record_id
      AND sag_customer.environment_kind=ol.link_environment AND DATALENGTH(sag_customer.environment_kind)=DATALENGTH(ol.link_environment)
    CROSS APPLY (SELECT MIN(bounds.valid_until) AS valid_until
      FROM (VALUES(physical_link.valid_until),(erp_revision.verified_until),(sag_revision.verified_until)) bounds(valid_until)
    ) validity
    WHERE ol.link_id=@operationalLinkId AND ol.portal_environment=@environment COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(ol.portal_environment)=DATALENGTH(@environment) AND ol.target_kind=''database''
      AND ol.retired_at IS NULL AND ol.registered_at<=@now
      AND NOT EXISTS (SELECT 1 FROM core.catalog_customer_revision_rows competing WITH (HOLDLOCK)
        WHERE competing.revision_key=erp_revision.revision_key AND competing.source_record_id<>erp_record.source_record_id
          AND ((competing.catalog_customer_key=own.catalog_customer_key
            AND (competing.issuer IS NULL OR competing.document_type IS NULL OR competing.document_number_token IS NULL
              OR competing.issuer<>erp_record.issuer OR competing.document_type<>erp_record.document_type
              OR DATALENGTH(competing.document_type)<>DATALENGTH(erp_record.document_type)
              OR competing.document_number_token<>erp_record.document_number_token))
            OR (competing.catalog_customer_key<>own.catalog_customer_key
              AND competing.issuer=erp_record.issuer AND competing.document_type=erp_record.document_type
              AND DATALENGTH(competing.document_type)=DATALENGTH(erp_record.document_type)
              AND competing.document_number_token=erp_record.document_number_token)))
      AND NOT EXISTS (SELECT 1 FROM core.catalog_customer_revision_rows unresolved WITH (HOLDLOCK)
        WHERE unresolved.revision_key=sag_revision.revision_key AND unresolved.issuer IS NULL
          AND unresolved.document_number_token=erp_record.document_number_token)
      AND (@purpose=''task'' OR EXISTS (
        SELECT 1 FROM core.catalog_sql_target_instance_identities instance_proof WITH (HOLDLOCK)
        WHERE instance_proof.physical_target_key=physical_target.physical_target_key
          AND instance_proof.portal_environment=ol.portal_environment AND instance_proof.target_kind=''database''
          AND instance_proof.trusted_instance_id=@reportInstanceId AND instance_proof.registered_at<=@now));

    -- The locks outlive this procedure in the authorized caller transaction.
    -- Expiry is checked after lock waits and must also be fenced by that caller.
    IF @deadline>SYSUTCDATETIME() SET @validUntil=@deadline;
  END;';

  DECLARE @owned056 table(object_id int NULL);
  INSERT @owned056 VALUES
    (OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P')),
    (OBJECT_ID(N'core.catalog_operational_links',N'U')),
    (OBJECT_ID(N'core.catalog_operational_owners',N'U')),
    (OBJECT_ID(N'core.catalog_operational_link_approvals',N'U')),
    (OBJECT_ID(N'core.clients',N'U')),
    (OBJECT_ID(N'core.domains',N'U')),
    (OBJECT_ID(N'core.databases',N'U')),
    (OBJECT_ID(N'core.database_access_profiles',N'U')),
    (OBJECT_ID(N'core.catalog_physical_target_links',N'U')),
    (OBJECT_ID(N'core.catalog_physical_targets',N'U')),
    (OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U')),
    (OBJECT_ID(N'settings.catalog_match_key_registry',N'U')),
    (OBJECT_ID(N'settings.catalog_source_bindings',N'U')),
    (OBJECT_ID(N'settings.external_database_connections',N'U')),
    (OBJECT_ID(N'settings.catalog_customer_revision_heads',N'U')),
    (OBJECT_ID(N'core.catalog_customer_source_revisions',N'U')),
    (OBJECT_ID(N'core.catalog_customer_revision_rows',N'U')),
    (OBJECT_ID(N'core.catalog_sag_revision_evidence',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U'));
  IF EXISTS(SELECT 1 FROM @owned056 expected
    LEFT JOIN sys.objects o ON o.object_id=expected.object_id
    LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id
    WHERE o.object_id IS NULL OR COALESCE(o.principal_id,s.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 55604,N'The SAG target link static ownership chain is incomplete.',1;

  -- Static same-owner invocation skips the callee permission check, unlike
  -- direct app/role execution. No principal is created or enrolled.
  DENY EXECUTE ON OBJECT::settings.verify_catalog_sag_target_link_internal TO public;
  IF @owns056=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns056=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
