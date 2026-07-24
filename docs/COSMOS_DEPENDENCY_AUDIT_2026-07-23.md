# Auditoría de dependencias Cosmos — 2026-07-23

## Dictamen

El runtime de Portal SAG Web queda implementado como SQL-only. No hay importaciones del SDK, adaptador de contenedores, fallback, lectura sombra ni escritura documental dentro de `api/src` fuera de pruebas negativas del selector. El almacenamiento de archivos se está desacoplando hacia S3/MinIO administrado por el proveedor y los secretos permanecen en Key Vault.

Estado operativo de este cambio: **listo para rehearsal**. La cuenta anterior no puede eliminarse todavía porque la ventana productiva de cero actividad termina como mínimo el `2026-07-30T22:26:43Z`.

## Cobertura revisada

| Área | Fuente operacional final | Escritura final | Evidencia principal |
|---|---|---|---|
| Usuarios, roles y permisos | SQL `security` | Repositorios SQL transaccionales | Login, perfiles, roles, setup y gestión de usuarios convertidos |
| Sesiones y refresh tokens | SQL `security` | Hashes y rotación atómica SQL | Ningún token en claro persistido |
| Rate limiting y lockout | SQL `security` | Consumo atómico SQL | Identificadores HMAC |
| Clientes, dominios y bases | SQL `core` | Servicios/cascadas SQL | Secretos de bases permanecen en Key Vault |
| Licencias y asignaciones | SQL `licensing` | Repositorios SQL | Validaciones y dependencias conservadas |
| Programaciones y alcance | SQL `scheduling` | Repositorios SQL | Alcance manual/licencias y recordatorios normalizados |
| Tareas y estados | SQL `workflow` | Transiciones y generación SQL | Idempotencia y consolidación preservadas |
| Alertas y correo | SQL `notification` | Outbox durable SQL | Envío directo bloqueado salvo mensaje reclamado |
| Configuración | SQL `settings` | Singleton SQL | Contraseña SMTP en Key Vault |
| Auditoría | SQL `audit` | Allowlist antes de insertar | Sin cuerpos, credenciales ni destinatarios |
| Descargas y videos | SQL `content` + Blob | Metadata SQL, bytes Blob | SAS privado de corta duración |
| Formatos de impresión | SQL `content` + Blob | Relación muchos-a-muchos y PDF Blob | Sin descripción de fuente |
| Reportes | SQL | Outbox SQL | Sin datos sensibles |
| Timers | SQL | Generación/outbox SQL | Seis timers sin fallback |

## Elementos eliminados del runtime

- Dependencia npm `@azure/cosmos`.
- `api/src/lib/cosmos.ts`.
- `api/src/lib/taskCleanup.ts`.
- Modos `cosmos` y `dual-read` del selector.
- Ramas condicionales documentales en endpoints y timers.
- Exportador, seed de descargas y saneador de auditoría basados en contenedores.
- Aprovisionamiento de una cuenta documental en `scripts/desplegar-azure.ps1`.
- Instrucciones de despliegue que configuraban la cadena anterior.

## Barreras contra regresión

`npm run check:no-cosmos-runtime` revisa:

- importación del SDK retirado;
- variables de conexión retiradas;
- modos de backend retirados;
- importación del adaptador retirado;
- dependencia npm retirada.

La validación ejecutada incluye:

- compilación TypeScript del API;
- 379 pruebas backend aprobadas;
- compilación del frontend;
- pruebas del frontend aprobadas;
- auditoría npm sin vulnerabilidades al retirar el SDK.

## Artefactos históricos que permanecen

`migration/backups`, `migration/work` y los importadores/validadores de migración conservan evidencia del traslado. No son cargados por la Function App, no forman parte del paquete publicado y no generan consumo de la cuenta. Deben archivarse cifrados e inmutables según la retención aprobada; no deben convertirse de nuevo en fuente operacional.

Los controladores antiguos de rollback hacia la base retirada deben archivarse después del segundo canary. El rollback vigente debe quedar limitado a:

1. restaurar el paquete SQL-only anterior;
2. restaurar App Settings exportados;
3. restaurar SQL desde backup si hay corrupción de datos;
4. recuperar versiones del bucket S3/MinIO si hay pérdida de archivos.

## Pasos pendientes antes de eliminar la cuenta

1. Crear un artefacto limpio y reproducible del API.
2. Exportar los App Settings actuales como evidencia, sin imprimir secretos.
3. Desplegar un segundo canary sin `COSMOS_CONNECTION_STRING` ni `COSMOS_DATABASE_NAME`.
4. Validar salud, autenticación, CRUD, tareas, correo, formatos, descargas y los seis timers.
5. Confirmar cero `5xx`, excepciones y actividad del servicio anterior.
6. Mantener cero actividad hasta `2026-07-30T22:26:43Z` como mínimo.
7. Generar y verificar el snapshot final cifrado.
8. Restaurar el backup SQL en QA y ejecutar integridad/smoke tests.
9. Verificar versionado/soft delete de Blob y recuperación de un archivo.
10. Rotar las claves del servicio anterior y observar que producción sigue sana.
11. Eliminar la cuenta en una operación separada y registrar el resultado.

## Elementos que no se deben eliminar

- SQL Server `PortalSAGWeb`.
- El bucket privado S3/MinIO del proveedor, una vez transferido y reconciliado.
- Azure Key Vault.
- Identidad administrada y sus permisos de Key Vault/Blob.
- Application Insights y alertas.
- Backups SQL y snapshots históricos cifrados durante su retención.
