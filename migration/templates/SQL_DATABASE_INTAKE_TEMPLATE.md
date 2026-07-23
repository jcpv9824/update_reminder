# Intake de base SQL para Portal SAG Web

Fecha: YYYY-MM-DD

Ambiente: development / test / staging / production

Responsables presentes:

- Dueño del portal:
- DBA/proveedor:
- Responsable Azure:
- Arquitecto:

> No registrar passwords, connection strings, tokens ni valores de Key Vault.

## 1. Identificación

| Campo | Resultado |
|---|---|
| Plataforma | Azure SQL / SQL Server |
| Servidor lógico | |
| Base | |
| Versión/edition | |
| Compatibility level | |
| Collation | |
| Base vacía | Sí / No |
| Objetos preexistentes | |

## 2. Conectividad y autenticación

| Control | Resultado / evidencia no secreta |
|---|---|
| TLS obligatorio | |
| Cifrado en reposo | |
| Private endpoint/firewall | |
| Conexión desde estación migradora | |
| Conexión desde Function App | |
| Método runtime | Managed Identity / Entra / SQL login |
| Método migrador | |
| Cuenta read-only | |

## 3. Configuración y capacidad

| Control | Resultado |
|---|---|
| READ_COMMITTED_SNAPSHOT | |
| ALLOW_SNAPSHOT_ISOLATION | |
| Recovery/PITR | |
| Retención backup | |
| Restore probado/fecha | |
| Tamaño/tier actual | |
| Máximo/crecimiento | |
| CPU/conexiones/storage monitoreados | |
| RPO | |
| RTO | |

## 4. Objetos existentes

Adjuntar salida sanitizada de `migration/sql/000_database_intake_readonly.sql`.

| Objeto/schema | Clasificación: portal/compartido/ajeno/desconocido | Decisión |
|---|---|---|
| | | |

No continuar si existe un objeto `desconocido` que pueda colisionar con los schemas objetivo.

## 5. Blob Storage

| Campo | Resultado |
|---|---|
| Cuenta/container disponible | |
| Acceso privado | |
| Identidad administrada | |
| Versionado | |
| Lifecycle/retención | |
| Backup/restore | |

## 6. Gate A

| Criterio | Pass/Fail | Evidencia/acción |
|---|---|---|
| Motor y compatibilidad soportados | | |
| Collation/texto español aceptable | | |
| Snapshot isolation disponible | | |
| Backup/PITR/restore confirmados | | |
| Conectividad workstation + Function App | | |
| Cuentas/permisos separados | | |
| Sin colisiones de objetos | | |
| Capacidad suficiente | | |
| Estrategia Blob aprobada | | |
| Credenciales fuera de documentos/repositorio | | |

Decisión: **ACEPTADA / RECHAZADA / ACEPTADA CON ACCIONES**

Acciones pendientes:

1.

Aprobaciones:

- Dueño del portal / fecha:
- DBA/proveedor / fecha:
- Arquitecto / fecha:
