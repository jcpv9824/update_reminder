[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedSha256,
  [string]$SessionDirectory,
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$name = '065_catalog_erp_owner_publisher.sql'
$ddlPath = Join-Path $root "migration\sql\$name"
$entries = @(Get-Content -LiteralPath (Join-Path $root 'migration\sql\MANIFEST.sha256') |
  Where-Object { $_ -match "\s+$([regex]::Escape($name))$" })
$pin = $ExpectedSha256.ToUpperInvariant()
if ($entries.Count -ne 1 -or ($entries[0] -split '\s+')[0].ToUpperInvariant() -cne $pin) {
  throw '065 reviewed hash does not match its one manifest entry.'
}
$ddlBytes = [IO.File]::ReadAllBytes($ddlPath)
if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($ddlBytes)) -cne $pin) {
  throw '065 file does not match the reviewed hash.'
}
$ddl = [Text.UTF8Encoding]::new($false, $true).GetString($ddlBytes).TrimStart([char]0xFEFF)

# No worker identity, payload, reservation, publication, or source connection is used.
$preamble = @'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15 OR @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0
  OR ISNULL(HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'CONTROL'),0)<>1
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID()
    AND compatibility_level=150 AND collation_name=N'Modern_Spanish_CI_AS' AND is_read_only=0)
  THROW 56570,N'ERP owner rehearsal requires an independent authorized SQL Server 2019 QA session.',1;

DECLARE @expectedModules table(name sysname COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY);
INSERT @expectedModules(name) VALUES
  (N'catalog_erp_owner_dispatch_internal'), (N'reserve_catalog_erp_owner_attempt'),
  (N'publish_catalog_erp_owner'), (N'fail_catalog_erp_owner_attempt');
DECLARE @roles table(role_id int NOT NULL,member_id int NOT NULL);
DECLARE @acl table(class tinyint NOT NULL,major_id int NOT NULL,minor_id int NOT NULL,
  grantee int NOT NULL,grantor int NOT NULL,permission_type char(4) NOT NULL,state char(1) NOT NULL);
DECLARE @principals table(id int NOT NULL, name sysname COLLATE Latin1_General_100_BIN2 NOT NULL,
  kind char(1) NOT NULL, owning_id int NULL, sid varbinary(85) NULL, authentication_type int NULL,
  default_schema sysname COLLATE Latin1_General_100_BIN2 NULL);
DECLARE @objects table(id int NOT NULL,schema_id int NOT NULL,name sysname COLLATE Latin1_General_100_BIN2 NOT NULL,
  kind char(2) NOT NULL, owner_id int NULL, execute_as_id int NULL, definition_hash varbinary(32) NULL);
DECLARE @schemas table(id int NOT NULL,name sysname COLLATE Latin1_General_100_BIN2 NOT NULL,owner_id int NOT NULL);
DECLARE @sequence table(id int NOT NULL,current_value bigint NULL,last_used_value bigint NULL);
DECLARE @firstModules table(id int NOT NULL, definition_hash varbinary(32) NULL);
DECLARE @delegate int=NULL,@phase int=0,@lock int,@settingsSchema int=SCHEMA_ID(N'settings');
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:qa:065-rollback',
     @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=0;
  IF @lock<0 THROW 56571,N'ERP owner rehearsal is already in progress.',1;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',
     @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=0;
  IF @lock<0 THROW 56571,N'Catalog publication is in progress in QA.',1;
  IF NOT EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='064' AND succeeded=1)
    OR EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='065')
    OR DATABASE_PRINCIPAL_ID(N'portal_catalog_erp_owner_delegate') IS NOT NULL
    OR EXISTS(SELECT 1 FROM sys.objects o JOIN @expectedModules m ON m.name=o.name
      COLLATE Latin1_General_100_BIN2 WHERE o.schema_id=@settingsSchema)
    THROW 56572,N'QA must have verified 064 and no 065 state.',1;

  INSERT @roles SELECT role_principal_id,member_principal_id FROM sys.database_role_members;
  INSERT @acl SELECT class,major_id,minor_id,grantee_principal_id,grantor_principal_id,[type],state
    FROM sys.database_permissions;
  INSERT @principals SELECT principal_id,name,[type],owning_principal_id,sid,authentication_type,default_schema_name
    FROM sys.database_principals;
  INSERT @objects SELECT o.object_id,o.schema_id,o.name,o.[type],o.principal_id,m.execute_as_principal_id,
    HASHBYTES('SHA2_256',CONVERT(varbinary(max),m.definition))
    FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.is_ms_shipped=0;
  INSERT @schemas SELECT schema_id,name,principal_id FROM sys.schemas;
  INSERT @sequence SELECT object_id,CONVERT(bigint,current_value),CONVERT(bigint,last_used_value) FROM sys.sequences
    WHERE object_id=OBJECT_ID(N'settings.catalog_customer_attempt_sequence',N'SO');
  IF @@ROWCOUNT<>1 THROW 56573,N'Existing catalog attempt sequence metadata is required.',1;
  DECLARE @migrationBody nvarchar(max)=N'
'@

# Compare the same typed columns in both directions. Any new ACL other than
# the ordinary CONNECT entry of the newly created login-less user is a failure.
$checks = @'
  IF EXISTS(SELECT * FROM @roles EXCEPT SELECT role_principal_id,member_principal_id FROM sys.database_role_members)
    OR EXISTS(SELECT role_principal_id,member_principal_id FROM sys.database_role_members EXCEPT SELECT * FROM @roles)
    THROW 56574,N'Existing database role memberships changed.',1;
  IF EXISTS(SELECT * FROM @acl EXCEPT SELECT class,major_id,minor_id,grantee_principal_id,grantor_principal_id,[type],state FROM sys.database_permissions)
    OR EXISTS(SELECT class,major_id,minor_id,grantee_principal_id,grantor_principal_id,[type],state
      FROM sys.database_permissions WHERE NOT (@delegate IS NOT NULL AND grantee_principal_id=@delegate
        AND class=0 AND major_id=0 AND minor_id=0 AND state='G' AND permission_name=N'CONNECT'
        AND grantor_principal_id=DATABASE_PRINCIPAL_ID(N'dbo'))
      EXCEPT SELECT * FROM @acl)
    THROW 56575,N'An unapproved database permission changed.',1;
  IF EXISTS(SELECT * FROM @principals EXCEPT SELECT principal_id,name COLLATE Latin1_General_100_BIN2,[type],
      owning_principal_id,sid,authentication_type,default_schema_name COLLATE Latin1_General_100_BIN2 FROM sys.database_principals)
    OR EXISTS(SELECT principal_id,name COLLATE Latin1_General_100_BIN2,[type],owning_principal_id,sid,
      authentication_type,default_schema_name COLLATE Latin1_General_100_BIN2 FROM sys.database_principals
      WHERE @delegate IS NULL OR principal_id<>@delegate EXCEPT SELECT * FROM @principals)
    THROW 56576,N'An existing database principal changed.',1;
  IF EXISTS(SELECT * FROM @schemas EXCEPT SELECT schema_id,name COLLATE Latin1_General_100_BIN2,principal_id FROM sys.schemas)
    OR EXISTS(SELECT schema_id,name COLLATE Latin1_General_100_BIN2,principal_id FROM sys.schemas EXCEPT SELECT * FROM @schemas)
    THROW 56577,N'Existing database schema ownership changed.',1;
  IF EXISTS(SELECT * FROM @objects EXCEPT SELECT o.object_id,o.schema_id,o.name COLLATE Latin1_General_100_BIN2,
      o.[type],o.principal_id,m.execute_as_principal_id,HASHBYTES('SHA2_256',CONVERT(varbinary(max),m.definition))
      FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.is_ms_shipped=0)
    OR EXISTS(SELECT o.object_id,o.schema_id,o.name COLLATE Latin1_General_100_BIN2,o.[type],o.principal_id,
      m.execute_as_principal_id,HASHBYTES('SHA2_256',CONVERT(varbinary(max),m.definition))
      FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.is_ms_shipped=0
       AND NOT (@delegate IS NOT NULL AND o.schema_id=@settingsSchema AND o.[type]='P'
         AND o.name COLLATE Latin1_General_100_BIN2 IN (SELECT name FROM @expectedModules))
      EXCEPT SELECT * FROM @objects)
    THROW 56578,N'An existing object or module definition changed.',1;
  IF EXISTS(SELECT * FROM @sequence EXCEPT SELECT object_id,CONVERT(bigint,current_value),CONVERT(bigint,last_used_value)
      FROM sys.sequences WHERE object_id=OBJECT_ID(N'settings.catalog_customer_attempt_sequence',N'SO'))
     OR EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='065')
    THROW 56579,N'The sequence advanced or the rehearsal modified the ledger.',1;
'@

$mid = @'
';
  WHILE @phase<2
  BEGIN
    EXEC sys.sp_executesql @migrationBody;
    SET @phase+=1;
    IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 THROW 56580,N'065 did not preserve the outer transaction.',1;
    SET @delegate=DATABASE_PRINCIPAL_ID(N'portal_catalog_erp_owner_delegate');
    IF @delegate IS NULL OR NOT EXISTS(SELECT 1 FROM sys.database_principals
          WHERE principal_id=@delegate AND [type]='S' AND authentication_type=0)
      OR (SELECT COUNT(*) FROM sys.objects o JOIN @expectedModules e
         ON e.name=o.name COLLATE Latin1_General_100_BIN2
         JOIN sys.sql_modules m ON m.object_id=o.object_id
         JOIN sys.schemas s ON s.schema_id=o.schema_id
         WHERE o.schema_id=@settingsSchema AND o.[type]='P' AND o.principal_id IS NULL
           AND s.principal_id=DATABASE_PRINCIPAL_ID(N'dbo')
           AND ((e.name=N'catalog_erp_owner_dispatch_internal' AND m.execute_as_principal_id=@delegate)
             OR (e.name<>N'catalog_erp_owner_dispatch_internal' AND m.execute_as_principal_id IS NULL)))<>4
      OR EXISTS(SELECT 1 FROM sys.database_permissions p JOIN sys.objects o ON o.object_id=p.major_id
        JOIN @expectedModules e ON e.name=o.name COLLATE Latin1_General_100_BIN2
        WHERE p.class=1 AND o.schema_id=@settingsSchema)
      THROW 56581,N'065 delegate, procedure ownership, or execution metadata differs.',1;
    IF @phase=1
      INSERT @firstModules SELECT m.object_id,HASHBYTES('SHA2_256',CONVERT(varbinary(max),m.definition))
      FROM sys.sql_modules m JOIN sys.objects o ON o.object_id=m.object_id
      JOIN @expectedModules e ON e.name=o.name COLLATE Latin1_General_100_BIN2 WHERE o.schema_id=@settingsSchema;
    ELSE IF (SELECT COUNT(*) FROM @firstModules f JOIN sys.sql_modules m ON m.object_id=f.id
      AND HASHBYTES('SHA2_256',CONVERT(varbinary(max),m.definition))=f.definition_hash)<>4
      THROW 56583,N'065 replay changed the installed module definitions.',1;
'@
$rollback = @'
  END;
  ROLLBACK TRANSACTION;
  SET @delegate=NULL;
  IF @@TRANCOUNT<>0 OR XACT_STATE()<>0 OR DATABASE_PRINCIPAL_ID(N'portal_catalog_erp_owner_delegate') IS NOT NULL
     OR EXISTS(SELECT 1 FROM sys.objects o JOIN @expectedModules m ON m.name=o.name COLLATE Latin1_General_100_BIN2
       WHERE o.schema_id=@settingsSchema)
     THROW 56582,N'065 rehearsal left residue.',1;
'@
$finish = @'
  SELECT @phase AS applied_passes,4 AS expected_procedures,1 AS acl_preserved,1 AS sequence_unchanged,0 AS remaining_objects;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SELECT ERROR_NUMBER() AS error_number,ERROR_LINE() AS error_line,@phase AS applied_passes;
END CATCH;
'@
$sql = @($preamble, $ddl.Replace("'", "''"), $mid, $checks, $rollback, $checks, $finish) -join [Environment]::NewLine

$scriptDom = Get-ChildItem -Path 'C:\Program Files\Microsoft SQL Server Management Studio*' -Filter 'Microsoft.SqlServer.TransactSql.ScriptDom.dll' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$scriptDom) { throw 'SQL Server 2019 ScriptDom is required for the rehearsal.' }
Add-Type -Path $scriptDom.FullName
$parser = [Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
foreach ($text in @($ddl, $sql)) {
  $reader = [IO.StringReader]::new($text)
  try { $errors = $null; $batch = $parser.Parse($reader,[ref]$errors) } finally { $reader.Dispose() }
  if ($errors.Count -or $batch.Batches.Count -ne 1) {
    $line = if ($errors.Count) { [int]$errors[0].Line } else { 0 }
    throw "065 rehearsal ScriptDom validation failed (line $line)."
  }
}
if (!$Execute) {
  [ordered]@{ migration='065'; sha256=$pin; parser='TSql150'; mode='offline' } | ConvertTo-Json -Compress
  return
}
if ([string]::IsNullOrWhiteSpace($SessionDirectory)) { throw 'An explicit authorized QA session directory is required.' }
$session = (Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor = Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if ($descriptor.environment -cne 'qa' -or $descriptor.database -cne 'PortalSAGWeb-TEST' -or
    $descriptor.accessLevel -cne 'full-control' -or $descriptor.sessionAuthorized -ne $true -or
    $descriptor.approvalMode -cne 'session' -or $descriptor.permissionMutationPolicy -cne 'preserve-existing' -or
    $descriptor.engineMajorVersion -ne 15 -or $descriptor.compatibilityLevel -ne 150) {
  throw '065 rehearsal refuses sessions other than authorized full-control SQL Server 2019 PortalSAGWeb-TEST.'
}
$invoke = Join-Path $root 'migration\connect-sql-server\Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response = (& $invoke -SessionDirectory $session -Sql $sql -Mode write -TimeoutSeconds 120 -MaxRows 1) |
    ConvertFrom-Json -Depth 14
} catch { throw '065 QA rehearsal failed before a sanitized result was received.' }
$sets = @($response.resultSets)
$row = if ($sets.Count -eq 1 -and @($sets[0].rows).Count -eq 1) { $sets[0].rows[0] } else { $null }
if (!$response.success -or $row.applied_passes -ne 2 -or $row.expected_procedures -ne 4 -or
    $row.acl_preserved -ne 1 -or $row.sequence_unchanged -ne 1 -or $row.remaining_objects -ne 0) {
  throw "065 QA rollback rehearsal failed (SQL $([int]$row.error_number), line $([int]$row.error_line), passes $([int]$row.applied_passes))."
}
$row | Select-Object applied_passes,expected_procedures,acl_preserved,sequence_unchanged,remaining_objects |
  ConvertTo-Json -Compress
