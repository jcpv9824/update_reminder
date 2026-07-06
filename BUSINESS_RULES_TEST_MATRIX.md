# Reglas de negocio y matriz de pruebas

Aplicacion: **Programador de Actualizaciones ERP**  
Ultima revision de este documento: 2026-06-30
Objetivo: documentar las reglas de negocio vigentes y relacionarlas con pruebas automatizadas existentes o esperadas.

Este archivo es una matriz viva. Cuando una regla cambie, debe actualizarse la regla, el codigo y la prueba asociada en el mismo cambio.

## Convenciones

- **ID**: identificador estable de regla.
- **Regla de negocio**: comportamiento funcional que no debe romperse.
- **Pruebas relacionadas**: archivos y casos que protegen la regla.
- **Cobertura**:
  - **Cubierta**: existe prueba automatizada directa o combinada.
  - **Cubierta por integracion UI**: la regla se valida desde pruebas de pagina/componente.
  - **Cubierta por unidad backend**: la regla se valida en funciones puras o servicios.
  - **Requiere vigilancia**: tiene cobertura parcial o depende de infraestructura externa; se indica como riesgo.

## Resumen de suites actuales

- Backend: `api/src/tests/*.test.ts`.
- Frontend: `frontend/src/tests/*.test.tsx` y `frontend/src/tests/*.test.ts`.
- Comandos obligatorios:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"
npm test
npm run build

cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\frontend"
npm test
npm run build

cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"
Select-String -Path "frontend/src/**/*.*" -Pattern "window.alert|window.confirm|window.prompt|alert\(|confirm\(|prompt\("
```

## Autenticacion, usuarios y roles

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-AUTH-01 | El login usa correo y contrasena en un solo paso; no usa MFA, autenticador, codigos de recuperacion, roles seleccionables ni login Microsoft. | `frontend/src/tests/LoginPage.test.tsx` -> "inicia con correo y contraseña y no muestra login Microsoft"; `api/src/tests/authSecurity.test.ts` -> "acepta sesión válida de administrador sin pedir un segundo factor"; `api/src/tests/authSessions.test.ts` -> "refresca una sesión de rol sensible sin pedir un segundo factor" | Cubierta por frontend y backend |
| BR-AUTH-02 | El login no permite enviar formulario vacio y muestra error en espanol. | `frontend/src/tests/LoginPage.test.tsx` -> "muestra error en español si el usuario envía vacío" | Cubierta |
| BR-AUTH-03 | Los JWT deben firmarse/verificarse con id, email y roles; tokens invalidos deben rechazarse. | `api/src/tests/jwt.test.ts` -> "firma y verifica token con id, email y roles", "verifyJwt devuelve null para token inválido" | Cubierta por unidad backend |
| BR-AUTH-04 | Las contrasenas se almacenan con hash, no en texto plano; la contrasena debe cumplir longitud minima. | `api/src/tests/password.test.ts` -> "hashPassword genera un hash que verifica con verifyPassword", "hashPassword rechaza contraseñas demasiado cortas" | Cubierta |
| BR-AUTH-05 | Los emails de usuarios se normalizan con trim y lowercase. | `api/src/tests/password.test.ts` -> "normalizeEmail trim + lowercase" | Cubierta |
| BR-AUTH-06 | Los tokens de restablecimiento no se guardan en texto plano; se guarda hash, expiracion y tokens unicos. | `api/src/tests/resetTokens.test.ts` | Cubierta |
| BR-AUTH-07 | Produccion autentica exclusivamente con JWT de la aplicacion y rechaza `x-ms-client-principal` fabricado; `x-dev-*` requiere `DEV_AUTH_ENABLED=true`. | `api/src/tests/authSecurity.test.ts` | Cubierta por unidad backend |
| BR-ROLE-01 | Roles vigentes: admin, client_manager, domain_updater, database_updater, viewer. | `api/src/tests/permissions.test.ts`, `api/src/types/models.ts` | Cubierta |
| BR-ROLE-02 | Admin puede gestionar todo. | `api/src/tests/permissions.test.ts` -> "admin puede gestionar todo" | Cubierta |
| BR-ROLE-03 | Client manager gestiona clientes y operacion relacionada, pero no usuarios. | `api/src/tests/permissions.test.ts` -> "client_manager puede gestionar clientes pero no usuarios" | Cubierta |
| BR-ROLE-04 | Viewer no puede gestionar ni mutar datos. | `api/src/tests/permissions.test.ts` -> "viewer no puede gestionar nada" | Cubierta |
| BR-ROLE-05 | Solo admin y client_manager pueden generar tareas y enviar reporte maestro. | `api/src/tests/permissions.test.ts` -> "solo admin y client_manager pueden generar tareas y enviar el reporte maestro" | Cubierta |
| BR-ROLE-06 | Actualizadores solo atienden tareas de su tipo o tareas asignadas manualmente. | `api/src/tests/permissions.test.ts` -> casos de `database_updater`, `domain_updater`, responsable manual; `frontend/src/tests/TareasPage.test.tsx` -> permisos en detalle | Cubierta |
| BR-ROLE-07 | El menu Licenciamiento solo aparece para admin y client_manager. | `frontend/src/tests/AppLayout.test.tsx` -> casos de Licenciamiento; `api/src/tests/licenseRules.test.ts` -> "oculta licenciamiento para actualizadores y visualizadores" | Cubierta |

## Navegacion y estructura UI

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-UI-01 | El menu lateral muestra "Actualizaciones programadas", no "Programaciones especiales". | `frontend/src/tests/AppLayout.test.tsx` -> "muestra Actualizaciones programadas en el menu lateral"; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-UI-02 | No se deben usar `alert`, `confirm` ni `prompt` nativos para flujos de negocio. | Busqueda obligatoria `Select-String ... "window.alert|window.confirm|window.prompt|alert\(|confirm\(|prompt\("`; `frontend/src/tests/TareasPage.test.tsx` -> "usa modal sin prompt del navegador" | Cubierta por check automatizable y UI |
| BR-UI-03 | Los maestros usan paginacion visual con rango y botones Anterior/Siguiente. | `frontend/src/tests/Paginacion.test.tsx`; pruebas de busqueda/listados en paginas | Cubierta |
| BR-UI-04 | Las acciones destructivas se mantienen al final y eliminar es rojo cuando aplica. | Pruebas de paginas cubren presencia/orden parcial; revisar visualmente en cambios de tablas | Requiere vigilancia |

## Paginacion y busqueda de maestros

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-LIST-01 | Listados paginan por defecto y `pageSize=10` limita resultados. | `api/src/tests/pagination.test.ts`; `frontend/src/tests/Paginacion.test.tsx` | Cubierta |
| BR-LIST-02 | Pagina 2 retorna datos diferentes cuando hay suficientes registros. | `api/src/tests/pagination.test.ts` | Cubierta |
| BR-LIST-03 | Filtros y busqueda se aplican antes de paginar. | `api/src/tests/pagination.test.ts` -> "mantiene filtros y búsqueda antes de paginar" | Cubierta |
| BR-LIST-04 | Auditoria usa busqueda paginada y conserva pagina 1 al buscar. | `frontend/src/tests/AuditoriaPage.test.tsx` | Cubierta por UI |
| BR-LIST-05 | Busqueda de dominios por cliente, URL, ambiente y estado. | `api/src/tests/listSearch.test.ts`; `frontend/src/tests/DominiosPage.test.tsx` -> "envía búsqueda..." | Cubierta |
| BR-LIST-06 | Busqueda de bases por dominio, empresa, base, servidor, ambiente y estado. | `api/src/tests/listSearch.test.ts`; `frontend/src/tests/BasesDeDatosPage.test.tsx` | Cubierta |
| BR-LIST-07 | Busqueda de licenciamiento por nombre, codigo, descripcion y estado. | `api/src/tests/listSearch.test.ts`; `frontend/src/tests/LicenciamientoPage.test.tsx` | Cubierta |
| BR-LIST-08 | Busqueda de actualizaciones programadas por cliente, tipo, licencia, frecuencia, responsable y estado. | `api/src/tests/listSearch.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |

## Validaciones generales

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-VAL-01 | Aplicar trim a textos de entrada. | `api/src/tests/inputValidation.test.ts` -> "aplica trim a textos" | Cubierta |
| BR-VAL-02 | Dominios deben iniciar con `https://`. | `api/src/tests/inputValidation.test.ts`; `frontend/src/tests/DominiosPage.test.tsx` -> "muestra error si el dominio no inicia con https" | Cubierta |
| BR-VAL-03 | Emails individuales deben tener formato valido. | `api/src/tests/inputValidation.test.ts` | Cubierta |
| BR-VAL-04 | Listas de emails se separan por punto y coma, se trimmean, ignoran `;` final y reportan invalidos. | `api/src/tests/inputValidation.test.ts`; `frontend/src/tests/AlertasCorreosPage.test.tsx` -> destinatarios semicolon e invalidos | Cubierta |
| BR-VAL-05 | Emails se deduplican normalizando mayusculas y espacios. | `api/src/tests/inputValidation.test.ts` | Cubierta |
| BR-VAL-06 | Ambientes permitidos: Produccion, Pruebas y Demo (`production`, `test`, `demo`). | `api/src/tests/environments.test.ts` | Cubierta |
| BR-VAL-07 | No se aceptan ambientes operativos fuera de production/test/demo. | `api/src/tests/environments.test.ts`; formularios frontend con opciones cerradas en paginas | Cubierta |
| BR-VAL-08 | Formato de dominio publicable se normaliza y entrada vacia no rompe. | `api/src/tests/domainFormat.test.ts`; `frontend/src/tests/dominio.test.ts` | Cubierta |
| BR-VAL-09 | Nombres de Key Vault deben cumplir formato seguro y longitud maxima. | `api/src/tests/keyVaultNames.test.ts` | Cubierta |

## Duplicados

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-DUP-01 | No puede haber dos clientes no eliminados con mismo nombre normalizado. | `api/src/tests/duplicateValidation.test.ts`; `frontend/src/tests/ClientesPage.test.tsx` -> error cliente duplicado | Cubierta |
| BR-DUP-02 | `externalId` de cliente es opcional; si se captura debe ser unico entre clientes no eliminados. | `api/src/tests/duplicateValidation.test.ts` -> "detecta ID de cliente duplicado solo cuando se captura"; `frontend/src/tests/ClientesPage.test.tsx` | Cubierta |
| BR-DUP-03 | En edicion, un registro no se bloquea por duplicarse consigo mismo. | `api/src/tests/duplicateValidation.test.ts` | Cubierta |
| BR-DUP-04 | No puede haber dos dominios con la misma URL normalizada; slash final no diferencia. | `api/src/tests/duplicateValidation.test.ts`; `frontend/src/tests/DominiosPage.test.tsx` | Cubierta |
| BR-DUP-05 | No puede haber dos bases con la misma cadena de conexion normalizada. | `api/src/tests/duplicateValidation.test.ts`; `frontend/src/tests/BasesDeDatosPage.test.tsx` | Cubierta |
| BR-DUP-06 | Registros eliminados no bloquean duplicados operativos. | `api/src/tests/duplicateValidation.test.ts` -> ignora deleted/inactivos segun regla | Cubierta |

## Clientes

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-CLI-01 | Crear/editar cliente admite ID de negocio opcional y muestra ayuda de unicidad. | `frontend/src/tests/ClientesPage.test.tsx` -> "el ID del cliente es opcional..." | Cubierta |
| BR-CLI-02 | Cliente guarda licencias compradas en `licenseModuleIds`. | `frontend/src/tests/ClientesPage.test.tsx`; `api/src/tests/licenseDeletion.test.ts`; `api/src/tests/reportsService.test.ts` | Cubierta |
| BR-CLI-03 | IDs de licencias se deduplican y se rechazan inexistentes. | `frontend/src/tests/ClientesPage.test.tsx`; pruebas backend de reglas/licencias relacionadas | Cubierta parcial por servicios; vigilar endpoints |
| BR-CLI-04 | Modal nuevo/editar cliente muestra selector de licencias activas y chips de seleccionadas. | `frontend/src/tests/ClientesPage.test.tsx` -> casos de licencias/chips/editar | Cubierta |
| BR-CLI-05 | Cliente sin licencias muestra texto "Sin licencias seleccionadas" o "Sin licencias registradas" segun contexto. | `frontend/src/tests/ClientesPage.test.tsx`; `api/src/tests/reportsService.test.ts` | Cubierta |
| BR-CLI-06 | Tabla de clientes incluye acciones de flujo: ver dominios y bases, agregar dominio, editar, desactivar, eliminar. | `frontend/src/tests/ClientesPage.test.tsx` -> "muestra acciones rápidas..." | Cubierta |
| BR-CLI-07 | Ver dominios y bases muestra licencias, dominios y bases del cliente. | `frontend/src/tests/ClientesPage.test.tsx` | Cubierta |
| BR-CLI-08 | Desde Ver dominios y bases se puede editar dominio, agregar base y editar base. | `frontend/src/tests/ClientesPage.test.tsx` | Cubierta |

## Dominios

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-DOM-01 | Dominios se crean/editan con URL `https://`, cliente, ambiente y estado. | `api/src/tests/inputValidation.test.ts`; `frontend/src/tests/DominiosPage.test.tsx` | Cubierta |
| BR-DOM-02 | El formulario de dominio no muestra ni envia frecuencia embebida. | `frontend/src/tests/DominiosPage.test.tsx` -> "al guardar dominio no envia frecuencia embebida", "editar dominio mantiene programación fuera..." | Cubierta |
| BR-DOM-03 | El maestro Dominios ya no muestra columnas Version/Recurrente/Proxima actualizacion. | `frontend/src/tests/DominiosPage.test.tsx` | Cubierta |
| BR-DOM-04 | La programacion de dominios/bases se hace desde Actualizaciones programadas. | `frontend/src/tests/DominiosPage.test.tsx`; `frontend/src/tests/BasesDeDatosPage.test.tsx`; `CAMBIOS_V17.md` | Cubierta por UI |
| BR-DOM-05 | Dominios tiene accion Agregar base. | `frontend/src/tests/DominiosPage.test.tsx` | Cubierta |
| BR-DOM-06 | Modal Bases asociadas permite copiar contraseña mediante endpoint seguro y editar base. | `frontend/src/tests/DominiosPage.test.tsx`; permisos en `api/src/tests/permissions.test.ts` | Cubierta |
| BR-DOM-07 | Copiar contraseña no muestra contraseña permanentemente ni en listados. | `frontend/src/tests/DominiosPage.test.tsx`; `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/permissions.test.ts` | Cubierta |

## Bases de datos

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-DB-01 | Crear base parsea cadena de conexion y guarda contraseña en Key Vault, no en Cosmos. | `api/src/tests/dbAccessParser.test.ts`; `api/src/tests/dbCreation.test.ts`; `api/src/tests/settingsService.test.ts` para secretos SMTP | Cubierta |
| BR-DB-02 | Parser de acceso acepta claves con espacios/case-insensitive y exige password e Initial Catalog. | `api/src/tests/dbAccessParser.test.ts`; `frontend/src/tests/dbAccessParser.test.ts` | Cubierta |
| BR-DB-03 | Tabla de bases no debe mostrar Servidor ni Version como columnas principales. | `frontend/src/tests/BasesDeDatosPage.test.tsx`; `frontend/src/tests/DominiosPage.test.tsx` para accesos relacionados | Cubierta por UI |
| BR-DB-04 | Ver acceso muestra partes de conexion y oculta contraseña. | `frontend/src/tests/AccesoBdParseado.test.tsx`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-DB-05 | Usuario sin permiso no revela contraseñas ni botones de reveal. | `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/permissions.test.ts` | Cubierta |
| BR-DB-06 | Database updater asignado puede acceder a metadata/contrasena de sus bases; domain updater no. | `api/src/tests/permissions.test.ts`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-DB-07 | Nueva base indica que se programa desde Actualizaciones programadas y no advierte por frecuencia embebida. | `frontend/src/tests/BasesDeDatosPage.test.tsx` | Cubierta |

## Licenciamiento

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-LIC-01 | Licenciamiento visible solo como maestro de modulos; Asignaciones ocultas por defecto. | `frontend/src/tests/LicenciamientoPage.test.tsx`; `frontend/src/tests/AppLayout.test.tsx` | Cubierta |
| BR-LIC-02 | Nombre de modulo es obligatorio; codigo es opcional. | `api/src/tests/licenseRules.test.ts`; `frontend/src/tests/LicenciamientoPage.test.tsx` | Cubierta |
| BR-LIC-03 | Si codigo viene vacio, backend autogenera codigo sin tildes y evita duplicados. | `api/src/tests/licenseRules.test.ts` -> "genera códigos automáticos..." | Cubierta |
| BR-LIC-04 | No se permiten codigos ni nombres duplicados de modulos activos. | `api/src/tests/licenseRules.test.ts`; `frontend/src/tests/LicenciamientoPage.test.tsx` | Cubierta |
| BR-LIC-05 | Admin administra modulos; admin/client_manager administran asignaciones; updaters/viewer no. | `api/src/tests/licenseRules.test.ts`; `frontend/src/tests/AppLayout.test.tsx` | Cubierta |
| BR-LIC-06 | No se puede eliminar una licencia con clientes/asignaciones activas; debe mostrar dependencias. | `api/src/tests/licenseDeletion.test.ts` | Cubierta |
| BR-LIC-07 | Asignaciones avanzadas por dominio/base quedan reservadas para futuro, no usadas por UI normal. | `frontend/src/tests/LicenciamientoPage.test.tsx` -> oculta Asignaciones | Cubierta |

## Actualizaciones programadas

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-SCH-01 | La vista se llama Actualizaciones programadas y usa `/frecuencias` por compatibilidad. | `frontend/src/tests/FrecuenciasPage.test.tsx`; `frontend/src/tests/AppLayout.test.tsx` | Cubierta |
| BR-SCH-02 | Solo hay dos modos de alcance: seleccion manual y por licenciamiento. No implementar "Todos los clientes activos". | `frontend/src/tests/FrecuenciasPage.test.tsx` -> modo licenciamiento/manual; ausencia validada por UI | Cubierta |
| BR-SCH-03 | Al crear se envia `origin: "special"`. | `frontend/src/tests/FrecuenciasPage.test.tsx` -> "al crear envia origin special"; `api/src/tests/scheduleService.test.ts` | Cubierta |
| BR-SCH-04 | Frecuencia Unica es default en nueva actualizacion programada. | `frontend/src/tests/FrecuenciasPage.test.tsx` -> "usa frecuencia Única por defecto..." | Cubierta |
| BR-SCH-05 | Unica solo muestra Fecha de actualizacion y no campos recurrentes. | `frontend/src/tests/FrecuenciasPage.test.tsx`; `api/src/tests/scheduleService.test.ts` | Cubierta |
| BR-SCH-06 | Unica permite no enviar `daysOfWeek` ni `intervalWeeks`; fecha fin no debe diferir de startDate. | `api/src/tests/scheduleService.test.ts` | Cubierta |
| BR-SCH-07 | Generar tareas para una unica no la cierra por crear tareas futuras; solo se cierra cuando fecha llego y todas sus tareas estan terminales. | `api/src/tests/taskGeneration.test.ts` -> "programación única genera en runDate pero no se cierra..." | Cubierta |
| BR-SCH-08 | Reprogramar una unica cancela tareas abiertas de la fecha anterior como obsoletas, sin borrar completadas/canceladas. | `api/src/tests/scheduleReschedule.test.ts` | Cubierta |
| BR-SCH-09 | Validaciones semanales requieren dias y cada N semanas >= 1. | `api/src/tests/scheduleService.test.ts`; `api/src/tests/scheduleEngine.test.ts` | Cubierta |
| BR-SCH-10 | Frecuencias por intervalo y mensual respetan intervalo/dia del mes/endDate. | `api/src/tests/scheduleService.test.ts`; `api/src/tests/scheduleEngine.test.ts` | Cubierta |
| BR-SCH-11 | Frecuencia manual nunca se ejecuta automaticamente. | `api/src/tests/scheduleEngine.test.ts` -> "nunca se ejecuta automáticamente" | Cubierta |
| BR-SCH-12 | Nombre de actualizacion se autogenera si queda vacio y se respeta el nombre manual con trim. | `api/src/tests/scheduleService.test.ts` -> "genera nombre descriptivo cuando la actualización programada no trae nombre" | Cubierta |
| BR-SCH-13 | Al crear, editar o reactivar actualizacion programada, backend intenta generar/reconciliar tareas idempotentemente. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/windowGeneration.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-SCH-14 | Desactivar/eliminar actualizacion programada cancela tareas abiertas asociadas, incluidas vencidas antiguas. | `api/src/tests/taskVisibility.test.ts`; `api/src/functions/schedules.ts`; recomendado agregar test endpoint si cambia IO | Cubierta por regla de visibilidad; requiere vigilancia endpoint |
| BR-SCH-15 | Recurrentes no tienen un unico estado operativo; se agrupan por salud derivada. | `frontend/src/tests/FrecuenciasPage.test.tsx` -> "agrupa las actualizaciones..." | Cubierta |
| BR-SCH-16 | Duplicar actualizacion abre formulario precargado y crea copia. | `frontend/src/tests/FrecuenciasPage.test.tsx` -> "Duplicar abre..." | Cubierta |
| BR-SCH-17 | Programaciones sin `origin` no deben aparecer como especiales. | `api/src/tests/scheduleService.test.ts` | Cubierta |

## Alcance manual

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-MAN-01 | Seleccion manual permite agregar cliente. | `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-MAN-02 | Agregar dominios y bases usa modales/paneles con checkboxes y permite varias selecciones. | `frontend/src/tests/FrecuenciasPage.test.tsx` -> "permite agregar varios dominios..." | Cubierta |
| BR-MAN-03 | `includeAllDomains` incluye dominios activos del cliente. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/windowGeneration.test.ts` | Cubierta |
| BR-MAN-04 | `includeAllDatabases` incluye todas las bases activas del dominio. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/windowGeneration.test.ts` | Cubierta |
| BR-MAN-05 | Programacion plana de dominio no genera bases implicitas. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/windowGeneration.test.ts` | Cubierta |
| BR-MAN-06 | Solo bases crea tareas de base sin tarea de dominio. | `api/src/tests/taskGeneration.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-MAN-07 | Solo dominios no crea bases aunque existan bases seleccionadas. | `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-MAN-08 | No se generan tareas para dominios/bases inactivos o eliminados. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/windowGeneration.test.ts` | Cubierta |

## Alcance por licenciamiento

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-LSCOPE-01 | Preview por licenciamiento exige licencias y muestra checklist/chips. | `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-LSCOPE-02 | Coincidencia `any` incluye clientes con al menos una licencia. | `api/src/tests/licensingScope.test.ts` | Cubierta |
| BR-LSCOPE-03 | Coincidencia `all` incluye clientes con todas las licencias. | `api/src/tests/licensingScope.test.ts` | Cubierta |
| BR-LSCOPE-04 | Solo se consideran clientes, dominios, bases y licencias activos. | `api/src/tests/licensingScope.test.ts`; `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-LSCOPE-05 | Filtro de ambiente aplica a dominios y bases en modo licenciamiento. | `api/src/tests/licensingScope.test.ts` | Cubierta |
| BR-LSCOPE-06 | Target types: dominios y bases, solo dominios, solo bases. | `api/src/tests/licensingScope.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-LSCOPE-07 | Preview devuelve IDs de cliente, dominio y base. | `api/src/tests/licensingScope.test.ts` -> "previsualiza IDs..." | Cubierta |
| BR-LSCOPE-08 | Excepciones de dominio excluyen solo tarea de dominio; no excluyen bases. | `api/src/tests/licensingScope.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-LSCOPE-09 | Excepciones de base excluyen solo tarea de base; no excluyen dominio. | `api/src/tests/licensingScope.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-LSCOPE-10 | Cambiar filtros revalida/actualiza preview y conserva excepciones validas. | `frontend/src/tests/FrecuenciasPage.test.tsx` -> "actualiza automáticamente el preview..." | Cubierta |
| BR-LSCOPE-11 | Guardar programacion por licencia guarda criterio, no snapshot; nuevos clientes licenciados entran en futuras generaciones. | `api/src/tests/taskGeneration.test.ts` -> "programación por licenciamiento incluye clientes licenciados agregados después" | Cubierta |

## Generacion, deduplicacion y reconciliacion de tareas

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-GEN-01 | Generacion crea tarea por target cuando fecha aplica. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/windowGeneration.test.ts` | Cubierta |
| BR-GEN-02 | Si fecha no aplica, no genera tareas. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/scheduleEngine.test.ts` | Cubierta |
| BR-GEN-03 | Generacion ignora programaciones inactivas. | `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-GEN-04 | Dedupe maximo una tarea por `targetType + targetId + taskDate`. | `api/src/tests/taskGeneration.test.ts` -> normal/licenciamiento/manual mismo dia; diferentes dias | Cubierta |
| BR-GEN-05 | Tarea completada existente bloquea duplicado para misma entidad/dia. | `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-GEN-06 | Tarea cancelada obsolete puede reactivarse si programacion activa la vuelve a requerir. | `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-GEN-07 | Responsables se sincronizan en tareas pendientes si cambia programacion; completadas no se modifican. | `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-GEN-08 | Reconciliacion marca obsoletas tareas futuras no esperadas. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/scheduleReschedule.test.ts` | Cubierta |
| BR-GEN-09 | Reconciliacion preserva vencidas abiertas antiguas, tareas de hoy y completadas. | `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-GEN-10 | Tareas generadas guardan `rootScheduleId` estable para migracion SQL y visibilidad. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/taskVisibility.test.ts` | Cubierta |
| BR-GEN-11 | `rootScheduleId` reconoce IDs expandidos con sufijos sintéticos. | `api/src/tests/taskGeneration.test.ts` -> "reconoce tareas expandidas..." | Cubierta |

## Vista operativa de tareas

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-TASK-01 | Texto superior: "Vista operativa: vencidas abiertas, hoy, próximas 4 días y completadas recientes." | `frontend/src/tests/TareasPage.test.tsx`; `frontend/src/tests/fechas.test.ts` | Cubierta |
| BR-TASK-02 | Vencidas abiertas antiguas nunca desaparecen por antiguedad. | `frontend/src/tests/TareasPage.test.tsx`; `frontend/src/tests/fechas.test.ts` | Cubierta |
| BR-TASK-03 | Hoy contiene solo tareas de hoy abiertas. | `frontend/src/tests/fechas.test.ts`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TASK-04 | Proximas contiene manana a hoy+4, no hoy+5. | `frontend/src/tests/fechas.test.ts`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TASK-05 | Completadas muestra completadas recientes y oculta antiguas fuera de ventana. | `frontend/src/tests/fechas.test.ts`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TASK-06 | Tareas canceladas obsoletas no se renderizan en tablero ni detalle. | `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-TASK-07 | Tareas abiertas solo visibles si su actualizacion programada raiz existe y esta activa. | `api/src/tests/taskVisibility.test.ts` | Cubierta |
| BR-TASK-08 | Tareas completadas solo visibles si su actualizacion programada raiz todavia existe. | `api/src/tests/taskVisibility.test.ts` | Cubierta |
| BR-TASK-09 | Tareas sin referencia a actualizacion programada raiz se ocultan. | `api/src/tests/taskVisibility.test.ts` | Cubierta |
| BR-TASK-10 | No existe boton Refrescar en Tareas como flujo operativo normal. | `frontend/src/tests/TareasPage.test.tsx` -> varios roles sin Refrescar | Cubierta |
| BR-TASK-11 | Tareas se agrupan por fecha, responsable y tipo. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TASK-12 | Grupos asignados al usuario actual muestran badge "Asignado a ti". | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |

## Acciones y estados de tareas

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-TSTATE-01 | Pendiente muestra Completar y Bloquear; no Iniciar. | `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/completionFlow.test.ts` | Cubierta |
| BR-TSTATE-02 | En progreso muestra Completar/Bloquear; no Iniciar. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TSTATE-03 | Bloqueada muestra Completar y Resolver bloqueo; no Reabrir. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TSTATE-04 | Completada muestra Reabrir; no Completar/Bloquear/Iniciar. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TSTATE-05 | Completar tarea abre modal, permite marcar con/sin problemas y envia payload correcto. | `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/completionFlow.test.ts` | Cubierta |
| BR-TSTATE-06 | `withProblems=true` requiere/usa nota de problema para email/flujo. | `api/src/tests/completionFlow.test.ts`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TSTATE-07 | Reabrir completada usa modal, no prompt, motivo opcional y `completed -> pending`. | `frontend/src/tests/TareasPage.test.tsx`; backend cubierto por funciones/flujo | Cubierta |
| BR-TSTATE-08 | Resolver bloqueo permite comentario opcional y estado destino requerido. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TSTATE-09 | Completar bloqueada usa modal de cierre y pasa a completed. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TSTATE-10 | Si guardado de accion falla, UI muestra error y permite reintentar. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |

## Acceso y copiado en tareas

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-TACCESS-01 | Detalle de dominio muestra modal grande y copiar dominio para publicar. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TACCESS-02 | Copiar todos los dominios pendientes usa formato publicable, uno por linea. | `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/emailDomainPublishable.test.ts` | Cubierta |
| BR-TACCESS-03 | Detalle de base muestra conexion apilada, password oculta y accion completar. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TACCESS-04 | Access-info carga por `taskId` aunque responsible sea por rol o manual. | `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/permissions.test.ts` | Cubierta |
| BR-TACCESS-05 | Si access-info falla, la fila muestra error y reintento. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TACCESS-06 | Si access-info devuelve 403, mostrar mensaje de permisos. | `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-TACCESS-07 | Ver/copiar contraseña llaman endpoint seguro sin precargar password. | `frontend/src/tests/TareasPage.test.tsx`; `api/src/tests/permissions.test.ts` | Cubierta |

## Responsables y recordatorios en programaciones

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-RESP-01 | Modo rol usa responsables por rol y recordatorios a usuarios del rol. | `frontend/src/tests/SeleccionFrecuencia.test.tsx`; `api/src/tests/scheduleService.test.ts` | Cubierta |
| BR-RESP-02 | Modo usuarios permite asignar usuarios especificos y limpia al volver a rol. | `frontend/src/tests/SeleccionFrecuencia.test.tsx`; `api/src/tests/scheduleService.test.ts` | Cubierta |
| BR-RESP-03 | Bases heredadas/seleccionadas pueden tener responsables especificos. | `frontend/src/tests/SeleccionFrecuencia.test.tsx`; `api/src/tests/taskGeneration.test.ts` | Cubierta |
| BR-RESP-04 | Recordatorios globales por defecto usan activo, dias `[1,0]`, hora `08:00`. | `api/src/tests/reminderLogic.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-RESP-05 | Override de recordatorios en programacion prevalece sobre global. | `api/src/tests/reminderLogic.test.ts`; `frontend/src/tests/FrecuenciasPage.test.tsx` | Cubierta |
| BR-RESP-06 | Dias previos se capturan separados por coma y hora configurable. | `frontend/src/tests/FrecuenciasPage.test.tsx`; `api/src/tests/scheduleService.test.ts` | Cubierta |

## Recordatorios y alertas por correo

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-MAIL-01 | Recordatorios se envian N dias antes o mismo dia si llego la hora. | `api/src/tests/reminderLogic.test.ts` | Cubierta |
| BR-MAIL-02 | No se envia recordatorio antes de la hora configurada. | `api/src/tests/reminderLogic.test.ts` | Cubierta |
| BR-MAIL-03 | No se duplican recordatorios enviados mismo dia/daysBefore. | `api/src/tests/reminderLogic.test.ts` | Cubierta |
| BR-MAIL-04 | No se envia si recordatorios estan deshabilitados. | `api/src/tests/reminderLogic.test.ts` | Cubierta |
| BR-MAIL-05 | Tareas pendientes pueden enviar recordatorio aunque la programacion ya este inactiva. | `api/src/tests/reminderLogic.test.ts` | Cubierta |
| BR-MAIL-06 | Completada con exito envia correo de exito. | `api/src/tests/taskNotifications.test.ts` | Cubierta |
| BR-MAIL-07 | Completada con problemas envia correo de problema siempre. | `api/src/tests/taskNotifications.test.ts`; `api/src/tests/completionFlow.test.ts` | Cubierta |
| BR-MAIL-08 | Fallida envia correo de problema si alertas estan activas; no si estan desactivadas. | `api/src/tests/taskNotifications.test.ts` | Cubierta |
| BR-MAIL-09 | Bloqueada envia correo de problema si alertas estan activas. | `api/src/tests/taskNotifications.test.ts` | Cubierta |
| BR-MAIL-10 | En progreso/cancelada/reabierta no envian correo automatico de estado. | `api/src/tests/taskNotifications.test.ts` | Cubierta |
| BR-MAIL-11 | Emails HTML escapan caracteres peligrosos y no contienen secretos. Los recordatorios de bloqueos usan plantilla central y neutralizan etiquetas, atributos y links ejecutables en todos los campos dinamicos. | `api/src/tests/emailEscape.test.ts`; `api/src/tests/completionFlow.test.ts`; `api/src/tests/emailTemplates.test.ts`; `api/src/tests/sendBlockedReminders.test.ts` | Cubierta |
| BR-MAIL-12 | Plantillas usan base URL normalizada sin slash final. | `api/src/tests/emailTemplates.test.ts` | Cubierta |

## Alertas y correos - UI y configuracion

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-SET-01 | Pagina muestra secciones principales y SMTP avanzado colapsado. | `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-SET-02 | Ayuda de recordatorios globales y bloqueos no resueltos visible. | `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-SET-03 | Configuracion recomendada P&A llena valores sin contrasena. | `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-SET-04 | Correo de prueba usa endpoint correspondiente. | `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-SET-05 | Reporte maestro acepta destinatarios separados por punto y coma. | `frontend/src/tests/AlertasCorreosPage.test.tsx`; `api/src/tests/reportsService.test.ts` | Cubierta |
| BR-SET-06 | SMTP sin password no envia `smtpPassword` al backend y preserva actual. | `frontend/src/tests/AlertasCorreosPage.test.tsx`; `api/src/tests/settingsService.test.ts` | Cubierta |
| BR-SET-07 | SMTP con password nuevo lo envia, limpia campo y backend lo guarda en Key Vault. | `frontend/src/tests/AlertasCorreosPage.test.tsx`; `api/src/tests/settingsService.test.ts` | Cubierta |
| BR-SET-08 | Cancelar SMTP descarta cambios locales y recarga configuracion guardada. | `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-SET-09 | Si guardar SMTP falla, muestra error y no limpia formulario. | `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-SET-10 | Respuesta de settings no expone `smtpPasswordSecretName`; expone `smtpPasswordConfigured`. | `api/src/tests/settingsService.test.ts` | Cubierta |

## Recordatorios administrativos

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-ADMINREM-01 | Hay recordatorios para guardar version mensual SAG Web y crear "Que hay de nuevo". | `frontend/src/tests/AlertasCorreosPage.test.tsx`; `api/src/tests/administrativeReminderSchedule.test.ts` | Cubierta |
| BR-ADMINREM-02 | Regla por defecto: ultimo dia habil del mes. | `frontend/src/tests/AlertasCorreosPage.test.tsx`; `api/src/tests/administrativeReminderSchedule.test.ts` | Cubierta |
| BR-ADMINREM-03 | Si fin de mes es lunes-viernes, enviar solo ese dia. | `api/src/tests/administrativeReminderSchedule.test.ts` | Cubierta |
| BR-ADMINREM-04 | Si fin de mes es sabado, enviar viernes anterior y lunes siguiente. | `api/src/tests/administrativeReminderSchedule.test.ts` | Cubierta |
| BR-ADMINREM-05 | Si fin de mes es domingo, enviar viernes anterior y lunes siguiente conservando periodo anterior. | `api/src/tests/administrativeReminderSchedule.test.ts` | Cubierta |
| BR-ADMINREM-06 | Primer dia, ultimo dia y dia fijo funcionan; dia fijo invalido se rechaza. | `api/src/tests/administrativeReminderSchedule.test.ts`; `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |

## Reporte maestro

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-REP-01 | Reporte acepta multiples correos por punto y coma y rechaza invalidos. | `api/src/tests/reportsService.test.ts`; `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-REP-02 | Reporte genera HTML/texto con clientes, dominios y empresas. | `api/src/tests/reportsService.test.ts`; `api/src/tests/emailTemplates.test.ts` | Cubierta |
| BR-REP-03 | Reporte incluye solo registros activos. | `api/src/tests/reportsService.test.ts` | Cubierta |
| BR-REP-04 | Reporte incluye ambiente en dominio/base. | `api/src/tests/reportsService.test.ts`; `api/src/tests/emailTemplates.test.ts` | Cubierta |
| BR-REP-05 | Reporte no incluye password, usuario SQL, server/IP/puerto, connection string, secretos ni tokens. | `api/src/tests/reportsService.test.ts`; `api/src/tests/emailTemplates.test.ts` | Cubierta |
| BR-REP-06 | Reporte incluye licencias activas del cliente, deduplicadas. | `api/src/tests/reportsService.test.ts` | Cubierta |
| BR-REP-07 | Reporte excluye modulos/asignaciones inactivas o eliminadas. | `api/src/tests/reportsService.test.ts` | Cubierta |
| BR-REP-08 | Cliente sin licencias muestra "Sin licencias registradas". | `api/src/tests/reportsService.test.ts` | Cubierta |

## Auditoria

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-AUD-01 | Audit log genera id y performedAt automaticamente. | `api/src/tests/auditLog.test.ts` | Cubierta |
| BR-AUD-02 | Audit log nunca incluye contrasenas aunque vengan en `after`. | `api/src/tests/auditLog.test.ts` | Cubierta |
| BR-AUD-03 | Auditoria se lista con busqueda/paginacion desde UI. | `frontend/src/tests/AuditoriaPage.test.tsx` | Cubierta |
| BR-AUD-04 | No eliminar audit logs en cascadas o limpiezas. | Regla documentada en handoff; no hay test especifico de cascade actual en esta matriz | Requiere vigilancia |
| BR-AUD-05 | `before`/`after` solo conservan campos permitidos por tipo de entidad; metadata solo conserva campos permitidos por accion. | `api/src/tests/auditLog.test.ts` | Cubierta |
| BR-AUD-06 | Connection strings, authorization, cookies, API keys, passwords, tokens, JWT, headers y cuerpos HTTP nunca se persisten en auditoria. | `api/src/tests/auditLog.test.ts` | Cubierta |
| BR-AUD-07 | Secretos incrustados en campos permitidos se reemplazan por `[REDACTED]`; tipos/eventos desconocidos no conservan payload. | `api/src/tests/auditLog.test.ts` | Cubierta |
| BR-AUD-08 | El saneamiento historico conserva ID, fecha y particion, es idempotente y no imprime contenido. | `api/src/tests/auditLog.test.ts`; `api/scripts/sanitize-audit-logs.js` | Cubierta por unidad y procedimiento |

## Seguridad de secretos

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-SEC-01 | No guardar passwords de DB en Cosmos. | `api/src/tests/dbCreation.test.ts`; `api/src/tests/permissions.test.ts` | Cubierta |
| BR-SEC-02 | No mostrar password ni secretName en metadata de conexion. | `api/src/tests/permissions.test.ts`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-SEC-03 | SMTP password se guarda en Key Vault y no se expone en respuesta. | `api/src/tests/settingsService.test.ts`; `frontend/src/tests/AlertasCorreosPage.test.tsx` | Cubierta |
| BR-SEC-04 | Emails/reportes no exponen secretos ni connection strings completas. | `api/src/tests/reportsService.test.ts`; `api/src/tests/emailTemplates.test.ts`; `api/src/tests/completionFlow.test.ts` | Cubierta |
| BR-SEC-05 | Copia/revelacion de password de base requiere permisos. | `api/src/tests/permissions.test.ts`; `frontend/src/tests/TareasPage.test.tsx` | Cubierta |
| BR-SEC-06 | Listados y detalles de bases nunca exponen servidor, usuario SQL ni referencias Key Vault; esos datos se obtienen solo mediante `access-info` autorizado. | `api/src/tests/publicDtos.test.ts`; `api/src/tests/objectAuthorization.test.ts`; `frontend/src/tests/DominiosPage.test.tsx` | Cubierta |
| BR-SEC-07 | Admin, client_manager y viewer tienen lectura operativa global sanitizada; actualizadores solo leen clientes, dominios, bases y tareas asignados por usuario, rol o relación directa. | `api/src/tests/objectAuthorization.test.ts` | Cubierta por unidad backend |
| BR-SEC-08 | Los parametros de filtro (`assignedToMe`, `clientId`, `domainId`) nunca amplian el alcance autorizado por backend. | `api/src/tests/objectAuthorization.test.ts` -> filtrado BOLA/IDOR | Cubierta por unidad backend |
| BR-SEC-09 | Copiar servidor/catalogo/usuario y revelar password aplican la misma autorizacion de objeto; una tarea ajena o de otra base no concede acceso. | `api/src/tests/objectAuthorization.test.ts` | Cubierta por unidad backend |
| BR-SEC-10 | Backend y frontend deben mantener auditoria npm de produccion y total sin vulnerabilidades moderadas o superiores antes de desplegar. | Scripts `security:audit:prod`/`security:audit`; workflow de Static Web Apps | Cubierta por CI |
| BR-SEC-11 | Dependabot revisa semanalmente dependencias npm y GitHub Actions; las remediaciones cumplen el SLA por severidad. | `.github/dependabot.yml`; `SECURITY_DEPENDENCY_POLICY.md` | Cubierta por proceso automatizado |
| BR-SEC-12 | Login, recuperacion, restablecimiento, setup y envios manuales aplican limites distribuidos por IP e identidad y responden `429` con `Retry-After`. | `api/src/tests/rateLimit.test.ts` | Cubierta por unidad backend |
| BR-SEC-13 | Cinco credenciales invalidas bloquean temporalmente la IP/cuenta; una autenticacion valida limpia solo los fallos de la cuenta. | `api/src/tests/rateLimit.test.ts`; integracion en `api/src/functions/auth.ts` | Cubierta por unidad backend |
| BR-SEC-14 | Los contadores de abuso no almacenan IP, correo ni token en claro y expiran mediante TTL. | `api/src/tests/rateLimit.test.ts`; contenedor `securityRateLimits` | Cubierta por unidad e infraestructura |
| BR-SEC-15 | El access JWT usa HS256, secreto >=32 bytes, 10 minutos y claims `iss`, `aud`, `jti`, `sid`, `ver`. | `api/src/tests/jwt.test.ts` | Cubierta por unidad backend |
| BR-SEC-16 | El refresh token se guarda hasheado, rota en cada uso y su reutilizacion revoca la sesion descendiente. | `api/src/tests/authSessions.test.ts` | Cubierta por unidad backend |
| BR-SEC-17 | Logout, cambio/reset de contraseña, reenvio de credenciales y desactivacion invalidan sesiones existentes mediante revocacion y `tokenVersion`. | `api/src/tests/authSessions.test.ts`; integracion en `auth.ts`, `users.ts`, `setup.ts` | Cubierta por unidad backend |
| BR-SEC-18 | El navegador no persiste JWT en localStorage; usa access token en memoria y cookie refresh HttpOnly con credenciales. | `frontend/src/tests/ApiClient.test.ts`; `api/src/tests/authSessions.test.ts` | Cubierta backend/frontend |
| BR-SEC-19 | Produccion fuerza HTTPS/TLS 1.2, deshabilita FTPS y permite CORS solo desde el frontend productivo. Credenciales CORS se mantienen exclusivamente para la cookie refresh HttpOnly cross-origin. | `scripts/harden-function-transport.ps1`; verificacion ARM y preflight productivo/localhost | Cubierta por script idempotente e infraestructura |

## Static Web Apps y despliegue

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-DEP-01 | SPA debe conservar `navigationFallback` para refrescar rutas como `/tareas`. | `frontend/public/staticwebapp.config.json`; build frontend; verificacion manual en despliegues | Requiere vigilancia |
| BR-DEP-02 | Backend se despliega por ZIP completo con `dist` y `node_modules`. | Scripts `scripts/deploy-all.ps1`, `scripts/desplegar-azure.ps1`; validacion manual de deploy | Requiere vigilancia |
| BR-DEP-03 | No versionar secretos ni contrasenas reales. | Revision de docs/tests; tests de secretos en audit/report/email/settings | Cubierta parcialmente |

## Migracion relacional futura

| ID | Regla de negocio | Pruebas relacionadas | Cobertura |
|---|---|---|---|
| BR-SQL-01 | Preservar IDs Cosmos como raiz de relaciones y `rootScheduleId` en tareas. | `api/src/tests/taskGeneration.test.ts`; `api/src/tests/taskVisibility.test.ts`; documentos `docs/*` | Cubierta |
| BR-SQL-02 | Licencias por cliente migran a `clients`, `license_modules`, `client_license_modules`. | `docs/RELATIONAL_MODEL_PROPOSAL.md`; `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md`; tests de licenciamiento/reportes | Cubierta documental y funcional |
| BR-SQL-03 | Mantener secretos en Key Vault durante migracion; no migrar valores planos. | `api/src/tests/dbCreation.test.ts`; `api/src/tests/settingsService.test.ts`; `SOLICITUD_BASE_SQL_SERVER.md` | Cubierta |
| BR-SQL-04 | Ambientes cerrados facilitan migracion a tabla/constraint relacional. | `api/src/tests/environments.test.ts`; docs SQL | Cubierta |

## Brechas conocidas y reglas que requieren vigilancia

Estas reglas no estan completamente cubiertas por pruebas unitarias de extremo a extremo porque dependen de infraestructura externa, Cosmos real, Azure Functions runtime o decisiones de despliegue. Deben revisarse manualmente en cada cambio que las toque:

1. **BR-AUD-04**: no eliminar audit logs durante cascadas o limpiezas. Recomendado agregar prueba de cascade delete si se vuelve a tocar esa logica.
2. **BR-SCH-14**: cancelar todas las tareas abiertas al desactivar/eliminar una actualizacion programada. La visibilidad esta cubierta; endpoint/cosmos IO debe vigilarse si cambia `schedules.ts`.
3. **BR-DEP-01/02**: despliegue y fallback SPA se validan con build/deploy/manual; no son reglas puramente unitarias.
4. **BR-UI-04**: orden visual y color de acciones destructivas requiere revision visual si se refactorizan tablas.

## Checklist para futuros cambios

Antes de cerrar una tarea:

1. Identificar los IDs de reglas afectados.
2. Actualizar esta matriz si cambia alguna regla.
3. Agregar o actualizar pruebas en los archivos relacionados.
4. Ejecutar tests focalizados del modulo.
5. Ejecutar `npm test` y `npm run build` en backend/frontend cuando el cambio sea transversal.
6. Ejecutar busqueda de `alert/confirm/prompt` si se toca UI.
7. No commitear `api/api-deploy-full.zip` ni artefactos generados salvo decision explicita.
