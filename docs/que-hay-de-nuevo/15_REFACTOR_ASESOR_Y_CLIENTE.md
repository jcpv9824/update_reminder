# Qué hay de nuevo: bandeja de Asesor y biblioteca Cliente

## Decisiones de producto

- La bandeja de Asesor abre con el mes calendario anterior, en Bogotá, por
  fecha de registro de la entrada; cambiar de tab no cambia el mes. El filtro
  histórico por fecha del resultado se mantiene como contrato distinto.
- «Asignadas a mí» se refiere al asesor designado inicialmente; «En prueba por
  mí» se refiere al titular de la ronda activa. Un resultado de prueba y sus
  hallazgos son cosas distintas: aprobar no exige borrar hallazgos. Los
  resultados históricos distinguen aprobadas de fallidas.
- El borrador de Desarrollo y el avance de Asesor se guardan con acciones
  explícitas. Guardar avance no registra un hallazgo ni aprueba el resultado.
  Adjuntar archivos sigue siendo una acción explícita y requiere un borrador
  ya guardado. No se cambia el editor enriquecido ni se abre el almacenamiento.
- Aprobar exige elegir «Aprobar sin publicar» o «Aprobar y publicar para todos».
  No hay opción preseleccionada. La segunda exige permiso de publicación y
  contenido para clientes válido; no aplica a SP crítico. Cambiar visibilidad
  desde el índice no cambia el resultado de prueba. La publicación general
  del módulo sigue bajo su configuración existente.
- Cliente es una biblioteca pública, sin inicio de sesión ni sidebar. Cualquier
  visitante ve la misma lista publicada; no se filtra por licencia ni por
  cliente. «Dónde lo encuentras» es texto de la ruta principal, no un enlace
  a otra pantalla ni una concesión de acceso. El contenido interno, hallazgos,
  personas y archivos privados no forman parte del contrato público.
- El reporte es privado. La vista previa no guarda ni envía. Guardar vincula
  la solicitud al SHA-256 de la vista previa actual; si la selección o el
  contenido cambió, se exige regenerar. El artefacto guardado no se recalcula
  al abrirlo.

## Compatibilidad y entrega

- No se requieren migraciones nuevas para este refactor. La verificación
  aislada debe usar el esquema ya aplicado y actores ficticios con permisos
  diferentes. Ver la matriz QA de este directorio.
- El API exige las decisiones explícitas al aprobar y al guardar un reporte.
  Un cliente anterior no puede completar esas acciones sin recargar la versión
  nueva; no se admite una publicación ni un guardado implícitos para esconder
  un desfase de versiones. Coordinar API y frontend en la misma ventana.
- No se habilita la configuración pública ni se envía correo en QA. Una
  validación anónima positiva usa únicamente instancias/datos desechables.
  Publicar o cambiar flags en producción requiere autorización aparte.

## Contrato frontend–API

Las rutas internas tienen prefijo `/api/whats-new`. No cambian los permisos de
opción ni el área exigida. Los identificadores públicos no son los internos.

| Operación | Contrato |
| --- | --- |
| Bandeja | `GET /queue`: `createdMonth=YYYY-MM` por fecha de registro; `assignedToMe=true` para asignación inicial; `testingByMe=true` para titular de ronda activa. El DTO privado incluye `initialAssigneeName`, `lastTesterName` y `showToClients`. |
| Guardar avance | `PATCH /rounds/{id}/round-progress`: `{items:[{itemNo,checked}],body:RichDoc|null}`, ETag de ronda. Checklist y nota de borrador se guardan en la misma transacción. |
| Aprobar | `POST /entries/{id}/mark-tested`: `{publishToClients:boolean}`, ETag de entrada y llave idempotente. |
| Texto para clientes | `PUT /entries/{id}/client-text`: `{title,body}`. Guardar no cambia la bandera de visibilidad. |
| Visibilidad | `POST /entries/{id}/set-client-visibility`: `{showToClients:boolean}`, ETag de entrada y llave idempotente. Solo una entrada aprobada puede mostrarse. |
| Vista previa / guardado | `POST /reports/preview` devuelve `snapshotSha256`; `POST /reports/saved` exige la selección original y `previewSha256`. Un cambio de versión devuelto como 409 requiere regenerar. |
