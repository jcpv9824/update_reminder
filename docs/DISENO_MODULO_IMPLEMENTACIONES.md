# Diseño — Módulo "Implementaciones" dentro del Programador de Actualizaciones ERP

> Documento de diseño (análisis de negocio + arquitectura de solución) para convertir los **tres procesos de implementación de SAG Web** —Migración (Caso 1), Cliente nuevo (Caso 2) y Módulos especiales (Caso 3)— en **un solo módulo** dentro del sistema existente, con acceso por roles para todos los interesados, captura de información estructurada, trazabilidad paso a paso y correos enviados directamente desde la plataforma.
>
> Fuentes: `Step-by-step/Documentación maestra (Claude)/01–05` (procesos, glosario, entregables, correos, decisiones).

---

## 1. Objetivo y alcance

**Objetivo:** que Ventas, Servicio al Cliente (Soporte) y el Líder de Soporte trabajen las implementaciones **dentro de este sistema**, en lugar de coordinar por documentos Word/HTML y correos manuales:

- Cada interesado entra con **su usuario y permisos** y ve/edita solo lo que le corresponde.
- Al crear una implementación se **selecciona el caso** (migración / cliente nuevo / módulo especial) y el sistema muestra **solo las etapas, campos y validaciones de ese caso**.
- Toda la información (entregables, datos de compañías, accesos, decisiones) queda **estructurada y trazable**: quién capturó qué, cuándo, y en qué etapa va el proceso.
- Los **correos del flujo** (Elasticserver, prerrequisitos al cliente, entrega a Soporte, credenciales) se generan y envían **desde el sistema**, con las plantillas responsivas ya existentes (`layout()` de `emailTemplates.ts`) y quedan registrados en la línea de tiempo.

**Alcance de la Fase 1 (MVP, confirmado con Juan Camilo):** captura de información + selección de caso + trazabilidad del avance + envío de correos desde el sistema. NO se automatiza aún la ejecución técnica (scripts SQL, Plesk, SAG Admin): esos pasos se registran como **checklist con evidencia**, no se ejecutan desde aquí.

**Principio rector:** los tres casos comparten una **espina dorsal común** (backbone) y difieren solo en configuración. El módulo se diseña como **"proceso como configuración"**: las etapas y campos de cada caso son datos (plantillas de proceso), no código duplicado. Un Caso 4 futuro se agrega definiendo su plantilla, no reescribiendo el módulo.

---

## 2. Los tres procesos como un solo modelo

### 2.1 Backbone común (idéntico en los tres)

```
Apertura → (Filtro de Ventas)* → Solicitud a Elasticserver → Prerrequisitos al cliente
→ Recolección y validación de entregables (bucle de faltantes)
→ Entrega a Soporte (indica el caso) → Paso a paso técnico (fases A–F, por caso)
→ Entrega de credenciales (pruebas)* → Pruebas del cliente (bucle)* → Producción → Cierre
```
\* Con variaciones por caso (ver 2.2).

### 2.2 Diferencias = configuración por caso

| Dimensión | Caso 1: Migración | Caso 2: Cliente nuevo | Caso 3: Módulo especial |
|---|---|---|---|
| Filtro inicial (¿opciones existen? / ¿híbrido? / rechazo) | Sí | Sí | No (entra directo) |
| Lista de usuarios | No se pide (Soporte extrae de la BD) | No se pide (cliente crea los suyos) | Sí (subconjunto del módulo) |
| Solicitud a Elasticserver | Dominio + BD pruebas + acceso a producción, por compañía | Dominio + BD nueva | Dominio; BD pruebas solo si aplica; nada de BD si es local |
| Local / nube | 100% nube | 100% nube | Único caso con BD local (IPs de firewall) |
| Scripts web (checklist técnico) | 5 (incluye `sp_migrar`) | 4 (sin SP) | 4 + `a_sagweb_migrar_login` |
| Queries de correos (duplicados/vacíos) | Sí | No | Sí |
| ¿Pruebas primero? | Siempre pruebas | Siempre pruebas | Decisión por módulo (WMS sí; portales/Power BI directo) |
| Producción | Ambiente separado (repetir preparación) | Mismo ambiente (borrar datos de prueba) | Según la rama elegida |

Todo esto se modela con una **plantilla de proceso por caso** (`processTemplates`): lista ordenada de etapas, cada una con su rol responsable, campos de captura, validaciones, decisiones (ramas) y correo asociado (si lo hay).

---

## 3. Actores, roles y permisos

### 3.1 Nuevos roles (se agregan a los existentes)

El sistema ya tiene `admin`, `client_manager`, `database_updater`, `domain_updater`, `viewer` con JWT y `permissions.ts`. Se agregan **tres roles del flujo de implementación**:

| Rol nuevo | Actor del proceso | Qué puede hacer |
|---|---|---|
| `implementation_sales` (Ventas) | Ventas | Crear implementaciones, elegir el caso, capturar filtro/checklist, registrar solicitud a Elasticserver, enviar prerrequisitos, marcar entregables, hacer la entrega a Soporte. **No** ve credenciales SQL. |
| `implementation_support` (Servicio al Cliente) | Equipo de soporte | Tomar la implementación tras la entrega, ejecutar el checklist técnico (fases A–F), registrar validaciones fail-fast, pedir faltantes, marcar avance. Ve accesos BD vía el flujo auditado existente (revelar/copiar). |
| `implementation_lead` (Líder de Soporte) | Líder de Operaciones/Soporte | Todo lo de soporte + los pasos de SAG Admin (cliente, compañías, usuarios) + **enviar credenciales al cliente** + habilitar producción + cerrar. |

`admin` puede todo; `viewer` puede consultar en solo lectura. Un usuario puede tener varios roles (el modelo de roles ya es un array). **Ingeniería no es actor**: recibe escalamientos — se modela como una acción "Escalar a Ingeniería" que notifica por correo, no como rol con permisos.

### 3.2 Matriz rol × etapa (quién edita qué)

| Etapa | Ventas | Soporte | Líder | admin |
|---|---|---|---|---|
| Apertura + selección de caso | ✏️ | — | — | ✏️ |
| Filtro de módulos (Casos 1–2) / rechazo | ✏️ | 👁 | 👁 | ✏️ |
| Solicitud a Elasticserver | ✏️ + 📧 | 👁 | 👁 | ✏️ |
| Prerrequisitos al cliente | ✏️ + 📧 | 👁 | 👁 | ✏️ |
| Entregables (captura + completitud) | ✏️ | 👁 | 👁 | ✏️ |
| Entrega a Soporte | ✏️ + 📧 | 👁 | 👁 | ✏️ |
| Paso a paso técnico (fases A, B, D) | 👁 | ✏️ | ✏️ | ✏️ |
| Fase C (SAG Admin) | 👁 | 👁 | ✏️ | ✏️ |
| Credenciales al cliente (pruebas/prod) | 👁 | 👁 | ✏️ + 📧 | ✏️ |
| Pruebas del cliente / decisión | 👁 | ✏️ | ✏️ | ✏️ |
| Producción + cierre | 👁 | 👁 | ✏️ | ✏️ |

(✏️ edita · 👁 solo lectura · 📧 puede disparar el correo de esa etapa)

La regla se implementa en el backend (cada endpoint valida rol + etapa actual), no solo en la UI.

---

## 4. Modelo de datos (Cosmos hoy, SQL mañana)

Contenedores nuevos (todas las columnas simples → tablas triviales en SQL Server; los arrays → tablas hijas, igual que la matriz de migración existente):

### 4.1 `implementations` (partición `/id`)
```ts
interface Implementation {
  id: string;
  type: "migration" | "new_client" | "special_module";   // el caso
  name: string;                       // p. ej. "Migración — SUMEL"
  status: "open" | "rejected" | "on_hold" | "completed" | "cancelled";
  currentStageId: string;             // etapa actual (de la plantilla)
  clientId?: string;                  // enlace opcional al cliente maestro existente
  clientName: string;

  // Datos capturados (entregables estructurados; ver 4.2)
  data: ImplementationData;

  // Interesados asignados (para notificaciones y "mi bandeja")
  assignees: { salesUserId?: string; supportUserId?: string; leadUserId?: string };

  // Decisiones registradas (ramas del flujo)
  decisions: { key: string; value: string; decidedBy: string; decidedAt: string; note?: string }[];

  createdAt: string; createdBy: string; updatedAt: string; updatedBy: string;
  completedAt?: string;
}
```

### 4.2 `ImplementationData` — entregables estructurados (embebido)
Espejo del `Checklist de Ventas - {caso}`; los campos que no aplican al caso ni se muestran ni se validan:
```ts
interface ImplementationData {
  contractedUsers?: number;             // N.º usuarios contratados
  domainRequested?: string;             // {cliente}.sagerp.cloud:54678
  licensedModules: string[];            // módulos licenciados
  specialModules?: string[];            // Caso 3: módulos a habilitar
  hosting?: "cloud" | "local";          // Caso 3
  requiresTestEnvironment?: boolean;    // Caso 3: decisión pruebas-vs-producción
  client: { nit: string; name: string; contactName: string; contactPhone: string; contactEmail: string; logoNote?: string };
  companies: CompanyDeliverable[];      // 1..n
  moduleUsers?: { name: string; documentId: string; email: string }[];  // Caso 3
  elasticserver: { requestedAt?: string; deliveredAt?: string; notes?: string };
}
interface CompanyDeliverable {
  nit: string; name: string; contactName: string; contactPhone: string; contactEmail: string;
  originalDbName?: string;              // Caso 1
  testDbAccessId?: string;              // referencia a acceso guardado (ver 4.5) — NUNCA credenciales en claro
  prodDbAccessId?: string;
}
```

### 4.3 `implementationSteps` (partición `/implementationId`)
Instancia del checklist por implementación (una fila por paso de la plantilla — en SQL: tabla hija con FK):
```ts
interface ImplementationStep {
  id: string; implementationId: string;
  stageId: string; stepId: string; order: number;
  title: string; phase?: "A"|"B"|"C"|"D"|"E"|"F";
  responsibleRole: "sales" | "support" | "lead";
  status: "pending" | "in_progress" | "done" | "blocked" | "not_applicable";
  evidence?: string;                    // nota/registro de lo hecho (query corrida, resultado, etc.)
  completedBy?: string; completedAt?: string;
}
```

### 4.4 `implementationEvents` (partición `/implementationId`) — la trazabilidad
Línea de tiempo inmutable (complementa `auditLogs`, que se sigue escribiendo):
```ts
interface ImplementationEvent {
  id: string; implementationId: string; at: string; byUserId: string; byEmail: string;
  kind: "created" | "stage_changed" | "data_updated" | "step_completed" | "decision_made"
      | "email_sent" | "email_failed" | "missing_info_requested" | "escalated" | "reopened" | "closed";
  summary: string;                      // texto legible: "Ventas envió prerrequisitos al cliente"
  metadata?: Record<string, unknown>;   // sanitizada con las reglas existentes (sin password/secret/token)
}
```

### 4.5 Credenciales y accesos — reutilizar lo que ya existe
- Los **accesos SQL** que entrega Elasticserver se guardan con el **mismo patrón de las bases de datos maestras**: contraseña en **Key Vault**, documento con referencia, revelar/copiar **auditado**. `testDbAccessId`/`prodDbAccessId` apuntan a esos registros. **Nunca** credenciales en claro en Cosmos ni en correos.
- Las **plantillas de proceso** (`processTemplates`) se versionan: cada implementación guarda `templateVersion` para que un cambio de proceso no rompa las implementaciones en curso.

### 4.6 Compatibilidad SQL Server
Mismo criterio de la matriz de migración existente: `implementations` → tabla con FK opcional a `clients`; `companies`, `moduleUsers`, `decisions` → tablas hijas; `implementationSteps` y `implementationEvents` → tablas hijas con FK e índice por `implementationId`; enums → `CHECK` constraints. Nada del diseño depende de features exclusivos de Cosmos.

---

## 5. Máquina de estados (etapas)

Etapas del backbone con las ramas por caso. Las transiciones válidas se validan en el backend:

```
 1. draft            → Apertura: caso, cliente, asignados.
 2. screening        → (Casos 1–2) Filtro de módulos con checklist. Salidas: continuar | rechazar (status=rejected).
 3. infra_request    → Solicitud a Elasticserver [correo 1]. Se registra la respuesta (dominio/BD listos).
 4. prerequisites    → Prerrequisitos al cliente [correo 2, HTML por caso/variante].
 5. collecting       → Captura de entregables. El sistema calcula completitud (checklist de Ventas del caso).
                       Bucle: "solicitar faltantes" (evento + correo opcional al cliente).
 6. handoff          → Entrega a Soporte [correo 3: un solo correo con todo + el caso]. Cambia el "dueño" a Soporte.
 7. technical        → Checklist técnico por fases (A–F según el caso). Fail-fast: los pasos de FASE A
                       bloquean el avance si se marcan "blocked" (falta info → volver a collecting).
 8. test_delivery    → (si aplica pruebas) Credenciales de pruebas al cliente [correo 4a]. Caso 3 decide aquí la rama.
 9. client_testing   → Pruebas del cliente. Bucle hasta "aprobado".
10. production       → Promover según el caso (separado / mismo ambiente / rama directa). Credenciales de producción [correo 4b].
11. completed        → Cierre. Gancho de integración (ver §8).
```

Reglas:
- **Fail-fast visible:** un paso bloqueado en FASE A detiene la etapa `technical` y muestra el motivo ("correos duplicados — cliente debe corregir"), replicando la filosofía del paso a paso reordenado.
- **Los bucles no retroceden el estado a ciegas:** "pedir faltantes" es un evento dentro de `collecting`/`technical`, para que la línea de tiempo cuente cuántas idas y vueltas hubo (métrica valiosa).
- Cada transición escribe `stage_changed` en `implementationEvents` + `auditLogs`.

---

## 6. Interfaz (frontend)

Nueva sección **"Implementaciones"** en el menú (visible según rol):

1. **Bandeja / tablero:** lista agrupada por etapa (como la agrupación por estado de Actualizaciones programadas), con filtros por caso, cliente y responsable, y la bandera **"Requiere atención"** (bloqueado o esperando faltantes hace >N días).
2. **Asistente de creación:** elegir caso → el formulario se arma con la plantilla del caso. Reutiliza el patrón de formularios existente (`Modal` + `fila-formulario`).
3. **Detalle de la implementación** (3 pestañas):
   - **Avance:** etapas tipo "stepper" + checklist técnico por fases con checkbox, evidencia y responsable.
   - **Datos:** los entregables estructurados (§4.2) editables según rol×etapa.
   - **Historia:** la línea de tiempo (`implementationEvents`) + correos enviados con su estado.
4. **Botones de correo por etapa:** "Enviar solicitud a Elasticserver", "Enviar prerrequisitos", "Entregar a Soporte", "Enviar credenciales" — cada uno abre una vista previa (asunto + HTML renderizado) antes de enviar.

---

## 7. Correos: automatizar la cadena con la infraestructura existente

Se reutiliza tal cual: `sendEmail()` (SMTP con contraseña en Key Vault), `layout()` responsivo (700px máx., paleta corporativa), auditoría de envíos y el contenedor `emailNotifications`.

**Nuevos builders en `emailTemplates.ts`** (mismo estándar responsivo):

| Builder | Reemplaza a | Contenido clave |
|---|---|---|
| `buildElasticserverRequestEmail(caso, datos)` | Word "Solicitud a Elasticserver" | Dominio solicitado; por caso: BD pruebas + acceso a prod por compañía / BD nueva / BD pruebas condicional. Sin explicar procedimientos ni mencionar NEW SAG. |
| `buildClientPrerequisitesEmail(caso, variante)` | HTML de prerrequisitos (3 casos + 2 variantes del C3) | Requisitos del caso; en migración: regla de activos ≤ contratados, correos únicos (con las 2 queries), nombre de BD; solo datos de compañías. |
| `buildHandoffToSupportEmail(implementación)` | Word "Entrega a Soporte" | Un solo correo con TODO + **indica el caso** + nota "la información es la enviada por el cliente; Ventas no verifica". Dirigido al rol Líder de Soporte. |
| `buildImplementationCredentialsEmail(ambiente)` | Word "Entrega de credenciales" | URL del dominio, usuario; **sin contraseñas** (política del sistema: las credenciales de acceso se entregan por el canal seguro / restablecimiento); portal Zoho para fallos; adjunta/enlaza la guía de logo y formato de impresión. |

Ventajas inmediatas: los placeholders `{{...}}` desaparecen (el sistema rellena con los datos capturados y **no permite enviar** si falta un dato obligatorio), y cada envío queda en la historia con destinatario, fecha y resultado.

**Notificaciones internas automáticas** (reutilizando el motor de timers): al cambiar de etapa se notifica al responsable de la siguiente; recordatorio si una implementación lleva >N días sin movimiento (configurable en "Alertas y correos").

---

## 8. Integración con el sistema actual (el círculo se cierra)

Al llegar a `completed`, el sistema ofrece **sembrar los datos maestros** que este mismo programador ya gestiona:

- Crear el **Cliente** (si no existe) con los datos capturados.
- Crear el **Dominio** (`{cliente}.sagerp.cloud:54678`).
- Crear las **Bases de datos** (una por compañía) reutilizando los accesos ya guardados en Key Vault.
- Sugerir crear la primera **Actualización programada** para ese cliente.

Así una implementación terminada queda automáticamente dentro del ciclo de vida de actualizaciones — sin recapturar nada.

---

## 9. Seguridad (hereda las políticas vigentes)

- Contraseñas SQL y SMTP **solo en Key Vault**; revelar/copiar auditado (mecanismo existente).
- **Ningún correo lleva credenciales SQL**; las credenciales de usuarios de plataforma siguen el flujo de bienvenida/reenvío ya implementado.
- `implementationEvents.metadata` pasa por la **sanitización de auditoría** existente (password/secret/token/jwt).
- Autorización **en el backend** por rol × etapa (la UI solo refleja).
- JWT + login existente (la seguridad de acceso se está reforzando por separado; este módulo no introduce mecanismos nuevos).

---

## 10. Plan por fases

**Fase 1 — MVP (captura + trazabilidad + correos):**
1. Modelos + contenedores (`implementations`, `implementationSteps`, `implementationEvents`) + plantillas de proceso de los 3 casos (seed en código/config).
2. Roles nuevos + matriz rol×etapa en `permissions.ts`.
3. Endpoints CRUD + transiciones + eventos.
4. Los 4 builders de correo + envío con vista previa.
5. Frontend: bandeja, asistente de creación, detalle (Avance/Datos/Historia).

**Fase 2 — Operación asistida:**
- Recordatorios automáticos por inactividad y por etapa; escalamiento a Ingeniería.
- Completitud automática del checklist de Ventas (semáforo de entregables) y bloqueo de "Entregar a Soporte" si falta algo.
- Métricas: duración por etapa, nº de bucles de faltantes, implementaciones por caso/mes.

**Fase 3 — Profundizar:**
- Gancho de cierre → creación de cliente/dominio/BD maestros (§8).
- Adjuntos (logos, evidencias) vía object storage.
- Acceso restringido para el cliente final (ver prerrequisitos y subir sus entregables) — requiere decisión de negocio.

## 11. Preguntas abiertas (antes de construir la Fase 1)

1. **Destinatarios reales:** remitente de Ventas → cliente y buzón del equipo de Soporte (pendiente conocido de `05_decisiones_y_pendientes.md`).
2. ¿Los correos al **cliente** salen desde el mismo SMTP configurado o se quiere un remitente distinto por área?
3. ¿La lista de módulos del Caso 3 que exigen pruebas (hoy: WMS sí; portales/Power BI no) se administra como **catálogo editable** en el sistema?
4. ¿Se desea que Elasticserver conteste **dentro** del sistema (enlace/formulario) o Ventas registra manualmente la respuesta? (Fase 1: manual.)
5. ¿El checklist `Opciones Disponibles 2026.xlsx` se digitaliza en el sistema (catálogo de opciones por versión) o se mantiene como herramienta externa y solo se registra la decisión? (Fase 1: solo la decisión.)
