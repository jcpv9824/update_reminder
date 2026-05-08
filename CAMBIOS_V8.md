# Cambios incrementales — Versión 8

## Resumen

| Tema | Resultado |
|---|---|
| Bug "tarea de mañana aparece bajo HOY" | **Corregido**. Comparación de fechas en zona Bogotá (no UTC). |
| Botón **Bloquear** en flujo de actualizador | **Eliminado** del UI. |
| Flujo de **Completar** | Nuevo modal de confirmación con checkbox de problema y notas. |
| **Email a admins** cuando se completa con problemas | Implementado. |
| **Nombres reales** de responsables en cards | Implementado (carga `/users` cuando admin/client_manager). |
| **Highlight** "Asignado a ti" / "Tu rol puede atender" | Implementado con badges. |
| Modal NO cierra por backdrop | Mantenido (regresión cubierta). |
| Pruebas | **93 backend + 47 frontend = 140** (todas verdes). |

---

## 1. Causa raíz del bug "2026-05-08 aparece bajo HOY"

`new Date().toISOString().slice(0, 10)` devuelve la **fecha en UTC**, no en hora Bogotá. Bogotá es UTC-5: a las **7:00 PM hora local del 7**, en UTC ya son las **00:00 del 8**, por lo que `toISOString()` retorna `"2026-05-08"`. La página entonces consideraba "hoy" = `2026-05-08` y la tarea del 8 caía bajo HOY.

## 2. Cómo se arregló la clasificación

Nuevo helper `frontend/src/utils/fechas.ts`:

```ts
const APP_OFFSET_HORAS = -5;
export function hoyEnBogotaIso(now: Date = new Date()): string {
  const ms = now.getTime() + APP_OFFSET_HORAS * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function clasificarTareaPorFecha(taskDate, status, hoyIso = hoyEnBogotaIso()) {
  if (status === "completed") return "completadas";
  if (taskDate < hoyIso) return "vencidas";
  if (taskDate === hoyIso) return "hoy";
  return "proximas";
}
```

`TareasPage.tsx` y la URL `/tasks?dateFrom=...&dateTo=...` usan ese `HOY` consistente. El backend (`tasks.ts`) también compensa por hora Bogotá:

```ts
const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
```

Pruebas (`fechas.test.ts`):
- A las **8 PM Bogotá** del 7, `hoyEnBogotaIso` devuelve `"2026-05-07"` (no 08).
- Tarea `2026-05-08` con today `2026-05-07` → `proximas`.
- Tarea `2026-05-07` con today `2026-05-07` → `hoy`.
- Tarea `2026-05-06` pendiente con today `2026-05-07` → `vencidas`.
- Tarea completada → siempre `completadas`.

## 3. **Bloquear** removido del UI

El botón **Bloquear** se eliminó del detalle de grupo. Las acciones visibles ahora son:
- Copiar dominio / Copiar base
- Iniciar (cuando `status === "pending"`)
- **Completar** (abre confirmación)
- **Reportar problema** (mantiene flujo `fail` con prompt para describir)
- **Reabrir** (cuando `status === "completed"`)

El endpoint backend `tasks/{id}/block` sigue existiendo por compatibilidad, pero el UI ya no lo expone. Prueba: `no muestra el botón Bloquear en el detalle del grupo`.

## 4. Nuevo flujo de completar con confirmación

Cuando se hace clic en **Completar**:

1. Se abre el modal **"Confirmar actualización"**.
2. Texto: *"Confirma que completaste esta actualización."*
3. Checkbox: *"¿Tuviste algún problema durante la actualización?"*.
4. Si está marcado, aparece textarea *"Describe el problema encontrado"* (obligatorio para confirmar).
5. Textarea opcional *"Nota de actualización"*.
6. Botones **Cancelar** y **Confirmar actualización**.

El payload enviado al backend es:

```json
{
  "withProblems": true|false,
  "problemNote": "...",
  "completionNote": "...",
  "notes": "...",
  "result": "completed_with_problems" | "success"
}
```

Backend (`api/src/functions/tasks.ts`):
- Si `withProblems === true`, marca `t.completedWithProblems = true` y guarda `t.problemNote` (truncado a 4000 chars).
- Auditoría usa la acción `task_completed_with_problems` cuando aplique (en lugar de `task_completed`).
- Limita `notes`/`problemNote`/`completionNote`/`result` a longitudes seguras.

Modelo (`UpdateTask`):
```ts
completedWithProblems?: boolean;
problemNote?: string;
completionNote?: string;
```

Una tarea puede ser `status="completed"` y a la vez tener `completedWithProblems=true`. Esto es **distinto** de `failed`.

## 5. Email a admins cuando se completa con problemas

`tasks.ts` dispara (asíncronamente, sin bloquear la respuesta) `notificarProblemaAdmins(t, performedByEmail)`:

1. Carga la configuración global de email.
2. Busca usuarios activos con rol `admin`.
3. Si hay destinatarios, envía email con asunto:
   - `"Problema reportado en actualización de dominio"` o
   - `"Problema reportado en actualización de base de datos"`.
4. Cuerpo (todo escapado con `escapeHtml`):
   - Cliente, dominio, base/empresa (si aplica), fecha, completada por, completada en, **problema reportado**, link a `frontendBaseUrl/tareas`.
5. **Nunca** incluye SQL user, password, server/port, connection strings, secret values ni tokens. Cubierto en `completionFlow.test.ts`:
   ```ts
   expect(html.toLowerCase()).not.toContain("password");
   expect(html.toLowerCase()).not.toContain("secret");
   expect(html.toLowerCase()).not.toContain("smtp");
   expect(html.toLowerCase()).not.toContain("token");
   expect(html.toLowerCase()).not.toContain("user id");
   expect(html.toLowerCase()).not.toContain("initial catalog");
   ```
6. Si no hay admins activos, la tarea ya quedó guardada y la función simplemente termina sin enviar nada (no rompe).

## 6. Nombres reales de responsables

`TareasPage` ahora carga `/users` (cuando el usuario tiene rol admin o client_manager) y resuelve los `assignedUserIds` a `displayName` para mostrar en cards.

`etiquetaResponsableDeGrupo`:
- 0 ids → fallback al rol (ej. *"Actualizador de dominios"*).
- 1 id que coincide con el usuario actual → *"Tú"*.
- 1-2 ids → muestra los nombres separados por coma.
- 3+ ids → *"3 responsables"*.

Ejemplos:
```
Mateo — Dominios por actualizar
Laura, Carlos — Bases de datos por actualizar
3 responsables — Dominios por actualizar
Actualizador de dominios — Dominios por actualizar       (sin asignados)
```

En el detalle se muestra **Responsables: Mateo Palacio**.

## 7. Highlight de cards asignadas al usuario actual

Cada grupo calcula:
- `asignadoAlActual = ids.includes(usuario.id)`.
- `rolHabilitaActual = ids.length === 0 && el usuario tiene el rol matching`.

Render:
- `asignadoAlActual` → clase `item-tarea-asignada` (borde dorado, badge **Asignado a ti**).
- `rolHabilitaActual` → clase `item-tarea-rol-actual` (borde gris-azul, badge **Tu rol puede atender esta tarea**).

CSS (`styles.css`):
```css
.item-tarea-asignada { border-left: 4px solid var(--color-accent); background: rgba(211, 193, 147, 0.10); }
.item-tarea-rol-actual { border-left: 4px solid var(--color-secondary); background: rgba(126, 153, 178, 0.08); }
.badge-asignado { background: var(--color-accent); ... }
.badge-rol { background: rgba(126, 153, 178, 0.4); ... }
```

Pruebas:
- `resalta el grupo asignado al usuario actual con el badge 'Asignado a ti'`.
- `muestra 'Tu rol puede atender esta tarea' cuando no hay asignado y el rol coincide`.

## 8. Permisos

`puedeCambiarTarea(usuario, tarea)`:
- Admin → siempre puede.
- Asignado directo → puede.
- Sin asignado y rol matching → puede (`domain_updater` para dominios, `database_updater` para bases).
- Otros → no puede; UI muestra *"Sin permiso"* en lugar de los botones.

Backend mantiene la misma validación con `canCompleteDatabaseTask` / `canCompleteDomainTask` + bypass admin.

## 9. Contadores y estados de grupo

```
Total: 12
Completadas: 10
Pendientes: 1
Con problemas: 1
Estado: Con problemas
```

Reglas (en `calcularEstadoGrupo`):
1. Si alguna tarea tiene `completedWithProblems` o `status==="failed"` → **Con problemas**.
2. Sino, si todas están `completed` → **Completado**.
3. Sino, si la fecha < hoy y hay pendientes → **Vencido**.
4. Sino, si alguna en progreso/completed/reopened → **En progreso**.
5. Sino → **Pendiente**.

## 10. Modal — sin regresión

`Modal` en `components/Comunes.tsx` mantiene la solución de la ronda anterior:
- No invoca `onCerrar` desde el backdrop por defecto.
- `onMouseDown` se detiene en el modal para evitar cierre por drag de selección.
- Se cierra solo con **Cerrar / Cancelar / Confirmar / Guardar**.

## 11. Resultados

```
Backend  : 93 / 93 passed (19 archivos)
Frontend : 47 / 47 passed (10 archivos)
tsc API  : OK
tsc Front: OK
vite build: OK · index-CWJ3igs0.js 303.96 kB · index-BnUBHjS3.css 8.66 kB
```

## 12. Riesgos / pendientes

- El email a admins se dispara con `void notificar...(...)`. Si el proveedor `mock` no está configurado o falla la conexión SMTP, la tarea ya quedó guardada y solo se omite el email; no hay reintento automático ni cola persistente.
- Cuando admin/client_manager no carga `/users` (por ejemplo si el usuario actual no tiene permiso para listar usuarios), las cards mostrarán los IDs en lugar de nombres. Para usuarios sin acceso a `/users`, hoy es la única opción razonable sin filtrar datos sensibles. Considerar más adelante un endpoint `/users/public-names` que devuelva solo `id + displayName` para todos los autenticados.
- El offset Bogotá está hardcoded en `-5`. Si en el futuro la zona horaria de la app cambia, mover a una variable de entorno `APP_TIMEZONE_OFFSET`.

## 13. Archivos modificados / nuevos

### Backend
- `api/src/functions/tasks.ts` — flujo `complete` con `withProblems`, email a admins, today por hora Bogotá.
- `api/src/types/models.ts` — campos `completedWithProblems`, `problemNote`, `completionNote`.
- `api/src/tests/completionFlow.test.ts` *(nuevo, 3 pruebas)*.

### Frontend
- `frontend/src/utils/fechas.ts` *(nuevo)* — helper de zona Bogotá.
- `frontend/src/pages/TareasPage.tsx` — refactor: clasificación correcta, modal de confirmación, sin Bloquear, nombres reales, highlight.
- `frontend/src/types.ts` — campos en `Tarea`.
- `frontend/src/styles.css` — clases `item-tarea-asignada`, `item-tarea-rol-actual`, `badge-asignado`, `badge-rol`.
- `frontend/src/tests/fechas.test.ts` *(nuevo, 8 pruebas)*.
- `frontend/src/tests/TareasPage.test.tsx` — adaptado al nuevo flujo, +pruebas para Bloquear oculto, modal confirmación, withProblems, próximas, badges.
