# 02 — Módulo M1: Roles y permisos

> Especifica los actores del flujo como roles del sistema, la matriz rol × etapa y su implementación sobre la infraestructura existente (`roles: string[]` en `UserRecord`, `permissions.ts`, JWT). Requisitos que cubre: RF-15, RN-01, RN-16, RNF-02.

## 1. Actores del proceso → roles del sistema

| Actor (proceso) | Rol nuevo | Etiqueta en UI (`ETIQUETAS_ROLES`) | Justificación |
|---|---|---|---|
| Ventas | `implementation_sales` | "Implementaciones — Ventas" | [VEN]: Ventas filtra, pide requisitos, reúne/organiza entregables y entrega a Soporte. Necesita crear implementaciones y operar las etapas 1–6. |
| Servicio al Cliente (equipo de Soporte) | `implementation_support` | "Implementaciones — Soporte" | [PROC] §0: ejecuta el paso a paso técnico. Opera el checklist (fases A, B, D, E) y las validaciones fail-fast. |
| Líder de Operaciones = Líder de Soporte | `implementation_lead` | "Implementaciones — Líder de Soporte" | [PROC] §0 y §1.B FASE C: hace la parte de SAG Admin y el envío final de credenciales. Es "rol distinto pero mismo equipo" → rol separado que **incluye** los permisos de `implementation_support`. |
| Ingeniería | **(sin rol)** | — | [CTX] glosario: "Ingeniería NO es actor del flujo; solo recibe escalamientos". Se modela como acción "Escalar" (RF-15) que envía correo a una dirección configurable. Darle rol violaría el proceso. |
| Cliente final | **(sin rol en Fase 1)** | — | El cliente actúa por correo (recibe prerrequisitos y credenciales, hace pruebas). Darle acceso es decisión de negocio pendiente (Fase 3). |

**Reglas de composición:**
- Los roles existentes (`admin`, `client_manager`, `database_updater`, `domain_updater`, `viewer`) **no cambian de significado**. `admin` puede todo en el módulo; `viewer` puede leer todo el módulo; los otros tres **no ven** el módulo salvo que además tengan un rol de implementación. *Justificación:* principio de mínimo privilegio; un actualizador de dominios no participa del flujo de implementación.
- `implementation_lead` ⊇ `implementation_support` (jerarquía en código: `canExecuteTechnical(u) = hasRole(support) || hasRole(lead) || isAdmin`). *Justificación:* [CTX] "mismo equipo"; el líder también ejecuta pasos técnicos.
- Un usuario puede tener **varios roles** (el modelo ya es `string[]`). En equipos pequeños una persona puede ser Ventas y Soporte a la vez; el sistema lo permite pero la **trazabilidad registra el usuario**, no el rol, así que no se pierde quién hizo qué.

## 2. Matriz rol × etapa (autorización de mutaciones)

Leyenda: **E** = editar/ejecutar · **L** = solo lectura · **📧** = puede disparar el correo de esa etapa · — = sin acceso (el módulo exige al menos un rol de implementación, `admin` o `viewer`).

| # | Etapa (M3) | `implementation_sales` | `implementation_support` | `implementation_lead` | `admin` | `viewer` |
|---|---|---|---|---|---|---|
| 1 | `draft` (apertura, selección de caso, asignados) | E | E* | E* | E | L |
| 2 | `screening` (filtro C1/C2; decisión rechazar) | E | L | L | E | L |
| 3–4 | `solicitudes` (correo 1 a Elasticserver + correo 2 de prerrequisitos, orden libre) | E + 📧 | L | L | E + 📧 | L |
| 5 | `collecting` (captura de entregables, completitud, faltantes) | E | L | L | E | L |
| 6 | `handoff` (entrega a Soporte) | E + 📧 | L | L | E + 📧 | L |
| 7 | `technical` — pasos de fases A, B, D, E | L | E | E | E | L |
| 7b | `technical` — pasos de **FASE C (SAG Admin)** | L | L | E | E | L |
| 8 | `test_delivery` (credenciales de pruebas) | L | L | E + 📧 | E + 📧 | L |
| 9 | `client_testing` (registro de pruebas y decisión) | L | E | E | E | L |
| 10 | `production` (promover + credenciales de producción) | L | L | E + 📧 | E + 📧 | L |
| 11 | `completed` / `rejected` / `cancelled` (cierres) | L | L | E | E | L |
| * | "Solicitar faltantes" (RF-07) | E (etapas 3–6) | E (etapa 7+) | E | E | — |
| * | "Escalar a Ingeniería" (RF-15) | E | E | E | E | — |
| * | Editar datos (`ImplementationData`) | E hasta `handoff` | E de campos técnicos tras `handoff` | E tras `handoff` | E | — |
| * | Revelar/copiar accesos SQL vinculados | — | E (auditado) | E (auditado) | E (auditado) | — |

\* **Fila 1 (`draft`, E* para Soporte/Líder):** [PROC] §1.A — el responsable inicial de una migración es "Ventas **o Soporte**". Soporte puede **abrir** la implementación (registrar la solicitud), pero las etapas de Ventas (`screening`–`handoff`) siguen siendo de Ventas: una implementación abierta por Soporte queda esperando a Ventas. *(Hallazgo H-02 del cotejo, ver `08`.)*

**Justificaciones de las filas sensibles:**
- **Fila 7b (FASE C solo Líder):** [PROC] §1.B FASE C está marcada "· Líder de Operaciones *(← handoff desde Servicio al Cliente)*". El proceso separa explícitamente esa responsabilidad; la matriz lo refleja para que el software refuerce el handoff interno.
- **Filas 8 y 10 (credenciales solo Líder):** [PROC] §0: el Líder hace "el envío final de credenciales". Además concentra en el rol de mayor confianza los correos que tocan accesos del cliente.
- **Ventas sin acceso a accesos SQL:** RN-01 — Ventas organiza entregables pero la operación técnica (y ver credenciales) es de Soporte. Los datos de acceso que recoge Ventas se capturan **una vez** hacia el almacén seguro (escribir ≠ leer): Ventas puede registrar un acceso nuevo pero no revelar uno guardado. *Justificación:* minimiza exposición sin bloquear el flujo real (hoy Ventas ve esas credenciales al recibirlas de Elasticserver; el sistema reduce ese privilegio a solo-escritura).
- **Edición de datos por etapa:** después de `handoff`, los entregables que Ventas capturó quedan **de solo lectura para Ventas** (los corrige Soporte o se registra un evento de faltantes). *Justificación:* [VEN] D.3 — la entrega es un corte formal ("la información es la que envió el cliente"); ediciones posteriores silenciosas romperían la trazabilidad del corte.

## 3. Implementación sobre lo existente

- `VALID_ROLES` (en `users.ts`) y `ETIQUETAS_ROLES` (frontend) se extienden con los tres roles. Sin migración de datos: los usuarios existentes simplemente no tienen los roles nuevos.
- `permissions.ts` agrega predicados puros (testeables): `canManageImplementationSales(u)`, `canExecuteImplementationTechnical(u)`, `canExecuteImplementationAdminPhase(u)`, `canSendImplementationEmail(u, emailKey)`, `canViewImplementations(u)`.
- Cada endpoint de M5 valida: (1) predicado de rol, (2) etapa actual permite la acción (matriz §2), (3) transición válida (M3). El orden importa: primero autenticación/rol (403), luego estado (409/400). *Justificación:* RNF-02; respuestas coherentes con el resto de la API.
- La UI (M6) usa los mismos predicados replicados en el frontend **solo para mostrar/ocultar**; nunca como única barrera.

## 4. Criterios de aceptación (CA-M1)

- **CA-M1-1:** Un usuario con solo `implementation_sales` puede crear una implementación y operar hasta `handoff`, pero recibe 403 al intentar completar un paso técnico o enviar credenciales.
- **CA-M1-2:** Un usuario con solo `implementation_support` recibe 403 al intentar completar un paso de FASE C; con `implementation_lead` lo logra.
- **CA-M1-3:** `viewer` puede leer bandeja, detalle e historia, y recibe 403 en toda mutación.
- **CA-M1-4:** Tras `handoff`, un PATCH de datos por `implementation_sales` devuelve 403 y no genera evento.
- **CA-M1-5:** "Escalar a Ingeniería" funciona para los tres roles del flujo y NUNCA otorga acceso al recurso escalado (solo evento + correo).
- **CA-M1-6:** Ningún endpoint del módulo responde datos a un usuario sin rol de implementación, `admin` o `viewer`.
