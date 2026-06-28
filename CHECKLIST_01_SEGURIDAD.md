# Checklist 01 - Auditoria de seguridad

Fecha de revision: 2026-06-27  
Alcance: frontend React/Vite, API Azure Functions, Cosmos DB, Key Vault, correo, GitHub Actions, scripts de despliegue y configuracion productiva consultable sin revelar secretos.

## Convenciones

- `[x]`: control existente y verificado.
- `[ ]`: requiere correccion, decision o evidencia adicional.
- `P0`: riesgo critico; atender antes de ampliar uso o migrar datos delicados.
- `P1`: alto; atender antes del cutover SQL.
- `P2`: medio; incluir en el plan de endurecimiento.
- `P3`: mejora defensiva.

## Veredicto

**Estado: NO APTO todavia para manejar datos delicados adicionales ni para un cutover SQL sin remediacion.**

La aplicacion tiene controles valiosos (hash de contrasenas, tokens de reset hasheados, Key Vault, auditoria sanitizada, permisos funcionales y pruebas). El bypass SEC-001 fue corregido, pero varios endpoints aun exponen mas datos de los necesarios y las dependencias presentan vulnerabilidades altas corregibles.

## Acciones inmediatas P0/P1

- [x] **SEC-001 - P0 - Deshabilitar la confianza directa en `x-ms-client-principal`.**
  - Estado: Corregido el 2026-06-27.
  - Implementacion: `api/src/lib/auth.ts` ya no lee ni interpreta `x-ms-client-principal`. En produccion solo acepta `Authorization: Bearer <JWT>` emitido por el login de la aplicacion.
  - Desarrollo: `x-dev-*` sigue disponible exclusivamente con `DEV_AUTH_ENABLED=true`; produccion mantiene el flag en false.
  - Pruebas: `api/src/tests/authSecurity.test.ts` falsifica un principal con rol admin y verifica `null/401`; tambien cubre JWT valido y el gating del modo desarrollo.

- [ ] **SEC-002 - P0 - Aplicar autorizacion de objeto y minimizacion de respuesta en listados.**
  - Estado: Falla.
  - Evidencia: `api/src/functions/databases.ts` (`databasesList`, `databasesGet`) devuelve `DatabaseRecord` completo a cualquier usuario autenticado; `api/src/functions/tasks.ts` lista/obtiene tareas sin filtrar por asignacion salvo parametro opcional.
  - Riesgo: un viewer/updater puede consultar directamente API y obtener todos los clientes, tareas, servidor, usuario SQL y `passwordSecretName`, aunque la UI no lo muestre.
  - Cierre: DTOs publicos sin referencias Key Vault; politicas por rol/cliente/asignacion obligatorias en backend; pruebas BOLA/IDOR para cada rol.

- [ ] **SEC-003 - P1 - Restringir metadata de acceso de bases de datos.**
  - Estado: Falla.
  - Evidencia: `databasesCopyAccessPart` solo valida permiso especial para `password`; servidor, catalogo y usuario quedan disponibles para cualquier autenticado. Los listados ya incluyen `dbAccess` completo.
  - Cierre: aplicar `canAccessDatabaseTaskConnection`, `canRevealDatabaseSecret` o permiso administrativo a todas las partes; auditar; devolver DTO en listados.

- [ ] **SEC-004 - P1 - Actualizar dependencias vulnerables y bloquear regresiones.**
  - Estado: Falla.
  - Evidencia `npm audit` 2026-06-27:
    - Backend: 4 vulnerabilidades (3 high, 1 moderate): `nodemailer@8.0.7`, `form-data@4.0.5`, `vite@8.0.13`, `uuid@9.0.1`.
    - Frontend: 5 vulnerabilidades (3 high, 2 moderate): `vite@8.0.13`, `ws@8.20.0`, `form-data@4.0.5`, `react-router-dom/react-router@6.30.3`.
  - Cierre: actualizar con pruebas completas; `npm audit --omit=dev` y audit total en CI; politica de Dependabot/Renovate y SLA por severidad.

- [ ] **SEC-005 - P1 - Rate limiting, lockout y proteccion contra abuso.**
  - Estado: Ausente.
  - Evidencia: `auth/login`, `forgot-password`, `reset-password`, setup y endpoints de correo no tienen limite por IP/cuenta ni backoff.
  - Riesgo: fuerza bruta, spam de reset/correo, costo y denegacion de servicio.
  - Cierre: Azure API Management/Front Door o middleware distribuido; limites por IP+identidad, lockout temporal, metricas y alertas; pruebas 429.

- [ ] **SEC-006 - P1 - Endurecer sesiones JWT.**
  - Estado: Parcial.
  - Evidencia: `api/src/lib/jwt.ts`, `frontend/src/api/client.ts`, `api/src/functions/auth.ts`.
  - Brechas: token en `localStorage`; logout no revoca; cambio/reset/desactivacion no invalida tokens existentes; no `issuer`, `audience`, `jti`, `tokenVersion` ni algoritmo permitido explicito; secreto minimo aceptado de 16 caracteres.
  - Cierre: cookie `HttpOnly`, `Secure`, `SameSite` o arquitectura BFF; access token corto + refresh rotatorio; `tokenVersion`/revocacion; HS256 explicitamente permitido o claves asimetricas; secreto >=32 bytes; pruebas de revocacion.

- [ ] **SEC-007 - P1 - Politica de contrasenas y MFA.**
  - Estado: Falla para datos delicados.
  - Evidencia: minimo 6 caracteres en `password.ts`, `auth.ts`, `users.ts`, `setup.ts`; bcrypt costo 10; no MFA.
  - Cierre: minimo 12-14 caracteres o passphrases, lista de contrasenas comprometidas, MFA para admin/client_manager y acceso a secretos, rotacion/primer cambio obligatorio.

- [ ] **SEC-008 - P1 - Evitar inyeccion HTML en correos de bloqueos.**
  - Estado: Falla.
  - Evidencia: `api/src/functions/sendBlockedReminders.ts` interpola cliente, dominio, objetivo y motivo directamente en HTML; otras plantillas usan escape.
  - Cierre: usar `escapeHtml`/plantilla central para todos los campos; pruebas con `<script>`, links y caracteres especiales.

- [ ] **SEC-009 - P1 - Completar sanitizacion de auditoria.**
  - Estado: Parcial.
  - Evidencia: `api/src/lib/audit.ts` usa denylist por nombre de clave (`password`, `secret`, `token`, etc.). No cubre de forma garantizada `connectionString`, `authorization`, `cookie`, `apiKey` ni secretos bajo claves genericas.
  - Cierre: allowlist por tipo de evento/entidad; tests con todas las variantes; clasificacion de datos; nunca guardar cuerpo HTTP completo.

- [ ] **SEC-010 - P1 - Corregir postura de red/transportes de Azure Functions.**
  - Estado productivo verificado: Parcial.
  - Bien: TLS minimo 1.2, Managed Identity activa, `DEV_AUTH_ENABLED=false`, `SETUP_SECRET` vacio.
  - Brechas: `httpsOnly` no aparece forzado; FTPS=`FtpsOnly` en vez de Disabled; CORS conserva localhost y placeholder, `supportCredentials=true`.
  - Cierre: HTTPS only, FTPS disabled, CORS solo origen productivo requerido, credentials false salvo justificacion, Private Endpoint/VNet si aplica.

## Identidad, secretos y datos

- [x] **SEC-011 - Las contrasenas de bases no se guardan en Cosmos.**
  - Evidencia: `databaseService.ts` envia valor a Key Vault y guarda `passwordSecretName`.

- [x] **SEC-012 - Password hash y reset token se almacenan como hash.**
  - Evidencia: `password.ts`, `resetTokens.ts`, pruebas asociadas.

- [ ] **SEC-013 - Sustituir connection string de Cosmos por Managed Identity/RBAC.**
  - Estado: Pendiente; produccion tiene ambas: identidad asignada y `COSMOS_CONNECTION_STRING` configurada.
  - Cierre: Cosmos RBAC de minimo privilegio, eliminar account key de app settings y probar rotacion.

- [ ] **SEC-014 - Politica de acceso a Key Vault.**
  - Estado: No verificado completamente.
  - Cierre: RBAC, soft delete/purge protection, private endpoint/firewall, alertas por lectura masiva, rotacion y separacion prod/no-prod.

- [ ] **SEC-015 - Proteger snapshots de migracion.**
  - Estado: Diseno parcial.
  - Riesgo: `raw_documents` y export JSON contienen hashes, PII y nombres de secretos.
  - Cierre: cifrado, ubicacion fuera del repo, ACL minima, retencion/borrado, hash de integridad y registro de accesos.

- [ ] **SEC-016 - Clasificacion y retencion de datos.**
  - Estado: Ausente.
  - Cierre: clasificar PII, credenciales tecnicas, auditoria y correos; definir retencion, legal hold, eliminacion y responsables.

## API y autorizacion

- [x] **SEC-017 - Mutaciones principales verifican perfil persistido y rol.**
  - Evidencia: helpers `getUserOrFail` y `permissions.ts` en clientes, dominios, bases, schedules, usuarios y licencias.

- [ ] **SEC-018 - Matriz endpoint-permiso automatizada.**
  - Estado: Parcial; hay pruebas de helpers, no pruebas HTTP negativas para cada endpoint/rol/objeto.
  - Cierre: suite parametrizada de todos los endpoints, roles, recursos asignados/no asignados y estados activo/inactivo.

- [ ] **SEC-019 - No filtrar mensajes internos en errores 500.**
  - Estado: Falla.
  - Evidencia: `serverError` devuelve `e.message` al cliente.
  - Cierre: mensaje generico + correlation ID; detalle solo en telemetria sanitizada.

- [ ] **SEC-020 - Limites de payload y validacion uniforme.**
  - Estado: Parcial; Zod no se aplica uniformemente y algunos endpoints usan `any`.
  - Cierre: limite de body, esquemas estrictos (`.strict()`), limites de arrays/texto, rechazo de propiedades desconocidas.

- [ ] **SEC-021 - Prevenir mass assignment.**
  - Estado: Parcial; algunos updates construyen DTO, otros mezclan objetos/`any`.
  - Cierre: DTO por endpoint y allowlist de campos mutables; pruebas que intenten modificar `createdBy`, IDs, estado y referencias.

- [ ] **SEC-022 - Acceso a auditoria por minimo privilegio.**
  - Estado: Riesgo.
  - Evidencia: `canViewAuditLogs` permite todos los roles, incluidos updaters y viewer.
  - Cierre: decidir alcance; filtrar por cliente/entidad o restringir a admin/auditor; ocultar PII y metadata sensible.

## Frontend y navegador

- [ ] **SEC-023 - Definir Content Security Policy y headers defensivos.**
  - Estado: Ausente en `staticwebapp.config.json`.
  - Cierre: CSP, `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; pruebas de cabeceras.

- [ ] **SEC-024 - Retirar headers de desarrollo del bundle productivo.**
  - Estado: Riesgo condicionado; `frontend/src/api/client.ts` siempre lee `devUser` de localStorage y construye `x-dev-*`.
  - Cierre: compilar esa funcion solo en `import.meta.env.DEV`; backend ya tiene flag false en produccion.

- [ ] **SEC-025 - Revisar XSS en contenido persistido.**
  - Estado: Parcial. React escapa UI, pero correos HTML manuales no siempre.
  - Cierre: helper unico de plantillas, prohibir `dangerouslySetInnerHTML`, pruebas de payloads almacenados.

## CI/CD y operacion

- [ ] **SEC-026 - CI debe ejecutar tests, audit y build antes de desplegar.**
  - Estado: Falla.
  - Evidencia: workflow Static Web Apps ejecuta build/deploy, no suites; backend no tiene pipeline de CI/deploy versionado equivalente.
  - Cierre: jobs separados de test/audit/build; deploy solo tras aprobacion y artefacto inmutable.

- [ ] **SEC-027 - Actualizar/pinear GitHub Actions.**
  - Estado: Pendiente: `actions/checkout@v3`, `github-script@v6`, instalacion dinamica de paquetes de Actions.
  - Cierre: versiones soportadas, pin por SHA para acciones sensibles, permisos minimos.

- [ ] **SEC-028 - Endurecer `deploy-all.ps1`.**
  - Estado: Falla operativa.
  - Evidencia: `npm install`, opcion `SkipTests`, backend se despliega antes de completar toda validacion, y `git add .` puede incluir ZIP/configuraciones.
  - Cierre: `npm ci`, no permitir skip en prod, allowlist de archivos, build/test antes de cualquier deploy, checksum de ZIP, version/release y rollback automatico.

- [ ] **SEC-029 - No versionar ZIP de produccion.**
  - Estado: Falla: `api/api-deploy-full.zip` esta versionado y modificado.
  - Cierre: eliminar del indice Git, agregar `*.zip` o ruta a `.gitignore`, publicar como artefacto de release con retencion.

- [ ] **SEC-030 - SAST, secret scanning y SBOM.**
  - Estado: Ausente/no evidenciado.
  - Cierre: CodeQL/Semgrep, Gitleaks, GitHub secret scanning, SBOM CycloneDX/SPDX, firma/provenance del artefacto.

- [ ] **SEC-031 - Observabilidad y alertas de seguridad.**
  - Estado: Parcial; Application Insights existe, sin evidencia de alertas.
  - Cierre: alertas por login fallido, reset masivo, lectura de passwords, cambios de roles, fallos timers, correos anormales y errores 5xx.

- [ ] **SEC-032 - Plan de respuesta y recuperacion.**
  - Estado: Ausente/no probado.
  - Cierre: RTO/RPO, restore probado, rotacion de JWT/Cosmos/SMTP/SQL, runbook de incidente y responsables.

## Criterio de salida del checkpoint

Antes del cutover SQL deben estar cerrados todos los P0 y P1, existir pruebas HTTP de autorizacion y quedar `npm audit` sin vulnerabilidades high/critical aplicables a runtime o tooling de despliegue.
