# 04 — Módulo M3: Motor de procesos (máquina de estados + las 3 plantillas completas)

> Especifica el backbone común, las transiciones válidas y las **tres plantillas de proceso completas** (etapa por etapa, paso por paso), cada una cotejada contra [PROC]/[SQL]/[VEN]. Requisitos que cubre: RF-01–RF-05, RF-07–RF-12, RN-02–RN-15, RNF-05, RNF-06.

## 1. Etapas del backbone (StageId)

```
draft → screening* → solicitudes → collecting → handoff
      → technical → test_delivery* → client_testing* → production → completed
Salidas terminales alternativas: rejected (desde screening), cancelled (desde cualquiera, con nota)
Pausa: on_hold ⇄ (etapa en curso)
```
\* `screening` solo existe en C1/C2 (RF-03). `test_delivery`/`client_testing` se omiten en C3 cuando la decisión `requires_test_env = no` (RF-12).

**Etapa `solicitudes` (una sola, con dos acciones):** agrupa los prerrequisitos al cliente (correo 2) y la solicitud a Elasticserver (correo 1). **Orden por caso (resuelto por Juan Camilo — H-01):**
- **C1 (migración): orden OBLIGATORIO correo 2 → correo 1.** La solicitud a Elasticserver necesita el **nombre de la BD** que el cliente entrega al responder los prerrequisitos (con él Elasticserver localiza la BD de producción, entrega accesos y crea la copia de pruebas). Guard adicional: el envío del correo 1 en C1 exige `originalDbName` en cada compañía.
- **C2 y C3: orden libre** (no hay acople de datos); ambas acciones pueden ir en paralelo.
La guard de salida hacia `collecting` exige AMBAS en todos los casos.

**Transiciones válidas** (el backend rechaza cualquier otra — RNF-02):

| Desde | Hacia | Condición (guard) |
|---|---|---|
| `draft` | `screening` (C1/C2) / `solicitudes` (C3) | datos mínimos: nombre de cliente, caso |
| `screening` | `solicitudes` | decisión `options_exist=yes` **o** (`options_exist=no` y `hybrid_benefit=yes`) registrada (RF-11) |
| `screening` | **`rejected`** | `options_exist=no` y `hybrid_benefit=no`; `rejectionReason` obligatorio |
| `solicitudes` | `collecting` | correo 1 enviado (o `elasticserver.requestedAt` registrado) **y** correo 2 enviado — en cualquier orden |
| `collecting` | `handoff` | `deliverablesComplete = true` (RF-06) — bloqueo duro |
| `handoff` | `technical` | correo 3 enviado (la entrega ES el correo — RF-08) |
| `technical` | `test_delivery` | todos los pasos `blocking` de fases A–E en `done`/`not_applicable` (RF-10); en C3 con `requires_test_env=no` → directo a `production` |
| `test_delivery` | `client_testing` | correo 4a (credenciales de pruebas) enviado |
| `client_testing` | `production` | decisión `client_tests_passed=yes` (los "no" quedan como eventos del bucle, no retroceden — RF-07) |
| `production` | `completed` | pasos de FASE F en `done`/`not_applicable` y correo 4b enviado |
| cualquiera | `cancelled` | nota obligatoria |
| cualquiera activa | `on_hold` y regreso | nota obligatoria; el regreso vuelve a la MISMA etapa |

**Reglas del motor:**
1. **Idempotencia** (RNF-06): transicionar a la etapa en la que ya se está = no-op sin evento duplicado. Los correos usan confirmación previa + registro; reintento de un envío fallido es explícito.
2. **Sin saltos**: no se puede ir de `collecting` a `technical` sin pasar por `handoff`, porque el correo de entrega es un artefacto obligatorio del proceso ([VEN] D.3).
3. **Los bucles son eventos, no retrocesos** (RF-07): "pedir faltantes" y "pruebas no exitosas" registran eventos y dejan contadores; la etapa no cambia. *Justificación:* [PROC] §0 los muestra como bucles dentro del mismo cuadro; además retroceder borraría la métrica de idas y vueltas.
4. **Fail-fast** (RF-10): un paso `blocking=true` en estado `blocked` impide la transición de salida de su etapa. Desbloquear exige nota de resolución (evento `step_unblocked`).

---

## 2. PLANTILLA C1 — Migración (`migration`, v1)

Fuente primaria: [PROC] §1 (flujo de negocio 14 pasos + paso a paso técnico **14 pasos** con BARRIDO único — rediseño 2026-07-09, fases A–F) + [SQL] §B/C. Fuente confiable: imagen + docx (regla de confianza [PROC] encabezado).

### Etapas de negocio

| Etapa | Contenido | Fuente |
|---|---|---|
| `screening` | Decisiones `options_exist` (hoja "Check" del xlsx) y `hybrid_benefit`; salida `rejected` | [PROC] §1.A.1–2 |
| `solicitudes` — correo 1 | A Elasticserver: dominio (UNO solo — RN-07) + por cada compañía: BD de pruebas (copia) + acceso a BD de producción existente (RN-08) | [PROC] §1.A.5, [VEN] D.1 |
| `solicitudes` — correo 2 | Al cliente: preparar usuarios (activos = a migrar, ≤ contratados, correo único en Clásico — RN-02/03), datos de compañías, nombre de BD. **NO pide lista de usuarios** (RN-04) | [PROC] §1.A.4 |
| `collecting` | Captura: `contractedUsers`, dominio, cliente (derivado por Ventas — RN-05), compañías (cada una con `originalDbName` + acceso pruebas + acceso producción), módulos licenciados | [VEN] §B |
| `handoff` | Correo 3 a Soporte indicando **Caso 1** | [VEN] D.3 |

### Checklist técnico (etapa `technical` + FASE F en `production`)

| stepKey | Fase | Paso | `blocking` | Rol | Fuente |
|---|---|---|---|---|---|
| `c1.a.entregables` | A | Validar que se tienen todos los datos/entregables (incluye activos ≤ contratados — RN-02) | ✔ | support | [PROC] §1.B.1 |
| `c1.a.barridoUsuarios` | A | **BARRIDO único (RN-21):** por cada BD de compañía: (a) 3 consultas de correos (duplicados, vacíos, formato con Motivo) — se ANOTA, no se detiene por consulta; (b) extracción del CSV (`consulta_importacion_usuarios.sql` por **ss_email** — RN-11 v2); (c) `ConsolidarUsuarios.exe` → **únicos por correo vs. contratados POR CLIENTE**; (d) reporte único → verde = continuar / algo mal = **STOP**: cliente corrige en PRODUCCIÓN → copia fresca → repetir barrido | ✔ | support | [PROC] §1.B.2 (2026-07-09) |
| `c1.b.actualizarLegado` | B | **Actualizar el SAG Clásico del cliente (librerías y BD) a la última versión** — SOLO con el barrido en verde; sobre la copia de PRUEBAS (producción en FASE F); si llegó copia nueva, repetir (RN-10/RN-21) | ✔ | support | [PROC] §1.B.3 (2026-07-09) |
| `c1.b.scripts` | B | Correr los **5 scripts** en orden: `a_sag_web → a_sagweb_Menu → a_format_sag_web → a_report_sag_web → sp_migrar_usuarios_permisos_web` (RN-09; usar siempre la última versión) | ✔ | support | [PROC] §1.B.4, [SQL] §B |
| `c1.b.validarScripts` | B | **Validar marcas de versión** (consulta embebida — `03_scripts_web.md` §F): 5 filas web con valor y FechaUltimaEjecucion de hoy (vacía = script olvidado → correrlo); `migrar_usuarios` SIN "SOLO" (permisos completos); versión local del mes (actualizada en el paso anterior). Propósito: detectar scripts olvidados | ✔ | support | docx C1 Paso 5 (2026-07-09), [SQL] §F |
| `c1.c.cadenaConexion` | C | Armar cadena de conexión (`IP,Puerto; Initial Catalog; User ID; Password`) | ✔ | **lead** | [PROC] §1.B.6 |
| `c1.c.crearCliente` | C | Crear cliente + licenciamiento en SAG Admin (reglas RN-13 en `instructions`) | ✔ | **lead** | [PROC] §1.B.7 |
| `c1.c.crearCompanias` | C | Crear compañías (NIT limpio, Token=1, Dispositivos=1) | ✔ | **lead** | [PROC] §1.B.8 |
| `c1.c.importarUsuarios` | C | **Importar usuarios por CSV** (Detalle del cliente → botón de importación → Seleccionar archivo → procesar): crea nuevos (contraseña autogenerada, composición estándar máx. 8), omite existentes e inválidos, asocia todos al cliente; descarga `resultado.xlsx` (Correo\|Contraseña) — insumo de credenciales. Reemplaza la creación/asociación manual. **Los CSV son los del barrido** (varias compañías → uno por uno; repetidos se omiten) | ✔ | **lead** | [PROC] §1.B.9 (2026-07-09), [DEC] importación CSV |
| `c1.d.plesk` | D | Publicar en Plesk (borrar contenido por defecto, subir paquete `.rar` de Teams, extraer, borrar `.rar`) — DESPUÉS de SAG Admin (RN-14) | ✔ | support | [PROC] §1.B.10 |
| `c1.d.objectStorage` | D | Parámetros Web → Almacenamiento de Archivos (fila del archivo de buckets) — casi al final (RN-14) | ✔ | support | [PROC] §1.B.11 |
| `c1.e.validarFinal` | E | Validar: acceder a SAG Web y confirmar permisos migrados de ≥1 usuario | ✔ | support | [PROC] §1.B.12 |
| — | E | *(El envío de credenciales de pruebas NO es un paso del checklist: es la etapa `test_delivery` con el correo 4a — evita doble contabilidad)* | | lead | [PROC] §1.B.15 |
| `c1.f.prepararProduccion` | F | Preparar la BD de producción: actualizar librerías/BD + correr los 5 scripts (incl. `sp_migrar`) sobre producción (el acceso ya se tiene desde `solicitudes` — RN-08). **NO hay re-extracción ni reimportación de usuarios** (RN-11 v2: viven en SAG Admin; las correcciones siempre fueron en producción) | ✔ | support | [PROC] §1.B.14 (2026-07-09) |
| `c1.f.repuntarConexion` | F | **Reapuntar la cadena de conexión** de la(s) compañía(s) del cliente EXISTENTE en SAG Admin hacia la BD de producción y **retirar el sufijo "- PRUEBAS"** del nombre si se usó. **NO** se crea cliente/compañía de producción, **NO** se recrean usuarios, **NO** se vuelve a publicar en Plesk ni a configurar object storage (dominio y bucket son los mismos) | ✔ | **lead** | [PROC] §1.B.16 (corregido por Juan Camilo, jul. 2026), [CTX] §6 bis |
| `c1.f.validarProduccion` | F | Validar acceso en producción (login + permisos) | ✔ | support | [PROC] §1.B.16 |
| — | F | *(Credenciales de producción = correo 4b en la etapa `production`)* | | lead | [PROC] §1.B.16 |

**Nota de fidelidad (actualizada):** en C1 **lo único separado de producción es la base de datos**; la publicación, el cliente de SAG Admin, los usuarios y el bucket **se reutilizan** (decisión de Juan Camilo que corrigió la versión anterior del proceso — ver [DEC] ronda jul. 2026). El motor exige `client_tests_passed=yes` antes de habilitar los pasos F.

---

## 3. PLANTILLA C2 — Cliente nuevo (`new_client`, v1)

Fuente: [PROC] §2 + [SQL] §B (cliente nuevo) y §C ter (script de borrado). Fuente confiable: imagen + co-construcción (regla de confianza).

### Etapas de negocio

| Etapa | Contenido | Diferencias vs C1 | Fuente |
|---|---|---|---|
| `screening` | Igual que C1 (opciones / híbrido / rechazo) | — | [PROC] §2.A.1–2 |
| `solicitudes` — correo 1 | Dominio + **una BD nueva POR COMPAÑÍA** (se listan las compañías; sin mencionar NEW SAG — RN-06) | Sin accesos de producción | [PROC] §2.A.5, RN-19 |
| `solicitudes` — correo 2 | Datos de compañías + **correo del administrador del sistema POR COMPAÑÍA** (RN-19; solo "envíenos", sin fallbacks). **Sin queries de correos, sin conexión** (100% nube) | Sin regla de activos ni nombre de BD | [VEN] D.2 |
| `collecting` | `contractedUsers` (dato de Ventas), dominio, cliente, compañías con **`adminEmail`** (SIN accesos de BD — [VEN] §B: "Cliente nuevo NO lleva BD"), módulos licenciados | Compañías sin `originalDbName` ni accesos | [VEN] §B, RN-19 |
| `handoff` | Correo 3 indicando **Caso 2** (transporta los correos de admin por compañía) | — | [VEN] D.3 |

### Checklist técnico

| stepKey | Fase | Paso | `blocking` | Rol | Fuente |
|---|---|---|---|---|---|
| `c2.a.entregables` | A | Validar datos: usuarios contratados, dominio, cliente/compañías, **correo del admin de CADA compañía (RN-19)**, módulos. **NO aplican queries de correos** (no hay base previa — RN-03/04) | ✔ | support | docx C2 Paso 1 |
| `c2.b.bdNueva` | B | Confirmar recepción de las BD nuevas — **una por compañía** (clones de `NEW SAG`; las entrega infraestructura, las solicitó Ventas) | ✔ | support | [PROC] §2.B.1, RN-19 |
| `c2.b.scripts` | B | Correr **4 scripts** (SIN `sp_migrar`): `a_sag_web → a_sagweb_Menu → a_format_sag_web → a_report_sag_web`, en cada BD de compañía (RN-09) | ✔ | support | docx C2 Paso 2, [SQL] §B |
| `c2.b.validarScripts` | B | **Validar marcas + versión de la plantilla** (por cada BD de compañía): 4 marcas web con FechaUpdate de hoy; `migrar_usuarios` VACÍA = **esperado** (no es olvido); si la clonada de `NEW SAG` muestra versiones viejas → **escalar al Líder de Soporte** (actualizar la plantilla) y correr las versiones recientes | ✔ | support | docx C2 Paso 3 (jul. 2026), [SQL] §F |
| `c2.b.actualizarAdmin` | B | **Actualizar el correo del admin** (`a_sagweb_actualizar_admin`) en CADA BD de compañía con el `adminEmail` de esa compañía — DESPUÉS de los scripts; solo UPDATE de `terceros.ss_email` + `usuarios.ss_login_web` (`ka_nl_tercero = 1`); nunca borrar/recrear. Evidencia obligatoria: correos aplicados por BD | ✔ | support | docx C2 Paso 4 (jul. 2026), [SQL] §C quater, RN-19 |
| `c2.c.cadenaConexion` | C | Obtener la cadena de conexión a la BD nueva | ✔ | support | docx C2 Paso 5 (responsable: Servicio al Cliente) |
| `c2.c.crearCliente` | C | Crear cliente + licenciamiento (RN-13) | ✔ | **lead** | docx C2 Paso 6 |
| `c2.c.crearCompanias` | C | Crear compañías | ✔ | **lead** | docx C2 Paso 7 |
| `c2.c.usuariosAdmin` | C | Crear **los usuarios administradores (uno por compañía)** con el `adminEmail` de cada una y **contraseña de estándar de compañía** (RN-19; en `instructions`), y asociarlos al cliente. Mismo correo para todas → un solo usuario. Los demás usuarios los crea el CLIENTE en SAG Web (RN-04) | ✔ | **lead** | docx C2 Pasos 8–9, [DEC] jul. 2026 |
| `c2.d.plesk` | D | Publicar en Plesk (igual C1; RN-14) | ✔ | support | docx C2 Paso 10 |
| `c2.d.objectStorage` | D | Object storage / Parámetros Web (con el usuario admin) | ✔ | support | docx C2 Paso 11 |
| `c2.e.validarFinal` | E | Validar login + permisos/menús con el administrador de alguna compañía | ✔ | **lead** | docx C2 Paso 12 (responsable: Líder de Operaciones) |
| `c2.f.produccion` | F | **Mismo ambiente** (RN-12): borrar datos de prueba con el script de borrado de movimientos (deja la BD en cero, reinicia consecutivos; enlace SharePoint en `instructions`) y **cargar los datos reales** — lo hace el agente de Soporte asignado junto con el cliente (o solo el cliente), manual o con importaciones según el caso | ✔ | **lead** | docx C2 Paso 14, [SQL] §C ter, [DEC] jul. 2026 |

**Notas de fidelidad:**
- No existe paso "crear usuarios" (lista) ni "extraer usuarios": el cliente crea los suyos. Lo que SÍ existe (RN-19, supersede [DEC] B.8) es el **admin exclusivo por compañía**: `adminEmail` en el modelo + paso `c2.b.actualizarAdmin` + creación en SAG Admin con contraseña de estándar de compañía. El admin de plantilla jamás se entrega tal cual (hueco multi-tenant corregido).
- FASE F no crea cliente/compañía nuevos en SAG Admin: es el MISMO ambiente ([PROC] §2.B contraste explícito con migración).
- El paso a paso definitivo tiene **14 pasos** (Paso 3 = validación de marcas; Paso 4 = actualizar correo del admin).

---

## 4. PLANTILLA C3 — Módulos especiales (`special_module`, v1)

Fuente: [PROC] §3 + [SQL] §C bis. Fuente confiable: imagen + co-construcción.

### Etapas de negocio

| Etapa | Contenido | Fuente |
|---|---|---|
| *(sin `screening`)* | Entra directo: "por definición ya es híbrido" (RF-03) | [PROC] §3 nota |
| `solicitudes` — correo 1 | **Dominio siempre**; BD de pruebas SOLO si `requiresTestEnvironment=true`; si `hosting=local`, **no se pide BD** (RN-15) | [PROC] §3.A.3, [VEN] D.1 |
| `solicitudes` — correo 2 | **Variante por `hosting`**: local (incluye datos de conexión + IPs de firewall `179.32.54.66`, `148.224.28.55`) o nube | [VEN] D.2 |
| `collecting` | `contractedUsers`, **`moduleUsers` (lista del cliente: nombre, ID, correo único — RN-04)**, compañías, `specialModules`, `hosting`; si local: acceso a BD del cliente por compañía | [PROC] §3.A.2, [VEN] §B |
| `handoff` | Correo 3 indicando **Caso 3** (conexión solo si local) | [VEN] D.3 |

**Decisión estructural del caso (RF-12):** al entrar a `technical` (o antes), se registra `requires_test_env` (sugerida desde `moduleTestCatalog` según `specialModules`; el usuario confirma). Determina la salida de `technical`: → `test_delivery` (sí) o → `production` directo (no). Fuente: [PROC] §3.A.9.

### Checklist técnico

| stepKey | Fase | Paso | `blocking` | Rol | Fuente |
|---|---|---|---|---|---|
| `c3.a.entregables` | A | Validar entregables — incluye la(s) **plantilla(s) de usuarios** con el **ADMIN marcado con S** por compañía (RN-22) y el **nombre de BD si es nube** | ✔ | support | [PROC] §3.B |
| `c3.a.correosDuplicados` | A | Query de correos duplicados — **SÍ aplica** (hay usuarios previos en Clásico — RN-03). STOP | ✔ | support | [PROC] §3.B, [SQL] §D |
| `c3.a.correosVacios` | A | Query de correos vacíos. STOP | ✔ | support | [PROC] §3.B |
| `c3.b.conectividad` | B | Si `hosting=local`: confirmar conectividad a la BD del cliente (IPs de firewall autorizadas). Si nube: `not_applicable` | ✔ | support | [CTX] §3.1, [SQL] §D (error de red) |
| `c3.b.scripts` | B | Correr **4 scripts generales + `a_sagweb_migrar_login`** (en lugar del SP completo; sin él los usuarios no inician sesión — RN-09) | ✔ | support | [PROC] §3.B, [SQL] §C bis |
| `c3.b.validarScripts` | B | **Validar marcas de versión**: 4 marcas web con FechaUpdate de hoy + `migrar_usuarios` CON "SOLO migracion de login/emails" (la escribe el script 6; si está vacía, faltó correrlo y los usuarios no podrán iniciar sesión) | ✔ | support | docx C3 Paso 6 (jul. 2026), [SQL] §F |
| `c3.b.generarCsv` | B | **Generar el CSV Y los scripts de permisos desde la(s) plantilla(s)** con `GenerarCSVUsuarios.exe` (valida — admins = S/SI/YES, uno o varios —, limpia; en verde genera CSV + `asignar_permisos_admins_{COMPAÑÍA}.sql` por compañía, un bloque por admin + reporte; con errores NO genera → devolver al cliente) | ✔ | support | docx C3 Paso 7 (2026-07-10), RN-22 |
| `c3.b.permisosAdmin` | B | **Ejecutar los scripts de permisos generados** (`asignar_permisos_admins_{COMPAÑÍA}.sql`) en la BD de cada compañía — UNA SOLA PASADA para todos los admins (CONF/USU/USU2, idempotente; requiere scripts 1–2). Los correos no encontrados se reportan sin detener el script → corregir en la plantilla y re-ejecutar (RN-22) | ✔ | support | docx C3 Paso 8 (2026-07-10) |
| `c3.c.clienteSagAdmin` | C | Cliente en SAG Admin: **reutilizar si existe; crear si no (lo común)** + licenciamiento del módulo | ✔ | **lead** | [PROC] §3.B |
| `c3.c.companias` | C | Crear/verificar compañías | ✔ | **lead** | [PROC] §3.B (genérico C) |
| `c3.c.importarUsuarios` | C | **Importar los usuarios por CSV** en SAG Admin (Detalle del cliente → importación → procesar; `resultado.xlsx` = insumo de credenciales). Supersede la creación manual (`c3.c.usuariosModulo`) | ✔ | **lead** | docx C3 Paso 12 (2026-07-09), RN-22 |
| `c3.d.plesk` | D | Publicar en Plesk al dominio | ✔ | support | [PROC] §3.B (genérico D) |
| `c3.d.objectStorage` | D | Object storage / Parámetros Web | ✔ | support | [PROC] §3.B |
| `c3.e.validarFinal` | E | Validar acceso al módulo con un usuario del módulo | ✔ | support | [PROC] §3.B |
| `c3.f.promover` | F | Según la rama: promover de pruebas a producción, o cierre directo si fue a producción desde el inicio ("los pasos son casi iguales; la rama solo cambia el destino") | ✔ | support | [PROC] §3.B |

---

## 5. Reglas transversales de las plantillas

1. **`not_applicable` controlado:** solo pasos que la plantilla marca como condicionales (p. ej. `c3.b.conectividad` en nube) pueden marcarse N/A, y el sistema lo hace automáticamente según los datos (`hosting`), no a criterio del ejecutor. *Justificación:* si cualquier paso pudiera saltarse a mano, el fail-fast sería decorativo.
2. **Evidencia obligatoria en pasos STOP:** completar `c*.a.correosDuplicados`/`correosVacios` exige evidencia (resultado de la query). *Justificación:* [SQL] §D — la mitad de los errores comunes de Soporte nacen de saltarse estas validaciones.
3. **El caso "Actualización" de [SQL] §B (3 scripts) NO es una plantilla:** es mantenimiento de clientes ya en SAG Web, fuera del alcance de implementaciones. El diseño de plantillas-como-configuración permite agregarlo después si el negocio lo pide. *(Hallazgo del cotejo — ver `08` H-06.)*
4. **Versionado:** cada plantilla lleva `version`; los cambios de proceso publican una versión nueva (RNF-05).

## 6. Criterios de aceptación (CA-M3)

- **CA-M3-1:** Crear C3 NO pasa por `screening`; crear C1/C2 sí; en C1/C2 la combinación `options_exist=no` + `hybrid_benefit=no` fuerza `rejected` con motivo.
- **CA-M3-2:** `collecting → handoff` es imposible con `deliverablesComplete=false` (respuesta 409 con la lista de faltantes).
- **CA-M3-3:** Con `c1.a.barridoUsuarios` en `blocked`, la transición `technical → test_delivery` devuelve 409 aunque el resto esté `done`.
- **CA-M3-4:** En C3 con `requires_test_env=no`, completar `technical` transiciona a `production` sin pasar por `test_delivery`; con `yes`, exige el correo 4a y la decisión `client_tests_passed=yes`.
- **CA-M3-5:** "Pruebas no exitosas" registra evento y NO cambia la etapa; el contador de bucles incrementa.
- **CA-M3-6:** En C1, los pasos de FASE F no pueden completarse antes de `client_tests_passed=yes`.
- **CA-M3-7:** `c3.b.conectividad` queda `not_applicable` automáticamente si `hosting=cloud`, y obligatorio si `local`.
- **CA-M3-8:** Doble clic en una transición produce exactamente un evento y cero correos duplicados.
