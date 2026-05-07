# Cambios incrementales — Versión 5

Cuatro correcciones puntuales sobre la aplicación existente.

## 1. Fix del 404 al refrescar `/tareas`

**Problema**: al refrescar cualquier ruta del SPA (`/tareas`, `/clientes`, …) Static Web Apps devolvía `404 Not Found` porque no existía un fallback al `index.html`.

**Solución**: `frontend/staticwebapp.config.json` (también copiado a `frontend/public/` para que Vite lo incluya en `dist/`).

```json
{
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/assets/*", "*.{css,js,png,jpg,jpeg,gif,ico,svg,woff,woff2,ttf,otf,map,json}"]
  },
  "responseOverrides": {
    "404": { "rewrite": "/index.html", "statusCode": 200 }
  }
}
```

Después del primer `npm run build`, el archivo aparece en `dist/staticwebapp.config.json` y es leído automáticamente por Azure Static Web Apps.

## 2. Listas ocultan automáticamente lo eliminado

`GET /api/clients`, `/api/domains` y `/api/databases` ahora **excluyen** registros con `status = "deleted"` cuando no se envía un filtro de estado. Para verlos explícitamente: `?includeDeleted=true` o `?status=deleted`.

Resultado en la UI: al eliminar un registro, deja de aparecer en la tabla.

## 3. Eliminación física con verificación de integridad

| Recurso | Antes | Ahora |
|---|---|---|
| `DELETE /clients/{id}` | soft delete (`status="deleted"`) | hard delete; falla con 400 si tiene dominios o bases activas asociadas |
| `DELETE /domains/{id}` | soft delete | hard delete; falla con 400 si tiene bases o frecuencias asociadas |
| `DELETE /databases/{id}` | soft delete | hard delete; falla con 400 si tiene frecuencias asociadas. Borra el secreto SMTP de Key Vault. |
| `DELETE /schedules/{id}` | hard delete | hard delete (sin cambios) |

Mensajes claros en español: `"No se puede eliminar el dominio porque tiene 2 base(s) de datos y 1 frecuencia(s) asociadas. Elimine o desactive esos registros primero."`

La página **Frecuencias** ahora tiene también un botón **Eliminar** (con confirmación) además de Activar/Desactivar.

## 4. Selector buscable (typeahead) en formularios y filtros

Nuevo componente `frontend/src/components/SelectorBuscable.tsx` con búsqueda incremental por etiqueta y subtítulo.

Sustituye los `<select>` que listaban registros maestros (puede haber muchos) en:

- **DominiosPage**: filtro de cliente y selector de cliente del formulario.
- **BasesDeDatosPage**: filtros de cliente y dominio; selectores de cliente y dominio del formulario.
- **FrecuenciasPage**: selector de cliente del formulario.
- **AuditoriaPage**: filtro de cliente.

Características:
- Filtra al escribir.
- Muestra subtítulo (p. ej. cliente del dominio).
- `permiteVacio` para filtros tipo "Todos".
- Navegación por mouse/teclado.

## Resultado de pruebas y builds

```
Backend tests : 56 passed (13 archivos)
Frontend tests: 18 passed (6 archivos)  ← +SelectorBuscable.test.tsx (3)

Backend build : OK (tsc)
Frontend build: OK (vite) — staticwebapp.config.json incluido en dist/
```

## Comandos para redeploy

### Backend (cambios de listas + DELETE)

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"

cd erp-update-scheduler\api
npm install; npm run build

$zip = "..\backend.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path host.json,package.json,package-lock.json,dist,node_modules -DestinationPath $zip
az webapp deploy --name $functionApp --resource-group $resourceGroup --type zip --src-path $zip
```

### Frontend (incluye `staticwebapp.config.json` para arreglar el 404)

```powershell
cd erp-update-scheduler\frontend
"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.production -Encoding utf8
npm install; npm run build

# Despliegue por GitHub Actions o CLI directa:
git add ..; git commit -m "Fix 404, listas sin deleted, hard delete, selector buscable"; git push
```

## Cómo verificar

1. **404 al refrescar**: abra `https://agreeable-wave-07469d50f.7.azurestaticapps.net/tareas`, presione F5; ahora carga la página de Tareas en lugar del 404 de Azure.
2. **Eliminar y desaparece**: en Clientes, Dominios o Bases de datos, clic en **Eliminar** → confirmación → la fila ya no aparece. La auditoría guarda el evento.
3. **Verificación de integridad**: intente eliminar un cliente con dominios → mensaje en español indicando cuántos hay; cancele eliminando primero las bases/frecuencias.
4. **Selector buscable**: en el formulario de "Nueva base de datos", haga clic en el campo Cliente y escriba parte del nombre — verá la lista filtrada.

## Archivos modificados / nuevos

### Frontend
- `frontend/staticwebapp.config.json` (nuevo, en raíz)
- `frontend/public/staticwebapp.config.json` (copia que Vite incluye en `dist/`)
- `frontend/src/components/SelectorBuscable.tsx` (nuevo)
- `frontend/src/styles.css` (estilos del selector)
- `frontend/src/pages/DominiosPage.tsx` (selector buscable)
- `frontend/src/pages/BasesDeDatosPage.tsx` (selector buscable)
- `frontend/src/pages/FrecuenciasPage.tsx` (selector buscable + botón Eliminar)
- `frontend/src/pages/AuditoriaPage.tsx` (selector buscable)
- `frontend/src/tests/SelectorBuscable.test.tsx` (nuevo)

### Backend
- `api/src/functions/clients.ts` (oculta deleted, hard delete con integridad)
- `api/src/functions/domains.ts` (oculta deleted, hard delete con integridad)
- `api/src/functions/databases.ts` (oculta deleted, hard delete con integridad y borrado de secreto en KV)
