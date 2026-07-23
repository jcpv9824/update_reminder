/*
  Portal SAG Web - intake read-only de SQL Server/Azure SQL
  No crea ni modifica objetos ni datos.
  Ejecutar en la base entregada y guardar el resultado por canal seguro.
*/

SET NOCOUNT ON;

SELECT
  @@VERSION AS engine_version,
  SERVERPROPERTY('ServerName') AS server_name,
  SERVERPROPERTY('EngineEdition') AS engine_edition,
  SERVERPROPERTY('Edition') AS edition,
  SERVERPROPERTY('ProductVersion') AS product_version,
  SERVERPROPERTY('ProductLevel') AS product_level,
  DB_NAME() AS database_name,
  SUSER_SNAME() AS login_name,
  USER_NAME() AS database_user;

SELECT
  d.name,
  d.compatibility_level,
  d.collation_name,
  d.state_desc,
  d.user_access_desc,
  d.recovery_model_desc,
  d.is_read_committed_snapshot_on,
  d.snapshot_isolation_state_desc,
  d.is_encrypted,
  d.containment_desc
FROM sys.databases AS d
WHERE d.name = DB_NAME();

SELECT
  type_desc,
  name AS logical_file_name,
  physical_name,
  CAST(size * 8.0 / 1024 AS DECIMAL(18,2)) AS size_mb,
  CASE max_size WHEN -1 THEN NULL ELSE CAST(max_size * 8.0 / 1024 AS DECIMAL(18,2)) END AS max_size_mb,
  CASE is_percent_growth WHEN 1 THEN CONCAT(growth, '%') ELSE CONCAT(CAST(growth * 8.0 / 1024 AS DECIMAL(18,2)), ' MB') END AS growth_setting
FROM sys.database_files
ORDER BY type_desc, name;

SELECT
  s.name AS schema_name,
  COUNT(t.object_id) AS user_table_count
FROM sys.schemas AS s
LEFT JOIN sys.tables AS t ON t.schema_id = s.schema_id AND t.is_ms_shipped = 0
WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
GROUP BY s.name
ORDER BY s.name;

SELECT
  s.name AS schema_name,
  t.name AS table_name,
  SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS approximate_rows,
  t.temporal_type_desc,
  t.is_memory_optimized
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
LEFT JOIN sys.partitions AS p ON p.object_id = t.object_id
WHERE t.is_ms_shipped = 0
GROUP BY s.name, t.name, t.temporal_type_desc, t.is_memory_optimized
ORDER BY s.name, t.name;

SELECT object_type, COUNT(*) AS object_count
FROM (
  SELECT 'TABLE' AS object_type FROM sys.tables WHERE is_ms_shipped = 0
  UNION ALL SELECT 'VIEW' FROM sys.views WHERE is_ms_shipped = 0
  UNION ALL SELECT 'PROCEDURE' FROM sys.procedures WHERE is_ms_shipped = 0
  UNION ALL SELECT 'FUNCTION' FROM sys.objects WHERE type IN ('FN','IF','TF','FS','FT') AND is_ms_shipped = 0
  UNION ALL SELECT 'TRIGGER' FROM sys.triggers WHERE is_ms_shipped = 0
) AS objects_by_type
GROUP BY object_type
ORDER BY object_type;

SELECT
  dp.name AS principal_name,
  dp.type_desc,
  dp.authentication_type_desc,
  dp.default_schema_name
FROM sys.database_principals AS dp
WHERE dp.principal_id > 4
  AND dp.type IN ('S','U','G','E','X')
ORDER BY dp.name;

SELECT
  member_principal.name AS member_name,
  role_principal.name AS role_name
FROM sys.database_role_members AS drm
JOIN sys.database_principals AS role_principal ON role_principal.principal_id = drm.role_principal_id
JOIN sys.database_principals AS member_principal ON member_principal.principal_id = drm.member_principal_id
ORDER BY member_principal.name, role_principal.name;

SELECT
  USER_NAME(grantee_principal_id) AS grantee,
  class_desc,
  permission_name,
  state_desc,
  CASE WHEN major_id = 0 THEN NULL ELSE OBJECT_SCHEMA_NAME(major_id) END AS object_schema,
  CASE WHEN major_id = 0 THEN NULL ELSE OBJECT_NAME(major_id) END AS object_name
FROM sys.database_permissions
WHERE grantee_principal_id > 4
ORDER BY grantee, class_desc, permission_name;

SELECT
  CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS NVARCHAR(128)) AS effective_collation,
  CASE WHEN TRY_CONVERT(DATETIME2(3), '2026-07-15T12:34:56.789') IS NOT NULL THEN 1 ELSE 0 END AS supports_datetime2_conversion,
  CASE WHEN ISJSON(N'{"portal":"sag-web"}') = 1 THEN 1 ELSE 0 END AS supports_json_validation;

SELECT
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create_table,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE SCHEMA') AS can_create_schema,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE PROCEDURE') AS can_create_procedure,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS can_view_definition;
