# Handoff — Programador de Actualizaciones ERP

Este documento es el contexto operativo para continuar el proyecto con otro chat o agente de IA. La aplicación ya existe y está parcialmente desplegada; no debe reconstruirse desde cero. Antes de editar, el siguiente agente debe inspeccionar los archivos reales del repositorio porque este proyecto cambia con frecuencia.

## Cómo usar este archivo en otro chat

1. Abra un chat nuevo con el asistente o agente de programación.
2. Adjunte este archivo o pegue su contenido completo.
3. Use una instrucción como:

```text
Este es el contexto completo del proyecto Programador de Actualizaciones ERP. Léelo primero y úsalo como fuente de verdad. La app ya existe: no la reconstruyas desde cero, trabaja incrementalmente, preserva la arquitectura, no rompas login/JWT/Cosmos/Key Vault/auditoría/tareas/alertas, y agrega pruebas para todo lo que toques.
```

4. Si el agente tiene acceso al sistema de archivos, indicar la ruta:

```text
C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler
```

5. Pedirle que ejecute pruebas y build antes de entregar cambios, y que no incluya secretos en logs, documentación ni respuestas.

Regla operativa para Cloud Code u otro agente:

- Después de cada cambio real debe ejecutar pruebas relacionadas y, al final, pruebas/build completos.
- No debe desplegar ni reportar “listo” si las pruebas fallan.
- Si todo pasa, debe dejar un commit con mensaje claro antes de desplegar o pedir revisión.
- Después de desplegar, debe verificar que el cambio sea visible en producción y revisar GitHub Actions, caché de Static Web Apps y Ctrl+F5 si “todo se ve igual”.

## 1. Descripción general

**Programador de Actualizaciones ERP** gestiona el trabajo operativo para actualizar dominios y bases de datos del ERP por cliente. El flujo principal es:

- Registrar clientes.
- Registrar dominios de clientes.
- Registrar empresas/bases de datos asociadas a dominios.
- Configurar frecuencias recurrentes o programaciones especiales.
- Generar tareas para actualizadores de dominios y bases.
- Hacer seguimiento de tareas vencidas, de hoy, próximas y completadas.
- Notificar por correo recordatorios, vencidos, bloqueos y reportes.
- Auditar acciones sensibles y cambios de estado.

Usuarios objetivo:

- Administradores de la plataforma.
- Administradores de clientes.
- Actualizadores de dominios.
- Actualizadores de bases de datos.
- Visualizadores.

Toda la UI, validaciones, correos y documentación deben permanecer en español.

## 2. Stack técnico

- Frontend: React + Vite + TypeScript.
- Estado/datos frontend: TanStack Query y React Router.
- Pruebas frontend: Vitest + Testing Library.
- Backend: Azure Functions Node.js + TypeScript.
- Pruebas backend: Vitest.
- Base de datos: Azure Cosmos DB.
- Secretos: Azure Key Vault.
- Autenticación: correo + contraseña con JWT.
- Correos: `EmailService` con proveedores mock y SMTP.
- Frontend producción: Azure Static Web Apps.
- Backend producción: Azure Function App.
- Despliegue backend recomendado: ZIP completo con `dist` + `node_modules`.

## 3. Recursos de producción actuales

- Suscripción Azure: `edbbf624-b155-4c51-ac57-d02424a7234d`.
- Resource Group: `rg-erp-update-scheduler-prod`.
- Function App: `erpupdsch4645-api`.
- API base: `https://erpupdsch4645-api.azurewebsites.net/api`.
- Static Web App: `https://agreeable-wave-07469d50f.7.azurestaticapps.net`.
- Cosmos account: `erpupdsch4645-cosmos`.
- Cosmos database: `erp-update-scheduler`.
- Key Vault: `erpupdsch4645-kv`.
- Región principal: `eastus2`.
- Repo GitHub: `jcpv9824/update_reminder`.
- Branch activa local: `main`.

No documentar contraseñas reales, app passwords, JWT secrets, cadenas de conexión completas ni nombres sensibles de secretos.

## 4. Roles y permisos

Roles funcionales:

- `admin`: Administrador. Acceso completo.
- `client_manager`: Administrador de clientes. Gestiona clientes, dominios, bases, licencias y programaciones según reglas actuales.
- `domain_updater`: Actualizador de dominios. Atiende tareas de dominio.
- `database_updater`: Actualizador de bases de datos. Atiende tareas de base.
- `viewer`: Visualizador. Solo consulta; no debe cambiar estados ni revelar secretos.

Licenciamiento en menú solo debe verse para `admin` y `client_manager`. Updaters no deben ver ese módulo.

## 5. Módulos funcionales

- Tablero.
- Tareas.
- Clientes.
- Dominios.
- Bases de datos.
- Licenciamiento.
- Programaciones especiales.
- Alertas y correos.
- Auditoría.
- Usuarios y roles.
- Reportes por correo.

Los maestros usan paginación de 10 registros por página por defecto, búsqueda donde aplica, y filtros que reinician a página 1.

## 6. Tareas

La página **Tareas** es una vista operativa. Texto esperado:

```text
Vista operativa: vencidas abiertas, hoy, próximas 4 días y completadas recientes.
```

Reglas de agrupación:

- **Vencidas**: `scheduledDate < hoy` y estado no cerrado. Nunca desaparecen por antigüedad si siguen pendientes, en progreso, bloqueadas o fallidas.
- **Hoy**: `scheduledDate = hoy` y estado no cerrado.
- **Próximas**: `scheduledDate > hoy` y `scheduledDate <= hoy + 4 días` y estado no cerrado.
- **Completadas**: `status = completed` y `completedAt` o `scheduledDate` dentro de los últimos 4 días.

Estados esperados:

- `pending`: pendiente.
- `in_progress`: en progreso, existe internamente pero no se expone acción principal “Iniciar”.
- `completed`: completada.
- `failed`: fallida, si aplica.
- `blocked`: bloqueada.
- `cancelled`: cancelada.
- `reopened`: reabierta, si aparece por compatibilidad.

Acciones por estado:

- Pendiente: Completar, Bloquear.
- En progreso: Completar, Bloquear.
- Bloqueada: Completar y Resolver bloqueo. No Reabrir. No Iniciar.
- Completada: Reabrir. No Completar. No Bloquear. No Iniciar.
- Visualizador: solo ver detalle.

Bloqueadas:

- Pueden completarse con modal “Completar tarea bloqueada”.
- Pueden resolverse a Pendiente, En progreso o Completada con modal “Resolver bloqueo”.
- Comentarios de cierre/resolución son opcionales.
- No deben reabrirse como si fueran completadas.

Completadas:

- Pueden reabrirse con modal “Reabrir tarea completada”.
- `completed -> pending`.
- Motivo de reapertura opcional.
- Debe auditarse como `task_reopened`.

No usar `alert`, `confirm` ni `prompt` del navegador para flujos de negocio.

## 7. Programaciones especiales

Modos vigentes:

1. Selección manual.
2. Por licenciamiento.

El modo **“Todos los clientes activos” está cancelado** y no debe implementarse por ahora.

Selección manual:

- Constructor jerárquico por cliente → dominio → base.
- Permite incluir todos los dominios activos de un cliente.
- Permite incluir todas las bases activas de un dominio.
- Permite seleccionar múltiples dominios/bases mediante paneles con checkboxes.

Por licenciamiento:

- Selecciona una o varias licencias activas.
- Resuelve clientes activos con esas licencias.
- Aplica coincidencia `any` o `all`.
- Filtra por ambiente: Todos, Producción, Pruebas, Demo u otros ambientes existentes.
- Objetivo: dominios y bases, solo dominios o solo bases.
- Solo activos por defecto.
- El preview muestra conteos y árbol de clientes/dominios/bases.
- Al guardar, se guarda el criterio (`licensingScope`), no solo un snapshot.
- La generación futura re-resuelve el criterio para incluir clientes nuevos que compren la licencia.
- Después del preview se pueden marcar excepciones manuales por dominio o por base.
- Excluir un dominio evita solo la tarea del dominio; no excluye automáticamente sus bases.
- Excluir una base evita solo la tarea de esa base; no excluye el dominio.
- Las excepciones se guardan como IDs en `licensingScope.excludedDomainIds` y `licensingScope.excludedDatabaseIds`.
- Si cambian licencias, coincidencia, ambiente u objetivo después del preview, el preview queda desactualizado y debe repetirse antes de guardar.
- Al reprevisualizar se conservan excepciones válidas y se descartan las que ya no pertenecen al alcance.

Frecuencias especiales:

- La frecuencia **Única** (`frequencyType = "once"`) es la opción por defecto para nuevas programaciones especiales.
- Para **Única** se usa `startDate` como **Fecha de actualización**.
- La UI oculta campos recurrentes cuando la frecuencia es única.
- El checkbox debe llamarse **Programación activa**.
- Después de generar tareas para una programación única, backend la marca inactiva y registra `completedReason = "one_time_schedule_executed"`.
- Un refresco posterior no debe volver a generar tareas de esa programación única.

Recordatorios en programaciones especiales:

- Por defecto usan la configuración global de **Alertas y correos → Recordatorios a actualizadores**.
- Si `reminders` queda `undefined` en la programación, el backend usa los valores globales.
- La UI muestra los valores globales como lectura: días previos, hora y zona horaria.
- Si el usuario desmarca **Usar configuración global de recordatorios**, se guarda un override en `schedule.reminders`.
- El override usa `reminderDaysBefore` capturado como texto separado por coma (`2,1,0`, `1,0`, etc.) y `reminderTime` en formato `HH:mm`.
- `0` significa el mismo día de la actualización.

Deduplicación obligatoria:

- Máximo una tarea por `entityType + entityId + scheduledDate`.
- Aplica a frecuencia normal, programación manual, programación por licenciamiento y diferentes horas del mismo día.
- Si el modelo `sources` existe, agregar fuentes al registro existente en lugar de crear duplicados.

## 8. Licenciamiento

Decisión de producto actual:

- El modelo principal es licenciamiento por cliente completo.
- En **Licenciamiento** se administran módulos: Mobile App, WMS, AI, Extract, etc.
- En **Clientes** se asignan las licencias compradas por cada cliente.
- Dominios y bases heredan conceptualmente la licencia del cliente.
- Asignaciones avanzadas por dominio/base existen o pueden existir en backend, pero están ocultas/reservadas para fase futura.

Página `/licenciamiento`:

- Visible para `admin` y `client_manager`.
- Solo muestra maestro de módulos por defecto.
- La pestaña “Asignaciones” debe estar oculta salvo feature flag futuro.
- Campos: Nombre, Código, Descripción, Estado.
- `Nombre` es obligatorio.
- `Código` es opcional; si se deja vacío, backend lo autogenera desde el nombre.
- El código autogenerado debe evitar duplicados con sufijos.
- No permitir código duplicado manual.
- La eliminación de módulo debe fallar con mensaje claro si tiene dependencias/asignaciones activas.

El reporte maestro incluye licencias por cliente:

```text
Licencias / módulos:
- Mobile App
- WMS
```

Si no hay:

```text
Licencias / módulos:
- Sin licencias registradas
```

## 9. Clientes

Clientes permiten:

- Crear, editar, activar/desactivar y eliminar en cascada con confirmación.
- Capturar un **ID del cliente** de negocio en `externalId`. Es opcional por ahora, pero si se captura debe ser único entre clientes no eliminados.
- Asignar licencias al cliente mediante checkboxes y buscador.
- Ver chips/lista de “Licencias seleccionadas”.
- Ver dominios y bases asociadas.
- Agregar dominio desde la fila del cliente.

Reglas de licencias en cliente:

- Guardar `licenseModuleIds`.
- Deduplicar IDs.
- Rechazar IDs inexistentes.
- Las licencias inactivas no aparecen para nuevas selecciones.
- Si un cliente no tiene licencias, mostrar “Sin licencias seleccionadas” o “Sin licencias registradas”, según contexto.

El modal “Ver dominios y bases” muestra:

- Licencias del cliente.
- Dominios agrupados.
- Bases por dominio.
- Acciones rápidas: editar dominio, agregar base, editar base, respetando permisos.

## 10. Dominios

Dominios permiten:

- Crear/editar dominio.
- Validar que la URL inicie con `https://`.
- Ver dominio para publicar.
- Agregar base de datos desde la fila.
- Ver bases asociadas.
- Filtrar por programación recurrente.
- Ver columnas Recurrente y Próxima actualización.

Reglas de frecuencia:

- Nuevo dominio inicia con “Activar frecuencia automática para este dominio” desactivado.
- Si se activa, se crea o actualiza una programación `domain_default`.
- Al editar un dominio con frecuencia activa, el checkbox debe aparecer marcado.
- Al desmarcar y guardar, frontend debe enviar `disableAutomaticFrequency: true` y `frequency: null`.
- Backend debe desactivar realmente schedules activos `domain_default` del dominio.
- Después de desactivar: Recurrente = No, Próxima actualización = `-`, no se generan nuevas tareas por esa frecuencia.
- No se elimina el dominio, no se eliminan bases, no se borra historial.

El modal “Bases asociadas al dominio” muestra:

- Dominio, cliente, ambiente.
- Empresa, base, ambiente, estado.
- Servidor y puerto, usuario y contraseña oculta.
- Copiar servidor y puerto.
- Copiar base.
- Copiar usuario.
- Copiar contraseña solo mediante acción explícita y con permisos.
- Editar base.

No revelar contraseñas en listados generales ni logs.

## 11. Bases de datos

Bases de datos permiten:

- Crear/editar base asociada a cliente y dominio.
- Capturar cadena de conexión.
- Guardar contraseña en Key Vault.
- Mostrar acceso mediante “Ver acceso”.
- Copiar partes individuales del acceso.
- Copiar contraseña solo con acción explícita y permiso.

Reglas:

- La tabla no debe mostrar columnas “Servidor” ni “Versión” como columnas principales.
- Sí deben seguir disponibles en acceso, detalle de tarea y correos de error.
- No permitir dos bases con la misma cadena de conexión normalizada.
- No exponer contraseña automáticamente.
- Auditar acceso a secretos cuando exista el patrón.

## 12. Alertas y correos

La página debe mantenerse clara mediante accordions/secciones:

- Estado del correo.
- Configuración básica.
- Configuración SMTP avanzada.
- Recordatorios a actualizadores.
- Alertas de tareas vencidas.
- Alertas de tareas bloqueadas / errores de actualización.
- Recordatorios administrativos.
- Reporte maestro.
- Correo de prueba.

SMTP:

- Configuración avanzada colapsada por defecto.
- Botón “Usar configuración recomendada de P&A”.
- No mostrar contraseña SMTP desde API.
- Contraseña SMTP se guarda en Key Vault.
- No guardar contraseña SMTP en Cosmos.

Recordatorios a actualizadores:

- Configuración global por defecto.
- Dominios/programaciones pueden usar global u override.
- Días previos, hora y zona horaria.

Alertas vencidas:

- Configuración global.
- Destinatarios por roles y correos manuales separados por punto y coma.
- Deduplicar correos.
- Frecuencia diaria o semanal.
- Evitar duplicados por periodo.

Alertas bloqueadas/errores:

- Enviar inmediatamente al bloquear como comportamiento natural.
- Configurar destinatarios por roles y correos manuales.
- Recordatorios si el bloqueo sigue sin resolverse, por días después del bloqueo.
- No duplicar recordatorios.
- No enviar si la tarea ya fue resuelta.

Recordatorios administrativos:

- Guardar última versión mensual de SAG Web.
- Crear documento “¿Qué hay de nuevo en SAG Web?”.
- Reglas: primer día, último día, último día hábil, día fijo 1-28.
- Regla por defecto: último día hábil del mes.
- Si el mes termina sábado o domingo, enviar viernes anterior y lunes siguiente.
- El lunes siguiente conserva el periodo del mes anterior.
- Idempotencia por `type + period + sendDate`.

Reporte maestro:

- Asunto esperado: “Reporte maestro ERP — clientes, dominios y empresas”.
- Solo clientes/dominios/bases/licencias activos.
- Incluye ambiente en dominios y bases.
- Incluye licencias por cliente.
- No incluye contraseñas, usuarios SQL, servidores/IP/puertos, connection strings, Key Vault secret names, tokens ni password hashes.

## 13. Validaciones importantes

Backend debe ser la fuente principal de validación:

- `externalId` de cliente es opcional, pero único si existe.
- No duplicar cliente por nombre normalizado.
- No duplicar dominio por URL normalizada.
- No duplicar base por cadena de conexión normalizada.
- En edición, no bloquear el mismo registro.
- Aplicar trim a nombres, notas, dominios, dominio para publicar, cadenas de conexión, empresas, bases, usuarios, emails, SMTP, licencias y textos de programaciones.
- Dominios deben iniciar con `https://`.
- Ambientes permitidos: `production` (Producción), `test` (Pruebas) y `demo` (Demo). No usar `staging`, `development` ni otros ambientes nuevos.
- Emails deben tener formato válido.
- Listas de emails separadas por punto y coma:
  - Separar por `;`.
  - Trim por email.
  - Ignorar vacíos por `;` final.
  - Reportar el correo inválido en español.

Ejemplo de error:

```text
El correo 'correo-mal' no tiene un formato válido.
```

## 14. Cosmos containers

Contenedores esperados por el código:

- `users`
- `clients`
- `domains`
- `databases`
- `updateSchedules`
- `updateTasks`
- `licenseModules`
- `licenseAssignments` (oculto/no usado por UI normal en la fase actual)
- `auditLogs`
- `appSettings`
- `emailNotifications`

Particiones clave importantes conocidas:

- `licenseModules`: `/id`.
- `licenseAssignments`: `/clientId`.
- `updateTasks`: suele operar por `taskBucket`.
- `clients`, `domains`, `databases` usan patrones existentes por cliente/id; revisar código antes de migrar.

## 15. Deployment

Backend ZIP completo:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"

npm install
npm run build

Remove-Item .\api-deploy-full.zip -ErrorAction SilentlyContinue

tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules

az account set --subscription edbbf624-b155-4c51-ac57-d02424a7234d

az functionapp deployment source config-zip `
  --resource-group rg-erp-update-scheduler-prod `
  --name erpupdsch4645-api `
  --src api-deploy-full.zip

az functionapp restart `
  --name erpupdsch4645-api `
  --resource-group rg-erp-update-scheduler-prod

az functionapp function list `
  --name erpupdsch4645-api `
  --resource-group rg-erp-update-scheduler-prod `
  --output table
```

Frontend:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\frontend"

"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.production -Encoding utf8

npm install
npm run build

cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"

git status
git add .
git commit -m "Correcciones operativas tareas dominios handoff"
git push
```

Azure Static Web Apps despliega por GitHub Actions. Verificar en:

```text
https://github.com/jcpv9824/update_reminder/actions
```

## 16. Troubleshooting

- **Error 405 en login**: revisar que el frontend apunte a `VITE_API_BASE_URL` correcto y que el backend tenga rutas `/api/auth/login` disponibles.
- **Azure CLI en suscripción incorrecta**: ejecutar `az account set --subscription edbbf624-b155-4c51-ac57-d02424a7234d`.
- **Funciones no aparecen en Azure**: desplegar ZIP completo con `dist` y `node_modules`, luego reiniciar Function App.
- **Cosmos container missing**: revisar contenedores listados en este handoff y scripts de aprovisionamiento.
- **CORS/login falla**: revisar configuración de Function App, Static Web App y API base en `.env.production`.
- **Static Web App cache**: usar Ctrl+F5 o probar ventana privada; confirmar GitHub Actions exitoso.
- **Rutas SPA dan 404 al refrescar**: conservar `frontend/public/staticwebapp.config.json` con `navigationFallback`.
- **Errores backend**: ver logs de Function App y Application Insights si está configurado.
- **Tareas vencidas antiguas desaparecen**: revisar que el refresh no cancele tareas abiertas anteriores a hoy.
- **Frecuencia de dominio no se desactiva**: verificar que el frontend envíe `disableAutomaticFrequency: true` y `frequency: null`, y que backend desactive `domain_default`.

## 17. Testing

Backend:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"
npm test
npm run build
```

Frontend:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\frontend"
npm test
npm run build
```

Búsqueda obligatoria de prompts nativos:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"
Select-String -Path "frontend/src/**/*.*" -Pattern "window.alert|window.confirm|window.prompt|alert\(|confirm\(|prompt\("
```

Tests críticos actuales cubren:

- Vista operativa de tareas.
- Vencidas antiguas abiertas.
- Acciones por estado de tarea.
- Reabrir completadas.
- Resolver/completar bloqueadas.
- Programaciones por licenciamiento y dedupe.
- Reporte maestro con licencias y sin secretos.
- Licenciamiento.
- Clientes con licencias.
- Dominios con frecuencia recurrente y desactivación.
- Semicolon emails.
- Alertas y recordatorios.

Regla para futuros cambios: toda lógica de negocio nueva debe tener prueba automatizada o una justificación explícita de por qué no aplica.

## 18. Pendientes y riesgos

- Migración futura a base relacional: el modelo de licencias por cliente migra limpiamente a tablas `clients`, `license_modules`, `client_license_modules`.
- Asignaciones avanzadas de licencias por dominio/base están ocultas; no usarlas sin nueva decisión de producto.
- Endurecer aún más auditoría de lectura/copia de contraseñas.
- Revisar permisos granulares de secretos por rol si el negocio lo exige.
- Mejorar observabilidad de timers y correos en producción.
- Mantener cuidado con Cosmos y particiones si se cambian contenedores o queries.
- No crear un modo de programación “Todos los clientes activos” salvo nueva instrucción explícita.

## 19. Reglas para el siguiente agente

- No reconstruir la app.
- No cambiar arquitectura general sin aprobación.
- No romper login correo/contraseña ni JWT.
- No romper Cosmos DB ni Key Vault.
- No romper auditoría.
- No romper tareas unificadas.
- No romper Alertas y correos.
- No exponer secretos.
- No usar `alert`, `confirm` ni `prompt` del navegador.
- Trabajar incrementalmente.
- Ejecutar pruebas y builds.
- Responder en español para documentación y funcionalidades de producto.
