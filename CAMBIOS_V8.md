# Cambios incrementales — Versión 8

## Resumen

Esta ronda consolida cambios profundos pero incrementales sobre la aplicación existente. No se cambió la arquitectura: React + Vite + TypeScript, Azure Functions, Cosmos DB, Key Vault, JWT con correo/contraseña y auditoría siguen vigentes.

## Cambios principales

- **Bases de datos**: la tabla maestra ya no muestra columnas visibles de Servidor ni Versión. Esos datos siguen disponibles en Ver acceso, tareas y correos técnicos.
- **Reporte maestro por correo**: ahora usa solo clientes, dominios y bases activos; agrega ambiente en dominios y bases; omite usuarios SQL, contraseñas, servidor, cadenas de conexión, tokens y nombres de secretos.
- **Eliminación en cascada**: clientes, dominios y bases usan confirmación explícita y `cascade=true`. Los maestros quedan en `status = "deleted"` con metadata de eliminación; las programaciones asociadas se eliminan en cascada; tareas futuras/pendientes se cancelan; auditoría no se borra.
- **Dominios**: la acción **Copiar para publicar** se reemplazó por **Ver bases asociadas**, con modal de bases, servidor/puerto, usuario y contraseña oculta.
- **Clientes**: se agregó **Ver dominios y bases**, con árbol cliente → dominios → bases.
- **Programaciones especiales**: el formulario ahora permite construir alcance jerárquico por grupos: agregar cliente, incluir todos sus dominios o dominios concretos, e incluir todas las bases o bases concretas por dominio.
- **Responsables**: programaciones especiales soportan asignación por rol o por usuarios específicos para dominios y bases de datos.
- **Tareas**: las tareas bloqueadas se pueden resolver con comentario obligatorio a pendiente, en progreso o completada. Las completadas se pueden reabrir a pendiente. Se conserva auditoría.
- **Alertas por correo**: vencidos y bloqueos/errores tienen destinatarios separados por roles y correos manuales; los correos se deduplican.
- **Correos de error de base**: incluyen servidor y puerto, base de datos y usuario. No incluyen contraseña ni connection string completa.
- **Frecuencia global de vencidos**: diaria o semanal, con hora, zona horaria, días de semana e idempotencia por periodo.
- **Tareas**: el botón manual ahora se llama **Refrescar**, usa `POST /api/tasks/refresh` y no dispara correos ni recordatorios.
- **SMTP**: configuración avanzada sigue colapsada; la configuración recomendada de P&A llena valores seguros y nunca contraseña.
- **Recordatorios administrativos**: nueva sección con recordatorios mensuales para:
  - Guardar versión mensual de SAG Web.
  - Crear documento “¿Qué hay de nuevo en SAG Web?”.
- **Static Web Apps**: `frontend/public/staticwebapp.config.json` mantiene navigation fallback para evitar 404 al refrescar `/tareas`.

## Endpoints nuevos o relevantes

- `GET /api/clients/{id}/tree`
- `GET /api/domains/{id}/databases`
- `DELETE /api/clients/{id}?cascade=true`
- `DELETE /api/domains/{id}?cascade=true`
- `DELETE /api/databases/{id}?cascade=true`
- `POST /api/tasks/refresh`
- `POST /api/tasks/{id}/resolve-block`
- `POST /api/settings/email-alerts/administrative-reminders/{key}/test`

## Seguridad

- No se hardcodearon contraseñas.
- La contraseña SMTP sigue guardándose en Key Vault.
- Las contraseñas de bases no se precargan ni se escriben en consola.
- Los reportes y auditorías sanitizan datos sensibles.
- La eliminación en cascada no elimina audit logs.

## Cosmos DB

Se agregó el contenedor:

```powershell
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name emailNotifications --partition-key-path "/id"
```

Se usa para idempotencia de recordatorios administrativos mensuales.

## Pruebas y builds validados

```powershell
cd api
npm test
npm run build

cd ..\frontend
npm test
npm run build
```

Resultado de esta ronda:

- Backend tests: 21 archivos, 135 pruebas, todas verdes.
- Backend build: OK.
- Frontend tests: 14 archivos, 89 pruebas, todas verdes.
- Frontend build: OK.
