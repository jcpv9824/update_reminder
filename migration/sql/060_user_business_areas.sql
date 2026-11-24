/* Portal SAG Web - SQL Server 2019 / 060 — DRAFT, NOT APPLIED
   Área de negocio de cada usuario (Soporte, Desarrollo, Ventas, Administrativa).
   Es una clasificación, no un permiso: Qué hay de nuevo la exige junto con el
   permiso para crear (Desarrollo) o probar (Soporte) entradas.
   Solo agrega objetos vacíos y el catálogo de cuatro áreas. No asigna áreas a
   nadie, no toca roles ni permisos existentes. Reejecutable. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 53100,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 53101,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL
  THROW 53102,N'Migration history is missing.',1;
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='030' AND succeeded=1)
  THROW 53103,N'Run migration 030 first (catalog migrations are not a dependency).',1;
IF (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
  THROW 53106,N'Compatibility level 150 is required.',1;
IF OBJECT_ID(N'security.users',N'U') IS NULL
  THROW 53104,N'security.users is missing.',1;
GO

BEGIN TRY
BEGIN TRANSACTION;

IF OBJECT_ID(N'security.business_areas',N'U') IS NULL
BEGIN
  CREATE TABLE security.business_areas
  (
    area_code   VARCHAR(20)  NOT NULL,
    label       NVARCHAR(80) NOT NULL,
    sort_order  SMALLINT     NOT NULL,
    active      BIT          NOT NULL CONSTRAINT DF_business_areas_active DEFAULT (1),
    CONSTRAINT PK_business_areas PRIMARY KEY CLUSTERED (area_code),
    CONSTRAINT UQ_business_areas_sort UNIQUE (sort_order),
    CONSTRAINT CK_business_areas_code CHECK (area_code IN ('soporte','desarrollo','ventas','administrativa'))
  );
END;

IF NOT EXISTS (SELECT 1 FROM security.business_areas WHERE area_code='soporte')
  INSERT security.business_areas(area_code,label,sort_order) VALUES ('soporte',N'Soporte',1);
IF NOT EXISTS (SELECT 1 FROM security.business_areas WHERE area_code='desarrollo')
  INSERT security.business_areas(area_code,label,sort_order) VALUES ('desarrollo',N'Desarrollo',2);
IF NOT EXISTS (SELECT 1 FROM security.business_areas WHERE area_code='ventas')
  INSERT security.business_areas(area_code,label,sort_order) VALUES ('ventas',N'Ventas',3);
IF NOT EXISTS (SELECT 1 FROM security.business_areas WHERE area_code='administrativa')
  INSERT security.business_areas(area_code,label,sort_order) VALUES ('administrativa',N'Administrativa',4);

IF OBJECT_ID(N'security.user_business_areas',N'U') IS NULL
BEGIN
  CREATE TABLE security.user_business_areas
  (
    user_key     BIGINT        NOT NULL,
    area_code    VARCHAR(20)   NOT NULL,
    assigned_at  DATETIME2(3)  NOT NULL CONSTRAINT DF_user_business_areas_assigned DEFAULT SYSUTCDATETIME(),
    assigned_by  NVARCHAR(150) NOT NULL,
    CONSTRAINT PK_user_business_areas PRIMARY KEY CLUSTERED (user_key,area_code),
    CONSTRAINT FK_user_business_areas_user FOREIGN KEY (user_key) REFERENCES security.users(user_key),
    CONSTRAINT FK_user_business_areas_area FOREIGN KEY (area_code) REFERENCES security.business_areas(area_code)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'security.user_business_areas') AND name=N'IX_user_business_areas_area')
  CREATE INDEX IX_user_business_areas_area ON security.user_business_areas(area_code,user_key);

IF (SELECT COUNT(*) FROM security.business_areas) <> 4
  THROW 53105,N'The business-area catalog must have exactly four rows.',1;

COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
PRINT N'060 complete: security.business_areas and security.user_business_areas are available.';
GO
