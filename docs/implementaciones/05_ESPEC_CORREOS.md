# 05 — Módulo M4: Correos del flujo

> Especifica los cuatro builders nuevos sobre la infraestructura existente (`layout()`, `sendEmail()`, registro de notificaciones) y sus reglas de contenido por caso. Requisitos que cubre: RF-04, RF-05, RF-08, RF-13, RF-18, RF-19, RN-06, RN-07, RN-15, RN-16, RN-18, RNF-01, RNF-08, RNF-09.

## 1. La cadena de correos (idéntica estructura en los 3 casos — [VEN] §D)

```
1. Ventas  → Elasticserver : Solicitud de dominio y/o BD          (etapa solicitudes)
2. Ventas  → Cliente       : Prerrequisitos                        (etapa solicitudes)
3. Ventas  → Soporte       : Entrega — UN correo con TODO + caso   (etapa handoff)
4a. Líder  → Cliente       : Credenciales de PRUEBAS               (etapa test_delivery)
4b. Líder  → Cliente       : Credenciales de PRODUCCIÓN            (etapa production)
```
*(No hay correo aparte "solo para el dominio" — regla explícita [VEN] §D. **Orden dentro de `solicitudes`:** en **C1 es obligatorio correo 2 → correo 1** — la solicitud a Elasticserver necesita el nombre de la BD que entrega el cliente; el envío del correo 1 en C1 exige `originalDbName` por compañía. En C2/C3 el orden es libre. Ver H-01 en `08`. La respuesta de Elasticserver se registra manualmente en Fase 1: `elasticserver.deliveredAt`.)*

**Comportamiento común a los cuatro builders:**
- Estándar responsivo existente: `layout()` — máx. 700px, tabla, paleta corporativa, preheader, CTA, `escapeHtml` en todo dato del usuario (RNF-08).
- **Vista previa obligatoria** antes de enviar (RF-18): la UI muestra asunto + HTML renderizado + destinatarios; el envío es un segundo clic.
- **Bloqueo por datos faltantes** (RF-19): el builder declara sus campos obligatorios; si falta alguno, el endpoint de envío devuelve 400 con la lista y la UI muestra qué completar. **No existen placeholders `{{...}}` en producción.**
- Registro: evento `email_sent`/`email_failed` (RF-14) + `emailNotifications` + `auditLogs` (RNF-03/09). Reenviar un correo ya enviado exige confirmación explícita ("ya se envió el DD/MM — ¿enviar de nuevo?") — protege contra dobles envíos a externos (RNF-06).
- **Sin secretos** (RNF-01): ningún builder acepta un campo de contraseña. Verificación en prueba unitaria (como las existentes de "no expone datos SQL").
- Textos con **roles, no nombres** (RN-16): "Líder de Soporte", "equipo de Servicio al Cliente".

## 2. `buildElasticserverRequestEmail` (correo 1)

| Aspecto | Especificación | Fuente |
|---|---|---|
| Destinatario | `requerimientos@elasticserver.co` (configurable en Alertas y correos) | [VEN] §D |
| Contenido común | Nombre del cliente + **solicitud del dominio** (patrón `{cliente}.sagerp.cloud` — RN-17 como sugerencia) | [CTX] §3.1: "en los TRES casos se solicita el dominio" |
| C1 | Por **cada compañía**: solicitar BD de pruebas (copia de la de producción) + accesos a **ambas** (pruebas y producción) — de una sola vez | RN-08, [VEN] D.1 |
| C2 | Solicitar **una BD nueva** — sin explicar el procedimiento, **sin mencionar NEW SAG** | RN-06, [VEN] D.1 |
| C3 nube | BD de pruebas **solo si** `requiresTestEnvironment=true`; si no, solo dominio | [VEN] D.1 |
| C3 local | **Solo dominio** (la BD queda en servidores del cliente) | RN-15 |
| Prohibiciones (validadas en prueba) | No dictar nombres de BD, no explicar procedimientos, no mencionar `NEW SAG`, no incluir credenciales | RN-06 |
| Obligatorios para enviar | `clientName`; C1: ≥1 compañía con `originalDbName`; C3: `hosting` y decisión de pruebas registrada si aplica | RF-19 |

**Justificación del builder único con ramas (vs. 3 builders):** el correo comparte estructura y solo varía la sección "qué solicitamos"; un builder por caso triplicaría las pruebas del layout sin ganancia. Contraste: los prerrequisitos SÍ son plantillas distintas por caso (contenido mayormente disjunto).

## 3. `buildClientPrerequisitesEmail` (correo 2) — una plantilla por caso (+ variante local C3)

| Variante | Contenido obligatorio | Fuente |
|---|---|---|
| **C1** | (a) Regla de usuarios: dejar activos SOLO los que se migran, activos ≤ contratados, cada uno con **correo real y único** en SAG Clásico (RN-02/03); (b) las **dos consultas SQL** (duplicados y sin correo) para que el cliente corrija — en bloque `<pre>` monoespaciado; (c) datos de **las compañías** (RN-05 — NO datos del cliente); (d) **nombre de la BD** (referencia a video — link pendiente [DEC] B.3: hasta tenerlo, la sección va sin botón); (e) **NO** pide lista de usuarios (RN-04); (f) **sin** sección de BD local (100% nube) | [VEN] D.2 |
| **C2** | Datos de las compañías a montar (ID, nombre, contacto, teléfono, logos); **sin** queries, **sin** conexión, **sin** pedir usuarios contratados (dato comercial que registra Ventas — H-09 resuelto) | [VEN] D.2 |
| **C3 nube** | Lista de usuarios del módulo (nombre, ID, **correo único**), datos de compañías; sin datos de conexión | [VEN] D.2, RN-04 |
| **C3 local** | Lo de C3 nube **+** datos de conexión a su BD **+** IPs de firewall a autorizar: `179.32.54.66`, `148.224.28.55` | RN-15 |
| Destinatario | `data.client.contactEmail` (el contacto derivado por Ventas) | [VEN] §B |
| Obligatorios para enviar | contacto del cliente con email; C3: `hosting` definido (elige la variante) | RF-19 |

*Justificación de que sea la plantilla "mejor presentada":* [VEN] C.3 — correo al cliente que requiere reemplazar datos y verse bien → HTML. Es exactamente el punto fuerte del estándar `layout()` existente.

## 4. `buildHandoffToSupportEmail` (correo 3)

| Aspecto | Especificación | Fuente |
|---|---|---|
| Destinatario | Buzón del equipo de Soporte (configurable; **pendiente la dirección real** [DEC] B.1 — el setting nace vacío y el envío se bloquea hasta configurarlo, coherente con RF-19) | [VEN] §D |
| Contenido | **UN solo correo** con TODO: caso (destacado al inicio), cliente, compañías, dominio, módulos, referencias de accesos (SIN credenciales — se indican "registradas en el sistema", RNF-01), usuarios del módulo (C3), decisiones tomadas | [VEN] D.3, regla C.5 |
| Cierre obligatorio | Nota de confianza: *"La información es la enviada por el cliente; Ventas no verifica usuarios reales/únicos/activos"* (RN-01) + saludo al rol "Líder de Soporte" (RN-16) | [VEN] D.3 |
| CTA | Enlace directo al detalle de la implementación en el sistema | Nuevo (mejora): el correo deja de ser el contenedor de los datos y pasa a ser la notificación del corte — los datos viven en el sistema |
| Obligatorios para enviar | `deliverablesComplete=true` (es la misma guard de la transición `collecting → handoff`) | RF-06/08 |

**Justificación del cambio más importante vs. el proceso en papel:** hoy el correo 3 ES el repositorio de la información. En el sistema, la información ya está estructurada y auditada; el correo se conserva (el proceso lo exige y Soporte vive en el correo) pero como **notificación con resumen + enlace**, evitando la divergencia correo-vs-sistema. Las credenciales, que hoy viajan en ese correo, quedan solo en el almacén seguro — reducción de riesgo directa.

## 5. `buildImplementationCredentialsEmail` (correos 4a/4b)

| Aspecto | Especificación | Fuente |
|---|---|---|
| Variantes | `environment: "test" | "production"` — asunto y encabezado distinguen claramente el ambiente | [VEN] D.4 |
| Contenido | URL de acceso (dominio del cliente); usuario(s) de acceso; **cómo reportar fallos**: portal Zoho `https://crmpya.zohodesk.com/portal/es/newticket`, opción "SAG Web"; firma con rol | [VEN] D.4 |
| Contraseñas | **NUNCA en el correo** (RNF-01). El correo indica que las contraseñas se entregan por el canal seguro definido. *(Ver hallazgo H-04 en `08`: los docx actuales usan `{{placeholders}}` — nunca hubo intención de credenciales reales en texto; el sistema formaliza la entrega segura.)* | [VEN] D.4 + política [SYS] |
| Guía de logo/formatos | Sección propia con la guía «Cómo configurar el logo y el formato de impresión…» (enlace; sin formato asignado SAG Web falla al imprimir) — RN-18 | [VEN] D.4 |
| C1 producción | Recordar que es el **mismo dominio** de siempre, ahora apuntando a producción (RN-07) | [CTX] §3.1 |
| Obligatorios para enviar | dominio entregado, contacto del cliente; 4a solo si la plantilla/rama incluye pruebas; 4b solo tras FASE F | RF-13, M3 |

## 6. Notificaciones internas (secundarias, reutilizan el motor de timers)

| Notificación | Disparador | Destinatario | Justificación |
|---|---|---|---|
| "Nueva implementación entregada a Soporte" | Transición a `technical` | `assignees.supportUserId` / buzón de Soporte | El handoff es el corte de responsabilidad (RF-08); sin aviso, el sistema depende de que Soporte mire la bandeja |
| "Paso bloqueado" | `step_blocked` en paso `blocking` | Responsables + Líder | RF-10: el fail-fast debe doler pronto |
| "Implementación sin movimiento > N días" | Timer diario (reutiliza patrón de overdue) sobre `lastActivityAt`, excluyendo `on_hold` | Responsable de la etapa actual | RF-16; N configurable en Alertas y correos |
| "Escalamiento a Ingeniería" | Acción escalar (RF-15) | Dirección de Ingeniería (setting) | [CTX]: Ingeniería solo recibe escalamientos |

## 7. Criterios de aceptación (CA-M4)

- **CA-M4-1:** Enviar el correo 1 de un C2 produce un HTML que contiene el dominio y la solicitud de BD nueva y **no contiene** "NEW SAG" ni nombres de BD dictados (prueba unitaria).
- **CA-M4-2:** El correo 2 de C1 contiene las dos consultas SQL, la regla activos ≤ contratados y NO contiene petición de lista de usuarios; el de C2 no contiene consultas.
- **CA-M4-3:** El correo 2 de C3 con `hosting=local` incluye las dos IPs de firewall; con `cloud` no las incluye.
- **CA-M4-4:** El correo 3 se rechaza (400) si `deliverablesComplete=false`, y su HTML contiene el caso, la nota de confianza y cero credenciales.
- **CA-M4-5:** Los correos 4a/4b nunca contienen contraseñas (prueba con acceso poblado) e incluyen Zoho + guía de logo.
- **CA-M4-6:** Un envío exitoso genera exactamente un evento `email_sent` y un registro en `emailNotifications`; un reenvío requiere confirmación y queda como segundo evento.
- **CA-M4-7:** Con el buzón de Soporte sin configurar, el envío del correo 3 devuelve 400 con mensaje accionable (no un envío a dirección inventada).
- **CA-M4-8:** Todos los HTML pasan por `layout()` (contienen `max-width` y el preheader) y escapan datos del cliente (`<script>` en un nombre no aparece en el HTML).
