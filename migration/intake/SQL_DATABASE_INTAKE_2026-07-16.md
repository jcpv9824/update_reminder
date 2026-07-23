# Intake de base SQL para Portal SAG Web

Fecha: 2026-07-16

Ambiente: **production (MVP)**; el login de migración se identifica como `SAGWebDev`

Fuente: captura de SSMS, confirmación del dueño del portal e intakes read-only ejecutados exitosamente el 2026-07-16. La segunda verificación se realizó mediante la sesión efímera de control, sin cambios SQL.

> No registrar passwords, connection strings, tokens ni valores de Key Vault.

## 1. Datos confirmados

| Campo | Resultado |
|---|---|
| Plataforma | Microsoft SQL Server 2019 Standard Edition (64-bit), Windows Server 2019 |
| Versión | `15.0.2170.1` (RTM-GDR, KB5090408) |
| Compatibility level | `150` |
| Endpoint preferido | `data14.sagerp.co,54103` |
| Instancia interna mostrada inicialmente | `DATA14\INS_D14_03`; produjo error de descubrimiento 26 desde el launcher |
| Base | `PortalSAGWeb` |
| Autenticación para migración | SQL Server Authentication |
| Login observado | `SAGWebDev`; la contraseña no se registra |
| Estado | Normal |
| Base de aplicación | Vacía; `user_table_count = 0`, confirmado por consulta SQL |
| Fecha de creación | 2026-07-15 15:00:52, según SSMS |
| Tamaño mostrado | 16.00 MB |
| Espacio disponible mostrado | 5.61 MB |
| Collation | `Modern_Spanish_CI_AS` |
| Recovery model | `FULL` |
| READ_COMMITTED_SNAPSHOT | `OFF` |
| ALLOW_SNAPSHOT_ISOLATION | `OFF` |
| TDE reportado por SQL | `is_encrypted = 0`; TDE no habilitado |
| TLS de cliente | Conexión exitosa con `Encrypt=True` y `TrustServerCertificate=False`; certificado validado |
| Archivo de datos | 8 MB, crecimiento 64 MB, `F:\DATA\INS_D14_03\PortalSAGWeb.mdf` |
| Archivo de log | 8 MB, crecimiento 64 MB, máximo mostrado 2 TB |
| Último backup mostrado | 2026-07-15 19:40:24 |
| Último log backup | Ninguno mostrado |
| Historial live de backups | 1 full, 0 differential, 0 transaction log; último full `2026-07-16T00:40:24Z`, sin checksum de backup |
| Query Store | `OFF`; límite configurado 1.000 MB si se habilita |
| Opciones de archivos | `AUTO_CLOSE OFF`, `AUTO_SHRINK OFF`, `PAGE_VERIFY CHECKSUM`, crecimiento fijo de 64 MB |
| Espacio data live | 8,00 MB asignados; 2,88 MB usados; 5,13 MB libres |
| Cuenta migradora | `SAGWebDev`, miembro de `db_owner`; puede crear tablas, schemas y procedures |
| Otros principals de usuario | `sa2`, también `db_owner`; cuenta del proveedor |
| Dueño | Identidad del proveedor visible en SSMS; valor omitido de este documento |

El valor “Number of Users: 6” mostrado por SSMS no implica seis registros de usuarios del portal. La base no tiene tablas de usuario y el intake identificó solo los principals SQL relevantes descritos arriba, además de principals internos.

## 2. Resultado del launcher read-only

La conexión mediante el nombre de instancia `DATA14\INS_D14_03` falló con error de descubrimiento 26. El endpoint del proveedor `data14.sagerp.co,54103` funcionó correctamente y debe ser el valor canónico.

Resultado:

- autenticación SQL: pass;
- cifrado TLS con validación de certificado: pass;
- acceso a la base correcta: pass;
- soporte `DATETIME2` y JSON: pass;
- base vacía/sin colisiones: pass;
- permisos DDL de la cuenta migradora: pass;
- snapshot isolation: action required;
- TDE/cifrado en reposo: action required o evidencia de cifrado de volumen;
- separación de cuenta runtime: action required.

## 3. Pendiente del proveedor

- Confirmar que `data14.sagerp.co,54103` es el endpoint estable para producción/ambiente asignado.
- Regla de firewall/VPN y allowlist para la Function App.
- Habilitar `READ_COMMITTED_SNAPSHOT` y `ALLOW_SNAPSHOT_ISOLATION` en una ventana aprobada.
- Habilitar TDE o documentar el cifrado de volumen equivalente y su recuperación de claves.
- Retención de backups, frecuencia de log backups, RPO, RTO y procedimiento de restore probado.
- Capacidad máxima y política de crecimiento.
- Crear una cuenta runtime separada y de mínimo privilegio; `SAGWebDev` se reserva para migraciones y no debe usarla la aplicación.
- Crear una cuenta read-only/reporting si se requiere operación o soporte.
- Blob Storage privado para formatos y descargas.
- Ambiente confirmado: production MVP. No existe una base separada de ensayo informada.
- No existe otra base con prefijo `PortalSAGWeb` visible para ensayo; la cuenta no dispone de metadata server-level suficiente para acreditar creación de bases.
- Verificación posterior: `SAGWebDev` puede ver bases, pero `CREATE ANY DATABASE = 0`, `dbcreator = 0` y `sysadmin = 0`; el proveedor debe crear/recrear la base de ensayo.
- La estación local tiene SQL Server 17.0 Evaluation detenido; no certifica el motor objetivo SQL Server 2019 y no sustituye el ensayo requerido.

## 4. Gate A

Estado: **PRODUCTION MVP COMPATIBLE CON ACCIONES MÍNIMAS — DDL aún no autorizado**.

| Criterio | Estado |
|---|---|
| Conexión SQL autenticada y cifrada | Pass; certificado validado sin bypass |
| Motor/compatibilidad soportados | Pass; el DDL se limitará a SQL Server 2019 / compatibility 150 |
| Collation aceptable | Pass |
| Base sin objetos de aplicación | Pass; cero tablas de usuario |
| READ_COMMITTED_SNAPSHOT | Action required |
| ALLOW_SNAPSHOT_ISOLATION | Action required |
| Cifrado en reposo | Action required; TDE aparece deshabilitado |
| Backup/PITR/restore | Parcial; existe full backup, no consta log backup ni política/restore |
| Conectividad desde Function App | Pendiente |
| Cuenta migradora con DDL | Pass; `SAGWebDev` es `db_owner` |
| Cuenta runtime de mínimo privilegio | Action required |
| Capacidad suficiente | Pendiente |
| Blob Storage | Pendiente |
| Credenciales fuera de archivos/repositorio | Pass por diseño del launcher |

Decisión arquitectónica: **Gate A condicional para production MVP; producción no está autorizada para el primer build**. El DDL versionado está certificado offline para SQL Server 2019, pero debe construirse y reconciliarse dos veces desde cero en bases desechables antes del primer cambio productivo. Después se exige backup/restore point reciente y aprobación explícita para producción. Antes de conectar la aplicación se exigen cuenta runtime mínima, conectividad Function App y política de log backup o decisión consciente de recovery model. El cifrado en reposo puede acreditarse mediante TDE o cifrado de volumen del proveedor, pero no se omite.
