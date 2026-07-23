/*
  Portal SAG Web - preparación mínima de la base production MVP

  ESTADO: PREPARADO, NO EJECUTADO.
  REQUIERE:
    1. Backup/restore point inmediatamente anterior confirmado.
    2. Aprobación explícita del dueño del portal.
    3. Cerrar sesiones no necesarias; READ_COMMITTED_SNAPSHOT usa ROLLBACK IMMEDIATE.

  Este script no crea tablas ni usuarios. Solo habilita las opciones de
  aislamiento requeridas por el diseño relacional.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

USE [master];
GO

IF DB_ID(N'PortalSAGWeb') IS NULL
  THROW 51000, N'La base PortalSAGWeb no existe en esta instancia.', 1;
GO

IF EXISTS (
  SELECT 1
  FROM [PortalSAGWeb].sys.tables
  WHERE is_ms_shipped = 0
)
  THROW 51001, N'PortalSAGWeb ya contiene tablas de usuario. Repetir el intake y revisar antes de preparar la base.', 1;
GO

DECLARE @CompatibilityLevel INT;
DECLARE @CollationName SYSNAME;

SELECT
  @CompatibilityLevel = compatibility_level,
  @CollationName = collation_name
FROM sys.databases
WHERE name = N'PortalSAGWeb';

IF @CompatibilityLevel < 150
  THROW 51002, N'PortalSAGWeb debe conservar compatibility level 150 para este diseño SQL Server 2019.', 1;

IF @CollationName <> N'Modern_Spanish_CI_AS'
  THROW 51003, N'La collation de PortalSAGWeb no coincide con Modern_Spanish_CI_AS.', 1;
GO

ALTER DATABASE [PortalSAGWeb]
  SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;
GO

ALTER DATABASE [PortalSAGWeb]
  SET ALLOW_SNAPSHOT_ISOLATION ON;
GO

SELECT
  name,
  compatibility_level,
  collation_name,
  recovery_model_desc,
  is_read_committed_snapshot_on,
  snapshot_isolation_state_desc,
  is_encrypted
FROM sys.databases
WHERE name = N'PortalSAGWeb';
GO
