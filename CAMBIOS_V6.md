# Cambios incrementales - Version 6

Ronda incremental sin reconstruir la app: se simplifico la configuracion de correos, se agrego un reporte maestro por email, se centralizo el flujo principal de frecuencias en dominios y se agrego generacion manual de tareas.

## 1. Alertas y correos simplificado

La pagina **Alertas y correos** ahora se organiza en secciones comprimibles:

1. Estado del correo.
2. Configuracion basica.
3. Recordatorios a actualizadores.
4. Alertas a administradores.
5. Reporte de clientes/dominios/empresas.
6. Configuracion avanzada SMTP.
7. Correo de prueba.

La seccion **Configuracion avanzada SMTP** esta colapsada por defecto. La tarjeta superior muestra proveedor, remitente, estado de contrasena SMTP y ultima actualizacion, sin mostrar secretos.

## 2. Configuracion recomendada de P&A

El boton **Usar configuracion recomendada de P&A** llena:

- `emailProvider = smtp`
- `emailFrom = info@pya.com.co`
- `emailFromName = Programador de Actualizaciones`
- `smtpHost = smtp.office365.com`
- `smtpPort = 587`
- `smtpSecure = false`
- `smtpUser = info@pya.com.co`
- `frontendBaseUrl = https://agreeable-wave-07469d50f.7.azurestaticapps.net`

No llena contrasena. La contrasena SMTP debe escribirse manualmente y sigue guardandose en Key Vault.

## 3. Reporte manual por correo

Nuevo endpoint:

```http
POST /api/reports/masters/send-email
```

Body:

```json
{
  "to": "correo1@empresa.com; correo2@empresa.com"
}
```

Reglas:

- Requiere JWT.
- Permite `admin` y `client_manager`.
- Valida correos separados por punto y coma.
- Envia HTML y texto plano usando `EmailService`.
- Audita `masters_report_email_sent` y `masters_report_email_failed`.
- No incluye contrasenas, usuarios SQL, cadenas de conexion completas, secretos ni tokens.

## 4. Frecuencias heredadas desde dominio

El flujo principal queda asi:

1. Crear dominio y configurar frecuencia.
2. Crear base de datos seleccionando dominio.
3. La base usa la frecuencia activa del dominio.

La vista **Nueva base de datos** ya no muestra frecuencia individual. Si el dominio no tiene frecuencia activa, muestra advertencia para configurar la frecuencia en el dominio.

Regla documentada: una frecuencia especifica activa de base de datos, si existe por compatibilidad o casos avanzados, tiene prioridad sobre la herencia del dominio. Si no existe, se hereda la frecuencia del dominio.

## 5. Generacion de tareas por dominio

La generacion diaria y manual ahora expande frecuencias de dominio:

- Crea una tarea para el dominio.
- Crea una tarea para cada base activa del dominio.
- Omite dominios inactivos/eliminados.
- Omite bases inactivas/eliminadas.
- Mantiene idempotencia y reporta duplicados omitidos.

## 6. Generar tareas ahora

La vista **Tareas** muestra **Generar tareas ahora** para `admin` y `client_manager`.

El boton llama:

```http
POST /api/tasks/generate
```

Respuesta:

```json
{
  "created": 10,
  "skipped": 5,
  "message": "Tareas generadas correctamente."
}
```

La UI muestra loading, mensaje de exito/error en espanol y refresca la lista.

## 7. Seguridad

- SMTP password no se hardcodea.
- SMTP password no se guarda en Cosmos DB.
- SMTP password no se devuelve al frontend.
- SMTP password no se incluye en auditoria.
- El reporte maestro no incluye datos sensibles.
- Solo admin configura SMTP.
- Admin y administrador de clientes pueden enviar el reporte y generar tareas manualmente.

## 8. Pruebas agregadas/actualizadas

Backend:

- Defaults SMTP P&A.
- GET/settings sanitizado sin secreto.
- Guardado de contrasena SMTP en Key Vault.
- Permisos para reporte maestro y generacion manual.
- Validacion de correos separados por punto y coma.
- Reporte sin passwords, secretos, usuarios SQL ni connection strings completas.
- Herencia de frecuencia desde dominio.
- Generacion de tareas de dominio y bases asociadas.
- Idempotencia y omitidos.
- Omision de dominios/bases inactivos o eliminados.
- Prioridad de frecuencia especifica de base de datos.

Frontend:

- SMTP avanzado colapsado.
- Boton de configuracion P&A.
- Destinatarios de reporte separados por punto y coma.
- Rechazo de correos invalidos.
- Envio de reporte.
- Nueva base de datos muestra frecuencia heredada y no frecuencia individual.
- Boton **Generar tareas ahora** visible solo para roles permitidos.
- Llamada a `/tasks/generate`.

## 9. Archivos principales modificados

Backend:

- `api/src/functions/generateDailyUpdateTasks.ts`
- `api/src/functions/reports.ts`
- `api/src/lib/taskGenerator.ts`
- `api/src/lib/reportsService.ts`
- `api/src/lib/settingsService.ts`
- `api/src/lib/permissions.ts`
- `api/src/index.ts`

Frontend:

- `frontend/src/pages/AlertasCorreosPage.tsx`
- `frontend/src/pages/BasesDeDatosPage.tsx`
- `frontend/src/pages/TareasPage.tsx`
- `frontend/src/styles.css`

Documentacion:

- `README.md`
- `DESPLIEGUE.md`
- `CAMBIOS_V6.md`
