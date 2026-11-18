/*
  Independent approval of a reviewed catalog population for scheduling.
  The authority supplies the digest; SQL does not derive completeness from
  counts, available hosts, or observations. The reader must recompute the
  exact digest and verify current, complete source/link evidence.
  This migration never creates approvals or changes permissions elsewhere.
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

DECLARE @owns046Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns046Transaction=1 BEGIN TRANSACTION;
  DECLARE @lock046 int;
  EXEC @lock046=sys.sp_getapplock @Resource=N'portal-sag:migration:046:schedule-population-approvals',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock046<0 THROW 54600,N'Could not reserve the schedule population approval migration lock.',1;

  IF OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_source_bindings',N'U') IS NULL
    OR OBJECT_ID(N'settings.external_database_connections',N'U') IS NULL
    OR OBJECT_ID(N'security.users',N'U') IS NULL OR OBJECT_ID(N'security.user_roles',N'U') IS NULL
    OR OBJECT_ID(N'security.roles',N'U') IS NULL
    THROW 54601,N'Install source bindings, security and schedule approvals before population approvals.',1;

  IF OBJECT_ID(N'scheduling.catalog_schedule_population_approvals',N'U') IS NULL
  BEGIN
    CREATE TABLE scheduling.catalog_schedule_population_approvals
    (
      population_id uniqueidentifier NOT NULL CONSTRAINT DF_catalog_schedule_population_approvals_id DEFAULT NEWSEQUENTIALID(),
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      source_count int NOT NULL,
      link_count int NOT NULL,
      population_sha256 binary(32) NOT NULL,
      approved_by bigint NOT NULL,
      approved_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_schedule_population_approvals_at DEFAULT SYSUTCDATETIME(),
      valid_until datetime2(3) NOT NULL,
      retired_at datetime2(3) NULL,

      CONSTRAINT PK_catalog_schedule_population_approvals PRIMARY KEY CLUSTERED(population_id),
      CONSTRAINT FK_catalog_schedule_population_approvals_approver FOREIGN KEY(approved_by)
        REFERENCES security.users(user_key),
      CONSTRAINT CK_catalog_schedule_population_approvals_environment CHECK (
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_schedule_population_approvals_counts CHECK (
        source_count BETWEEN 2 AND 50 AND link_count BETWEEN 1 AND 5000),
      CONSTRAINT CK_catalog_schedule_population_approvals_validity CHECK (
        valid_until>approved_at AND valid_until<=DATEADD(day,30,approved_at)
        AND (retired_at IS NULL OR retired_at>=approved_at))
    );
  END;

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'scheduling.catalog_schedule_population_approvals',N'U')
    AND name=N'UX_catalog_schedule_population_approvals_open')
    CREATE UNIQUE NONCLUSTERED INDEX UX_catalog_schedule_population_approvals_open
      ON scheduling.catalog_schedule_population_approvals(portal_environment)
      WHERE retired_at IS NULL;

  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_population_approvals_register',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_population_approvals_register
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
      )
        THROW 54603,N''A catalog population approval requires an active superadministrator.'',1;

      DECLARE @approvedAt datetime2(3)=SYSUTCDATETIME();
      -- Merely a role prerequisite; these rows do not attest what is in the
      -- reviewed digest. The reader compares the complete, current population.
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
                OR (b.source_role=''sag-admin'' AND b.contract_version=''sag_admin_v1'')))<>2
      )
        THROW 54604,N''A catalog population requires certified ERP and SAG Admin bindings in this environment.'',1;

      INSERT scheduling.catalog_schedule_population_approvals(
        population_id,portal_environment,source_count,link_count,population_sha256,approved_by,approved_at,valid_until)
      SELECT COALESCE(population_id,NEWID()),portal_environment,source_count,link_count,population_sha256,
        approved_by,@approvedAt,valid_until FROM inserted;
    END;';

  IF OBJECT_ID(N'scheduling.TR_catalog_schedule_population_approvals_retire',N'TR') IS NULL
    EXEC sys.sp_executesql N'CREATE TRIGGER scheduling.TR_catalog_schedule_population_approvals_retire
      ON scheduling.catalog_schedule_population_approvals INSTEAD OF UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (
        SELECT 1 FROM deleted o LEFT JOIN inserted n ON n.population_id=o.population_id
        WHERE n.population_id IS NULL OR o.retired_at IS NOT NULL OR n.retired_at IS NULL
          OR EXISTS (
            SELECT n.portal_environment,DATALENGTH(n.portal_environment),n.source_count,n.link_count,
              n.population_sha256,n.approved_by,n.approved_at,n.valid_until
            EXCEPT
            SELECT o.portal_environment,DATALENGTH(o.portal_environment),o.source_count,o.link_count,
              o.population_sha256,o.approved_by,o.approved_at,o.valid_until)
      )
        THROW 54605,N''Catalog population approval history is immutable except for one-time retirement.'',1;

      DECLARE @retiredAt datetime2(3)=SYSUTCDATETIME();
      UPDATE o SET retired_at=@retiredAt
      FROM scheduling.catalog_schedule_population_approvals o
      JOIN inserted n ON n.population_id=o.population_id
      WHERE o.retired_at IS NULL;
      IF @@ROWCOUNT<>(SELECT COUNT_BIG(*) FROM inserted)
        THROW 54605,N''A catalog population approval was already retired.'',1;
    END;';

  IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
    DENY INSERT,UPDATE,DELETE ON OBJECT::scheduling.catalog_schedule_population_approvals TO portal_runtime;

  IF @owns046Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns046Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
