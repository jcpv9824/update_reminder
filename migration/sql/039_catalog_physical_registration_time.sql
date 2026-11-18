/*
  Proof verification can precede registration. Only the SQL-owned registration
  instant can establish when a physical link was available for a scheduled
  occurrence. Existing links receive the migration-time default conservatively:
  no legacy link is presumed to have been registered at its verification time.
  This migration changes neither grants nor existing identity/retirement rules.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'core.catalog_physical_target_links', N'U') IS NULL
  OR OBJECT_ID(N'core.TR_catalog_physical_target_links_evidence', N'TR') IS NULL
  THROW 53900, N'Install the verified physical link registry before registration timestamps.', 1;

IF COL_LENGTH(N'core.catalog_physical_target_links', N'registered_at') IS NULL
  ALTER TABLE core.catalog_physical_target_links ADD registered_at datetime2(3) NOT NULL
    CONSTRAINT DF_catalog_physical_target_links_registered DEFAULT SYSUTCDATETIME() WITH VALUES;

IF OBJECT_ID(N'core.TR_catalog_physical_target_links_register', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_physical_target_links_register
    ON core.catalog_physical_target_links INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @registeredAt datetime2(3)=SYSUTCDATETIME();
      -- Ignore any submitted timestamp. This insert continues into the ordinary
      -- constraints and the 036 AFTER trigger; all of its evidence checks remain.
      INSERT INTO core.catalog_physical_target_links(
        link_id,physical_target_key,portal_environment,target_kind,client_key,domain_key,database_key,
        access_profile_key,access_profile_version,domain_route_fingerprint,proof_id,verified_by,verified_at,
        valid_until,retired_at,registered_at)
      SELECT COALESCE(n.link_id,NEWID()),n.physical_target_key,n.portal_environment,n.target_kind,n.client_key,
        n.domain_key,n.database_key,n.access_profile_key,n.access_profile_version,n.domain_route_fingerprint,
        n.proof_id,n.verified_by,n.verified_at,n.valid_until,n.retired_at,@registeredAt
      FROM inserted AS n;
    END;';

IF OBJECT_ID(N'core.TR_catalog_physical_target_links_registered_at_immutable', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_physical_target_links_registered_at_immutable
    ON core.catalog_physical_target_links AFTER UPDATE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (
        SELECT 1 FROM deleted AS o
        JOIN inserted AS n ON n.physical_target_link_key=o.physical_target_link_key
        WHERE n.registered_at<>o.registered_at
      )
        THROW 53901, N''A physical link registration timestamp is immutable.'', 1;
    END;';
