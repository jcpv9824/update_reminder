# Cambios incrementales — Versión 7

## Resumen

| Tema | Resultado |
|---|---|
| Bug "Generar tareas ahora — created: 0" | **Corregido**. La generación recorre toda la ventana, no una sola fecha. |
| Herencia de frecuencia dominio → bases | Confirmada y cubierta por pruebas (escenario SAMPEDRO). |
| Diagnostics en `POST /api/tasks/generate` | Implementado (campo `diagnostics`). |
| Modal cierra por backdrop al soltar fuera | **Corregido** globalmente. |
| Login filtra existencia de usuario | **Corregido**. Mensaje genérico para todos los fallos. |
| Forgot password + Reset password | Implementado (token aleatorio 32 bytes, hash SHA-256, expiración 30 min). |
| Hardening | Longitudes máximas, escape HTML en plantillas, queries Cosmos parametrizadas. |
| Pruebas | **90 backend + 34 frontend** (todas verdes). |
| Builds | `tsc` OK; `vite build` OK. |

---

## 1. Bug raíz de "Generar tareas ahora"

**Causa**: `runTaskGeneration(isoDate, ...)` evaluaba **una sola fecha** (la del día), pero la respuesta y la UI hablaban de una ventana `[hoy-7, hoy+7]`. Con `isoDate = 2026-05-07` (jueves) y un schedule weekly Friday, no había candidato — el viernes 2026-05-08 nunca se evaluaba.

**Fix**: la nueva implementación construye `ventana = [windowStart..windowEnd]` (15 días por defecto) y llama `summarizeTaskGenerationForDate` por cada fecha de la ventana. El cuerpo de la petición acepta opcionalmente `windowStart` / `windowEnd` para sobrescribir.

`isScheduleDueOnDate` ya respetaba `startDate` como "no antes de"; el problema no era el motor de fechas sino el iterador.

## 2. Herencia dominio → bases (escenario SAMPEDRO)

`expandSchedulesWithDomainInheritance` ya hacía esto, pero estaba subordinado al bug anterior. Las bases activas asociadas al dominio reciben un schedule "virtual":
- mismo `frequencyType` y fechas
- `targetType = "database"`, `targetIds = [dbId]`
- `assignedRole = "database_updater"`

Si existe un schedule específico activo para esa base, gana el específico (la herencia se omite).

Pruebas en `windowGeneration.test.ts`:
- `startDate jueves 2026-05-07 con weekday FRIDAY genera el viernes 2026-05-08`
- `expandSchedulesWithDomainInheritance crea el schedule heredado para la base`
- `recorriendo la ventana 2026-04-30..2026-05-14 se generan 2 tareas (dominio + base) el 2026-05-08`
- `idempotencia: ejecutar dos veces no duplica las tareas`
- `dominio inactivo no genera tareas`

## 3. Ejemplo de respuesta `POST /api/tasks/generate`

**Caso SAMPEDRO ejecutado el 2026-05-07:**

```json
{
  "date": "2026-05-07",
  "created": 2,
  "skipped": 0,
  "windowStart": "2026-04-30",
  "windowEnd": "2026-05-14",
  "message": "Tareas generadas correctamente.",
  "diagnostics": {
    "activeClients": 1,
    "activeDomains": 1,
    "activeDatabases": 1,
    "activeSchedules": 1,
    "schedulesEvaluated": 2,
    "candidateDates": ["2026-05-08"],
    "eligibleDomainTasks": 1,
    "eligibleDatabaseTasks": 1,
    "createdDomainTasks": 1,
    "createdDatabaseTasks": 1,
    "skippedDomainTasks": 0,
    "skippedDatabaseTasks": 0,
    "reasons": []
  }
}
```

**Cuando no genera nada, `reasons` explica por qué:**

```json
{
  "created": 0,
  "diagnostics": {
    "candidateDates": [],
    "reasons": [
      "Schedule schedule_xxx omitido: no tiene fechas candidatas en 2026-04-30..2026-05-14.",
      "Dominio domain_yyy omitido: estado inactive."
    ]
  }
}
```

`diagnostics` no contiene SQL users, contraseñas, tokens, secret values ni cadenas de conexión.

## 4. Modal — fix de cierre accidental

`Modal` (`components/Comunes.tsx`) deja de invocar `onCerrar` desde el backdrop por defecto. Adicionalmente:
- `onMouseDown` se detiene en el modal para evitar que un drag de selección de texto que termine afuera dispare el cierre.
- Botón **Cerrar** explícito con `aria-label`.
- Modales informativas pueden pasar `cerrarPorFondo={true}` para volver al comportamiento antiguo.

`DialogoConfirmar` reusa `Modal` y por tanto hereda el comportamiento. Todos los formularios (Clientes, Dominios, Bases, Frecuencias, Usuarios, Alertas) quedan protegidos sin cambios adicionales.

## 5. Login — error genérico

`POST /api/auth/login` devuelve siempre **HTTP 401** con `{ "error": "Correo o contraseña incorrectos." }` ante:
- correo desconocido
- contraseña incorrecta
- usuario inactivo
- usuario sin `passwordHash`
- payload mal formado

Schemas Zod limitan email a 254 y password a 200 caracteres. No se devuelven stack traces.

## 6. Forgot / Reset password

**Endpoints nuevos**

```
POST /api/auth/forgot-password
POST /api/auth/reset-password
```

**`forgot-password`** siempre devuelve el mismo mensaje:
> *"Si el correo existe y está activo, enviaremos instrucciones para restablecer la contraseña."*

Si el usuario existe y está activo, el backend:
1. Genera 32 bytes aleatorios → hex (token de 64 chars).
2. Calcula SHA-256 → guarda **solo el hash** en `passwordResetTokenHash`.
3. Establece `passwordResetExpiresAt = ahora + 30 min`.
4. Envía email con plantilla `renderResetPasswordEmail` (campos del usuario escapados con `escapeHtml`).
5. URL de reset: `${frontendBaseUrl}/reset-password?token=...`.
6. Audita `password_reset_requested` (sin token).

El raw token no entra a logs ni a la respuesta HTTP.

**`reset-password`** acepta `{ token, password }`:
1. Hashea el token y busca por `passwordResetTokenHash`.
2. Rechaza si no existe, está usado, o expiró.
3. Hashea la nueva contraseña con bcrypt.
4. Marca `passwordResetUsedAt = ahora`, limpia `passwordResetTokenHash` y `passwordResetExpiresAt`.
5. Audita `password_reset_completed`.

Errores devuelven: *"El enlace no es válido o ya expiró. Solicita uno nuevo."*

**Frontend**:
- `LoginPage.tsx`: enlace **"¿Olvidaste tu contraseña?"**.
- `ForgotPasswordPage.tsx`: ruta `/forgot-password`.
- `ResetPasswordPage.tsx`: ruta `/reset-password?token=...`.

## 7. Hardening

- `LoginSchema`, `ForgotSchema`, `ResetSchema` con `max(254)` para email y `max(200)` para password; `token` 16-256 chars.
- `ClientSchema` con `name.max(200)` y `notes.max(2000)`.
- Cosmos queries usan parámetros (`@e`, `@id`, `@h`, etc.) — sin concatenación.
- `escapeHtml` aplicado a `displayName` y `email` dentro de `renderResetPasswordEmail`.
- `auth.ts`: `try/catch` que no filtra mensajes detallados al cliente.
- No se loguean: passwords, tokens crudos, stack traces.

Pruebas adicionales:
- `resetTokens.test.ts` (5): generación aleatoria, hashing determinista, no colisiones, expiración.
- `emailEscape.test.ts` (2): `escapeHtml` y plantilla de reset bloquean `<script>` / `<img onerror>`.
- `windowGeneration.test.ts` (5): escenario SAMPEDRO completo.

## 8. Resultados

```
Backend  : 90 tests passed (19 archivos)
Frontend : 34 tests passed (9 archivos)
tsc API  : OK
tsc Front: OK
vite build: OK (300.46 kB JS, 8.16 kB CSS)
```

## 9. Comandos de redespliegue

### Backend

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"

cd erp-update-scheduler\api
npm install; npm run build
if (Test-Path ..\backend.zip) { Remove-Item ..\backend.zip }
Compress-Archive -Path host.json,package.json,package-lock.json,dist,node_modules -DestinationPath ..\backend.zip
az webapp deploy --name $functionApp --resource-group $resourceGroup --type zip --src-path ..\backend.zip
```

### Frontend

```powershell
cd erp-update-scheduler\frontend
"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.production -Encoding utf8
npm install; npm run build
git add ..; git commit -m "Fix generación por ventana, modales, login genérico, forgot password"; git push
```

## 10. Verificación manual (escenario reportado)

1. Cliente SAMPEDRO + dominio `https://sampedro.sagerp.cloud:54678/` (activo) + 1 base activa asociada.
2. Schedule weekly FRIDAY startDate `2026-05-07`, `targetType=domain`, `targetIds=[domainId]`, activo.
3. `POST /api/tasks/generate`. Esperado:
   - `created: 2`
   - `diagnostics.candidateDates: ["2026-05-08"]`
   - `createdDomainTasks: 1`, `createdDatabaseTasks: 1`
4. `GET /api/tasks?...` muestra ambas tareas.
5. UI: aparecen agrupadas en **Próximas** del 8 de mayo.

## 11. Riesgos / pendientes

- La protección "cambios sin guardar" no se implementó esta ronda; solo se previene cierre por backdrop. Si el usuario pulsa **Cerrar**, los datos se descartan sin advertir.
- El email de reset usa el `frontendBaseUrl` configurado en *Alertas y correos*. Si está vacío, el enlace queda relativo (`/reset-password?token=...`); revisar que esté lleno antes de usar el flujo en producción.

## 12. Archivos modificados / nuevos

### Backend
- `api/src/functions/generateDailyUpdateTasks.ts` (refactor completo: ventana + diagnostics)
- `api/src/functions/auth.ts` (login genérico + forgot + reset)
- `api/src/functions/clients.ts` (max length)
- `api/src/lib/resetTokens.ts` (nuevo)
- `api/src/lib/emailService.ts` (`escapeHtml`, `renderResetPasswordEmail`)
- `api/src/types/models.ts` (campos `passwordResetTokenHash`, `passwordResetExpiresAt`, `passwordResetUsedAt`)
- `api/src/tests/windowGeneration.test.ts` (nuevo, 5 pruebas)
- `api/src/tests/resetTokens.test.ts` (nuevo, 5 pruebas)
- `api/src/tests/emailEscape.test.ts` (nuevo, 2 pruebas)

### Frontend
- `frontend/src/components/Comunes.tsx` (Modal sin cierre por backdrop)
- `frontend/src/pages/LoginPage.tsx` (link a forgot)
- `frontend/src/pages/ForgotPasswordPage.tsx` (nuevo)
- `frontend/src/pages/ResetPasswordPage.tsx` (nuevo)
- `frontend/src/App.tsx` (rutas `/forgot-password`, `/reset-password`)
- `frontend/src/tests/LoginPage.test.tsx` (envuelve render en `MemoryRouter`)
