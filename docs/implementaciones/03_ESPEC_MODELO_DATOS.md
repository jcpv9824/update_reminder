# 03 — Módulo M2: Modelo de datos

> Entidades, campos (con justificación campo a campo donde no es obvio), particiones Cosmos y mapeo a SQL Server. Requisitos que cubre: RF-06, RF-09, RF-11, RF-14, RN-04, RN-05, RN-08, RN-15, RNF-01, RNF-03, RNF-04, RNF-05.

## 1. Vista general

```
implementations (1) ──< implementationSteps      (checklist técnico instanciado)
                 (1) ──< implementationEvents    (línea de tiempo inmutable)
                 (1) ──< emailNotifications      (reutilizado: registro de envíos)
                 (n) ──> users                   (assignees)
                 (0..1) ──> clients              (enlace opcional al maestro)
                 (n) ──> dbAccess seguro         (patrón Key Vault existente, por referencia)
processTemplates (config versionada en código)   (define etapas/pasos/campos por caso)
moduleTestCatalog (catálogo editable)            (C3: módulo → ¿requiere pruebas?)
```

## 2. `implementations` — contenedor nuevo, partición `/id`

*Justificación de partición:* volumen bajo (decenas–cientos por año), documento de tamaño medio, acceso dominante por id. Partición por `/id` = lecturas puntuales baratas; los listados son cross-partition igual que los ya existentes en el sistema (mismo perfil de costo aceptado). En SQL será la tabla raíz.

```ts
interface Implementation {
  id: string;                                   // uuid
  type: "migration" | "new_client" | "special_module";  // RF-01; inmutable tras crear
  name: string;                                 // "Migración — SUMEL"; autogenerado si vacío (patrón de schedules)
  status: "open" | "rejected" | "on_hold" | "completed" | "cancelled";
  currentStageId: StageId;                      // etapa actual (M3)
  templateVersion: number;                      // RNF-05: versión de plantilla con la que se instanció

  clientId?: string;                            // enlace al maestro si ya existe (RF-17)
  clientName: string;                           // denormalizado para listar sin join (patrón existente)

  data: ImplementationData;                     // §3
  assignees: {
    salesUserId?: string;                       // responsable de Ventas
    supportUserId?: string;                     // responsable de Soporte
    leadUserId?: string;                        // Líder de Soporte
  };
  decisions: ImplementationDecision[];          // §4

  // Derivados que se recalculan al escribir (no se confía en el cliente):
  deliverablesComplete: boolean;                // RF-06
  attentionRequired: boolean;                   // RF-16: paso blocked o inactividad > umbral
  lastActivityAt: string;                       // para la bandera de inactividad

  createdAt: string; createdBy: string;
  updatedAt: string; updatedBy: string;
  completedAt?: string;
  rejectionReason?: string;                     // RF-03: obligatorio si status = rejected
}
```

**Justificaciones puntuales:**
- `type` inmutable: cambiar el caso a mitad de proceso invalidaría checklist, correos y datos capturados; el proceso real tampoco lo permite (el caso se decide en el filtro de Ventas). Si Ventas se equivocó, se cancela y se crea otra (queda trazado).
- `status` ≠ `currentStageId`: `status` es el estado de vida (como en Actualizaciones programadas: vida + detalle); `rejected` y `cancelled` son terminales distintos de `completed` porque el negocio los distingue ([PROC] rama "Rechazar solicitud → Fin").
- `on_hold`: los bucles largos ("cliente corrigiendo correos duplicados") pueden durar semanas; `on_hold` evita que la bandera de inactividad grite por implementaciones legítimamente pausadas. Pasa a `on_hold` manualmente con nota (evento).
- Derivados **calculados en el backend** al escribir: la completitud depende de reglas por caso (RN-04, RN-15) que no deben duplicarse en el cliente.

## 3. `ImplementationData` — entregables estructurados (embebido)

Espejo del `Checklist de Ventas - {caso}` [VEN] §B. La plantilla del caso (M3) define qué campos **aplican** y cuáles son **obligatorios para la completitud**; los que no aplican ni se muestran ni se validan (RF-02).

```ts
interface ImplementationData {
  // Licenciamiento y alcance
  contractedUsers?: number;          // C1: obligatorio (RN-02). C2: opcional (pendiente [DEC] B.5). C3: obligatorio.
  licensedModules: string[];         // los 3 casos ([VEN] §B)
  specialModules?: string[];         // C3: módulo(s) a habilitar
  hosting?: "cloud" | "local";       // SOLO C3 (RN-15); obligatorio en C3
  requiresTestEnvironment?: boolean; // C3: resultado de la decisión (RF-12); se sugiere desde moduleTestCatalog

  // Dominio
  domainRequested?: string;          // un solo campo (RN-07); validación suave de patrón (RN-17)

  // Cliente (los llena Ventas; RN-05)
  client: {
    nit: string; name: string;
    contactName: string; contactPhone: string; contactEmail: string;
    logoNote?: string;               // RN-05/[VEN] C.10: QUÉ logo de las compañías representa al cliente (elección explícita de Ventas)
  };

  // Compañías (vienen del cliente; 1..n)
  companies: CompanyDeliverable[];

  // Usuarios del módulo — SOLO C3 (RN-04)
  moduleUsers?: { name: string; documentId: string; email: string }[];

  // Registro de la gestión con Elasticserver (Fase 1: manual)
  elasticserver: { requestedAt?: string; deliveredAt?: string; notes?: string };
}

interface CompanyDeliverable {
  nit: string;                       // se normaliza sin puntos/comas/dígito de verificación al usarse (RN-13)
  name: string;
  contactName: string; contactPhone: string; contactEmail: string;
  hasLogo: boolean;                  // Fase 1 sin adjuntos: se registra que el logo se recibió (dónde está, en notas)
  originalDbName?: string;           // C1: nombre de la BD original ([VEN] §B: "va dentro de los datos de acceso")
  testDbAccessId?: string;           // referencia al acceso seguro (RNF-01) — NUNCA credenciales en claro
  prodDbAccessId?: string;           // C1: RN-08 (se piden ambos de una vez). C3 local: acceso a la BD del cliente.
}
```

**Justificaciones puntuales:**
- **Accesos por compañía** y no por implementación: [DEC] A — "cada compañía tiene su propia base de datos… un juego por cada una". El modelo anterior de "una BD por implementación" sería incorrecto para C1 multi-compañía.
- `moduleUsers` embebido (no contenedor aparte): subconjunto pequeño (usuarios de UN módulo), siempre se lee con la implementación. En SQL: tabla hija `implementation_module_users`.
- **No hay lista de usuarios en C1/C2** (RN-04): el modelo NO tiene campo para "usuarios a migrar" — la extracción de C1 es un **paso del checklist con evidencia** (la lista vive en la evidencia/futuro adjunto), no un entregable de Ventas. *Esto refuerza la decisión de negocio en el esquema mismo.*
- `hasLogo` booleano en Fase 1: los adjuntos son Fase 3; registrar la recepción basta para la completitud sin construir almacenamiento de archivos ahora.

## 4. `ImplementationDecision` (embebido)

```ts
interface ImplementationDecision {
  key: "options_exist" | "hybrid_benefit" | "requires_test_env" | "client_tests_passed" | string;
  value: string;                     // "yes" | "no" | texto corto
  decidedBy: string; decidedByEmail: string; decidedAt: string;
  note?: string;                     // p. ej. qué opciones faltan en SAG Web
}
```
*Justificación:* RF-11. Embebido porque son pocas (≤ ~6 por implementación) y solo tienen sentido con su implementación. `key` abierto (string) para decisiones futuras sin migración. En SQL: tabla hija `implementation_decisions`.

## 5. `implementationSteps` — contenedor nuevo, partición `/implementationId`

*Justificación de partición:* todos los accesos son "los pasos de ESTA implementación" → partición por `implementationId` hace cada lectura/escritura single-partition. En SQL: tabla hija con FK + índice.

```ts
interface ImplementationStep {
  id: string;                        // `${implementationId}:${stepKey}`  (determinista → idempotencia RNF-06)
  implementationId: string;
  stepKey: string;                   // clave estable en la plantilla ("c1.faseA.correosDuplicados")
  stageId: StageId;                  // etapa a la que pertenece
  phase?: "A"|"B"|"C"|"D"|"E"|"F";   // fase técnica ([PROC] §1.B)
  order: number;
  title: string;                     // copiado de la plantilla al instanciar (RNF-05: el título histórico no cambia si la plantilla cambia)
  instructions?: string;             // texto de ayuda (p. ej. reglas de campos SAG Admin — RN-13; query de referencia)
  responsibleRole: "sales" | "support" | "lead";
  blocking: boolean;                 // RF-10: si true y status=blocked, la etapa no avanza
  status: "pending" | "in_progress" | "done" | "blocked" | "not_applicable";
  evidence?: string;                 // qué se hizo / resultado (texto; sanitizado RNF-03)
  blockedReason?: string;            // obligatorio al marcar blocked
  completedBy?: string; completedAt?: string;
}
```

**Justificaciones puntuales:**
- **Instanciar los pasos al crear** (copiar de la plantilla) y no resolverlos al vuelo: RNF-05 — si mañana el proceso cambia, las implementaciones en curso conservan SU checklist; además permite marcar `not_applicable` caso a caso (p. ej. C3: pasos de BD cuando el módulo no la requiere).
- `id` determinista: reintentar una creación no duplica pasos (RNF-06).
- `instructions` guarda las reglas operativas del paso ([PROC] §1.B.8–11, queries de FASE A, orden de scripts RN-09/RN-10) para que el ejecutor no dependa del docx: **el docx sigue siendo la fuente; el sistema lo operacionaliza.**

## 6. `implementationEvents` — contenedor nuevo, partición `/implementationId`

```ts
interface ImplementationEvent {
  id: string;                        // uuid
  implementationId: string;
  at: string; byUserId: string; byEmail: string;
  kind: "created" | "stage_changed" | "data_updated" | "step_completed" | "step_blocked"
      | "step_unblocked" | "decision_made" | "email_sent" | "email_failed"
      | "missing_info_requested" | "escalated" | "put_on_hold" | "resumed"
      | "rejected" | "cancelled" | "reopened" | "closed";
  summary: string;                   // legible en español: "Ventas envió prerrequisitos al cliente (variante nube)"
  metadata?: Record<string, unknown>;// sanitizada con las reglas de auditoría existentes (RNF-03)
}
```
*Justificación:* RF-14. Contenedor propio (no solo `auditLogs`) porque la línea de tiempo se consulta SIEMPRE por implementación y con semántica propia (`kind` del dominio); `auditLogs` global se sigue escribiendo en paralelo para las acciones sensibles (patrón del sistema). **Solo INSERT**: no hay endpoint de edición/borrado de eventos.

## 7. Plantillas de proceso y catálogo (configuración)

- **`processTemplates`**: en Fase 1 viven **en código** (TypeScript tipado, un archivo por caso) con `version` explícita. *Justificación:* las plantillas cambian con revisión de Ingeniería (Juan Camilo es el dueño del diseño de procesos [CTX]); código = revisión por PR + pruebas. Editor visual sería prematuro.
- **`moduleTestCatalog`** (RF-12): documento de configuración en el contenedor de settings existente, editable por admin desde la UI: `{ moduleName: string; requiresTestEnvironment: boolean; notes?: string }[]`. Semilla inicial: WMS → sí; portales → no; Power BI → no ([PROC] §3.A.9). *Justificación:* [DEC] B.4 — la lista está incompleta y la completarán los equipos; debe ser editable sin despliegue.

## 8. Reutilizado sin cambios

| Pieza existente | Uso en el módulo | Requisito |
|---|---|---|
| Almacén seguro de accesos BD (Key Vault + revelar/copiar auditado) | `testDbAccessId`/`prodDbAccessId` referencian accesos guardados con ese patrón | RNF-01 |
| `emailNotifications` + `sendEmail()` | Registro y envío de los correos del flujo | RNF-09 |
| `auditLogs` + sanitización | Acciones sensibles (revelar acceso, enviar credenciales) | RNF-03 |
| `users` / JWT / `permissions.ts` | Autenticación y roles (M1) | RNF-02 |
| `getPagination`/`paginateArray` | Bandeja | RNF-10 |

## 9. Mapeo a SQL Server (RNF-04)

| Cosmos | SQL Server | Notas |
|---|---|---|
| `implementations` | `implementations` | PK `id`; FK opcional `client_id → clients`; CHECK en `type`/`status`; `data.client` → columnas planas; `data.elasticserver` → columnas planas |
| `data.companies[]` | `implementation_companies` | FK + índice; accesos = FKs a la tabla de accesos seguros |
| `data.moduleUsers[]` | `implementation_module_users` | FK + índice |
| `decisions[]` | `implementation_decisions` | FK + índice |
| `data.licensedModules[]`, `specialModules[]` | `implementation_modules` (tabla puente con `kind`) | mismo criterio de la matriz de migración existente |
| `implementationSteps` | `implementation_steps` | FK + índice por `implementation_id`; UNIQUE (`implementation_id`,`step_key`) |
| `implementationEvents` | `implementation_events` | FK + índice; tabla append-only |
| `moduleTestCatalog` | `module_test_catalog` | tabla simple |

## 10. Criterios de aceptación (CA-M2)

- **CA-M2-1:** Crear una implementación C1 instancia exactamente los pasos de la plantilla C1 vigente y guarda `templateVersion`; cambiar la plantilla después NO altera esos pasos.
- **CA-M2-2:** Ninguna respuesta de la API contiene credenciales SQL; los accesos aparecen solo como referencias (`…AccessId`).
- **CA-M2-3:** `deliverablesComplete` es `true` para C1 solo si: `contractedUsers`, dominio, datos de cliente, ≥1 compañía con `originalDbName` + ambos accesos, y `licensedModules` no vacío — y NO exige lista de usuarios (RN-04).
- **CA-M2-4:** `deliverablesComplete` para C3 exige `hosting`, `specialModules`, `moduleUsers` (≥1, con email) y, si `hosting=local`, acceso a BD del cliente por compañía — sin exigir BD de Elasticserver.
- **CA-M2-5:** Los eventos no admiten UPDATE/DELETE por ninguna vía de la API.
- **CA-M2-6:** Reintentar la creación (mismo request-id) no duplica pasos ni eventos.
