SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns074Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns074Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock074 int;
  EXEC @lock074=sys.sp_getapplock @Resource=N'portal-sag:migration:074:schedule-population-sag-v2',
    @LockMode=N'Exclusive', @LockOwner=N'Transaction', @DbPrincipal=N'public', @LockTimeout=5000;
  IF @lock074<0 THROW 57400,N'Could not reserve schedule population migration lock.',1;
  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_population_approvals_register',N'TR') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_customer_directory_rows',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_match_key_registry',N'U') IS NULL
    THROW 57401,N'Install schedule population approvals and sealed SAG V2 directory before this migration.',1;

  EXEC sys.sp_executesql N'ALTER TRIGGER scheduling.TR_catalog_schedule_population_approvals_register
    ON scheduling.catalog_schedule_population_approvals INSTEAD OF INSERT AS
  BEGIN
    SET NOCOUNT ON;
    IF EXISTS(SELECT 1 FROM inserted WHERE retired_at IS NOT NULL)
      THROW 54602,N''A catalog population cannot be approved as already retired.'',1;
    IF EXISTS (
      SELECT 1 FROM inserted n WHERE NOT EXISTS (
        SELECT 1 FROM security.users u WITH (HOLDLOCK)
        JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key AND ur.role_id=N''super_admin''
        JOIN security.roles role_record WITH (HOLDLOCK) ON role_record.role_id=ur.role_id AND role_record.active=1
          AND role_record.system_role=1 AND role_record.protected_role=1
        WHERE u.user_key=n.approved_by AND u.active=1
      )
    ) THROW 54603,N''A catalog population approval requires an active superadministrator.'',1;

    DECLARE @approvedAt datetime2(3)=SYSUTCDATETIME();
    IF EXISTS (
      SELECT 1 FROM inserted n WHERE
        (SELECT COUNT(DISTINCT b.source_role)
          FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
          JOIN settings.external_database_connections p WITH (HOLDLOCK)
            ON p.external_database_connection_key=b.external_database_connection_key
          WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=n.portal_environment
            AND DATALENGTH(b.portal_environment)=DATALENGTH(n.portal_environment)
            AND b.source_state=''active'' AND b.validated_at<=@approvedAt AND b.validated_profile_version=p.row_version
            AND p.status=''active'' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
            AND ((b.source_role=''erp-customers'' AND b.contract_version=''erp_v1'')
              OR (b.source_role=''sag-admin'' AND b.contract_version=''sag_admin_v1'')
              OR (b.source_role=''sag-admin'' AND b.contract_version COLLATE Latin1_General_100_BIN2=''sag_admin_v2''
                AND DATALENGTH(b.contract_version)=12 AND EXISTS (
                  SELECT 1 FROM settings.catalog_customer_revision_heads h WITH (HOLDLOCK)
                  JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK) ON r.revision_key=h.revision_key
                    AND r.catalog_source_key=b.catalog_source_key AND r.source_role=b.source_role AND r.attempt_ordinal=h.attempt_ordinal
                  JOIN settings.catalog_match_key_registry k WITH (HOLDLOCK) ON k.portal_environment=n.portal_environment
                    AND k.match_key_version=r.match_key_version AND k.enrolled_at<=@approvedAt
                  WHERE h.catalog_source_key=b.catalog_source_key AND h.attempt_status=''succeeded'' AND h.attempted_at<=@approvedAt
                    AND r.binding_version=b.row_version AND r.profile_version=p.row_version AND r.observed_at<=@approvedAt
                    AND r.sealed_at<=@approvedAt AND r.verified_until>@approvedAt AND r.has_sag_inventory_evidence=1
                    AND r.expected_sag_company_rows IS NOT NULL
                    AND (SELECT COUNT_BIG(*) FROM core.catalog_sag_customer_directory_rows d WITH (HOLDLOCK)
                      WHERE d.revision_key=r.revision_key)=r.expected_rows
                    AND (SELECT COUNT_BIG(*) FROM core.catalog_sag_company_revision_rows c WITH (HOLDLOCK)
                      WHERE c.revision_key=r.revision_key)=r.expected_sag_company_rows))))<>2
    ) THROW 54604,N''A catalog population requires certified ERP and SAG Admin bindings in this environment.'',1;

    INSERT scheduling.catalog_schedule_population_approvals(
      population_id,portal_environment,source_count,link_count,population_sha256,approved_by,approved_at,valid_until)
    SELECT COALESCE(population_id,NEWID()),portal_environment,source_count,link_count,population_sha256,
      approved_by,@approvedAt,valid_until FROM inserted;
  END;';

  IF @owns074Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns074Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
