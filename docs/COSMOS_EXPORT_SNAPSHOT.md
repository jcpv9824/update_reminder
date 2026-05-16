# Fase 2 — Export y Snapshot de Cosmos DB

Objetivo: crear un snapshot reproducible de los contenedores actuales de Cosmos DB antes de diseñar o ejecutar la migración relacional.

Esta fase **no cambia runtime**, **no modifica Cosmos**, **no consulta Key Vault** y **no despliega nada**. Solo lee Cosmos y escribe archivos JSON locales con un `manifest.json`.

## 1. Archivos agregados

- Script: `api/scripts/export-cosmos-snapshot.js`
- Comando npm: `cd api && npm run export:cosmos`
- Salida por defecto: `migration/backups/cosmos-export-YYYYMMDD-HHMMSS/`
- Protección git: `migration/backups/` está en `.gitignore`

## 2. Contenedores exportados por defecto

- `users`
- `clients`
- `domains`
- `databases`
- `updateSchedules`
- `updateTasks`
- `licenseModules`
- `licenseAssignments`
- `auditLogs`
- `appSettings`
- `emailNotifications`

Nota V14: `updateSchedules` puede contener programaciones especiales con `frequencyType = "once"`, `completedAt`, `completedReason` y excepciones en `licensingScope.excludedDomainIds` / `licensingScope.excludedDatabaseIds`. El export debe preservar esos campos sin transformarlos.

## 3. Seguridad

El export puede contener:

- PII, como emails y nombres de usuarios.
- Hashes de contraseña.
- Hashes de tokens de reset.
- Nombres de secretos de Key Vault.
- Datos operativos internos.

El export **no debe contener**:

- Contraseñas reales de bases de datos.
- Contraseña SMTP real.
- JWT secrets.
- Tokens reales.
- Valores reales de Key Vault.

El script no llama Key Vault, por lo que no resuelve secretos. Aun así, el backup debe tratarse como información sensible y no debe subirse a GitHub.

## 4. Preparar Azure CLI

```powershell
az account set --subscription edbbf624-b155-4c51-ac57-d02424a7234d
```

Confirmar cuenta:

```powershell
az account show --query "{name:name, id:id, tenantId:tenantId}" --output table
```

## 5. Configurar variables sin imprimir secretos

Desde PowerShell:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"

$env:COSMOS_CONNECTION_STRING = az cosmosdb keys list `
  --resource-group rg-erp-update-scheduler-prod `
  --name erpupdsch4645-cosmos `
  --type connection-strings `
  --query "connectionStrings[0].connectionString" `
  --output tsv

$env:COSMOS_DATABASE_NAME = "erp-update-scheduler"
```

No pegar ni imprimir el valor de `$env:COSMOS_CONNECTION_STRING` en chats, logs o documentación.

## 6. Ejecutar export completo

```powershell
npm run export:cosmos
```

Salida esperada:

```text
Exportando Cosmos DB 'erp-update-scheduler' a: ...\migration\backups\cosmos-export-YYYYMMDD-HHMMSS
- users... X documento(s), sha256=...
- clients... X documento(s), sha256=...
...
Manifest escrito: ...\manifest.json
```

## 7. Ejecutar export con carpeta explícita

```powershell
npm run export:cosmos -- --out "..\migration\backups\cosmos-export-prod-20260516-001"
```

## 8. Exportar solo algunos contenedores

Útil para pruebas:

```powershell
npm run export:cosmos -- --containers clients,domains,databases --out "..\migration\backups\cosmos-export-test"
```

## 9. Continuar aunque falte un contenedor

Solo usar para diagnóstico. En producción se recomienda fallar si algo no exporta.

```powershell
npm run export:cosmos -- --continue-on-error
```

## 10. Verificar manifest

```powershell
$latest = Get-ChildItem "..\migration\backups" -Directory |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

Get-Content (Join-Path $latest.FullName "manifest.json")
```

El manifest incluye:

- `exportedAt`
- `cosmosDatabase`
- `outputDirectory`
- `containers.<name>.count`
- `containers.<name>.sha256`
- advertencias de seguridad

## 11. Verificar hashes manualmente

Ejemplo:

```powershell
Get-FileHash (Join-Path $latest.FullName "clients.json") -Algorithm SHA256
```

Comparar con `manifest.json`.

## 12. Checklist de aceptación Fase 2

- La carpeta de export existe en `migration/backups/...`.
- Existe un archivo JSON por contenedor esperado.
- Existe `manifest.json`.
- Todos los contenedores tienen `status: "ok"` en manifest.
- Los conteos son razonables frente a producción.
- Los SHA256 existen.
- No se imprimieron secretos en consola.
- No se subió `migration/backups/` a git.
- Cosmos sigue intacto y sigue siendo fuente de verdad.

## 13. Siguiente fase

Con un snapshot real disponible, continuar con:

1. `docs/RELATIONAL_MODEL_PROPOSAL.md`
2. `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md`
3. Scripts SQL de schema inicial.
4. Scripts de staging/import.
5. Scripts de validación Cosmos vs SQL.

No implementar `DATA_PROVIDER=sql` ni cambiar endpoints hasta completar la propuesta relacional y matriz campo por campo.
