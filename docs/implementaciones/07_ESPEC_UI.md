# 07 — Módulo M6: Interfaz de usuario

> Pantallas y comportamiento por rol, reutilizando los componentes y patrones del frontend existente (React + Vite, TanStack Query, `Modal`, `Alerta`, `EtiquetaEstado`, `Paginacion`, agrupación por estado). Requisitos que cubre: RF-02, RF-16, RF-18, RF-20, RNF-07, RNF-10.

## 1. Navegación

- Nueva entrada de menú **"Implementaciones"** en `AppLayout`, visible solo para roles con acceso (M1) — mismo mecanismo de visibilidad por rol ya usado.
- Ruta `/implementaciones` (lista) y `/implementaciones/{id}` (detalle). Español en todo (RNF-07).

## 2. Bandeja (`/implementaciones`) — RF-16

- **Agrupación por etapa** en secciones (patrón de "Requiere atención / Al día / Completadas" ya aprobado en Actualizaciones programadas): **Requiere atención** (bandera `attentionRequired`) · **En Ventas** (draft→handoff) · **En Soporte** (technical→production) · **Terminadas** (completed/rejected/cancelled).
- Columnas: nombre, caso (etiqueta con color por caso), cliente, etapa actual, responsable de la etapa, días sin movimiento, bandera de atención.
- Filtros: caso, estado, texto (cliente), "solo las mías" (assignee = usuario actual). Paginación con el componente existente.
- Botón **"Nueva implementación"** visible para `implementation_sales`/`admin` (M1 §2 fila 1).
- *Justificación de la agrupación "En Ventas / En Soporte":* el backbone tiene un corte único de responsabilidad (el handoff — RF-08); agrupar por área responde la pregunta operativa diaria ("¿qué tengo yo?") mejor que 11 grupos por etapa.

## 3. Asistente de creación — RF-01/02

Paso 1: **elegir el caso** — tres tarjetas con descripción de una línea ([00_indice] resumen: "Cliente que ya usa SAG Clásico y pasa a SAG Web", etc.). Paso 2: nombre (opcional, autogenera "Migración — {cliente}"), cliente (texto libre o enlazar a cliente maestro existente), asignados. Al crear → navega al detalle.

- El caso **no se puede cambiar** después (M2 §2); el asistente lo advierte antes de crear.
- Si el usuario duda del caso, un enlace "¿Cuál caso aplica?" muestra la tabla comparativa de [PROC] §4 resumida. *Justificación:* elegir mal el caso es el error más costoso del asistente; la guía reduce su probabilidad sin bloquear.

## 4. Detalle (`/implementaciones/{id}`) — RF-20

Encabezado: nombre, caso, cliente, etapa (stepper horizontal con las etapas de SU plantilla — RF-02), bandera de atención, acciones de etapa (transición disponible, pausar, escalar, cancelar) **solo si el rol puede** (M1).

### Pestaña "Avance"
- **Stepper de etapas** con la actual destacada; las etapas omitidas por rama (C3 sin pruebas) se muestran tachadas con nota "no aplica: módulo directo a producción". *Justificación:* ocultarlas del todo haría ilegible la comparación entre implementaciones; tacharlas explica la rama (RF-11/12).
- **Checklist técnico** agrupado por fase (A–F) cuando la etapa ≥ `technical`: cada paso con estado, responsable, instrucciones desplegables (`instructions` — las reglas de SAG Admin, queries, orden de scripts), botones Completar / Bloquear / Desbloquear según rol, y campo de evidencia (obligatorio donde M3 §5.2 lo exige — la UI lo marca con asterisco y el backend lo refuerza).
- Pasos `blocked` en rojo con su motivo, arriba del grupo. Paso N/A en gris con la razón automática.
- **Decisiones**: tarjetas con las decisiones registradas y las pendientes de la etapa (p. ej. `requires_test_env` en C3 muestra la sugerencia del catálogo y pide confirmación).

### Pestaña "Datos"
- Formulario de `ImplementationData` armado **desde la plantilla** (RF-02): solo campos del caso; obligatorios marcados; sección Compañías como lista editable (agregar/quitar) con sus campos por caso (C1: BD original + accesos; C2: sin BD; C3 local: acceso local).
- **Semáforo de completitud** (RF-06): banner con "Faltan: …" nombrando campos; en verde habilita visualmente la entrega a Soporte.
- Accesos de BD: se **registran** hacia el almacén seguro (formulario del patrón existente) y quedan como chip "Acceso registrado ✓ (pruebas)"; revelar/copiar solo para roles técnicos vía el flujo auditado existente (M1 §2). Ventas ve el chip, no el contenido.
- Edición deshabilitada según rol×etapa (M1): tras `handoff`, Ventas ve todo en solo lectura con nota "Entregado a Soporte el DD/MM".

### Pestaña "Historia"
- Línea de tiempo descendente de `implementationEvents` con íconos por `kind`, autor y fecha; los `email_sent` expanden a destinatario + asunto + enlace al contenido enviado.
- Contadores arriba: idas y vueltas de faltantes (RF-07), correos enviados, días por etapa. *Justificación:* es la respuesta directa a "traceability of how the process is going on".

## 5. Envío de correos — RF-18/19

Modal de dos pasos (patrón `Modal` existente):
1. **Vista previa**: asunto, destinatarios editables solo si el rol lo permite, HTML renderizado (iframe sandbox), y si el preview trae `missingFields`, un aviso ámbar "No se puede enviar: faltan …" con enlaces que llevan al campo en la pestaña Datos.
2. **Confirmación**: botón "Enviar" (deshabilitado con faltantes); si ya se envió antes, checkbox explícito "Entiendo que ya se envió el DD/MM y quiero reenviarlo".

## 6. Estados vacíos y errores

- Bandeja vacía: explica qué es una implementación y quién puede crearla.
- 403 en acción: mensaje con el rol necesario ("Esta acción corresponde al Líder de Soporte") — pedagogía del proceso, no un "prohibido" seco (RN-16: siempre en términos de rol).
- 409 de transición: muestra la guard que falló (lista de faltantes, paso bloqueado) con enlaces.

## 7. Criterios de aceptación (CA-M6)

- **CA-M6-1:** Un usuario `implementation_sales` ve el botón "Nueva implementación"; un `implementation_support` no lo ve (y el backend igual lo rechazaría).
- **CA-M6-2:** Al crear un C1, la pestaña Datos muestra accesos por compañía y NO muestra `moduleUsers`; en C3 muestra `hosting` y `moduleUsers` (prueba de render por caso).
- **CA-M6-3:** El stepper de un C3 con `requires_test_env=no` muestra `test_delivery`/`client_testing` tachadas.
- **CA-M6-4:** El modal de envío con faltantes tiene el botón Enviar deshabilitado y lista los campos.
- **CA-M6-5:** Tras `handoff`, los campos de Datos quedan de solo lectura para Ventas con la nota del corte.
- **CA-M6-6:** La Historia muestra el evento del último cambio realizado sin recargar (invalidation de TanStack Query).
