# 08 — Matriz de trazabilidad y verificación espec-vs-proceso

> Cierra el ciclo spec-driven: (A) matriz requisito ↔ especificación ↔ fuente; (B) el **cotejo**: verificación punto por punto de que la especificación coincide con los procesos documentados, con los **hallazgos** (confirmaciones, discrepancias resueltas, desviaciones deliberadas y pendientes); (C) verificación de cobertura por caso.

## A. Matriz de trazabilidad

### Requisitos funcionales

| Req | Especificado en | Fuente original | Verificado |
|---|---|---|---|
| RF-01 | M2 §2 (`type`), M5 (`POST /implementations`), M6 §3 | [PROC] §1–3 | ✔ |
| RF-02 | M3 (plantillas), M2 §3 (campos por caso), M6 §4 | [PROC] §4 | ✔ |
| RF-03 | M3 §1 (guards de `screening`), M3 §4 (C3 sin screening) | [PROC] §1.A.2, §2.A.2, §3 | ✔ |
| RF-04 | M4 §2 (builder con ramas por caso) | [VEN] D.1, [CTX] §3.1 | ✔ |
| RF-05 | M4 §3 (plantilla por caso + variante local) | [VEN] D.2 | ✔ |
| RF-06 | M2 §2 (`deliverablesComplete`), M3 §1 (guard), M6 §4 (semáforo) | [VEN] §B | ✔ |
| RF-07 | M3 §1 regla 3, M5 (`request-missing`), M6 §4 (contadores) | [PROC] §0 | ✔ |
| RF-08 | M3 §1 (guard `handoff`), M4 §4, M1 §2 | [VEN] D.3, C.5 | ✔ |
| RF-09 | M2 §5, M3 §2–4 (checklists completos), M6 §4 | [PROC] §1.B–3.B | ✔ |
| RF-10 | M2 §5 (`blocking`), M3 §1 regla 4, M4 §6 (notificación) | [PROC] §5, [SQL] §D | ✔ |
| RF-11 | M2 §4, M5 (`decisions`), M6 §4 | [PROC] flujos A | ✔ |
| RF-12 | M2 §7 (`moduleTestCatalog`), M3 §4, M5 (catálogo) | [PROC] §3.A.9, [DEC] B.4 | ✔ |
| RF-13 | M4 §5 (4a/4b) | [VEN] D.4 | ✔ |
| RF-14 | M2 §6, M5 §1 (evento por mutación) | pedido de trazabilidad | ✔ |
| RF-15 | M1 §1 (sin rol), M5 (`escalate`), M4 §6 | [CTX] glosario | ✔ |
| RF-16 | M2 §2 (derivados), M5 (GET lista), M6 §2 | patrón [SYS] | ✔ |
| RF-17 | M5 (`close` + `seedSuggestions`), diseño §8 (Fase 3) | [SYS] | ✔ (gancho) |
| RF-18 | M4 §1, M5 (`preview`/`send`), M6 §5 | pedido explícito | ✔ |
| RF-19 | M4 §1 y §2–5 (obligatorios), M5 (400 con lista), M6 §5 | [VEN] C.8 | ✔ |
| RF-20 | M6 §4 (tres pestañas) | pedido explícito | ✔ |

### Reglas de negocio

| Regla | Encarnada en | Verificación clave |
|---|---|---|
| RN-01 (Ventas confía) | M1 §2 (edición por etapa), M4 §4 (nota de confianza), M6 §4 | El texto "verificar" no existe en ninguna pantalla/correo de Ventas; la verificación vive en los pasos FASE A de Soporte |
| RN-02 (activos ≤ contratados) | M2 §3 (`contractedUsers` obligatorio C1), M3 §2 pasos `c1.a.entregables`/`c1.b.extraerUsuarios`, M4 §3 (correo 2 C1) | ✔ |
| RN-03 (correos reales/únicos) | M3 pasos STOP C1/C3 (y su ausencia en C2), M4 §3 (queries en correo 2 C1) | ✔ |
| RN-04 (lista de usuarios por caso) | M2 §3 (`moduleUsers` SOLO C3; sin campo en C1/C2), M3 §2–4, M4 §3 | El esquema mismo impide el error (CA-M2-3/4) |
| RN-05 (solo datos de compañías al cliente; logo elegido) | M2 §3 (`client` lo llena Ventas; `logoNote`), M4 §3 | ✔ |
| RN-06 (Elasticserver: sin procedimiento, sin NEW SAG) | M4 §2 (prohibiciones probadas) | CA-M4-1 |
| RN-07 (un solo dominio C1) | M2 §3 (un campo), M4 §5 (nota C1 producción) | ✔ |
| RN-08 (accesos pruebas+prod por compañía, de una vez) | M2 §3 (`CompanyDeliverable`), M4 §2 (correo 1 C1) | ✔ |
| RN-09 (scripts por caso y orden) | M3 pasos `c*.b.scripts` (5 / 4 / 4+login) | Cotejado contra [SQL] §C tabla — coincide columna por columna |
| RN-10 (librerías antes de scripts) | M3 `c1.b.actualizarLibrerias` (order menor) | ✔ |
| RN-11 (extracción después de scripts) | M3 `c1.b.extraerUsuarios` (order mayor que scripts) | ✔ |
| RN-12 (producción por caso) | M3 FASE F distinta en cada plantilla | C1 separado / C2 mismo ambiente + borrado / C3 rama |
| RN-13 (reglas de campos SAG Admin) | M2 §5 (`instructions`), M3 pasos FASE C, M5 §3 (NIT crudo + normalización) | ✔ |
| RN-14 (Plesk tras SAG Admin; storage al final) | M3 orden de pasos D tras C | ✔ |
| RN-15 (local solo C3) | M2 §3 (`hosting` solo C3), M3 §4, M4 §2–3, M5 §3 (esquema por caso) | ✔ |
| RN-16 (roles, no nombres) | M1 §1, M4 §1, M6 §6 | ✔ |
| RN-17 (patrón de subdominio) | M5 §3 (validación suave) | Suave por pendiente [DEC] B.7 (H-10) |
| RN-18 (guía de logo en credenciales) | M4 §5 | ✔ |

### No funcionales

| Req | Especificado en | Verificado |
|---|---|---|
| RNF-01 | M2 §3/§8 (referencias), M4 §1/§4/§5, M5 (CA-M5-6) | ✔ |
| RNF-02 | M1 §3, M3 §1, M5 §1 | ✔ |
| RNF-03 | M2 §6 (solo INSERT), M5 (sin update/delete de eventos) | ✔ |
| RNF-04 | M2 §9 (mapeo completo) | ✔ |
| RNF-05 | M2 §2/§5/§7, M3 §5.4 | ✔ |
| RNF-06 | M2 §5 (ids deterministas), M3 §1 regla 1, M5 (CA-M5-4) | ✔ |
| RNF-07 | M6 §1 (y todos los textos de la espec en español) | ✔ |
| RNF-08 | M4 §1 (CA-M4-8) | ✔ |
| RNF-09 | M4 §1, M2 §8 | ✔ |
| RNF-10 | M5 (GET lista), M6 §2 | ✔ |

## B. Cotejo espec-vs-proceso — hallazgos

> Resultado de recorrer la especificación contra [PROC], [SQL], [VEN], [CTX] y [DEC] buscando contradicciones. Clasificación: **CONFIRMADO** (espec fiel), **RESUELTO** (discrepancia encontrada y espec ajustada), **DESVIACIÓN DELIBERADA** (la espec mejora el proceso a propósito, con justificación), **PENDIENTE** (depende de decisión de negocio abierta).

| # | Hallazgo | Clase | Resolución en la espec |
|---|---|---|---|
| **H-01** | **Las fuentes discrepaban en el orden correo-cliente vs. correo-Elasticserver.** [PROC] §1.A/2.A/3.A: requisitos al cliente ANTES de Elasticserver. [VEN] §D: la cadena numeraba Elasticserver primero. | RESUELTO (por Juan Camilo, jul. 2026) | **C1: orden obligatorio cliente → Elasticserver** (la solicitud a Elasticserver necesita el nombre de la BD que entrega el cliente). **C2/C3: orden libre.** Etapa única `solicitudes` con guard por caso (M3 §1); [VEN] §D corregido en la fuente. |
| **H-02** | **C1 puede iniciarlo Soporte.** [PROC] §1.A: "Responsable inicial: Ventas **o Soporte**". La matriz inicial daba la creación solo a Ventas. | RESUELTO | M1 §2 fila 1: Soporte/Líder pueden **abrir** (`draft`); las etapas de Ventas siguen siendo de Ventas. |
| **H-03** | **Orden de scripts:** el docx original de migración corría reportes antes que formatos; el orden canónico ([SQL] §A, carpeta + Visio) es formatos → reportes, y el script 2 crea la tabla que llena el 5. | CONFIRMADO | M3 usa el orden corregido (RN-09). La espec sigue la fuente corregida, no el docx viejo. |
| **H-04** | **Credenciales en correos:** los docx usan placeholders ("nunca datos reales"); nunca hubo intención de contraseñas en texto plano. | DESVIACIÓN DELIBERADA + ACLARADO | M4 §5: los correos 4a/4b **no llevan contraseñas**. Aclarado (jul. 2026): **P&A crea contraseñas NUEVAS** para los usuarios (no se extraen) siguiendo el **estándar de la diapositiva 15 de `SAG Web - Generalidades.pptx`** — la contraseña es la de **SAG Admin**. La documentación detallada del estándar está pendiente de aprobación del texto propuesto (P-06). |
| **H-05** | **El correo 3 (entrega a Soporte) hoy ES el contenedor de la información.** | DESVIACIÓN DELIBERADA | M4 §4: se conserva el correo (el proceso lo exige) pero como **resumen + enlace al sistema**; los datos viven estructurados y las credenciales nunca viajan. Evita divergencia correo-vs-sistema. |
| **H-06** | **Ventas hoy ve las credenciales SQL** (las recibe de Elasticserver por correo). | DESVIACIÓN DELIBERADA | M1 §2: Ventas **registra** accesos (solo-escritura) pero no puede revelarlos. Reducción de exposición sin bloquear el flujo. Requiere aviso operativo a Ventas al desplegar. |
| **H-07** | **[SQL] §B trae un cuarto caso ("Actualización", 3 scripts)** que no es ninguno de los tres procesos. | CONFIRMADO (fuera de alcance) | M3 §5.3: no es una implementación (es mantenimiento de clientes ya en SAG Web — de hecho es el dominio del resto de ESTE sistema). El diseño de plantillas permite agregarlo si el negocio lo pide. |
| **H-08** | **"Enviar credenciales" aparece como paso 15/16 del paso a paso C1**, pero también es la etapa `test_delivery`/`production`. | RESUELTO (doble contabilidad) | M3 §2: el envío NO se duplica como paso del checklist; es el correo de la etapa. Un solo lugar para una sola acción. |
| **H-09** | **¿C2 pide usuarios contratados?** [DEC] B.5 abierto: el correo de prerrequisitos de C2 hoy no lo pide. | RESUELTO (jul. 2026) | El N.º de usuarios contratados es **dato comercial que definen Ventas y el cliente**: lo registra Ventas en el sistema (campo de `collecting`), **no** se pide por correo en ningún caso. M4 §3 no lo incluye en el correo 2. |
| **H-10** | **Patrón de dominio:** [DEC] B.7 detecta un ejemplo con `sagwerp.cloud:44795` vs. el patrón `sagerp.cloud:54678`. | PENDIENTE | M5 §3: validación **suave** (advertencia) del patrón; endurecer cuando se confirme. |
| **H-11** | **Direcciones reales faltantes:** remitente Ventas→cliente y buzón de Soporte ([DEC] B.1). | PENDIENTE | M4 §4: settings vacíos **bloquean el envío** con mensaje accionable (CA-M4-7) — coherente con RF-19, nunca direcciones inventadas. |
| **H-12** | **Links de video** del correo de prerrequisitos C1 ([DEC] B.3). | PENDIENTE | M4 §3: la sección va sin botón hasta tener el link (no placeholder roto). |
| **H-13** | **¿Módulos especiales requieren scripts propios además de los 4+login?** ([SQL] §E). | PENDIENTE | M3 `c3.b.scripts` admite evidencia de scripts adicionales; `moduleTestCatalog` puede anotarlo (`notes`). Si se confirma, versión nueva de la plantilla C3 (RNF-05). |
| **H-14** | El **diseño preliminar** (`docs/DISENO_MODULO_IMPLEMENTACIONES.md` §5) mostraba `infra_request → prerequisites` en secuencia. | RESUELTO | Esta especificación lo **supersede** (H-01). El diseño preliminar queda como visión general; la espec manda. |
| **H-15** | **Hueco multi-tenant en C2 (reportado por Juan Camilo, jul. 2026):** el admin de la plantilla `NEW SAG`, creado tal cual en SAG Admin y asociado a varios clientes nuevos, dejaba UN usuario con acceso a TODOS esos clientes (asociación multi-cliente + credenciales compartidas). | RESUELTO (proceso corregido) | RN-19: el cliente envía en prerrequisitos el **correo real del admin por compañía** → nuevo Paso 3 del paso a paso (`a_sagweb_actualizar_admin`, `ka_nl_tercero = 1`, solo UPDATE) → admins creados en SAG Admin uno por compañía con **contraseña de estándar de compañía** → Elasticserver crea **una BD por compañía**. Paso a paso C2 = 13 pasos. **Sin remediación**: las implementaciones previas ya aplicaban el cambio de correo en la práctica; se formaliza lo que los documentos no reflejaban. |
| **H-16** | **Simplificación implementada (jul. 2026): importación CSV de usuarios en C1.** La creación/asociación manual en SAG Admin fue reemplazada por una importación desde el Detalle del cliente (crea nuevos con contraseña autogenerada, omite existentes/inválidos, asocia todos, descarga Excel de resultados = insumo de credenciales). Query de extracción ahora con NúmeroTelefono; nuevos scripts 08/09/10 en la carpeta C1; nuevo paso STOP de formato de correos (FASE A) espejado al cliente como Consulta 3. | RESUELTO (ya implementado y probado por el negocio) | Plantilla C1 actualizada (`c1.a.correosInvalidos`, `c1.b.extraerUsuarios` CSV+conteo, `c1.c.importarUsuarios`); RN-03/RN-11 actualizadas. Solo C1 por ahora (C3 se definirá después). |

## C. Verificación de cobertura por caso (resumen ejecutivo del cotejo)

| Punto del proceso | C1 espec | C2 espec | C3 espec | ¿Coincide con la fuente? |
|---|---|---|---|---|
| Filtro/rechazo de Ventas | screening ✔ | screening ✔ | sin screening ✔ | ✔ [PROC] |
| Lista de usuarios | no se pide; se extrae a CSV y se **importa** (Pasos 7 y 11) | no existe como lista; **correo del admin por compañía** (RN-19) + cliente crea los suyos | `moduleUsers` del cliente | ✔ RN-04/RN-19 / [DEC] |
| Solicitud a Elasticserver | dominio + pruebas + prod por compañía | dominio + **BD nueva por compañía** | dominio (+pruebas condicional; local sin BD) | ✔ [VEN] D.1, RN-19 |
| Queries de correos (STOP) | sí (**3** pasos blocking: duplicados, vacíos, formato) | no existen | sí (2 pasos blocking) | ✔ [PROC]/[SQL]/[DEC] jul. 2026 |
| Scripts | 5 | 4 + `a_sagweb_actualizar_admin` (por compañía) | 4 + `a_sagweb_migrar_login` | ✔ [SQL] §C/§C quater |
| Librerías antes de scripts | paso previo ✔ | n/a (BD nueva) | n/a | ✔ [PROC] |
| SAG Admin (FASE C, Líder) | cliente+compañías+usuarios+asociar | cliente+compañías+**admin** | reutilizar-o-crear+usuarios del módulo | ✔ [PROC] |
| Plesk tras SAG Admin; storage al final | ✔ | ✔ | ✔ | ✔ RN-14 |
| ¿Pruebas primero? | siempre | siempre | decisión por módulo (catálogo) | ✔ [PROC] §4 |
| Producción | misma publicación y mismo cliente SAG Admin; **solo cambia la BD** (preparar BD prod + reapuntar conexión) | mismo ambiente (borrado de movimientos + reales) | según rama | ✔ RN-12 actualizada ([DEC] jul. 2026) |
| Local/nube | solo nube | solo nube | único con local (IPs firewall) | ✔ RN-15 |

**Conclusión de la verificación:** la especificación cubre los 20 RF, las 18 RN y los 10 RNF; el cotejo encontró **2 discrepancias reales** (H-01, H-02) que se corrigieron en la espec, **3 desviaciones deliberadas** de seguridad/consistencia justificadas (H-04, H-05, H-06) que requieren visto bueno operativo, y **5 pendientes** que ya estaban abiertos en [DEC] y que la espec absorbe sin bloquear (defaults seguros). No quedó ningún elemento de los procesos fuente sin representar en el software, ni ningún elemento del software sin fuente o justificación.

## D. Preguntas abiertas consolidadas (insumo para Juan Camilo antes de construir)

| # | Pregunta | Origen | Estado / default |
|---|---|---|---|
| P-01 | Buzón real de Soporte y remitente de Ventas→cliente | [DEC] B.1 / H-11 | **Abierta.** Envío bloqueado hasta configurar |
| P-02 | ~~¿C2 pide N.º de usuarios contratados?~~ | [DEC] B.5 / H-09 | **RESUELTA:** dato comercial de Ventas; se registra en el sistema, no se pide por correo |
| P-03 | Completar catálogo de módulos C3 (¿pruebas?) | [DEC] B.4 / RF-12 | **Abierta.** Semilla: WMS sí; portales/Power BI no; editable |
| P-04 | Link del video "nombre de la BD" (el de correos únicos ya existe: Canva) | [DEC] B.3 / H-12 | **Semiabierta.** Sección sin botón hasta tener el link |
| P-05 | ¿Quién en Ventas arma la entrega a Soporte? | [DEC] B.6 | **Abierta.** Cualquier `implementation_sales`; queda trazado quién |
| P-06 | ~~Estándar de contraseñas~~ | H-04 | **RESUELTA (texto aprobado):** documentado en `01_contexto_y_glosario.md` §6 bis — contraseña NUEVA de SAG Admin, 8 caracteres (Inicial + 4 del apellido + año + `*`); tildes/ñ tal cual (recordatorio suave). Sufijo "- PRUEBAS" en cliente/compañía de pruebas, se retira al pasar a producción. Los correos siguen sin contraseñas |
| P-07 | ¿Los correos al cliente salen del mismo SMTP o remitente por área? | diseño §11 | **Abierta.** Mismo SMTP configurado |
| P-08 | Confirmar patrón único de subdominio | [DEC] B.7 / H-10 | **Abierta.** Validación suave |
