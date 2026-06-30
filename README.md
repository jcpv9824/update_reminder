# Programador de Actualizaciones del ERP

Aplicación web para gestionar las actualizaciones programadas de los clientes del ERP, sus dominios y bases de datos. Construida sobre Microsoft Azure (Static Web Apps, Azure Functions, Cosmos DB y Key Vault). Toda la interfaz está en español.

## Características

- **Login con correo y contraseña** (JWT). Los roles se administran únicamente desde la página *Usuarios y roles*.
- **Alertas y correos** en secciones simples: estado, configuración básica, recordatorios, alertas por tipo, reporte, SMTP avanzado, recordatorios administrativos y correo de prueba.
- **Recordatorios por correo** a los actualizadores (días previos, hora y zona horaria configurables).
- **Alertas globales de vencidos** con frecuencia diaria o semanal, destinatarios por roles y correos adicionales con deduplicación.
- **Alertas de tareas bloqueadas / errores de actualización** con destinatarios propios. Los correos de error de bases incluyen servidor y puerto, base de datos y usuario, nunca contraseña.
- **Recordatorios de bloqueos no resueltos** configurables por días después del bloqueo, hora y zona horaria.
- **Reporte manual por correo** de clientes, licencias/módulos, dominios y empresas/bases de datos activos, con ambiente, sin contraseñas ni datos sensibles.
- **Diseño con colores corporativos**: `#1C3664`, `#7E99B2`, `#D1D3D2`, `#D3C193`.
- Página principal **Tareas** con dos columnas (dominios y bases de datos) divididas en *Vencidas / Hoy / Próximas / Completadas*.
- Gestión de **clientes**, **dominios** y **bases de datos** con eliminación en cascada confirmada y soft-delete de maestros. Las actualizaciones de dominios y bases se configuran desde **Actualizaciones programadas** con alcance explícito.
- **Licenciamiento** visible para administradores y administradores de clientes, como maestro de módulos que luego se asignan al cliente completo desde **Clientes**.
- **Actualizaciones programadas** con frecuencia **Única** por defecto, además de semanal, intervalo, mensual o manual. El alcance puede ser jerárquico manual o por licenciamiento, con responsables por rol o usuarios específicos.
- **Maestros paginados y buscables**. Clientes, dominios, bases de datos, licenciamiento, actualizaciones programadas, auditoría y usuarios muestran 10 registros por página por defecto. Las búsquedas y filtros vuelven a página 1.
- **Validaciones de calidad de datos**: trim en campos de texto, dominios con `https://`, listas de correos separadas por punto y coma, y bloqueo de duplicados de clientes, dominios, bases y módulos de licencia.
- **Ambientes cerrados** a Producción (`production`), Pruebas (`test`) y Demo (`demo`).
- **Generación automática de tareas** al crear/editar/reactivar actualizaciones programadas, además del Azure Functions Timer Trigger diario. La vista **Tareas** ya no usa el botón **Refrescar** como flujo operativo.
- Panel del actualizador con las cuatro partes del acceso (servidor, Initial Catalog, usuario y contraseña) y botones independientes para copiar; cada acción se audita.
- Desde **Dominios** se puede abrir **Ver bases asociadas**; desde **Clientes**, **Ver dominios y bases**.
- **Recordatorios administrativos mensuales** para guardar la versión mensual de SAG Web y crear el documento “¿Qué hay de nuevo en SAG Web?”.
- Los recordatorios administrativos soportan reglas de envío: primer día, último día, último día hábil y día fijo. Si el mes termina en fin de semana, la regla de último día hábil envía viernes y lunes manteniendo el periodo del mes anterior.
- **Roles**: administrador, administrador de clientes, actualizador de bases de datos, actualizador de dominios, visualizador.
- **Auditoría completa** de todas las acciones (incluyendo revelar/copiar contraseñas).
- **Contraseñas en Azure Key Vault**, nombres de secreto sanitizados automáticamente (sin guiones bajos ni caracteres inválidos).
- **Parser** de cadenas `servidor; Initial Catalog = X; User ID = Y; Password = Z;`.

## Requisitos

- Node.js 20 LTS
- PowerShell 7+
- Azure CLI
- Azure Functions Core Tools v4
- Una suscripción de Azure activa

## Estructura del proyecto

```
erp-update-scheduler/
├── README.md
├── DESPLIEGUE.md           Guía paso a paso para desplegar en Azure (PowerShell).
├── api/                    Backend en Azure Functions (Node.js + TypeScript).
│   ├── src/lib/            Utilidades (parser, scheduleEngine, permisos, auditoría, etc.)
│   ├── src/functions/      Endpoints HTTP y Timer Trigger.
│   └── src/tests/          Pruebas con vitest.
├── frontend/               Aplicación React + Vite + TypeScript.
└── scripts/
    └── desplegar-azure.ps1 Script de aprovisionamiento en Azure.
```

## Ejecutar localmente

### 1. Instalar dependencias

```powershell
cd api
npm install

cd ..\frontend
npm install
```

### 2. Configurar variables del API

Copie `api/local.settings.json.example` a `api/local.settings.json` y rellene los valores. En modo desarrollo puede dejar `DEV_AUTH_ENABLED=true` para autenticarse con encabezados.

### 3. Ejecutar el backend

```powershell
cd api
npm run build
func start
```

El API queda disponible en `http://localhost:7071/api`.

### 4. Ejecutar el frontend

En otra ventana de PowerShell:

```powershell
cd frontend
"VITE_API_BASE_URL=http://localhost:7071/api" | Out-File -FilePath .env.local -Encoding utf8
npm run dev
```

El frontend queda disponible en `http://localhost:5173`.

## Ejecutar pruebas

### Backend

```powershell
cd api
npm test
```

Cubre el parser de conexión, el motor de frecuencias, la generación idempotente de tareas, reportes sin secretos, recordatorios, reglas de permisos por rol, creación de bases de datos sin guardar contraseña en texto plano, y sanitización de auditoría.

### Frontend

```powershell
cd frontend
npm test
```

Cubre vistas principales, selectores buscables, tareas, alertas y correos, actualizaciones programadas, login y parser visual.

## Roles y permisos

| Rol | Puede hacer |
|---|---|
| Administrador | Todo: usuarios, roles, clientes, dominios, bases, licenciamiento, frecuencias, tareas, auditoría. |
| Administrador de clientes | CRUD de clientes, dominios, bases y frecuencias; asignar licencias compradas a clientes; ver módulos de licencias y auditoría. |
| Actualizador de bases de datos | Ver y completar tareas de bases de datos asignadas; revelar/copiar contraseñas autorizadas. |
| Actualizador de dominios | Ver y completar tareas de dominios asignadas. |
| Visualizador | Solo lectura. |

## Clientes

El campo **ID del cliente** (`externalId`) es opcional por ahora. Si se captura, debe ser único entre clientes no eliminados. El `id` técnico interno (`client_*`) sigue siendo generado por la aplicación y no debe editarse manualmente.

## Seguridad

### Protección contra abuso

- Los endpoints sensibles usan rate limiting distribuido en Cosmos por IP e identidad.
- Login aplica lockout temporal tras cinco fallos en 15 minutos; las respuestas limitadas usan HTTP `429` y `Retry-After`.
- Recuperación/restablecimiento, setup y envíos manuales de correo tienen límites independientes según su costo.
- Los identificadores se guardan como HMAC; nunca se persisten IP, correo, token ni secreto en claro en `securityRateLimits`.
- Los eventos bloqueados quedan en logs estructurados y auditoría. Consulte `SECURITY_RATE_LIMITING.md` para límites y operación.

- La contraseña SMTP se guarda en **Azure Key Vault**. El frontend nunca la recibe ni la muestra; Cosmos DB solo guarda el nombre del secreto y el indicador de configuración.
- La contraseña de cada base de datos se guarda en **Azure Key Vault** con el nombre `db-{databaseId}-password`.
- En Cosmos DB solo se guarda la **referencia** al secreto, nunca la contraseña.
- Los registros de auditoría **eliminan automáticamente** cualquier campo cuyo nombre incluya `password`, `secret`, `rawDbAccess`.
- Cada acción de **revelar** o **copiar** la contraseña genera una entrada de auditoría con el usuario, la fecha y la base de datos asociada.
- Los listados y detalles generales de bases usan DTOs sanitizados: nunca incluyen servidor, usuario SQL ni `passwordSecretName`. La conexión se consulta exclusivamente mediante **Ver acceso** y autorización backend.
- Admin, administrador de clientes y visualizador conservan lectura global sanitizada. Los actualizadores solo reciben clientes, dominios, bases y tareas relacionados con asignaciones propias; ningún query param puede ampliar ese alcance.
- Las tareas se filtran obligatoriamente por asignación en la API. Si existen usuarios específicos, el rol por sí solo no permite leer la tarea.
- Antes de desplegar, CI ejecuta auditoría npm de producción y total con umbral `moderate`, además de todas las pruebas y builds. Dependabot revisa backend, frontend y GitHub Actions semanalmente.
- La política y SLA de actualización de dependencias están en `SECURITY_DEPENDENCY_POLICY.md`.
- El reporte de clientes/licencias/dominios/empresas no incluye usuarios SQL, servidores, puertos, contraseñas, cadenas de conexión completas, secretos ni tokens.
- Las eliminaciones en cascada no eliminan auditoría y no borran secretos de Key Vault cuando el maestro queda en soft-delete.

## Alertas y correos

La vista **Alertas y correos** está organizada en acordeones. La sección **Configuración avanzada SMTP** queda cerrada por defecto para mantener la pantalla inicial simple.

Use **Usar configuración recomendada de P&A** para llenar:

- Proveedor SMTP.
- Remitente `info@pya.com.co`.
- Servidor `smtp.office365.com`.
- Puerto `587`.
- SSL/TLS desactivado para STARTTLS.
- URL pública de la aplicación.

La contraseña SMTP no se llena automáticamente. Para configurarla, abra **Configuración avanzada SMTP**, use **Configurar/Cambiar contraseña SMTP** y escriba la contraseña de aplicación. La contraseña actual nunca se muestra.

Para probar el envío, escriba un destinatario en **Correo de prueba** y pulse **Enviar correo de prueba**.

En **Alertas de tareas vencidas** configure roles destinatarios, correos adicionales, frecuencia diaria/semanal, hora y zona horaria. En **Alertas de tareas bloqueadas / errores de actualización** configure destinatarios independientes. Cuando una tarea se bloquea, la alerta inmediata se envía por defecto si las alertas de bloqueos están activas. También puede activar recordatorios de bloqueos no resueltos.

En **Recordatorios administrativos** configure los dos recordatorios mensuales: guardar la última versión mensual de SAG Web y crear el documento “¿Qué hay de nuevo en SAG Web?”. La regla por defecto es **Último día hábil del mes**. Si el último día del mes cae sábado o domingo, se envían dos recordatorios: viernes anterior y lunes siguiente, ambos asociados al periodo del mes que terminó.

Para enviar el reporte maestro, abra **Reporte de clientes/dominios/empresas**, escriba destinatarios separados por punto y coma, por ejemplo `correo1@empresa.com; correo2@empresa.com`, y pulse **Enviar reporte**. El reporte incluye solo clientes, licencias/módulos, dominios y bases activos, con ambiente. Las licencias se muestran debajo de cada cliente, se deduplican por módulo y si no hay licencias activas aparece **Sin licencias registradas**.

## Licenciamiento

La vista **Licenciamiento** está disponible en `/licenciamiento` para administradores y administradores de clientes, entre **Bases de datos** y **Actualizaciones programadas** en el menú lateral.

La vista queda como maestro de módulos. Permite crear, editar, activar/desactivar y eliminar módulos. El campo **Código** es opcional; si se deja vacío, el backend genera un código a partir del nombre, sin tildes, en mayúsculas y con sufijo si ya existe.

Las licencias compradas se asignan desde **Clientes**, en la sección **Licencias del cliente** del modal de creación o edición. La fuente principal del modelo es:

```json
{
  "licenseModuleIds": ["module_mobile", "module_wms"]
}
```

Las asignaciones avanzadas por dominio/base (`licenseAssignments`) quedan ocultas y reservadas para una fase futura. No son usadas por el frontend normal ni por el reporte maestro actual salvo que se active explícitamente `ENABLE_ADVANCED_LICENSE_ASSIGNMENTS=true` en backend y `VITE_ENABLE_ADVANCED_LICENSE_ASSIGNMENTS=true` en frontend.

El endpoint `POST /api/reports/masters/send-email` carga módulos activos desde `licenseModules` y usa `licenseModuleIds` de cada cliente activo para mostrar sus licencias.

Reglas del reporte:

- Solo se muestran módulos activos.
- Se excluyen módulos inactivos, eliminados o con `deletedAt`.
- Los módulos se deduplican por `moduleId` y se ordenan alfabéticamente.
- Los nombres y códigos de módulos son permitidos; datos técnicos y secretos siguen excluidos.

Si se intenta eliminar un módulo con asignaciones avanzadas activas, `DELETE /api/license-modules/{id}` responde `409 Conflict`. En la versión actual las licencias de cliente se guardan en `clients.licenseModuleIds`.

Endpoints disponibles:

- `GET /api/license-modules`
- `POST /api/license-modules`
- `PUT /api/license-modules/{id}`
- `DELETE /api/license-modules/{id}`
- `GET/POST/PUT/DELETE /api/license-assignments` existe como soporte avanzado oculto para fase futura.

## Actualizaciones programadas

El flujo principal es:

1. Crear cliente.
2. Crear dominio.
3. Crear base de datos seleccionando el dominio.
4. Crear una **Actualización programada** para dominios, bases o ambos.

La frecuencia embebida en el dominio/base fue retirada de la UI. Para programar las bases de un dominio se usa el alcance de **Actualizaciones programadas**:

- Agregue el cliente.
- Agregue el dominio o marque todos los dominios activos del cliente.
- Para bases, marque **Incluir todas las bases activas de este dominio** o seleccione bases puntuales.
- Si solo necesita bases, use **Objetivo de la actualización → Solo bases de datos**.

Cada tarea guarda `rootScheduleId` para enlazarse a la actualización programada original. En recurrentes, la actualización mantiene su vida (`active/inactive/cancelled`) y la salud operativa se ve en los resúmenes de tareas por fecha, no en un único estado engañoso.

## Tareas

La vista usa una **ventana operativa**: vencidas abiertas sin límite hacia atrás, tareas de hoy, próximas 4 días y completadas recientes (completadas hoy o dentro de los últimos 4 días por `completedAt` o fecha programada). No muestra completadas antiguas ni próximas más allá de 4 días.

El tablero principal no lista todos los dominios o bases individualmente. Muestra grupos resumidos como **Dominios por actualizar** o **Bases de datos por actualizar**, con total, completadas, pendientes, con problemas, estado general y nombre de la actualización programada cuando está disponible. El botón **Ver detalle** abre las tareas individuales, permite copiar dominios o nombres de bases y guarda inmediatamente cada cambio de estado.

El detalle de tareas usa un modal amplio. Para dominios muestra acciones según estado: pendientes pueden completarse/bloquearse; bloqueadas muestran **Completar** y **Resolver bloqueo**, pero no **Reabrir**; completadas muestran **Reabrir**, pero no **Completar**. Para bases de datos muestra la conexión en campos apilados: servidor, base, usuario y contraseña. La contraseña no se precarga; se revela o copia bajo demanda con el endpoint seguro y auditoría sin incluir el valor.

Las tareas bloqueadas se resuelven con modal propio hacia pendiente, en progreso o completada. El comentario de resolución es opcional. Una bloqueada también puede marcarse como completada con un modal de cierre. Las completadas se pueden reabrir a pendiente con modal propio y motivo opcional. No se usan `alert`, `confirm` ni `prompt` del navegador en estos flujos.

## Flujo rápido de creación

El flujo principal ahora es **Cliente → Dominio → Base de datos → Actualización programada → Tareas**:

- **Clientes**: `Guardar`, `Guardar y agregar dominio`, `Guardar y crear nuevo cliente`.
- **Dominios**: `Guardar`, `Guardar y agregar base de datos`, `Guardar y crear nuevo dominio`.
- **Bases de datos**: `Guardar`, `Guardar y crear nueva base de datos`.

Los formularios normales ya no capturan frecuencia. Los responsables se definen desde **Actualizaciones programadas**: por rol predeterminado (**Actualizador de dominios** o **Actualizador de bases de datos**) o por usuarios específicos.

La vista **Actualizaciones programadas** define las actualizaciones operativas recurrentes o únicas. El alcance se construye por grupos: agregar cliente, incluir todos los dominios o agregar dominios específicos, e incluir todas las bases o bases puntuales. En **Selección manual** se puede elegir el **Objetivo de la actualización**: dominios y bases, solo dominios o solo bases. Si se elige **Solo bases de datos**, la UI permite seleccionar bases directamente desde el cliente y el generador no crea tareas de dominio. Para seleccionar varios dominios o bases se usan modales con búsqueda y checkboxes. Las actualizaciones se guardan con `origin = "special"`.

También puede crear actualizaciones **Por licenciamiento**. En ese modo se seleccionan una o varias licencias, coincidencia `cualquiera/todas`, ambiente, y objetivo `dominios`, `bases` o ambos. La app previsualiza clientes, dominios y bases activos afectados, y al generar tareas re-resuelve el criterio para incluir clientes que compren esa licencia en el futuro.

Después del preview por licenciamiento se pueden marcar excepciones de esta actualización:

- **Excluir dominio** evita crear la tarea del dominio, pero no excluye automáticamente sus bases.
- **Excluir base** evita crear la tarea de esa base, pero no excluye el dominio.
- Si cambian licencias, ambiente, coincidencia u objetivo después del preview, el alcance queda desactualizado y debe previsualizarse de nuevo antes de guardar.
- Las excepciones se guardan por ID (`excludedDomainIds`, `excludedDatabaseIds`) dentro de `licensingScope`.

La deduplicación de tareas por entidad/día se mantiene aunque coincidan actualizaciones manuales o por licenciamiento. Para nuevas actualizaciones programadas, **Única** es la frecuencia por defecto: solo pide **Fecha de actualización** y genera tareas para esa fecha sin duplicarlas. Generar tareas no cierra la actualización por sí solo; una actualización única queda inactiva/completada solo cuando sus tareas asociadas ya están cerradas (`completed` o `cancelled`). Si se reprograma una única antes de cerrarla, las tareas abiertas de la fecha anterior asociadas a esa actualización se cancelan como obsoletas para que no queden vencidas artificialmente ni disparen alertas incorrectas.

Los recordatorios de actualizaciones programadas usan por defecto la configuración global de **Alertas y correos → Recordatorios a actualizadores**. Si se requiere una configuración específica, se desmarca **Usar configuración global de recordatorios** y se capturan **Días previos separados por coma** (`2,1,0`, `1,0`, etc.) y **Hora de envío**. El valor `0` significa el mismo día de la actualización.

## Cambios recientes

- [SOLICITUD_BASE_SQL_SERVER.md](SOLICITUD_BASE_SQL_SERVER.md): especificación para solicitar al proveedor la base SQL Server/Azure SQL de migración.
- [CAMBIOS_V17.md](CAMBIOS_V17.md): Actualizaciones programadas, tareas vinculadas por `rootScheduleId` y retiro de frecuencia embebida.
- [docs/RELATIONAL_MODEL_PROPOSAL.md](docs/RELATIONAL_MODEL_PROPOSAL.md): modelo relacional objetivo para migración desde Cosmos DB.
- [docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md](docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md): matriz de transformación Cosmos → SQL.
- [CAMBIOS_V14.md](CAMBIOS_V14.md): excepciones en programación por licenciamiento y frecuencia única por defecto.
- [CAMBIOS_V11.md](CAMBIOS_V11.md): licenciamiento a nivel cliente, código opcional, asignaciones avanzadas ocultas y programaciones especiales por licenciamiento.
- [CAMBIOS_V10.md](CAMBIOS_V10.md): modales de tareas, selección múltiple jerárquica, recordatorios globales/overrides, bloqueos no resueltos y reglas administrativas de último día hábil.
- [CAMBIOS_V9.md](CAMBIOS_V9.md): licencias/módulos en reporte maestro y bloqueo claro al eliminar licencias asignadas.
- [CAMBIOS_V8.md](CAMBIOS_V8.md): cascada, vistas relacionadas, programaciones por grupos, estados de tareas, alertas por tipo, Refrescar, reporte activo con ambiente y recordatorios administrativos.
- [CAMBIOS_V6.md](CAMBIOS_V6.md): Alertas y correos simplificado, reporte maestro por correo, frecuencias heredadas desde dominio y generación manual de tareas.
- [CAMBIOS_V5.md](CAMBIOS_V5.md): fix del 404 al refrescar, listas sin eliminados, eliminación física con integridad y selectores buscables.
- [CAMBIOS_V4.md](CAMBIOS_V4.md): vista administrativa **Alertas y correos** (SMTP, recordatorios, alertas, prueba). Contraseña SMTP en Key Vault.
- [CAMBIOS_V3.md](CAMBIOS_V3.md): login email/password con JWT, recordatorios y alertas por correo, colores corporativos.
- [CAMBIOS.md](CAMBIOS.md): vista unificada de tareas, frecuencia integrada en formularios, sanitización Key Vault.

## Cómo iniciar sesión

1. La pantalla de login pide únicamente correo y contraseña.
2. El backend devuelve un JWT (`Authorization: Bearer …`).
   En producción este JWT es el único mecanismo aceptado: la API ignora `x-ms-client-principal` aunque sea enviado por el cliente.
3. Para crear el primer usuario, configure `SETUP_SECRET` en la Function App y llame `POST /api/setup/first-admin` con `id`, `email`, `displayName`, `password`.
4. Para asignar contraseña al admin existente (`camilo.palacio@pya.com.co`), use `POST /api/setup/set-admin-password` (ver `CAMBIOS_V3.md`).
5. Después de configurar el primer admin, vacíe `SETUP_SECRET`.

## Despliegue

Consulte [DESPLIEGUE.md](DESPLIEGUE.md) para la guía completa con PowerShell.

### Modo desarrollo

- Backend: variable `DEV_AUTH_ENABLED=true` permite autenticación con cabeceras `x-dev-user-*`.
- Frontend: variable `VITE_DEV_MODE=true` muestra un formulario oculto en la pantalla de login para entrar como usuario de prueba con roles arbitrarios.
- En producción ambas deben estar en `false`.

### Cómo crear el primer administrador

1. Configure `SETUP_SECRET` en la Function App.
2. Llame `POST /api/setup/first-admin` con `setupSecret`, `id` y `email` (use el correo que va a usar para entrar con Microsoft 365).
3. Borre `SETUP_SECRET` para deshabilitar el endpoint.

### Cómo agregar más usuarios

1. Inicie sesión como administrador.
2. Vaya a **Usuarios y roles → Nuevo usuario**.
3. Registre el correo corporativo del nuevo usuario y una contraseña temporal según el flujo disponible.
4. Asigne roles. El usuario entra con correo y contraseña; los roles siempre se recargan desde el perfil persistido.

## Documento original

El diseño funcional está basado en `azure_erp_update_app_claude_code_instructions.md` (en la carpeta padre).
