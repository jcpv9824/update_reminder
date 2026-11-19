# Qué hay de nuevo · Modelo de datos

> Histórico de diseño: para la implementación vigente prevalece [11_CONTRATO_IMPLEMENTACION.md](11_CONTRATO_IMPLEMENTACION.md). Migraciones reservadas 052–055, no aplicadas. No hay menú de referencia ni reasignación del desarrollador. Rondas/checklist/hallazgos/bitácora son relaciones SQL; JSON solo para documentos enriquecidos y snapshots inmutables de revisión.

Estado: **diseño, sin construir**. No autoriza aplicar migraciones en QA ni en producción.
Motor: SQL Server 2019, nivel de compatibilidad 150, intercalación `Modern_Spanish_CI_AS`, base `PortalSAGWeb` o `PortalSAGWeb-TEST`.
Fuentes: `01_DISENO_FUNCIONAL.md`, `02_HUECOS_DE_LOGICA.md` (incluye las resoluciones QA-01 a QA-27), `migration/sql/003`, `005`, `007`, `024` a `030` y `docs/SQL_SERVER_PHYSICAL_DATA_DICTIONARY.md`.

Las decisiones que no están en la especificación están marcadas como **Decisión propuesta**.

## 1. Principios

| Regla | Cómo se cumple |
|---|---|
| Sin bytes ni secretos en SQL | Los archivos van a SeaweedFS. SQL guarda el localizador en `content.files`, más el tipo, el tamaño y el SHA-256 (`BINARY(32)`). No guarda URL firmadas, llaves ni contraseñas. |
| Solo SeaweedFS | Las filas propias del módulo exigen `storage_provider = 's3'`, que es el valor histórico de SeaweedFS en SQL (ver `ARCHITECTURE.md`). El servicio rechaza escribir si `OBJECT_STORAGE_PROVIDER <> 'seaweedfs'`. |
| Historia solo de inserción | Revisiones publicadas, notas, hallazgos, anulaciones, eventos de estado, reasignaciones y auditoría: disparador `AFTER UPDATE, DELETE` que lanza `THROW`, más `DENY UPDATE, DELETE` a `portal_runtime`. Una ronda cerrada y su checklist quedan inmutables por disparador. |
| Concurrencia optimista | Toda tabla editable tiene `row_version ROWVERSION`. La API la publica como `ETag` (base64 de 8 bytes, igual que `guideBuilder.decodeIfMatch`) y exige `If-Match`. |
| Identidad | Clave interna `BIGINT IDENTITY` para relaciones. Para la API, `source_id` (UUID en minúsculas, generado por la API). El enlace público usa un **GUID aleatorio distinto** (`NEWID()`, QA-23); nunca el número secuencial ni el `source_id`. |
| Trazabilidad | `created_at`, `created_by`, `updated_at` y `updated_by` como en el diccionario físico: `DATETIME2(3)` UTC y el snapshot `NVARCHAR(150)` con el `source_id` del usuario. Además, `*_user_key` con FK cuando la regla de negocio depende del usuario (autor, quien tiene la ronda, etc.). |
| FK | Todas `NO ACTION`. No hay cascadas; los borrados lógicos los hace el servicio en una transacción. |
| Fechas de mes | Se guardan en UTC. Los filtros «mes y año» y la fecha de liberación se calculan en **America/Bogota** (UTC−5, sin horario de verano; en SQL Server, `'SA Pacific Standard Time'`). El servicio convierte el mes a un rango UTC `[inicio, fin)` y consulta por rango, que sí usa índices (QA-24). |

## 2. Esquema

**Decisión propuesta: esquema nuevo `whats_new`.** No se reutiliza `content` por tres razones:

1. **Dominio acotado.** Son unas 20 tablas con su propia máquina de estados. En `content` se mezclarían con formatos, descargas y el constructor de guías.
2. **Permisos.** `007` concede permisos por esquema. Con un esquema propio, las concesiones y los `DENY` de historia se dan sin tocar `content`.
3. **Retiro.** Un esquema propio se puede retirar o archivar sin afectar a los demás.

Los **bytes** sí se registran en `content.files`: el ciclo existente de reclamos de borrado (`content.object_deletion_claims`) solo protege los objetos que tienen fila en `content.files`. El área de usuario va en `security`, porque es una propiedad del usuario y no de este módulo.

## 3. Área de negocio del usuario (`security`)

### 3.1 `security.business_areas` (catálogo)

| Columna | Tipo | Regla |
|---|---|---|
| `area_code` | `VARCHAR(20)` | PK. `CHECK IN ('soporte','desarrollo','ventas','administrativa')` |
| `label` | `NVARCHAR(80)` | Soporte, Desarrollo, Ventas, Administrativa |
| `sort_order` | `SMALLINT` | `UNIQUE` |
| `active` | `BIT` | Por defecto 1 |

La migración llena las cuatro filas iniciales. Ampliar el catálogo exige una migración, porque el `CHECK` es cerrado.

### 3.2 `security.user_business_areas` (multivalor)

| Columna | Tipo | Regla |
|---|---|---|
| `user_key` | `BIGINT` | FK `security.users` |
| `area_code` | `VARCHAR(20)` | FK `security.business_areas` |
| `assigned_at` | `DATETIME2(3)` | Por defecto `SYSUTCDATETIME()` |
| `assigned_by` | `NVARCHAR(150)` | `source_id` del actor |

- PK `(user_key, area_code)`.
- Índice `IX_user_business_areas_area (area_code, user_key)`, para «usuarios activos con área Soporte».
- Para cambiar las áreas, el servicio borra e inserta en la misma transacción que la auditoría `user_business_areas_updated`, con `before` y `after` como arreglos de códigos. La tabla es el estado vigente; la historia queda en `audit.audit_logs`, que ya es solo de inserción.

## 4. Configuración del módulo (`whats_new`)

### 4.1 `whats_new.settings` (fila única)

| Columna | Tipo | Regla |
|---|---|---|
| `settings_key` | `TINYINT` | PK. `CHECK (settings_key = 1)` |
| `public_enabled` | `BIT` | Interruptor «Publicación activa». Por defecto **0**. |
| `updated_at`, `updated_by` | | |
| `row_version` | `ROWVERSION` | |

### 4.2 `whats_new.action_catalog` (acciones requeridas predefinidas)

| Columna | Tipo | Regla |
|---|---|---|
| `action_catalog_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE` |
| `code` | `VARCHAR(40)` | `UNIQUE`. Iniciales: `leer_reglas`, `dar_permiso`, `probar_opciones`, `otro` |
| `label` | `NVARCHAR(120)` | Obligatorio, sin espacios a los lados |
| `label_normalized` | `NVARCHAR(120)` | Minúsculas y sin tildes. Índice único filtrado `WHERE active = 1` |
| `sort_order` | `SMALLINT` | `CHECK BETWEEN 1 AND 999` |
| `active` | `BIT` | |
| `is_other` | `BIT` | Marca «Otro». Índice único filtrado `(is_other) WHERE is_other = 1` |
| `created_*`, `updated_*`, `row_version` | | |

- Siempre debe quedar **al menos una acción activa** (QA-18). Lo valida el servicio con bloqueo `UPDLOCK, HOLDLOCK` sobre el catálogo dentro de la transacción. Lo comprueba también un disparador `TR_action_catalog_keep_one_active`, que lanza `THROW 53310` si tras el cambio no queda ninguna.
- No se borran filas; se desactivan. Las entradas guardan una copia del nombre (sección 6.4), así que cambiar el nombre aquí no altera la historia.

### 4.3 Menú de referencia: `whats_new.menu_versions`

| Columna | Tipo | Regla |
|---|---|---|
| `menu_version_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE` |
| `system_code` | `VARCHAR(20)` | `CHECK IN ('sag_web','sag_clasico')` |
| `version_no` | `INT` | `UNIQUE (system_code, version_no)`; 1, 2, 3… por sistema |
| `status` | `VARCHAR(20)` | `CHECK IN ('previa','activa','inactiva','descartada')` |
| `original_file_key` | `BIGINT` | FK `content.files`; el libro cargado, guardado en SeaweedFS |
| `original_name` | `NVARCHAR(260)` | |
| `sheet_name` | `NVARCHAR(100)` | Siempre `Menú Final` |
| `node_count` | `INT` | `CHECK > 0` |
| `max_level` | `TINYINT` | `CHECK BETWEEN 1 AND 4` |
| `warnings_json` | `NVARCHAR(MAX)` | `ISJSON`. Filas omitidas, con número de fila y código de motivo; sin el texto de las celdas |
| `uploaded_by_user_key`, `uploaded_at` | | |
| `activated_at`, `activated_by_user_key` | | Última activación |
| `row_version` | `ROWVERSION` | |

- Índice único filtrado `UX_menu_versions_one_active (system_code) WHERE status = 'activa'`: hay **una sola versión activa por sistema**.
- Ciclo: `previa` → `activa` → `inactiva` → `activa` (se puede **reactivar** una versión anterior, QA-19). `previa` → `descartada`. Las versiones no se borran porque las rutas guardadas apuntan a sus nodos.
- Activar una versión deja la activa anterior en `inactiva` y **recalcula la marca «fuera del menú»** de las rutas de entradas no archivadas del mismo sistema (QA-20, sección 6.3), todo en una sola transacción.

### 4.4 `whats_new.menu_nodes`

Son inmutables: se insertan al cargar la versión y nunca se actualizan.

| Columna | Tipo | Regla |
|---|---|---|
| `menu_node_key` | `BIGINT IDENTITY` | PK |
| `menu_version_key` | `BIGINT` | FK |
| `menu_code` | `NVARCHAR(40)` | Columna B «Cod.». `UNIQUE (menu_version_key, menu_code)` |
| `parent_code` | `NVARCHAR(40)` | Columna G «Padre»; `NULL` si es `00` |
| `parent_node_key` | `BIGINT NULL` | FK a sí misma, resuelta después de insertar |
| `level_no` | `TINYINT` | Columna D «Nivel». `CHECK BETWEEN 1 AND 4` |
| `via_code` | `VARCHAR(20)` | Columna M «Ubicacion»: `NavBar` → `navbar`, `SideBar` → `sidebar`. `CHECK IN ('navbar','sidebar','menu_principal')` |
| `label` | `NVARCHAR(120)` | Columna C, recortada y con espacios normalizados (sin `NBSP`) |
| `label_normalized` | `NVARCHAR(120)` | Minúsculas y sin tildes |
| `is_last_level` | `BIT` | Columna E «ult.» = `S` |
| `developed` | `BIT` | Columna A «Desarrollada» = `S` |
| `sort_order` | `INT` | Columna F «Orden» |
| `path_text` | `NVARCHAR(1200)` | `Barra lateral › Ventas › Facturas › Factura de venta` |
| `path_normalized` | `NVARCHAR(1200)` | Para recalcular «fuera del menú» |
| `path_hash` | `BINARY(32)` | SHA-256 de `path_normalized`; clave del índice de coincidencia |

- Índices:
  - `IX_menu_nodes_children (menu_version_key, parent_node_key, sort_order) INCLUDE (label, level_no, is_last_level, menu_code)`, para las sugerencias por nivel;
  - `IX_menu_nodes_path (menu_version_key, path_normalized)`; como `path_normalized` mide hasta 1200 caracteres (2400 bytes, por encima del límite de 1700 bytes de una clave no agrupada), la clave real es `path_hash BINARY(32)` (SHA-256 de `path_normalized`), con `path_normalized` en `INCLUDE`.
- **Formato exacto de la hoja «Menú Final»** (QA-20), verificado con `Menu Sag Web.xlsx`: 298 filas con encabezado, columnas A a S, niveles 1 a 4 y ubicaciones `NavBar` y `SideBar`. El analizador lee solo:

| Columna | Encabezado esperado (sin tildes, espacios ni mayúsculas) | Uso |
|---|---|---|
| A | `desarrollada` | `developed` |
| B | `cod.` | `menu_code` (obligatorio y único) |
| C | `descripcion` | `label` (obligatorio, máximo `L_SEG` = 120 caracteres) |
| D | `nivel` | `level_no` (1 a 4) |
| E | `ult.` | `is_last_level` |
| F | `orden` | `sort_order` |
| G | `padre` | `parent_code` (`00` = raíz) |
| M | `ubicacion` | `via_code` (solo en el nivel 1; los niveles siguientes heredan la del padre) |

  - Las columnas H a L y N a S (módulos, controlador y scripts) **se ignoran**: no se guardan.
  - El encabezado se valida por posición **y** por nombre normalizado.
  - Las celdas con fórmula se leen por su valor en caché (`<v>`), nunca por la fórmula.
  - Son **errores** que impiden cargar el libro: un código duplicado, un padre inexistente, un nivel distinto de padre + 1, un ciclo, un nivel 1 sin ubicación válida o una descripción vacía.
  - Una fila completamente vacía se omite y se anota como advertencia.

## 5. Máquina de estados de la entrada

Estados en `whats_new.entries.status`: `borrador`, `sin_probar`, `en_pruebas`, `fallida`, `probado`, `archivada` y `eliminada`. El último es el borrado lógico de un borrador, H-16; no aparece en ninguna lista.

| Desde | Acción (endpoint `04`) | Hacia | Quién | Condiciones del servidor |
|---|---|---|---|---|
| — | Crear | `borrador` | Autor (`author` y área Desarrollo) | |
| `borrador` | Guardar borrador o autoguardado | `borrador` | Autor dueño | Solo el tamaño del contenido |
| `borrador` | Publicar a Soporte | `sin_probar` | Autor dueño | Validación completa: tipo; sistema; de 1 a 10 rutas válidas y no repetidas; Qué cambió no vacío; al menos una acción con detalle; en Nuevo, cliente (texto o referencia) y asesor activo con área Soporte (QA-05). Crea la revisión 1. |
| `borrador` | Eliminar | `eliminada` | Autor dueño o `manage` | Los archivos quedan sin referencia (ver `05`) |
| `sin_probar` | Corregir | `sin_probar` | Autor dueño | Nota de corrección obligatoria. Crea la revisión n+1. Solo cambian Qué cambió y las acciones (QA-06). |
| `sin_probar` | Tomar | `en_pruebas` | `test` y área Soporte | No figura en `entry_contributors` (QA-04). Crea la ronda en estado `tomada`, con su checklist en blanco a partir de la revisión vigente. |
| `en_pruebas` | Soltar | `sin_probar` | Quien tiene la ronda | La ronda se cierra como `soltada` |
| `en_pruebas` | Forzar Soltar | `sin_probar` | `configuration.whats_new.manage` | Motivo obligatorio (QA-08). La ronda se cierra como `soltada`, con `close_reason = 'forzada'`. |
| `en_pruebas` | Marcar probado | `probado` | Quien tiene la ronda | Checklist **de la ronda actual** completo (QA-11). Si «Mostrar a clientes» está activo: título y texto no vacíos y, en Nuevo, «Disponible para todos los clientes» marcado. Fija `tested_at`. |
| `en_pruebas` | Marcar fallida | `fallida` | Quien tiene la ronda | Al menos un hallazgo **no anulado de la ronda actual** (QA-11, QA-26) |
| `fallida` | Corregir y volver a publicar | `sin_probar` | Autor dueño | Igual que «Corregir». La siguiente toma abre una ronda nueva. |
| `probado` | Archivar | `archivada` | `manage` | Motivo obligatorio. Sale de la página pública y sigue en los reportes (QA-10). |
| cualquiera salvo `eliminada` | Reasignar autor | igual | `manage` | Motivo obligatorio. El nuevo autor debe estar activo y tener `author` y área Desarrollo (QA-07). El autor anterior **sigue** en `entry_contributors`. |

- Cualquier otro par (estado, acción) devuelve `409 estado_no_permite_accion` sin efectos.
- Cada transición es **una sola transacción SQL** que hace lo siguiente:
  1. bloquea la entrada con `UPDLOCK, ROWLOCK` y compara `row_version`;
  2. actualiza la entrada y la ronda;
  3. inserta `entry_status_events`;
  4. escribe `audit.audit_logs`;
  5. registra la llave de idempotencia.

**Interpretación del diagrama de `01` §5.2:** «Corregir y volver a publicar» desde `fallida` lleva a `sin_probar`, no a `borrador`. Así lo dice el texto de 4.4 («la entrada pasa a `sin_probar`»), aunque la flecha del dibujo apunta a la columna de `borrador`.

## 6. Entradas

### 6.1 `whats_new.entries`

| Columna | Tipo | Regla |
|---|---|---|
| `entry_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE`. UUID; es el `<entry_id>` de la clave de objeto |
| `entry_number` | `INT` | `UNIQUE`. `DEFAULT NEXT VALUE FOR whats_new.entry_number_seq`; se muestra como `QHN-000123` |
| `status` | `VARCHAR(20)` | `CHECK IN` (los siete estados de la sección 5) |
| `entry_type` | `VARCHAR(20) NULL` | `CHECK IN ('nuevo','mejora','regla_negocio','sp_critico','rediseno')` |
| `system_code` | `VARCHAR(20) NULL` | `CHECK IN ('sag_web','sag_clasico')` |
| `what_changed_json` | `NVARCHAR(MAX) NULL` | `CHECK (ISJSON = 1)`, perfil `medio` de `05` |
| `what_changed_text` | `NVARCHAR(MAX) NULL` | Texto plano extraído (`05` §9) |
| `what_changed_summary` | `NVARCHAR(300) NULL` | Primera línea, para la lista |
| `route_search_text` | `NVARCHAR(2000) NULL` | Rutas concatenadas y normalizadas, para la búsqueda |
| `client_key` | `BIGINT NULL` | FK `core.clients`. Hoy siempre `NULL` (no hay fuente, H-12) |
| `client_name_text` | `NVARCHAR(200) NULL` | Cliente escrito a mano (H-12). **Nunca sale en la API pública.** |
| `initial_tester_user_key` | `BIGINT NULL` | FK `security.users`. Asesor a cargo, con prioridad pero sin exclusividad (QA-02) |
| `author_user_key` | `BIGINT` | FK. Autor vigente (reasignable, QA-07) |
| `current_revision_no` | `INT` | Por defecto 0; aumenta al publicar y al corregir |
| `last_finding_no` | `INT` | Por defecto 0; da el número consecutivo del hallazgo |
| `open_findings_count` | `INT` | Hallazgos no anulados, para «2 hallazgos» |
| `first_published_at`, `last_published_at` | `DATETIME2(3) NULL` | |
| `tested_at` | `DATETIME2(3) NULL` | Fecha de liberación (H-08), que se muestra como mes y año en Bogotá |
| `released_in` | `NVARCHAR(80) NULL` | Reservado para «Liberada en», si se confirma H-08. Hoy no se usa. |
| `archived_at`, `archived_by` | | |
| `deleted_at`, `deleted_by` | | |
| `created_*`, `updated_*`, `row_version` | | |

Restricciones:

- `CK_entries_complete`: `status IN ('borrador','eliminada') OR (entry_type IS NOT NULL AND system_code IS NOT NULL AND what_changed_json IS NOT NULL AND current_revision_no >= 1 AND first_published_at IS NOT NULL)`.
- `CK_entries_nuevo_fields`: `entry_type = 'nuevo' OR entry_type IS NULL OR (client_key IS NULL AND client_name_text IS NULL AND initial_tester_user_key IS NULL)`.
- `CK_entries_nuevo_publish`: `entry_type <> 'nuevo' OR status IN ('borrador','eliminada') OR ((client_key IS NOT NULL OR client_name_text IS NOT NULL) AND initial_tester_user_key IS NOT NULL)`.
- `CK_entries_tested`: `(status IN ('probado','archivada')) = (tested_at IS NOT NULL)`, escrita como `CASE`.
- `CK_entries_archived`: `(status = 'archivada' AND archived_at IS NOT NULL) OR (status <> 'archivada' AND archived_at IS NULL)`.
- `CK_entries_deleted`: lo mismo con `eliminada` y `deleted_at`.
- `CK_entries_counts`: `current_revision_no >= 0 AND last_finding_no >= 0 AND open_findings_count BETWEEN 0 AND last_finding_no`.
- `CK_entries_json_size`: `what_changed_json IS NULL OR DATALENGTH(what_changed_json) <= 2 * L_QC` (`L_QC` = 200 000 caracteres; ver `05`).

Secuencia: `CREATE SEQUENCE whats_new.entry_number_seq AS INT START WITH 1 INCREMENT BY 1 NO CYCLE CACHE 20`. Puede haber saltos tras un reinicio; el número es solo una referencia legible.

### 6.2 `whats_new.entry_contributors`

Personas que **no pueden probar** la entrada (QA-04): quien la creó, quien guardó un borrador, quien la publicó, quien la corrigió y quien fue autor por reasignación.

| Columna | Tipo | Regla |
|---|---|---|
| `entry_key` | `BIGINT` | FK |
| `user_key` | `BIGINT` | FK |
| `first_contribution` | `VARCHAR(20)` | `CHECK IN ('creo','edito','publico','corrigio','autor_asignado')` |
| `first_at` | `DATETIME2(3)` | |

- PK `(entry_key, user_key)`. Solo se inserta, con `IF NOT EXISTS`; nunca se borra.
- Tomar comprueba `NOT EXISTS (… WHERE entry_key = @e AND user_key = @actor)`.

### 6.3 Rutas: `whats_new.entry_routes` y `whats_new.entry_route_levels`

`entry_routes`:

| Columna | Tipo | Regla |
|---|---|---|
| `entry_route_key` | `BIGINT IDENTITY` | PK |
| `entry_key` | `BIGINT` | FK |
| `route_no` | `TINYINT` | `CHECK BETWEEN 1 AND 10` (`L_RUTAS` = 10 rutas en total, QA-12). `UNIQUE (entry_key, route_no)`. La ruta 1 es la principal. |
| `level_count` | `TINYINT` | `CHECK BETWEEN 3 AND 5` (vía, al menos un submenú y la opción) |
| `display_text` | `NVARCHAR(1200)` | Niveles unidos con « › » |
| `route_hash` | `BINARY(32)` | SHA-256 de los niveles en minúsculas y sin tildes. `UNIQUE (entry_key, route_hash)`: no puede haber dos rutas idénticas (QA-12). |
| `out_of_active_menu` | `BIT` | Se recalcula al guardar y al activar una versión del menú (QA-20) |
| `created_*`, `updated_*` | | |

`entry_route_levels`:

| Columna | Tipo | Regla |
|---|---|---|
| `entry_route_key` | `BIGINT` | FK |
| `level_no` | `TINYINT` | `CHECK BETWEEN 1 AND 5`. PK `(entry_route_key, level_no)` |
| `level_kind` | `VARCHAR(10)` | `CHECK IN ('via','submenu','opcion')` |
| `via_code` | `VARCHAR(20) NULL` | `CHECK IN ('sidebar','navbar','menu_principal')` |
| `label` | `NVARCHAR(120)` | `L_SEG` = 120. Sin `›`, `<` ni `>`, y sin caracteres de control (lo valida zod; el `CHECK` rechaza `›`) |
| `is_free_text` | `BIT` | Escrito con «Otro…» (H-13). No cambia después. |
| `menu_node_key` | `BIGINT NULL` | FK `menu_nodes`: el nodo elegido de la sugerencia |
| `matched_menu_node_key` | `BIGINT NULL` | FK `menu_nodes`: coincidencia en la versión activa, recalculada |

- `CK_route_levels_kind`:
  - `(level_no = 1 AND level_kind = 'via' AND via_code IS NOT NULL AND menu_node_key IS NULL AND is_free_text = 0)`, o bien
  - `(level_no > 1 AND level_kind IN ('submenu','opcion') AND via_code IS NULL AND (is_free_text = 1 OR menu_node_key IS NOT NULL))`.
- Que el **último** nivel sea `opcion` y los intermedios `submenu` no se puede expresar en un `CHECK` de fila. Lo comprueba el servicio antes de confirmar y lo verifica una consulta de postcondición en las pruebas de repositorio.
- Para SAG Web, el nivel 1 es `sidebar` o `navbar`; para SAG Clásico, `menu_principal` (H-07). Lo valida el servicio, porque depende de `entries.system_code`.
- Recalcular «fuera del menú»: para cada ruta, se arma `path_normalized` a partir de los niveles y se busca en `menu_nodes` de la versión activa del sistema por `path_hash`. Si existe, `out_of_active_menu = 0` y `matched_menu_node_key` apunta al nodo; si no, queda en 1.
- Las rutas solo se editan en `borrador`. Después de publicar quedan fijas: la corrección no las cambia.

### 6.4 `whats_new.entry_required_actions` (estado vigente)

| Columna | Tipo | Regla |
|---|---|---|
| `entry_required_action_key` | `BIGINT IDENTITY` | PK |
| `entry_key` | `BIGINT` | FK |
| `ordinal` | `TINYINT` | `CHECK BETWEEN 1 AND 10`. `UNIQUE (entry_key, ordinal)` |
| `action_catalog_key` | `BIGINT` | FK `action_catalog`. `UNIQUE (entry_key, action_catalog_key)` |
| `label_snapshot` | `NVARCHAR(120)` | Copia del nombre al guardar o publicar (QA-18) |
| `detail_json` | `NVARCHAR(MAX) NULL` | `ISJSON`, perfil `compacto`, `DATALENGTH <= 2 * L_ACC` |
| `detail_text` | `NVARCHAR(4000) NULL` | |
| `created_*`, `updated_*` | | |

Se reemplaza como conjunto (borrar e insertar) solo en `borrador` y al corregir. La copia histórica queda en la revisión (6.5).

### 6.5 `whats_new.entry_revisions` (solo inserción)

Cada **Publicar** o **Corregir** inserta una revisión. Es la fuente de la historia («la historia anterior se conserva») y del checklist de cada ronda.

| Columna | Tipo | Regla |
|---|---|---|
| `entry_revision_key` | `BIGINT IDENTITY` | PK |
| `entry_key` | `BIGINT` | FK |
| `revision_no` | `INT` | `CHECK >= 1`. `UNIQUE (entry_key, revision_no)` |
| `revision_kind` | `VARCHAR(20)` | `CHECK IN ('publicacion','correccion')` |
| `what_changed_json`, `what_changed_text` | | Copia |
| `required_actions_json` | `NVARCHAR(MAX)` | `ISJSON`. Arreglo `[{ordinal, actionCode, label, detailJson, detailText}]`, con la copia del nombre |
| `routes_json` | `NVARCHAR(MAX)` | `ISJSON`. Rutas tal como estaban, solo en la revisión 1 |
| `correction_note_json`, `correction_note_text` | `NULL` | Obligatorio si `revision_kind = 'correccion'` (`CHECK`) |
| `published_at` | `DATETIME2(3)` | |
| `published_by_user_key` | `BIGINT` | FK |

Disparador `TR_entry_revisions_append_only` (`THROW 53320`) y `DENY UPDATE, DELETE`.

### 6.6 Adjuntos: `whats_new.entry_attachments`

Listas «Documento de reglas de negocio» y «Video de la entrega» (solo en Nuevo).

| Columna | Tipo | Regla |
|---|---|---|
| `entry_attachment_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE` |
| `entry_key` | `BIGINT` | FK |
| `attachment_group` | `VARCHAR(20)` | `CHECK IN ('reglas_negocio','video')` |
| `item_kind` | `VARCHAR(10)` | `CHECK IN ('archivo','enlace')` |
| `entry_file_key` | `BIGINT NULL` | FK `entry_files`. Obligatorio si es `archivo` |
| `link_url` | `NVARCHAR(2000) NULL` | Obligatorio si es `enlace`. `CHECK (link_url LIKE N'https://%')` |
| `link_label` | `NVARCHAR(200) NULL` | |
| `ordinal` | `TINYINT` | `CHECK BETWEEN 1 AND 10` (`L_ADJ` = 10 por lista) |
| `status` | `VARCHAR(10)` | `CHECK IN ('activo','retirado')` |
| `removed_at`, `removed_by` | | |
| `created_*`, `updated_*`, `row_version` | | |

- `CK_attachments_kind`: `(item_kind = 'archivo' AND entry_file_key IS NOT NULL AND link_url IS NULL) OR (item_kind = 'enlace' AND entry_file_key IS NULL AND link_url IS NOT NULL)`.
- Índice único filtrado `(entry_key, attachment_group, ordinal) WHERE status = 'activo'`.
- Se editan solo en `borrador`. **Decisión propuesta:** al corregir no se cambian adjuntos, para respetar QA-06.

### 6.7 Archivos del módulo: `whats_new.entry_files`

Una fila por objeto que se carga a SeaweedFS para una entrada: imágenes y adjuntos del editor, reglas de negocio, video e imágenes del texto para clientes.

| Columna | Tipo | Regla |
|---|---|---|
| `entry_file_key` | `BIGINT IDENTITY` | PK |
| `public_id` | `UNIQUEIDENTIFIER` | `UNIQUE`, `DEFAULT NEWID()`. Es el `fileId` del texto enriquecido y de las URL |
| `entry_key` | `BIGINT` | FK |
| `purpose` | `VARCHAR(30)` | `CHECK IN ('editor_imagen','editor_adjunto','reglas_negocio','video','cliente_imagen')` |
| `kind` | `VARCHAR(10)` | `CHECK IN ('imagen','documento','video')` |
| `original_name` | `NVARCHAR(260)` | Saneado (ver `05`) |
| `declared_mime_type` | `NVARCHAR(160)` | De la lista permitida |
| `declared_byte_count` | `BIGINT` | `CHECK > 0 AND <= 100000000` |
| `declared_sha256` | `BINARY(32)` | |
| `storage_provider` | `VARCHAR(30)` | `CHECK (storage_provider = 's3')`. Solo SeaweedFS |
| `storage_bucket` | `NVARCHAR(255)` | |
| `object_key` | `NVARCHAR(1024)` | Generado por el servidor. `UNIQUE (storage_bucket, object_key)` |
| `upload_status` | `VARCHAR(20)` | `CHECK IN ('pendiente','lista','rechazada','vencida','huerfana')` |
| `upload_expires_at` | `DATETIME2(3)` | Vencimiento de la URL de escritura |
| `rejection_code` | `VARCHAR(40) NULL` | Por ejemplo, `sha256_no_coincide` |
| `file_key` | `BIGINT NULL` | FK `content.files`. Obligatorio si está `lista` |
| `copied_from_entry_file_key` | `BIGINT NULL` | FK a sí misma: imagen copiada al texto para clientes (QA-13) |
| `uploaded_by_user_key` | `BIGINT` | FK |
| `authorize_idempotency_key` | `NVARCHAR(200)` | `UNIQUE (uploaded_by_user_key, authorize_idempotency_key)` |
| `created_at`, `completed_at`, `row_version` | | |

- `CK_entry_files_ready`: `(upload_status = 'lista') = (file_key IS NOT NULL)`, en forma de `CASE`.
- Índices:
  - `IX_entry_files_entry (entry_key, purpose, upload_status) INCLUDE (public_id, kind, file_key)`;
  - `IX_entry_files_sweep (upload_status, upload_expires_at) WHERE upload_status = 'pendiente'`.

### 6.8 `whats_new.file_references`

Saber qué contenido usa cada archivo permite autorizar la lectura y detectar huérfanos.

| Columna | Tipo | Regla |
|---|---|---|
| `entry_file_key` | `BIGINT` | FK |
| `ref_source` | `VARCHAR(20)` | `CHECK IN ('que_cambio','accion','revision','nota_borrador','nota','hallazgo','anulacion','texto_cliente','adjunto')` |
| `ref_owner_key` | `BIGINT` | Clave de la fila dueña: entrada, revisión, ronda, nota, hallazgo o adjunto |
| `created_at` | `DATETIME2(3)` | |

- PK `(entry_file_key, ref_source, ref_owner_key)`.
- Índice `IX_file_references_owner (ref_source, ref_owner_key)`.
- Las referencias de contenido mutable (`que_cambio`, `accion`, `nota_borrador`, `texto_cliente` y `adjunto`) se reemplazan en la transacción que guarda ese contenido. Las de contenido de solo inserción (`revision`, `nota`, `hallazgo` y `anulacion`) se insertan una vez.
- **El endpoint público solo sirve un archivo si tiene `purpose = 'cliente_imagen'` y una referencia `texto_cliente`** de una entrada visible (H-15, ver `06`).

## 7. Pruebas

### 7.1 `whats_new.test_rounds`

| Columna | Tipo | Regla |
|---|---|---|
| `round_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE` |
| `entry_key` | `BIGINT` | FK |
| `round_no` | `INT` | `UNIQUE (entry_key, round_no)` |
| `revision_no` | `INT` | FK `(entry_key, revision_no)` → `entry_revisions` |
| `status` | `VARCHAR(10)` | `CHECK IN ('tomada','soltada','fallida','probada')` |
| `holder_user_key` | `BIGINT` | FK |
| `taken_at` | `DATETIME2(3)` | |
| `closed_at` | `DATETIME2(3) NULL` | |
| `closed_by_user_key` | `BIGINT NULL` | FK |
| `close_reason` | `VARCHAR(20) NULL` | `CHECK IN ('normal','forzada')` |
| `close_reason_text` | `NVARCHAR(500) NULL` | Obligatorio si es `forzada` |
| `note_draft_json` | `NVARCHAR(MAX) NULL` | Nota en curso con autoguardado, perfil `medio` |
| `note_draft_text` | `NVARCHAR(MAX) NULL` | |
| `note_draft_saved_at` | `DATETIME2(3) NULL` | |
| `row_version` | `ROWVERSION` | |

- `UX_test_rounds_one_open (entry_key) WHERE status = 'tomada'`: una sola ronda abierta por entrada (QN-SQL-07).
- `CK_test_rounds_closed`: `(status = 'tomada' AND closed_at IS NULL AND closed_by_user_key IS NULL AND close_reason IS NULL) OR (status <> 'tomada' AND closed_at IS NOT NULL AND closed_by_user_key IS NOT NULL AND close_reason IS NOT NULL)`.
- `CK_test_rounds_forced`: `close_reason <> 'forzada' OR (status = 'soltada' AND close_reason_text IS NOT NULL)`.
- Disparador `TR_test_rounds_closed_immutable`: rechaza (`THROW 53330`) cualquier `UPDATE` o `DELETE` sobre una fila cuyo `deleted.status <> 'tomada'`. Así, la ronda soltada conserva su checklist y su nota (H-10).
- Índice `IX_test_rounds_holder (holder_user_key, status) INCLUDE (entry_key)`, para «En pruebas» y «Felipe Cardona · 2 de 3».

### 7.2 `whats_new.round_checklist_items`

| Columna | Tipo | Regla |
|---|---|---|
| `round_key` | `BIGINT` | FK |
| `item_no` | `TINYINT` | Ordinal de la acción en la revisión. PK `(round_key, item_no)` |
| `label_snapshot` | `NVARCHAR(120)` | De `required_actions_json` |
| `checked` | `BIT` | Por defecto 0 |
| `checked_at` | `DATETIME2(3) NULL` | |
| `checked_by_user_key` | `BIGINT NULL` | |

- `CK_checklist_checked`: `(checked = 1) = (checked_at IS NOT NULL AND checked_by_user_key IS NOT NULL)`.
- Disparador `TR_checklist_round_open`: rechaza (`THROW 53331`) un `UPDATE` o `DELETE` si la ronda no está `tomada`.
- Al tomar, el servicio inserta un ítem por acción de la revisión vigente: el checklist empieza en blanco (QN-EST-08 y QN-EST-18).

### 7.3 `whats_new.round_notes` (solo inserción)

| Columna | Tipo | Regla |
|---|---|---|
| `round_note_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE` |
| `round_key` | `BIGINT` | FK |
| `entry_key` | `BIGINT` | FK |
| `body_json` | `NVARCHAR(MAX)` | `ISJSON`, `DATALENGTH <= 2 * L_NOTA` |
| `body_text` | `NVARCHAR(MAX)` | |
| `created_by_user_key`, `created_at` | | |

### 7.4 `whats_new.findings` (solo inserción)

| Columna | Tipo | Regla |
|---|---|---|
| `finding_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE` |
| `entry_key` | `BIGINT` | FK |
| `round_key` | `BIGINT` | FK |
| `finding_no` | `INT` | `UNIQUE (entry_key, finding_no)`; consecutivo por entrada, tomado de `entries.last_finding_no` |
| `body_json`, `body_text` | | Como en las notas |
| `created_by_user_key`, `created_at` | | |

Índice `IX_findings_round (round_key, finding_no)`.

### 7.5 `whats_new.finding_annulments` (solo inserción, QA-26)

| Columna | Tipo | Regla |
|---|---|---|
| `finding_key` | `BIGINT` | PK y FK: un hallazgo se anula una sola vez |
| `reason_text` | `NVARCHAR(500)` | Obligatorio y sin texto enriquecido |
| `annulled_by_user_key`, `annulled_at` | | |

**Decisión propuesta:** anula quien registró el hallazgo mientras su ronda sigue `tomada`, o `manage` en cualquier momento. Anular descuenta `entries.open_findings_count` en la misma transacción.

### 7.6 `whats_new.entry_status_events` (solo inserción)

| Columna | Tipo | Regla |
|---|---|---|
| `status_event_key` | `BIGINT IDENTITY` | PK |
| `entry_key` | `BIGINT` | FK |
| `event_no` | `INT` | `UNIQUE (entry_key, event_no)` |
| `action` | `VARCHAR(30)` | `crear`, `publicar`, `corregir`, `tomar`, `soltar`, `forzar_soltar`, `marcar_probado`, `marcar_fallida`, `archivar`, `eliminar`, `reasignar_autor` |
| `from_status`, `to_status` | `VARCHAR(20)` | `to_status` con el mismo `CHECK` que la entrada |
| `round_key`, `revision_no` | `NULL` | |
| `reason_text` | `NVARCHAR(500) NULL` | Obligatorio para `forzar_soltar`, `archivar` y `reasignar_autor` |
| `occurred_at`, `occurred_by_user_key` | | |

## 8. Texto para clientes: `whats_new.entry_client_texts`

Pertenece a la **entrada**, no a la ronda (QA-09).

| Columna | Tipo | Regla |
|---|---|---|
| `entry_key` | `BIGINT` | PK y FK |
| `public_id` | `UNIQUEIDENTIFIER` | `UNIQUE`, `DEFAULT NEWID()`. Es el identificador del detalle público (QA-23) |
| `show_to_clients` | `BIT` | Por defecto 0 |
| `available_to_all_clients` | `BIT` | Confirmación «Disponible para todos los clientes» (QA-01). Por defecto 0 |
| `title` | `NVARCHAR(120) NULL` | `L_CLI_TIT` = 120 |
| `body_json` | `NVARCHAR(MAX) NULL` | Perfil `cliente`, `DATALENGTH <= 2 * L_CLI_TXT` |
| `body_text` | `NVARCHAR(MAX) NULL` | |
| `first_shown_at` | `DATETIME2(3) NULL` | |
| `updated_at`, `updated_by_user_key` | | |
| `row_version` | `ROWVERSION` | |

- `CK_client_text_complete`: `show_to_clients = 0 OR (title IS NOT NULL AND LEN(title) > 0 AND body_json IS NOT NULL)`.
- Disparador `TR_client_text_rules`: tras `INSERT` o `UPDATE`, lanza `THROW 53340` si la fila tiene `show_to_clients = 1` y su entrada:
  - es `sp_critico` (H-05), o
  - es `nuevo` sin `available_to_all_clients = 1` (QA-01).
- **Decisión de diseño:** el filtro de la API pública **repite** esas condiciones y además exige `status = 'probado'` y `settings.public_enabled = 1`. No confía en la casilla (QN-VIS-10 y QN-VIS-11).
- **Conflicto que QA debe actualizar:** QN-VIS-02, QN-VIS-03 y QN-VIS-10 todavía describen el H-02 original («con cliente asignado nunca se muestra»). Con QA-01, una entrada Nuevo se muestra si el asesor confirma «Disponible para todos los clientes», tenga o no cliente.
- Historia: `audit.audit_logs` registra cada cambio de visibilidad con valores booleanos y longitudes, sin el texto. **Decisión propuesta:** no se versiona el cuerpo en una tabla aparte. Si se exige recuperar textos anteriores, se agrega `entry_client_text_revisions`, de solo inserción.
- Índice para la página pública: `IX_client_texts_public (show_to_clients, entry_key) INCLUDE (public_id, title, available_to_all_clients) WHERE show_to_clients = 1`, unido con `IX_entries_status_tested` (sección 11).

## 9. Reportes y correo

### 9.1 `whats_new.reports`

Un reporte es una **instantánea inmutable** en PDF, guardada en SeaweedFS.

| Columna | Tipo | Regla |
|---|---|---|
| `report_key` | `BIGINT IDENTITY` | PK |
| `source_id` | `NVARCHAR(150)` | `UNIQUE` |
| `scope` | `VARCHAR(10)` | `CHECK IN ('entrada','pestana')` |
| `tab` | `VARCHAR(20) NULL` | `CHECK IN ('fallidas','probadas')`. Obligatorio si el alcance es `pestana` |
| `entry_key` | `BIGINT NULL` | Obligatorio si el alcance es `entrada` |
| `content_mode` | `VARCHAR(20)` | `CHECK IN ('solo_hallazgos','completo')` |
| `filters_json` | `NVARCHAR(MAX) NULL` | `ISJSON`; los filtros aplicados, ya normalizados |
| `entry_count` | `INT` | `CHECK BETWEEN 1 AND 200` (`L_REP`, H-17) |
| `file_key` | `BIGINT` | FK `content.files`, el PDF |
| `generated_by_user_key`, `generated_at` | | |
| `idempotency_key` | `NVARCHAR(200)` | `UNIQUE (generated_by_user_key, idempotency_key)` |

- `CK_reports_scope`: `(scope = 'entrada' AND entry_key IS NOT NULL AND tab IS NULL) OR (scope = 'pestana' AND tab IS NOT NULL AND entry_key IS NULL)`.
- Disparador de solo inserción.

### 9.2 `whats_new.report_entries`

`(report_key, entry_key)` PK, más `revision_no`, `rounds_included` y `findings_included`. Es la evidencia de qué entró en el reporte. Solo inserción.

### 9.3 `whats_new.report_deliveries` y `whats_new.report_recipients`

`report_deliveries`:

| Columna | Tipo | Regla |
|---|---|---|
| `report_delivery_key` | `BIGINT IDENTITY` | PK |
| `report_key` | `BIGINT` | FK |
| `notification_key` | `BIGINT` | FK `notifications.email_notifications`. `UNIQUE` |
| `recipient_count` | `SMALLINT` | `CHECK BETWEEN 1 AND 30` (`L_DEST` = 30) |
| `recipients_without_access` | `SMALLINT` | Cuántos no tenían acceso a la opción cuando se envió (QA-27) |
| `sent_by_user_key`, `requested_at` | | |
| `idempotency_key` | `NVARCHAR(200)` | `UNIQUE (sent_by_user_key, idempotency_key)` |

`report_recipients`: `(report_delivery_key, user_key)` PK, `email_snapshot NVARCHAR(254)` y `had_option_access BIT`.

- Autoriza la descarga del PDF a un destinatario (ver `06`).
- Ambas tablas son de solo inserción.

### 9.4 Enlace con el outbox

- La migración amplía `notifications.CK_email_notifications_type` con `'whats_new_report'`, con el mismo patrón que `019` y `023`: borrar la restricción y volver a crearla con la lista completa, más una verificación.
- La fila del outbox se inserta en **la misma transacción** que `report_deliveries` y `report_recipients`.
- La llave de idempotencia del outbox es `whats-new-report:<report_source_id>:<sha256 de los user_key ordenados>:<Idempotency-Key>`.
- `metadata_json` lleva `html` y `text` como en `reports.ts`, más `reportId` y `recipientCount`. **No** lleva URL firmadas, el contenido del reporte ni el PDF.
- El correo trae un resumen y el enlace autenticado del portal (ver `04` §8).
- **Decisión propuesta:** sin adjunto. El outbox y `sendEmail` no tienen adjuntos hoy; agregarlos pondría el contenido interno en el proveedor de correo y aumentaría el tamaño de la cola.

## 10. Idempotencia: `whats_new.idempotency_keys`

| Columna | Tipo | Regla |
|---|---|---|
| `idempotency_record_key` | `BIGINT IDENTITY` | PK |
| `actor_user_key` | `BIGINT` | FK |
| `operation` | `VARCHAR(40)` | `crear`, `publicar`, `corregir`, `tomar`, `soltar`, `forzar_soltar`, `marcar_probado`, `marcar_fallida`, `registrar_nota`, `registrar_hallazgo`, `anular_hallazgo`, `archivar`, `reasignar_autor`, `autorizar_carga`, `completar_carga`, `generar_reporte`, `enviar_reporte`, `cargar_menu` |
| `idempotency_key` | `NVARCHAR(200)` | ASCII visible |
| `request_sha256` | `BINARY(32)` | Hash del cuerpo y de los parámetros |
| `entry_key` | `BIGINT NULL` | |
| `response_status` | `SMALLINT` | |
| `response_json` | `NVARCHAR(MAX)` | `ISJSON`. **Nunca** URL firmadas ni secretos |
| `created_at`, `expires_at` | | `expires_at = created_at + 7 días` |

- `UNIQUE (actor_user_key, operation, idempotency_key)`.
- Repetir con el mismo hash devuelve la respuesta guardada. Con otro hash devuelve `409 llave_idempotencia_reutilizada`.
- Es la única tabla del módulo que se purga, en el temporizador de barrido: filas vencidas en lotes de 500.

## 11. Índices para las pestañas y volumen

**Volumen esperado (Decisión propuesta, a confirmar con Desarrollo):** de 10 a 40 entradas al mes, es decir, menos de 500 al año. Unas 1,5 rondas por entrada, de 0 a 5 hallazgos y de 0 a 10 archivos. En cinco años: menos de 3 000 entradas, 5 000 rondas, 10 000 hallazgos y 20 000 archivos. No se particiona. QA prueba los planes con 5 000 entradas (QN-SQL-05).

| Consulta | Índice |
|---|---|
| Bandeja del asesor por pestaña (`sin_probar`, `en_pruebas`, `fallida`, `probado`), con tipo y sistema, ordenada por fecha | `IX_entries_queue (status, last_published_at DESC, entry_key DESC) INCLUDE (entry_type, system_code, entry_number, author_user_key, initial_tester_user_key, open_findings_count, what_changed_summary, source_id) WHERE status IN ('sin_probar','en_pruebas','fallida','probado','archivada')` |
| Probadas por mes (rango UTC de Bogotá) y página pública ordenada por liberación | `IX_entries_status_tested (status, tested_at DESC, entry_key) INCLUDE (entry_type, system_code, source_id) WHERE tested_at IS NOT NULL` |
| Mis entradas (autor), pestañas Todas, Borradores y Publicadas | `IX_entries_author (author_user_key, status, updated_at DESC, entry_key DESC) INCLUDE (entry_type, system_code, what_changed_summary, open_findings_count, current_revision_no)` |
| «Asignadas a mí» (QA-02) | `IX_entries_initial_tester (initial_tester_user_key, status) WHERE initial_tester_user_key IS NOT NULL` |
| Conteo por pestaña | Una sola consulta `GROUP BY status` sobre `IX_entries_queue` con los mismos filtros |
| Quién la tiene y avance «2 de 3» | `UX_test_rounds_one_open`, más un agregado sobre la PK de `round_checklist_items` |
| Búsqueda por ruta o texto | `LIKE @q` sobre `route_search_text` y `what_changed_text`, siempre **después** de los filtros indexados. Con este volumen basta; no se usa full-text. `@q` se escapa (`%`, `_`, `[`) y mide de 2 a 100 caracteres. |

La paginación usa `OFFSET/FETCH` con `pageSize` de hasta 50 y orden estable `(fecha DESC, entry_key DESC)`.

## 12. Permisos de base de datos

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::whats_new TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::whats_new TO portal_migrator;
DENY UPDATE, DELETE ON OBJECT::whats_new.entry_revisions      TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.round_notes          TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.findings             TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.finding_annulments   TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.entry_status_events  TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.reports              TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.report_entries       TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.report_deliveries    TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.report_recipients    TO portal_runtime;
DENY UPDATE         ON OBJECT::whats_new.entry_contributors   TO portal_runtime;
-- portal_reporting no recibe nada del esquema.
```

- `security.business_areas` y `security.user_business_areas` ya quedan cubiertos por la concesión vigente sobre `security`.
- **Riesgo conocido:** en producción, `SAGWebDev` es `db_owner`, y `DENY` no aplica a `db_owner`. Por eso los **disparadores** son la garantía real de la historia de solo inserción. Las migraciones no cambian esa membresía (ver `AGENTS.md`).

## 13. Plan de migraciones

Son aditivas, numeradas después de `030` (la última en `main`) y siguen el patrón de `024` a `030`:

- preámbulo `SET NOCOUNT ON; SET XACT_ABORT ON;`;
- verificación de base `PortalSAGWeb` o `PortalSAGWeb-TEST` y de versión mayor 15;
- exigir la migración anterior en `migration.schema_migrations` con `succeeded = 1`;
- todo DDL protegido con `IF OBJECT_ID(...) IS NULL`, `COL_LENGTH`, `sys.indexes` o `sys.check_constraints`, para poder reejecutar;
- `BEGIN TRANSACTION … COMMIT`;
- postcondiciones con `THROW` (cantidad de permisos, restricciones confiables, disparadores habilitados).

El registro en `schema_migrations` lo hace el lanzador, como hoy. Códigos de error reservados: 53100–53199 (031), 53200–53299 (032), 53300–53399 (033) y 53400–53499 (034).

| N.º | Archivo | Contenido | Hito |
|---|---|---|---|
| 031 | `031_user_business_areas.sql` | `security.business_areas` (4 filas), `security.user_business_areas` e índice. No asigna áreas a nadie. | H1 |
| 032 | `032_whats_new_configuration_and_permissions.sql` | `CREATE SCHEMA whats_new`. Concesiones a `portal_runtime` y `portal_migrator`. `settings` (fila única con `public_enabled = 0`), `action_catalog` (4 acciones iniciales y disparador de al menos una activa), `menu_versions` y `menu_nodes`. Claves de permiso de `06` en `security.permissions` y concesión a `super_admin` (patrón `026` a `028`). Roles sugeridos de `06`, solo si no existen y sin asignarlos. | H1 |
| 033 | `033_whats_new_entries_and_testing.sql` | Secuencia; `entries`, `entry_contributors`, `entry_routes`, `entry_route_levels`, `entry_required_actions`, `entry_revisions`, `entry_files`, `entry_attachments`, `file_references`, `test_rounds`, `round_checklist_items`, `round_notes`, `findings`, `finding_annulments`, `entry_status_events`, `entry_client_texts` e `idempotency_keys`. Disparadores, `DENY` e índices. | H2 a H4 |
| 034 | `034_whats_new_reports_outbox.sql` | `reports`, `report_entries`, `report_deliveries` y `report_recipients`. Amplía `CK_email_notifications_type` con `'whats_new_report'`, conservando los ocho valores vigentes y verificando que quede `is_disabled = 0 AND is_not_trusted = 0`. | H4 |

Las cuatro migraciones crean objetos vacíos, así que los bloqueos son cortos. La única operación sobre una tabla con datos es la recreación del `CHECK` de `email_notifications` en 034: valida las filas existentes (`WITH CHECK`), con un tiempo proporcional a la cola, que hoy es de miles de filas. Se aplica en ventana sin envíos.

### 13.1 Manifiesto y validación

1. Calcular el SHA-256 de cada script con `Get-FileHash` y agregarlo a `migration/sql/MANIFEST.sha256`.
2. Ejecutar `migration/tools/Validate-SqlServer2019Scripts.ps1` y `validate-permission-seed.js`. Las claves de la migración 032 deben coincidir con `PERMISSION_CATALOG` en `api/src/lib/permissionModel.ts`.
3. Agregar 031 a 034 a la lista de versiones de `Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1`.

### 13.2 Recuperación

- Antes de aplicar se exige un **respaldo completo reciente** (`Assert-PortalSAGWeb-RecentProductionBackup.ps1`) y un ensayo en `PortalSAGWeb-TEST`.
- Las migraciones solo agregan objetos. **Rollback lógico** si no hay datos de negocio: desactivar la opción, con el flag de API y frontend apagado.
- Script de reversión **solo para QA**, `rollback_031_034_qa.sql`, que no se ejecuta en producción sin autorización. Hace lo siguiente:
  1. `DROP` de las tablas `whats_new` en orden inverso de FK y del esquema;
  2. restaura el `CHECK` del outbox a los ocho valores, si no hay filas `whats_new_report`;
  3. marca los permisos `active = 0`, sin borrar `role_permissions` (evidencia, como en 025);
  4. `DROP` de las tablas de área.
- En producción, con datos ya creados, no hay `DROP`: se apaga la opción y se conserva todo.
- Los objetos de SeaweedFS no se borran en una reversión.

## 14. Coordinación con lo existente

- `settings.administrative_reminders` ya tiene el tipo `'whats_new'`: es el recordatorio mensual de la plantilla Word «Qué Hay de Nuevo SAG Web». No se toca. Cuando el módulo esté en producción, el texto del recordatorio podría enlazar a la nueva opción; eso es una decisión aparte.
- El esquema `implementation` sigue reservado y no se usa.
