# Cambios incrementales — Versión 3

## Resumen

| Área | Cambio |
|---|---|
| Login | Email + contraseña. Microsoft eliminado del flujo principal. |
| Usuarios | Modelo extendido con `passwordHash`, `passwordUpdatedAt`. CRUD con contraseña + endpoint `reset-password`. |
| Auth | JWT (HS256) firmado con `JWT_SECRET`. Header `Authorization: Bearer …` validado en backend. |
| Setup | `/api/setup/first-admin` ahora exige contraseña. Nuevo `/api/setup/set-admin-password` para asignar contraseña al admin existente. |
| Email | `lib/emailService.ts` con providers `mock`, `sendgrid` y placeholder `acs`. Plantillas en español. |
| Recordatorios | Configuración por frecuencia (`reminders`). Timer trigger `sendScheduledReminders` cada 15 minutos, idempotente. |
| Alertas | Timer trigger `sendOverdueAlerts` diario 08:00 Bogotá. Resumen a admins activos. |
| Frontend | LoginPage minimalista email/password, cliente HTTP envía Bearer automáticamente, Usuarios con campos de contraseña, SeleccionFrecuencia con bloque de recordatorios. |
| Diseño | Variables CSS corporativas: `--color-primary #1C3664`, `--color-secondary #7E99B2`, `--color-neutral #D1D3D2`, `--color-accent #D3C193`. |
| Auditoría | Sanitización extendida (omite `passwordHash`, `token`, `jwt` además de `password`, `secret`). |
| Pruebas | +20 nuevas (password, jwt, email, reminderLogic, login UI). Total: 52 backend + 13 frontend. |

## Endpoints nuevos / actualizados

```
POST  /api/auth/login
POST  /api/auth/logout
GET   /api/me                       (requiere Bearer)
POST  /api/setup/first-admin        (ahora exige password)
POST  /api/setup/set-admin-password (asigna password a admin existente)
POST  /api/users                    (incluye password)
POST  /api/users/{id}/reset-password
```

`POST /api/auth/login`

Body:
```json
{ "email": "camilo.palacio@pya.com.co", "password": "..." }
```
Respuesta:
```json
{
  "token": "eyJ...",
  "user": { "id": "...", "email": "...", "displayName": "...", "roles": ["admin"], "active": true }
}
```
Errores:
- `400`: “Debe ingresar correo electrónico y contraseña.”
- `401`: “Correo o contraseña incorrectos.”
- `403`: “Tu usuario está inactivo. Contacta al administrador.”

## Recordatorios

Cada frecuencia puede tener:

```json
{
  "reminders": {
    "remindersEnabled": true,
    "reminderDaysBefore": [3, 1, 0],
    "reminderTime": "08:00",
    "reminderRecipientsMode": "assignedUsers",
    "customReminderEmails": []
  }
}
```

Modos de destinatarios:
- `assignedUsers`: combina IDs asignados de la frecuencia y la tarea.
- `roleUsers`: todos los usuarios activos con el rol asignado.
- `customEmails`: lista explícita de correos.

**Idempotencia**: cada tarea guarda `remindersSent` con `{type, daysBefore, sentAt, recipients}`. La función no envía dos veces el mismo `daysBefore` para la misma tarea el mismo día. La auditoría registra `reminder_email_sent` o `reminder_email_failed`.

## Alertas de vencidos

`sendOverdueAlerts` corre 08:00 Bogotá (13:00 UTC). Una vez al día agrupa todas las tareas con `taskDate < hoy` y estado `pending|in_progress|failed|blocked|reopened`. Envía un único correo a los administradores y administradores de clientes activos. Cada tarea queda marcada en `overdueAlertSentDates` para evitar duplicados el mismo día.

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `COSMOS_CONNECTION_STRING` | Cadena de conexión Cosmos DB |
| `COSMOS_DATABASE_NAME` | Nombre de la BD (default `erp-update-scheduler`) |
| `KEY_VAULT_URL` | URL del Key Vault |
| `JWT_SECRET` | Secreto para firmar tokens (≥ 32 bytes recomendado) |
| `JWT_EXPIRES_IN` | p.ej. `8h` |
| `DEV_AUTH_ENABLED` | `true` solo en desarrollo |
| `EMAIL_PROVIDER` | `mock` \| `sendgrid` \| `acs` |
| `EMAIL_FROM` | Remitente |
| `EMAIL_FROM_NAME` | Nombre del remitente |
| `SENDGRID_API_KEY` | Solo si `EMAIL_PROVIDER=sendgrid` |
| `SETUP_SECRET` | Solo durante el bootstrap del primer admin |

## Comandos exactos para configurar Azure

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"

# Generar JWT_SECRET (64 bytes en base64)
$jwtSecret = [Convert]::ToBase64String((1..64 | ForEach-Object { Get-Random -Maximum 256 }))

az functionapp config appsettings set `
  --name $functionApp `
  --resource-group $resourceGroup `
  --settings `
    "JWT_SECRET=$jwtSecret" `
    "JWT_EXPIRES_IN=8h" `
    "DEV_AUTH_ENABLED=false"

# Email mock (sin envío real, solo logs)
az functionapp config appsettings set `
  --name $functionApp `
  --resource-group $resourceGroup `
  --settings `
    "EMAIL_PROVIDER=mock" `
    "EMAIL_FROM=no-reply@pya.com.co" `
    "EMAIL_FROM_NAME=Programador de Actualizaciones"

# Email real con SendGrid (cuando esté listo)
az functionapp config appsettings set `
  --name $functionApp `
  --resource-group $resourceGroup `
  --settings `
    "EMAIL_PROVIDER=sendgrid" `
    "SENDGRID_API_KEY=SG...." `
    "EMAIL_FROM=no-reply@pya.com.co" `
    "EMAIL_FROM_NAME=Programador de Actualizaciones"
```

## Cómo asignar contraseña al admin existente (camilo.palacio@pya.com.co)

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"
$apiBase       = "https://$functionApp.azurewebsites.net/api"

# 1) Asegúrese de que SETUP_SECRET esté configurado.
$setupSecret = [Guid]::NewGuid().ToString("N")
az functionapp config appsettings set `
  --name $functionApp --resource-group $resourceGroup `
  --settings "SETUP_SECRET=$setupSecret"

# Espere ~30s a que reinicie la Function App.
Start-Sleep -Seconds 30

# 2) Asignar la contraseña al admin existente.
$cuerpo = @{
  setupSecret = $setupSecret
  email       = "camilo.palacio@pya.com.co"
  password    = "ContraseñaTemporalSegura123"
} | ConvertTo-Json

Invoke-RestMethod -Uri "$apiBase/setup/set-admin-password" -Method Post -Body $cuerpo -ContentType "application/json"

# 3) Borrar SETUP_SECRET para deshabilitar el endpoint.
az functionapp config appsettings set `
  --name $functionApp --resource-group $resourceGroup `
  --settings "SETUP_SECRET="
```

## Comandos exactos para redesplegar (ZIP)

Si `func azure functionapp publish` no detecta funciones (caso conocido en algunos planes Consumption con Node 4 v4 model), use el método ZIP:

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"

cd erp-update-scheduler\api
npm install
npm run build

# Empaquetar todo (incluye node_modules)
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

# El despliegue automático ocurre vía GitHub Actions de Static Web Apps cuando hace push.
git add ..\..\erp-update-scheduler
git commit -m "Login email/password, recordatorios y alertas, colores corporativos"
git push
```

## Archivos modificados/nuevos

### Backend
- `api/src/lib/password.ts` (nuevo)
- `api/src/lib/jwt.ts` (nuevo)
- `api/src/lib/emailService.ts` (nuevo)
- `api/src/lib/reminderLogic.ts` (nuevo)
- `api/src/lib/auth.ts` (validación Bearer)
- `api/src/lib/audit.ts` (más claves sensibles)
- `api/src/lib/scheduleService.ts` (campo `reminders`)
- `api/src/types/models.ts` (`UserRecord` con password, `RemindersConfig`, `SentReminder`, etc.)
- `api/src/functions/auth.ts` (nuevo)
- `api/src/functions/me.ts` (sanitiza)
- `api/src/functions/users.ts` (password + reset)
- `api/src/functions/setup.ts` (password + set-admin-password)
- `api/src/functions/sendScheduledReminders.ts` (nuevo)
- `api/src/functions/sendOverdueAlerts.ts` (nuevo)
- `api/src/index.ts` (registra nuevas funciones)
- `api/src/tests/password.test.ts` (nuevo)
- `api/src/tests/jwt.test.ts` (nuevo)
- `api/src/tests/emailService.test.ts` (nuevo)
- `api/src/tests/reminderLogic.test.ts` (nuevo)

### Frontend
- `frontend/src/api/client.ts` (Authorization Bearer + getToken/setToken)
- `frontend/src/auth/AuthContext.tsx` (`iniciarSesion(email, password)`)
- `frontend/src/pages/LoginPage.tsx` (minimalista email + contraseña)
- `frontend/src/pages/UsuariosPage.tsx` (creación con password, reset password, activar/desactivar)
- `frontend/src/components/SeleccionFrecuencia.tsx` (sección recordatorios)
- `frontend/src/styles.css` (variables CSS corporativas)
- `frontend/src/tests/LoginPage.test.tsx` (actualizado)

## Resultado de pruebas y builds

```
Backend tests : 52 passed (12 archivos)
Frontend tests: 13 passed (4 archivos)

Backend build : OK (tsc)
Frontend build: OK (vite build) — index-CgkYJmHa.css 6.72 kB; index-DARYlxvz.js 271.10 kB
```
