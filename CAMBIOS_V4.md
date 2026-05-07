# Cambios incrementales — Versión 4

## Resumen

| Área | Cambio |
|---|---|
| Backend | Nuevo contenedor Cosmos `appSettings` con doc `id="email-alerts"` para la configuración global de correos y alertas. |
| Backend | `lib/settingsService.ts` — guarda configuración no sensible en Cosmos y la contraseña SMTP en Azure Key Vault. |
| Backend | `lib/emailService.ts` refactorizado — soporta `mock`, `smtp` (nodemailer), `sendgrid`. Lee la configuración desde Cosmos con fallback a variables de entorno. |
| Backend | Nuevos endpoints: `GET /api/settings/email-alerts`, `PUT /api/settings/email-alerts`, `POST /api/settings/email-alerts/test-email`. Solo admin. |
| Backend | `sendScheduledReminders` y `sendOverdueAlerts` ahora respetan `remindersEnabled` y `overdueAlertsEnabled` y usan los destinatarios configurados. |
| Backend | Notificación opcional al crear / restablecer contraseña. Respeta `passwordNotificationEnabled` y `sendTemporaryPasswordByEmail`. Auditoría sin contraseñas. |
| Frontend | Nueva página `Alertas y correos` con 6 secciones: proveedor, SMTP, recordatorios, alertas, contraseñas, prueba. |
| Frontend | Menú lateral muestra "Alertas y correos" solo a `admin`, ubicado entre "Frecuencias" y "Auditoría". |
| Pruebas | +6 nuevas (settingsService 4, AlertasCorreosPage 2). Total: **56 backend + 15 frontend = 71**. |

## Endpoints nuevos

```
GET    /api/settings/email-alerts                 (admin)
PUT    /api/settings/email-alerts                 (admin)
POST   /api/settings/email-alerts/test-email      (admin)
```

`GET` nunca devuelve `smtpPassword` ni `smtpPasswordSecretName`. Devuelve `smtpPasswordConfigured: true|false`.

`PUT` acepta cualquier subconjunto de campos. Si `smtpPassword` viene con valor:
1. Se sanitiza el nombre del secreto (`smtp-password-info-pya-com-co`).
2. Se guarda en **Azure Key Vault**.
3. En Cosmos solo queda `smtpPasswordSecretName` y `smtpPasswordConfigured: true`.
4. Se registra auditoría `smtp_password_updated` (sin la contraseña).

`POST .../test-email` envía un correo de prueba al destinatario indicado y registra `test_email_sent` o `test_email_failed`.

## Modelo Cosmos

Contenedor: `appSettings` (partition key `/id`).
Documento único:

```json
{
  "id": "email-alerts",
  "emailProvider": "smtp",
  "emailFrom": "info@pya.com.co",
  "emailFromName": "Programador de Actualizaciones",
  "frontendBaseUrl": "https://...",
  "smtpHost": "smtp.office365.com",
  "smtpPort": 587,
  "smtpSecure": false,
  "smtpUser": "info@pya.com.co",
  "smtpPasswordSecretName": "smtp-password-info-pya-com-co",
  "smtpPasswordConfigured": true,
  "remindersEnabled": true,
  "defaultReminderDaysBefore": [3, 1, 0],
  "defaultReminderTime": "08:00",
  "defaultTimezone": "America/Bogota",
  "overdueAlertsEnabled": true,
  "overdueAlertTime": "08:00",
  "overdueAlertTimezone": "America/Bogota",
  "overdueAlertRecipientsMode": "admins",
  "customAdminAlertEmails": [],
  "passwordNotificationEnabled": true,
  "sendTemporaryPasswordByEmail": false
}
```

## Crear el contenedor `appSettings` en Azure

```powershell
$resourceGroup  = "rg-erp-update-scheduler-prod"
$cosmosAccount  = "erpupdsch4645-cosmos"
$cosmosDatabase = "erp-update-scheduler"

az cosmosdb sql container create `
  --account-name $cosmosAccount `
  --resource-group $resourceGroup `
  --database-name $cosmosDatabase `
  --name appSettings `
  --partition-key-path "/id"
```

Si el contenedor no existe, el endpoint sigue funcionando (devuelve los valores por defecto + variables de entorno) y al primer `PUT` Cosmos creará el documento por upsert. Pero **debe existir el contenedor** para que `upsert` funcione, así que cree el contenedor antes del primer guardado.

## Cómo configurar SMTP en producción desde la vista

1. Inicie sesión como admin.
2. Vaya a **Alertas y correos** en el menú lateral.
3. En "Proveedor de correo": elija **SMTP**.
4. Llene `Servidor SMTP` (`smtp.office365.com`), puerto (`587`), usuario (`info@pya.com.co`), correo y nombre del remitente, URL de la aplicación.
5. Haga clic en **Configurar contraseña SMTP** y escriba la contraseña de aplicación de Office 365 (la contraseña nunca se mostrará después).
6. Configure recordatorios y alertas según necesite.
7. Clic en **Guardar configuración**. El estado mostrará "Contraseña configurada: Sí".
8. Use **Enviar correo de prueba** para validar.

Si Key Vault rechaza el secreto, revise que la Function App tenga el rol `Key Vault Secrets Officer` (ver `DESPLIEGUE.md`).

## Comandos para verificar la vista en producción

```powershell
$apiBase = "https://erpupdsch4645-api.azurewebsites.net/api"

# 1) Login y obtener token (use sus credenciales reales).
$loginBody = @{ email = "camilo.palacio@pya.com.co"; password = "..." } | ConvertTo-Json
$login = Invoke-RestMethod -Uri "$apiBase/auth/login" -Method Post -Body $loginBody -ContentType "application/json"
$token = $login.token

# 2) Leer configuración (debe llegar sin contraseña).
Invoke-RestMethod -Uri "$apiBase/settings/email-alerts" -Headers @{ Authorization = "Bearer $token" }

# 3) Test email.
$testBody = @{ to = "destino@empresa.com" } | ConvertTo-Json
Invoke-RestMethod -Uri "$apiBase/settings/email-alerts/test-email" -Method Post `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } -Body $testBody
```

## Comandos exactos para redeploy (ZIP)

### Backend

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"

cd erp-update-scheduler\api
npm install
npm run build

$zip = "..\backend.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path host.json,package.json,package-lock.json,dist,node_modules -DestinationPath $zip

az webapp deploy `
  --name $functionApp `
  --resource-group $resourceGroup `
  --type zip `
  --src-path $zip
```

### Frontend

```powershell
cd erp-update-scheduler\frontend
"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.production -Encoding utf8
npm install
npm run build

# Despliegue por GitHub Actions
git add ..\..\erp-update-scheduler
git commit -m "Vista 'Alertas y correos' con SMTP en Key Vault"
git push
```

## Archivos modificados / nuevos

### Backend
- `api/src/lib/cosmos.ts` (incluye `appSettings`)
- `api/src/lib/settingsService.ts` (nuevo)
- `api/src/lib/emailService.ts` (refactor async + SMTP nodemailer)
- `api/src/types/models.ts` (`EmailAlertsSettings`)
- `api/src/functions/settings.ts` (nuevo)
- `api/src/functions/sendScheduledReminders.ts` (gate por settings + frontendBaseUrl)
- `api/src/functions/sendOverdueAlerts.ts` (gate por settings + destinatarios configurables)
- `api/src/functions/users.ts` (notificación de contraseña vía settings)
- `api/src/index.ts` (registra `settings`)
- `api/src/tests/settingsService.test.ts` (nuevo)
- `api/package.json` (`nodemailer`, `@types/nodemailer`)

### Frontend
- `frontend/src/pages/AlertasCorreosPage.tsx` (nueva)
- `frontend/src/App.tsx` (ruta `/alertas-correos`)
- `frontend/src/components/AppLayout.tsx` (item de menú admin)
- `frontend/src/tests/AlertasCorreosPage.test.tsx` (nuevo)

## Resultado de pruebas y builds

```
Backend tests : 56 passed (13 archivos)
Frontend tests: 15 passed (5 archivos)

Backend build : OK (tsc)
Frontend build: OK (vite) — index-CQHszNGX.js 280.98 kB · index-CgkYJmHa.css 6.72 kB
```

## Seguridad

- `smtpPassword` nunca se devuelve al frontend ni se incluye en `GET /settings/email-alerts`.
- Se guarda como secreto en Azure Key Vault con nombre sanitizado (sin `_`, `@`, etc.).
- Auditoría sanitiza claves `password`, `passwordHash`, `secret`, `token`, `jwt`, `rawDbAccess`.
- Solo admin puede leer, editar o probar la configuración.
