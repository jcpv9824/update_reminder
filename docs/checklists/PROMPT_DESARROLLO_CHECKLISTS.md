# Prompt — Construir y desplegar «Checklists de implementación»

Copie todo lo que está debajo de la línea y péguelo en Codex, abierto en el repositorio `erp-update-scheduler`.

---

## Meta

Construir, probar y **desplegar en producción** las dos opciones nuevas del Portal SAG Web descritas en la
especificación, siguiendo **desarrollo basado en especificaciones**. La meta se cumple solo cuando **todo** lo
siguiente es verdad y tiene evidencia:

1. Cada requisito de la especificación (`RN-`, `P-`, `API-`, `RNF-`) está implementado.
2. Cada casuística `CA-01` … `CA-38` tiene **al menos una prueba automática** que cita su identificador en el
   nombre, y todas pasan.
3. La matriz de trazabilidad (sección 16 de la especificación) está completa y al día: requisito → código → prueba.
4. El recorrido completo funciona en el navegador, comparado contra el mockup, con capturas como evidencia.
5. Está desplegado en producción (frontend, API y migración SQL) y la verificación posterior al despliegue pasó.

## Fuentes (léalas completas antes de escribir código)

- **Especificación (fuente de verdad):**
  `C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\docs\checklists\ESPEC_CHECKLISTS_IMPLEMENTACION.md`
- **Mockup navegable:** `…\docs\checklists\mockup_checklists.html`. Ábralo en el navegador. Es la referencia visual
  y de comportamiento; los colores, la tipografía y los componentes reales salen de `DESIGN_SYSTEM.md` y
  `frontend/src/styles.css`.
- Protocolo del repositorio: `AGENTS.md`, `ARCHITECTURE.md`, `DESIGN_SYSTEM.md`,
  `docs/PORTAL_SAG_WEB_APP_GUIDELINES.md`, `docs/ENGINEERING_SKILLS_AND_TESTING.md`,
  `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md`.
- Editor que se reutiliza: `frontend/src/pages/queHayDeNuevo/componentes/EditorEnriquecido.tsx` y
  `api/src/lib/whatsNewRichText.ts` (ya están en `main`).

> Si la especificación y el código no coinciden, o si algo de la especificación es imposible o inseguro, **pare y
> pregunte** antes de inventar. No agregue nada que no esté en la especificación.

## Autorización

Juan Camilo autoriza, **solo para esta funcionalidad**:

- Crear una rama, hacer commits, push y abrir y fusionar el PR a `main` cuando todas las pruebas estén en verde.
- Correr en producción la migración SQL nueva de esta funcionalidad (tablas y permisos de checklists).
- Publicar la API en producción y dejar que el push a `main` despliegue el frontend.

No autoriza: cambiar App Settings, RBAC, el proveedor de almacenamiento, timers ajenos, ni tocar datos que no
sean de esta funcionalidad. Si el despliegue exige algo de eso, pare y pregunte.

## Cómo trabajar

1. **Árbol de trabajo limpio.** La copia `erp-update-scheduler` en `main` tiene cambios locales que no son
   suyos. No los toque. Cree un worktree nuevo desde `origin/main` (rama `feature/checklists-implementacion`) y
   copie ahí la carpeta `docs/checklists/` (especificación, mockup y este prompt). Esa carpeta va en el primer
   commit.
2. **Contrato primero.** Antes de programar en paralelo, deje escritos los tipos de request/response, los esquemas
   `zod`, las claves de permiso, los códigos de error y la propiedad de las transacciones SQL de la sección 10. Si
   usa agentes (`frontend`, `api-domain`, `sql-data`), todos trabajan contra ese contrato.
3. **Pruebas antes que lógica.** Por cada `CA-xx`, escriba primero la prueba (API con vitest; frontend con
   Testing Library) y véala fallar. Luego implemente hasta que pase. Agregue además las pruebas de las secciones
   12 y 13: permisos (403 en cada escritura sin ser responsable), concurrencia (409), límites y tipo real de los
   archivos, saneamiento del texto y la máquina de estados de las versiones.
4. **Por fases**, como dice la sección 15: plantillas → checklists → evidencias → cierre. Al final de cada fase:
   pruebas en verde, `npm run build` en `api` y `frontend`, y la matriz de trazabilidad al día.
5. **Migración SQL.** Use el siguiente número libre en `migration/sql/`, compatible con SQL Server 2019,
   aditiva y re-ejecutable. Actualice `MANIFEST.sha256`, el runner y `Validate-SqlServer2019Scripts.ps1`. Pruébela
   en una base de juego dentro de una transacción revertida antes de producción.
6. **Seguridad.** Pase el diff por `security-adversary`: autorización en el servidor, subidas (tamaño, tipo
   real por contenido, nombre), archivos servidos como descarga con `nosniff`, sin URL públicas, texto
   enriquecido saneado, nada de secretos ni URL firmadas en logs, auditoría o JSON. Resuelva cada hallazgo o
   repórtelo.
7. **Revisión final completa en una sola pasada.** Entregue **todos** los hallazgos juntos, no uno por uno.

## Verificación de que se cumplió (antes de desplegar)

- `api`: `npm test` y `npm run build` en verde. `frontend`: `npm test` y `npm run build` en verde.
  `npm run security:audit` y `npm run security:audit:prod` en `api` y en `frontend`, en verde.
- Un reporte (`docs/checklists/VERIFICACION.md`) con:
  - la matriz de trazabilidad: cada `RN`/`API`/`P` → archivos → pruebas;
  - la lista `CA-01` … `CA-38` con el nombre de su prueba y el resultado;
  - capturas del recorrido en el navegador:
    - crear plantilla, crear versión 2.0, reordenar puntos, publicar;
    - crear un checklist con ambiente; el bloqueo por repetido y la confirmación por completado;
    - marcar un punto, escribir con imagen redimensionada y adjuntar los cinco tipos de evidencia;
    - guardar borrador, aviso de cambios sin guardar, finalizar, ver las fechas «Creado» y «Finalizado»;
    - la vista de solo lectura de otro usuario;
    - el menú con solo las dos opciones nuevas.
- Comparación contra el mockup: lo que difiera se corrige, o se justifica en el reporte.

## Despliegue en producción

1. PR a `main` con el resumen y el enlace a `VERIFICACION.md`. Espere el CI en verde, pero no fusione todavía.
2. Verifique el respaldo y corra la migración SQL en producción con el procedimiento del repositorio (`docs/SQL_SERVER_MIGRATION_RUNBOOK.md`).
   Guarde la salida sin credenciales.
3. Publique y verifique la API en producción por el camino documentado del repositorio (`$commit-deploy`).
   Solo después fusione a `main`: esa fusión despliega el frontend.
4. **Verificación posterior al despliegue en producción:**
   - el portal carga;
   - las dos opciones aparecen solo a quien tiene el permiso;
   - los servicios de lista responden;
   - una escritura sin permiso responde 403.

   No cree datos de prueba en producción salvo que sea imprescindible. Si los crea, nómbrelos «PRUEBA — borrar» y
   elimínelos al terminar.
5. Si algo falla en producción, pare, no improvise un arreglo directo en producción, y reporte con evidencia.

## Entrega

Empiece por el resultado. Luego:
- archivos cambiados;
- pruebas corridas, con números;
- estado del despliegue (frontend, API, migración) con evidencia;
- riesgos que quedan.

«Listo» significa **implementado, verificado y desplegado**, no solo programado.
