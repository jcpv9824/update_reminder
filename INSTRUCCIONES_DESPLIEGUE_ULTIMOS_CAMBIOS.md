# Instrucciones de despliegue de los últimos cambios

Este archivo documenta cómo desplegar los últimos cambios del **Programador de Actualizaciones ERP** usando PowerShell, incluyendo backend, frontend y envío a Git.

Cambios incluidos:

- Correos HTML/CSS corporativos.
- Recordatorios separados por responsable y por tipo:
  - dominios;
  - bases de datos / empresas.
- Alerta única de vencidos por responsable, con secciones de dominios vencidos y bases/empresas vencidas.
- Correo de prueba con proveedor, remitente, fecha y URL.
- Reporte maestro por correo sin datos sensibles.
- Mejoras previas de Alertas y correos, reporte maestro, herencia de frecuencias y botón Generar tareas ahora.

## 1. Variables de despliegue

Ejecute en PowerShell:

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"
$apiBaseUrl    = "https://erpupdsch4645-api.azurewebsites.net/api"
$repoPath      = "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"
```

## 2. Revisar cambios locales

```powershell
cd $repoPath
git status
git diff --stat
```

Revise que no haya secretos:

```powershell
Select-String -Path .\api\src\**\*.ts,.\frontend\src\**\*.tsx,.\*.md -Pattern "password-real","connectionString-real","token-real","keyVault-real","clave-real" -CaseSensitive
```

Si el comando no devuelve resultados sensibles reales, continúe.

## 3. Probar backend

```powershell
cd "$repoPath\api"
npm install
npm test
npm run build
```

Resultado esperado:

- Tests backend en verde.
- `npm run build` termina sin errores.

## 4. Crear ZIP completo del backend

```powershell
cd "$repoPath\api"

Remove-Item .\api-deploy-full.zip -ErrorAction SilentlyContinue
tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules

dir .\api-deploy-full.zip
```

El ZIP debe existir y pesar mucho más que unos pocos KB porque incluye `node_modules`.

## 5. Desplegar backend

```powershell
az functionapp deployment source config-zip `
  --resource-group $resourceGroup `
  --name $functionApp `
  --src "$repoPath\api\api-deploy-full.zip"

az functionapp restart `
  --resource-group $resourceGroup `
  --name $functionApp
```

Verifique funciones:

```powershell
az functionapp function list `
  --resource-group $resourceGroup `
  --name $functionApp `
  --output table
```

Debe ver funciones como:

- `sendScheduledReminders`
- `sendOverdueAlerts`
- `settingsEmailAlertsTestEmail`
- `mastersReportSendEmail`
- `generateDailyUpdateTasksManual`

## 6. Probar frontend

```powershell
cd "$repoPath\frontend"
"VITE_API_BASE_URL=$apiBaseUrl" | Out-File -FilePath .env.production -Encoding utf8
npm install
npm test
npm run build
```

Verifique que el archivo de fallback para Static Web Apps quedó en `dist`:

```powershell
Test-Path "$repoPath\frontend\dist\staticwebapp.config.json"
```

Debe devolver:

```text
True
```

## 7. Enviar cambios a Git con PowerShell

Desde la raíz:

```powershell
cd $repoPath
git status
git add .
git status
git commit -m "Mejorar correos por responsable y alertas vencidas combinadas"
git push
```

Si Git rechaza el push porque el remoto tiene cambios:

```powershell
git pull --rebase origin main
git push
```

Si aparecen conflictos durante el rebase, deténgase, resuélvalos manualmente y luego:

```powershell
git add .
git rebase --continue
git push
```

## 8. Desplegar frontend en Static Web Apps

Si el frontend se despliega por GitHub Actions, después del `git push`:

1. Abra GitHub Actions del repositorio.
2. Espere a que el workflow de Azure Static Web Apps termine en verde.
3. Abra la app:

```text
https://agreeable-wave-07469d50f.7.azurestaticapps.net
```

Si usa despliegue manual, publique el contenido de:

```text
frontend\dist
```

## 9. Pruebas manuales recomendadas

### 9.1 Correo de prueba

1. Inicie sesión como administrador.
2. Abra **Alertas y correos**.
3. En **Correo de prueba**, escriba un destinatario.
4. Pulse **Enviar correo de prueba**.
5. Verifique que el correo muestre:
   - proveedor actual;
   - correo remitente;
   - fecha y hora;
   - URL de la aplicación.

### 9.2 Recordatorios por responsable

En modo `EMAIL_PROVIDER=mock` o SMTP controlado:

1. Cree tareas próximas de dominio asignadas a un responsable.
2. Cree tareas próximas de base de datos asignadas al mismo u otro responsable.
3. Ejecute o espere `sendScheduledReminders`.
4. Verifique:
   - dominios y bases no se mezclan en el mismo recordatorio;
   - cada responsable recibe solo sus tareas;
   - si un responsable tiene ambos tipos, recibe un correo de dominios y otro de bases.

### 9.3 Alerta combinada de vencidos

1. Cree o use tareas vencidas de dominio y base para un mismo responsable.
2. Ejecute o espere `sendOverdueAlerts`.
3. Verifique que el responsable recibe un solo correo con:
   - resumen de total vencidas;
   - sección **Dominios vencidos**;
   - sección **Bases de datos / empresas vencidas**.

### 9.4 Reporte maestro

1. Abra **Alertas y correos**.
2. En **Reporte de clientes/dominios/empresas**, escriba destinatarios separados por punto y coma:

```text
correo1@empresa.com; correo2@empresa.com
```

3. Pulse **Enviar reporte**.
4. Verifique que el correo agrupe:
   - cliente;
   - dominios;
   - empresas/bases.
5. Verifique que no incluya:
   - contraseñas;
   - usuarios SQL;
   - servidores SQL;
   - puertos;
   - cadenas de conexión;
   - tokens;
   - secretos;
   - valores de Key Vault.

## 10. Nota de seguridad

No se deben commitear ni documentar contraseñas reales. La contraseña SMTP debe configurarse desde la UI de **Alertas y correos** para que se guarde en Key Vault, o mediante un procedimiento controlado de Azure si la UI no está disponible.
