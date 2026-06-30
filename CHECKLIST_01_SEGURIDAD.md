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

La aplicacion tiene controles valiosos (hash de contrasenas, tokens de reset hasheados, Key Vault, auditoria sanitizada, permisos funcionales y pruebas). Los bypass SEC-001/SEC-002 y la exposicion SEC-003 fueron corregidos, pero las dependencias y otros controles de endurecimiento aun presentan brechas que deben resolverse antes del cutover SQL.

## Acciones inmediatas P0/P1

- [x] **SEC-001 - P0 - Deshabilitar la confianza directa en `x-ms-client-principal`.**
  - Estado: Corregido el 2026-06-27.
  - Implementacion: `api/src/lib/auth.ts` ya no lee ni interpreta `x-ms-client-principal`. En produccion solo acepta `Authorization: Bearer <JWT>` emitido por el login de la aplicacion.
  - Desarrollo: `x-dev-*` sigue disponible exclusivamente con `DEV_AUTH_ENABLED=true`; produccion mantiene el flag en false.
  - Pruebas: `api/src/tests/authSecurity.test.ts` falsifica un principal con rol admin y verifica `null/401`; tambien cubre JWT valido y el gating del modo desarrollo.

- [x] **SEC-002 - P0 - Aplicar autorizacion de objeto y minimizacion de respuesta en listados.**
  - Estado: Corregido el 2026-06-30.
  - Implementacion: `objectAuthorization.ts` aplica lectura global solo a admin/client_manager/viewer y limita actualizadores a clientes, dominios, bases y tareas asignados por maestro, usuario o rol. Los filtros son obligatorios en backend y no dependen de query params.
  - Minimizacion: `publicDtos.ts` elimina servidor, usuario SQL, `passwordSecretName`, actores internos, buckets, dedupe, sources y marcas de correo de respuestas generales. Los arboles de clientes/dominios tambien usan DTO de base sanitizado.
  - Pruebas: `objectAuthorization.test.ts` cubre BOLA/IDOR para todos los roles, objetos propios/ajenos y asignacion individual/por rol; `publicDtos.test.ts` verifica ausencia estructural de datos sensibles.

- [x] **SEC-003 - P1 - Restringir metadata de acceso de bases de datos.**
  - Estado: Corregido el 2026-06-30 junto con SEC-002.
  - Implementacion: `access-info`, `copy-access-part` y `reveal-password` comparten politica de objeto. Servidor/usuario solo se obtienen mediante accion explicita autorizada; la contrasena mantiene una politica mas restrictiva y auditoria.
  - Pruebas: `objectAuthorization.test.ts` cubre viewer, domain_updater, client_manager, database_updater por maestro/tarea, tarea ajena y target incorrecto.

- [x] **SEC-004 - P1 - Actualizar dependencias vulnerables y bloquear regresiones.**
  - Estado: Corregido el 2026-06-30.
  - Backend: `nodemailer@9.0.3`, `vitest@4.1.9`, `vite@8.1.1` transitivo y `form-data@4.0.6`. Se elimino `uuid@9`; los IDs usan `node:crypto.randomUUID()` para conservar CommonJS sin introducir UUID 14 ESM-only.
  - Frontend: `vite@8.1.1`, `vitest@4.1.9`, `react-router-dom/react-router@6.30.4`, `ws@8.21.0` y `form-data@4.0.6`.
  - Resultado: auditoria de produccion y auditoria total con umbral `moderate` reportan 0 vulnerabilidades en ambos proyectos.
  - Prevencion: el workflow ejecuta auditorias, pruebas y builds de backend/frontend antes de desplegar; `.github/dependabot.yml` revisa npm y GitHub Actions semanalmente.
  - SLA y excepciones: `SECURITY_DEPENDENCY_POLICY.md`.

- [x] **SEC-005 - P1 - Rate limiting, lockout y proteccion contra abuso.**
  - Estado: Corregido el 2026-06-30.
  - Implementacion: `api/src/lib/rateLimit.ts` usa contadores distribuidos en Cosmos (`securityRateLimits`, PK `/id`, TTL) con concurrencia optimista. Aplica limites combinados por IP e identidad a login, recuperacion/restablecimiento, setup, correos de prueba, reporte maestro y correos de credenciales.
  - Lockout: cinco fallos de login en 15 minutos bloquean durante 15 minutos; un login valido limpia el contador de fallos de la cuenta. Los limites restantes devuelven `429` y `Retry-After` con ventanas acordes al costo del endpoint.
  - Privacidad y observabilidad: IP, correo y token se convierten en HMAC; no se persiste ni registra el valor original. Cada bloqueo emite evento estructurado `rate_limit_exceeded` y auditoria `rate_limit_exceeded`/`account_lockout_triggered` para metricas y alertas.
  - Pruebas: `api/src/tests/rateLimit.test.ts` cubre umbrales, lockout, expiracion, independencia IP/identidad, reset, seudonimizacion y respuesta `429` con `Retry-After`.
  - Defensa adicional recomendada: mantener reglas de rate limit en Azure API Management o Front Door/WAF para absorber trafico antes de que alcance Functions; no reemplaza el control distribuido de aplicacion.

- [x] **SEC-006 - P1 - Endurecer sesiones JWT.**
  - Estado: Corregido el 2026-06-30.
  - Access token: JWT HS256 explicitamente permitido, secreto minimo de 32 bytes, expiracion predeterminada de 10 minutos y claims obligatorios `iss`, `aud`, `jti`, `sid` y `ver`.
  - Refresh: token opaco aleatorio de 256 bits, guardado solo como hash en `authSessions`, enviado mediante cookie `HttpOnly; Secure; SameSite=None` y rotado en cada uso. La reutilizacion del refresh anterior revoca su descendiente.
  - Frontend: el access token vive solo en memoria; al cargar elimina el JWT legado de `localStorage`. `fetch` usa credenciales y refresh/logout exigen `X-Requested-With` para forzar preflight CORS y reducir CSRF.
  - Revocacion: cada solicitud valida sesion y `tokenVersion`. Logout revoca la sesion; reset/cambio de contraseña, reenvio de credenciales y desactivacion incrementan version y revocan todas las sesiones del usuario.
  - Pruebas: `jwt.test.ts`, `authSessions.test.ts`, `authSecurity.test.ts` y `frontend/src/tests/ApiClient.test.ts` cubren claims, algoritmo, secreto, rotacion, replay, logout/revocacion, version, cookie y ausencia de JWT persistido.

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
