# 06 — Módulo M5: API

> Endpoints Azure Functions (mismo patrón del sistema: `app.http`, `authLevel: "anonymous"` + JWT propio, zod, respuestas `ok/badRequest/forbidden/notFound/serverError`). Requisitos que cubre: RF-01–RF-20 (exposición), RNF-02, RNF-03, RNF-06, RNF-10.

## 1. Convenciones

- Autenticación: `getUserOrFail(req)` (patrón existente). Autorización: predicados M1 + guards M3. Orden de validación: **401/403 → 404 → 400 (zod) → 409 (estado)**.
- Toda mutación: escribe evento (RF-14), actualiza `lastActivityAt`, recalcula derivados (`deliverablesComplete`, `attentionRequired`) y escribe `auditLogs` si es sensible.
- Errores en español, accionables (patrón del sistema).

## 2. Endpoints

### Implementaciones

| Método y ruta | Rol mínimo | Qué hace | Notas |
|---|---|---|---|
| `GET /implementations` | viewer | Bandeja: lista con filtros `type`, `status`, `stage`, `clientName`, `assignee`, `attention=true` + paginación | RF-16, RNF-10. Devuelve resumen por ítem (sin `data` completa) para lista liviana |
| `POST /implementations` | sales | Crea la implementación: valida caso, instancia pasos de la plantilla vigente (RNF-05), evento `created` | CA-M2-1/6. Body: `{ type, name?, clientName, clientId?, assignees? }` |
| `GET /implementations/{id}` | viewer | Detalle completo: implementación + pasos + últimas decisiones | Eventos van aparte (paginados) |
| `PATCH /implementations/{id}/data` | según matriz M1 §2 | Actualiza `ImplementationData` (parcial); recalcula completitud; evento `data_updated` con difs de claves (sin valores sensibles) | RN-01: tras `handoff`, 403 para sales (CA-M1-4) |
| `POST /implementations/{id}/transition` | según etapa | `{ to: StageId, note? }` — aplica guards M3 §1; 409 con motivo si la guard falla (p. ej. lista de faltantes) | CA-M3-2/3/8; idempotente (RNF-06) |
| `POST /implementations/{id}/decisions` | según etapa | Registra decisión `{ key, value, note? }`; si es `requires_test_env`, sugiere valor desde `moduleTestCatalog` pero exige confirmación humana | RF-11/12 |
| `POST /implementations/{id}/request-missing` | sales/support | Evento `missing_info_requested` `{ target: "client"|"sales"|"support", detail }`; opcionalmente reenvía el correo de prerrequisitos | RF-07 |
| `POST /implementations/{id}/escalate` | roles del flujo | Evento `escalated` + correo a Ingeniería (setting) | RF-15 |
| `POST /implementations/{id}/hold` / `/resume` | lead/admin | `on_hold` ⇄ etapa actual, nota obligatoria | M3 §1 |
| `POST /implementations/{id}/cancel` | lead/admin | Terminal `cancelled`, nota obligatoria | M3 §1 |
| `GET /implementations/{id}/events` | viewer | Línea de tiempo paginada, orden descendente | RF-14; solo lectura (CA-M2-5) |

### Pasos del checklist

| Método y ruta | Rol | Qué hace |
|---|---|---|
| `GET /implementations/{id}/steps` | viewer | Pasos ordenados por `order`, agrupables por fase |
| `POST /implementations/{id}/steps/{stepKey}/complete` | según `responsibleRole` (M1 §2, fila 7/7b) | `{ evidence? }` — evidencia **obligatoria** en pasos STOP (M3 §5.2); evento `step_completed` |
| `POST /implementations/{id}/steps/{stepKey}/block` | idem | `{ reason }` obligatorio; evento `step_blocked`; recalcula `attentionRequired`; notificación interna |
| `POST /implementations/{id}/steps/{stepKey}/unblock` | idem | `{ resolution }` obligatorio; evento `step_unblocked` |
| `POST /implementations/{id}/steps/{stepKey}/reopen` | lead/admin | `done → in_progress` con nota (correcciones honestas > editar historia) |

*`not_applicable` no tiene endpoint:* lo fija el sistema según los datos (M3 §5.1) al crear o al cambiar `hosting`/decisiones. **Justificación:** evita que el fail-fast se esquive a mano.

### Correos del flujo

| Método y ruta | Rol | Qué hace |
|---|---|---|
| `GET /implementations/{id}/emails/{emailKey}/preview` | quien puede enviarlo (M1 §2 📧) | `{ subject, html, missingFields[] }` — si `missingFields` no está vacío, la UI muestra qué falta y el botón Enviar se deshabilita |
| `POST /implementations/{id}/emails/{emailKey}/send` | idem | Valida obligatorios (400 con lista si faltan — RF-19); si ya se envió, exige `{ confirmResend: true }` (CA-M4-6); envía, registra evento + `emailNotifications` + audit |

`emailKey ∈ { elasticserver_request, client_prerequisites, handoff_to_support, credentials_test, credentials_production }`.

### Catálogo y plantillas

| Método y ruta | Rol | Qué hace |
|---|---|---|
| `GET /implementation-templates` | viewer | Las plantillas vigentes (para que la UI arme formularios y stepper) |
| `GET /module-test-catalog` | viewer | Catálogo C3 módulo→¿pruebas? |
| `PUT /module-test-catalog` | admin | Reemplaza el catálogo (validado con zod); audit | 

### Cierre e integración (gancho RF-17, Fase 3)

| Método y ruta | Rol | Qué hace |
|---|---|---|
| `POST /implementations/{id}/close` | lead/admin | Transición final a `completed`; en Fase 3 devolverá `seedSuggestions` (cliente/dominio/BD a crear en los maestros) |

## 3. Validación (zod) — reglas destacadas

- `type` ∈ los tres casos; inmutable (no existe en el PATCH).
- `data` se valida con **esquema por caso** (el esquema base + refinamientos): C3 exige `hosting`; C1 exige accesos por compañía para completitud; C2 **rechaza** campos de acceso a BD (no aplican — mejor error temprano que dato fantasma).
- `domainRequested`: advertencia (no error) si no cumple el patrón `*.sagerp.cloud` (RN-17 + pendiente [DEC] B.7).
- NITs se aceptan como los escriba el usuario y se **normalizan al usarse** (RN-13): el dato crudo del cliente se conserva (trazabilidad), la normalización es presentación.
- Todo string largo pasa por límites de tamaño (patrón anti-abuso existente).

## 4. Criterios de aceptación (CA-M5)

- **CA-M5-1:** Cada mutación exitosa produce exactamente un evento y actualiza `lastActivityAt` (verificable listando eventos antes/después).
- **CA-M5-2:** `POST /transition` con una transición no listada en M3 §1 devuelve 409 y no escribe nada.
- **CA-M5-3:** `PATCH /data` con campo de otro caso (p. ej. `moduleUsers` en C1) devuelve 400 nombrando el campo.
- **CA-M5-4:** `preview` nunca envía; `send` sin `confirmResend` sobre un correo ya enviado devuelve 409.
- **CA-M5-5:** Un `viewer` obtiene 200 en todos los GET del módulo y 403 en todos los POST/PATCH/PUT.
- **CA-M5-6:** Las respuestas nunca incluyen credenciales SQL ni campos internos de seguridad (reuso del patrón `sanitize`).
