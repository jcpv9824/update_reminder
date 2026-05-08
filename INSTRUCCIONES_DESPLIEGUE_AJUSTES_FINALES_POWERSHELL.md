# Instrucciones de despliegue de últimos cambios con PowerShell

Fecha: 2026-05-07

Estos pasos publican los cambios finales de flujo **Cliente → Dominio → Base de datos → Tareas**, el tablero agrupado de tareas, la ventana visible de tareas, las frecuencias con fecha de fin opcional y la reorganización de **Alertas y correos**.

No incluya contraseñas reales en Git, documentación, capturas, logs ni comandos.

## 1. Variables de trabajo

```powershell
$repo = "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp = "erpupdsch4645-api"
$apiBaseUrl = "https://erpupdsch4645-api.azurewebsites.net/api"
```

## 2. Revisar cambios antes de enviar a Git

```powershell
Set-Location $repo
git status
git diff -- README.md DESPLIEGUE.md CAMBIOS_V6.md
git diff -- api/src frontend/src
```

## 3. Ejecutar pruebas y build del backend

```powershell
Set-Location "$repo\api"
npm install
npm test
npm run build
```

## 4. Crear ZIP y desplegar backend

```powershell
Set-Location "$repo\api"
Remove-Item .\api-deploy-full.zip -ErrorAction SilentlyContinue
tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules

az functionapp deployment source config-zip `
  --resource-group $resourceGroup `
  --name $functionApp `
  --src api-deploy-full.zip

az functionapp restart `
  --resource-group $resourceGroup `
  --name $functionApp
```

## 5. Verificar backend

```powershell
az functionapp function list `
  --resource-group $resourceGroup `
  --name $functionApp `
  --output table
```

Confirme que existan las funciones de tareas, reportes, dominios, frecuencias y configuración de correos. En especial:

- `generateDailyUpdateTasksManual`
- `mastersReportSendEmail`
- funciones de `domains`
- funciones de `schedules`
- funciones de `tasks`

## 6. Ejecutar pruebas y build del frontend

```powershell
Set-Location "$repo\frontend"
"VITE_API_BASE_URL=$apiBaseUrl" | Out-File -FilePath .env.production -Encoding utf8
npm install
npm test
npm run build
```

El build debe generar `frontend\dist`. El archivo `frontend\public\staticwebapp.config.json` debe copiarse a `frontend\dist\staticwebapp.config.json` para evitar 404 al refrescar rutas como `/tareas`.

## 7. Desplegar frontend

Si el frontend se despliega por GitHub Actions de Azure Static Web Apps, use Git:

```powershell
Set-Location $repo
git status
git add README.md DESPLIEGUE.md CAMBIOS_V6.md INSTRUCCIONES_DESPLIEGUE_AJUSTES_FINALES_POWERSHELL.md
git add api/src frontend/src
git commit -m "Ajusta flujo de dominios, frecuencias, tareas y alertas"
git push
```

Si se despliega manualmente con SWA CLI o el método actual del proyecto, publique el contenido de:

```powershell
$repo\frontend\dist
```

## 8. Pruebas manuales después del despliegue

### 8.1 Configuración recomendada de P&A

1. Inicie sesión como administrador.
2. Abra **Alertas y correos**.
3. Pulse **Usar configuración recomendada de P&A**.
4. Verifique remitente `info@pya.com.co`, servidor `smtp.office365.com`, puerto `587`, proveedor `SMTP` y URL pública.
5. Abra **Configuración SMTP avanzada**.
6. Configure la contraseña SMTP solo si necesita cambiarla.
7. Guarde.

La contraseña no debe mostrarse, no debe volver por API y no debe guardarse en Cosmos DB.

### 8.2 Correo de prueba

1. En **Alertas y correos**, vaya al bloque final **Correo de prueba**.
2. Escriba un destinatario válido.
3. Pulse **Enviar correo de prueba**.
4. Verifique mensaje de éxito o error en español.

### 8.3 Reporte maestro manual

1. Abra **Reporte maestro de clientes/dominios/empresas**.
2. Escriba destinatarios separados por punto y coma, por ejemplo:

```text
correo1@empresa.com; correo2@empresa.com
```

3. Pulse **Enviar reporte**.
4. Verifique que el reporte no incluya contraseñas, usuarios SQL, cadenas de conexión completas, secretos ni tokens.

### 8.4 Flujo Cliente → Dominio → Base

1. Cree un cliente.
2. Use **Guardar y agregar dominio**.
3. Cree un dominio con frecuencia semanal y, si aplica, fecha de fin.
4. Use **Guardar y agregar base de datos**.
5. Cree una base asociada al dominio.
6. Confirme que la base muestra la frecuencia heredada y no pide frecuencia ni rol responsable.

### 8.5 Generar tareas ahora

1. Abra **Tareas** como admin o administrador de clientes.
2. Pulse **Generar tareas ahora**.
3. Verifique mensaje con creadas y omitidas.
4. Confirme que el tablero muestra grupos dentro de la ventana `hoy - 7 días` a `hoy + 7 días`.
5. Abra **Ver detalle** y confirme que las tareas individuales están dentro del grupo.

### 8.5.1 Tablero agrupado de tareas

1. Cree o genere varias tareas para el mismo día.
2. Confirme que la vista principal muestra grupos por responsable, fecha y tipo.
3. Confirme que no aparecen todos los dominios o bases como tarjetas principales.
4. Abra un grupo de dominios y use **Copiar dominio** o **Copiar todos los dominios pendientes**.
5. Abra un grupo de bases y use **Copiar base**, **Copiar dominio** o **Copiar todas las bases pendientes**.
6. Marque una tarea como completada. Debe mostrar `Guardando` y luego `Guardado`.
7. Si una acción falla, debe verse `Error` y el botón **Reintentar**.

### 8.6 Actualizadores

1. Inicie sesión con rol **Actualizador de dominios** o **Actualizador de bases de datos**.
2. Abra **Tareas**.
3. Cambie una tarea de su tipo a iniciada, completada, fallida o bloqueada.
4. Agregue notas cuando corresponda.
