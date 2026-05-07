# Cambios incrementales — Versión 2

Esta ronda de mejoras se aplicó sobre la aplicación existente sin reescribirla.

## Resumen de cambios

| Área | Cambio |
|---|---|
| Login | Pantalla minimalista con botón único “Iniciar sesión con Microsoft”. El selector de roles solo aparece detrás de la variable `VITE_DEV_MODE=true`. |
| Backend | `POST /api/domains` y `POST /api/databases` aceptan ahora un campo opcional `frequency` para crear el dominio/BD y su frecuencia en una sola operación. |
| Backend | Helper `toKeyVaultSecretName` movido a `lib/keyVaultNames.ts` con prueba dedicada. Sanitiza guiones bajos y caracteres inválidos en nombres de secretos. |
| Backend | `loadUserProfileDetailed` distingue **no registrado** vs **inactivo**, y busca por id o por correo electrónico. |
| Backend | `GET /api/me` devuelve mensajes específicos para cada caso. |
| Frontend | Formulario de dominio incluye sección “Frecuencia de actualización del dominio”. |
| Frontend | Formulario de base de datos incluye sección “Frecuencia de actualización de la base de datos”. |
| Frontend | Página unificada `/tareas` con dos columnas (dominios y bases de datos). |
| Frontend | Ruta inicial cambiada a `/tareas`; el tablero queda como página secundaria opcional. |
| Frontend | Menú lateral reorganizado: Tareas primero, Frecuencias marcado como “avanzado”. |
| Frontend | Visibilidad de columnas por rol en la vista de tareas. Visualizadores ven sin botones. |
| Pruebas | +6 pruebas nuevas (sanitización Key Vault, validación de frecuencia, login minimalista, vista unificada por rol). Total: 38 backend + 11 frontend. |
| Documentación | Este archivo + actualizaciones a `README.md`. |

## Login con Microsoft 365

La pantalla de login solo muestra:

- Título y subtítulo.
- Botón **Iniciar sesión con Microsoft**, que redirige a `/.auth/login/aad` (proveedor configurado en Azure Static Web Apps).
- Pequeña ayuda: “Usa tu cuenta corporativa de Microsoft 365”.

El backend extrae al usuario autenticado de la cabecera `x-ms-client-principal` (la inyecta Static Web Apps después del login Entra ID). Después busca al usuario en Cosmos DB por `id` y, si no aparece, por correo electrónico (case-insensitive). Si no existe → `No tienes acceso…`. Si existe pero `active=false` → `Tu usuario está inactivo…`. Solo si está activo se cargan los roles desde Cosmos.

### Modo desarrollo

- Solo visible cuando se compila el frontend con `VITE_DEV_MODE=true`.
- El backend solo lo acepta si `DEV_AUTH_ENABLED=true`.
- En producción ambas variables deben estar en `false`.

## Frecuencia integrada al crear dominio o base de datos

El cuerpo de `POST /api/domains` y `POST /api/databases` puede incluir ahora:

```json
{
  "frequency": {
    "frequencyType": "weekly",
    "everyNWeeks": 1,
    "weekdays": ["FRIDAY"],
    "startDate": "2026-05-08",
    "timezone": "America/Bogota",
    "assignedRole": "domain_updater",
    "assignedUserIds": [],
    "active": true
  }
}
```

Si se incluye:

1. Se valida en `lib/scheduleService.validateFrequency`.
2. Se crea la frecuencia con `targetType` y `targetIds` apuntando al recién creado dominio o base de datos.
3. Se registra auditoría `domain_created` (o `database_created`) **y** `schedule_created`.

El frontend muestra esta sección dentro del formulario de “Nuevo dominio” y “Nueva base de datos”. Es activable con un checkbox por si el usuario quiere crear el objetivo sin frecuencia (por ejemplo, frecuencia manual).

## Vista unificada de tareas

`/tareas` es ahora la página principal. Dispone de dos columnas en escritorio (≥1024 px) y se apilan en móvil:

- Tareas de dominios
- Tareas de bases de datos

Cada columna muestra grupos: **Vencidas, Hoy, Próximas, Completadas**. Cada tarea es compacta con cliente, fecha, estado, responsable y botones rápidos: Iniciar, Completar, Bloquear, Fallar (o Reabrir si está completada). El botón **Abrir** muestra el detalle, incluyendo el panel de acceso a base de datos con las cuatro partes copiables.

### Visibilidad por rol

| Rol | Columna dominios | Columna bases | Botones de acción |
|---|---|---|---|
| Administrador | ✅ | ✅ | ✅ |
| Administrador de clientes | ✅ | ✅ | ✅ |
| Actualizador de dominios | ✅ | ❌ | ✅ |
| Actualizador de bases de datos | ❌ | ✅ | ✅ |
| Visualizador | ✅ | ✅ | ❌ |

## Bug de Key Vault

El nombre de secreto se construye ahora con `toKeyVaultSecretName(...)` que reemplaza guiones bajos, espacios y caracteres especiales. Se preservan letras, números y guiones; se eliminan guiones repetidos y a los extremos; longitud máxima 127. Hay prueba unitaria con el caso real:

```
db-db_f9fd2821-password  →  db-db-f9fd2821-password
```

## Cómo redesplegar

```powershell
# Variables (use las del despliegue actual)
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"

# Backend
cd erp-update-scheduler\api
npm install
npm run build
func azure functionapp publish $functionApp

# Frontend
cd ..\frontend
npm install
"VITE_API_BASE_URL=https://$functionApp.azurewebsites.net/api`nVITE_DEV_MODE=false" | Out-File -FilePath .env.production -Encoding utf8
npm run build
# El despliegue del frontend es por GitHub Actions de Static Web Apps.
git add ..; git commit -m "Mejoras incrementales"; git push
```

### Configurar CORS

```powershell
az functionapp cors add --name $functionApp --resource-group $resourceGroup --allowed-origins "https://NOMBRE-STATIC-WEB-APP.azurestaticapps.net"
# Para credenciales (Microsoft Entra ID)
az resource update `
  --resource-group $resourceGroup `
  --name $functionApp `
  --resource-type "Microsoft.Web/sites/config" `
  --namespace "Microsoft.Web" `
  --parent "sites/$functionApp" `
  --set properties.cors.supportCredentials=true
```

## Archivos modificados

Backend:
- `api/src/lib/keyVaultNames.ts` (nuevo)
- `api/src/lib/scheduleService.ts` (nuevo)
- `api/src/lib/databaseService.ts` (refactor: usa helper externo)
- `api/src/lib/auth.ts` (loadUserProfileDetailed, búsqueda por email)
- `api/src/functions/me.ts` (mensajes diferenciados)
- `api/src/functions/domains.ts` (acepta `frequency`)
- `api/src/functions/databases.ts` (acepta `frequency`)
- `api/src/tests/keyVaultNames.test.ts` (nuevo)
- `api/src/tests/scheduleService.test.ts` (nuevo)

Frontend:
- `frontend/src/pages/LoginPage.tsx` (minimalista)
- `frontend/src/pages/TareasPage.tsx` (vista unificada de dos columnas)
- `frontend/src/pages/DominiosPage.tsx` (sección frecuencia)
- `frontend/src/pages/BasesDeDatosPage.tsx` (sección frecuencia)
- `frontend/src/components/SeleccionFrecuencia.tsx` (nuevo, reutilizable)
- `frontend/src/components/AppLayout.tsx` (menú reorganizado)
- `frontend/src/auth/AuthContext.tsx` (mensajes diferenciados, logout SWA)
- `frontend/src/App.tsx` (ruta inicial /tareas)
- `frontend/src/styles.css` (estilos de tareas en dos columnas)
- `frontend/src/tests/LoginPage.test.tsx` (nuevo)
- `frontend/src/tests/TareasPage.test.tsx` (nuevo)
