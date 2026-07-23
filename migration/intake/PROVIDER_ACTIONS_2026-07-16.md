# Acciones requeridas al proveedor — PortalSAGWeb

Fecha: 2026-07-16

Base: `PortalSAGWeb`

Endpoint validado: `data14.sagerp.co,54103`

Este documento no contiene credenciales. No ejecutar cambios sin aprobación del dueño de la base y ventana acordada.

## Prioridad crítica antes del schema productivo

### 1. Ambiente confirmado

`PortalSAGWeb` es la base de **production para el MVP**. El intake live confirmó que no hay otra base `PortalSAGWeb*` visible para ensayo. El proveedor debe entregar dos bases desechables consecutivas —o una base que pueda recrearse dos veces— con SQL Server 2019, compatibility 150 y collation `Modern_Spanish_CI_AS`. Producción no será el primer build del schema ni el primer ensayo de carga.

La cuenta `SAGWebDev` no tiene `CREATE ANY DATABASE`, `dbcreator` ni `sysadmin`. Por tanto, Codex no puede aprovisionar esa base con el acceso actual; el proveedor debe crearla y mapear `SAGWebDev` como `db_owner` únicamente durante el ensayo.

### 2. Habilitar versionado de lectura

Estado observado:

```text
READ_COMMITTED_SNAPSHOT = OFF
ALLOW_SNAPSHOT_ISOLATION = OFF
```

Configuración requerida para reducir bloqueos y soportar transacciones de lectura consistentes:

```sql
ALTER DATABASE [PortalSAGWeb]
  SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;

ALTER DATABASE [PortalSAGWeb]
  SET ALLOW_SNAPSHOT_ISOLATION ON;
```

El proveedor debe ejecutar o aprobar estos comandos en una ventana controlada. `WITH ROLLBACK IMMEDIATE` puede terminar sesiones abiertas; no se ejecutará automáticamente desde Codex.

### 3. Cifrado en reposo

SQL reporta `is_encrypted = 0`, por lo que TDE no está habilitado. Solicitar una de estas evidencias:

- TDE habilitado con administración/backup de certificado y clave por el proveedor; o
- cifrado de volumen equivalente, alcance, custodia de claves y procedimiento de recuperación documentados.

El cifrado TLS en tránsito sí fue validado correctamente con verificación de certificado.

### 4. Backups y log

La base usa recovery model `FULL`. El historial live mostró exactamente 1 full backup, 0 differential y 0 log backups; el full no registra backup checksum. Confirmar:

- frecuencia de full, differential y transaction log backups;
- retención;
- RPO y RTO;
- monitoreo de fallos de backup;
- fecha y evidencia de un restore probado;
- alerta de crecimiento del log.

FULL sin log backups periódicos puede producir crecimiento continuo del archivo de log.

### 5. Separación de identidades

`SAGWebDev` es `db_owner`. Se acepta temporalmente como cuenta de migración/DDL, pero no como credencial runtime.

Solicitar:

- cuenta/identidad runtime sin `db_owner` y sin permisos de alterar schema;
- permisos DML solo sobre schemas del portal;
- auditoría/eventos con `INSERT` pero sin `UPDATE`/`DELETE`;
- cuenta read-only opcional para soporte/reportes;
- revocación o reducción de la cuenta migradora después del cutover.

### 6. Conectividad de Azure Functions

Confirmar:

- allowlist/firewall para las salidas de la Function App;
- DNS y acceso a `data14.sagerp.co:54103` desde Azure;
- límites de conexiones y timeouts;
- certificado TLS estable para ese FQDN.

## Requerido antes de migrar archivos

Provisionar Blob Storage privado o almacenamiento de objetos equivalente para extraer los Base64 de formatos de impresión y descargas públicas. Debe incluir cifrado, acceso por identidad/secret seguro, versionado, lifecycle, backup y restore.

## Capacidad

Los archivos actuales inician en 8 MB data + 8 MB log con crecimiento de 64 MB. Confirmar:

- cuota real de almacenamiento disponible;
- máximo del archivo de datos;
- espacio de volumen y alertas;
- política ante crecimiento de data/log;
- monitoreo de CPU, memoria, I/O, conexiones, bloqueos y queries lentas.

## Respuesta esperada

| Control | Respuesta del proveedor | Evidencia/fecha |
|---|---|---|
| Ambiente confirmado | Production MVP | 2026-07-16, dueño del portal |
| Snapshot isolation habilitado | | |
| Cifrado en reposo | | |
| Política de backup/log/restore | | |
| Cuenta runtime mínima | | |
| Conectividad Function App | | |
| Blob Storage | | |
| Capacidad/monitoreo | | |
