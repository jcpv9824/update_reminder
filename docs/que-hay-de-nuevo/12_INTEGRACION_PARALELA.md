# Entrega paralela y controles de integración

## Alcance vigente (18 de noviembre de 2026)

Continuar el frontend existente y terminar el backend de «Actualizaciones →
Qué hay de nuevo», sin alterar el refactor del catálogo multiempresa. Mandan
las últimas decisiones del propietario del relevo y el contrato de
implementación `11_CONTRATO_IMPLEMENTACION.md`; las propuestas anteriores de
PDF, Excel/menú de referencia, cuarta pestaña o reasignación del desarrollador
no son requisitos vigentes.

El catálogo real de clientes y la conexión de almacenamiento pueden quedar
pendientes por autorización explícita del relevo. Esto no permite simular
éxito: una operación que necesite SeaweedFS debe fallar de forma controlada,
sin escribir ni encolar correo. El campo cliente usa texto provisional, no
lee ni modifica las fuentes que se están integrando en la otra línea.

## Aislamiento

- Carpeta exclusiva: `portal-que-hay-de-nuevo`.
- Rama existente: `design/que-hay-de-nuevo`; base observada `11887e5`.
- No cambiar archivos de `portal-catalogo-integracion` ni sus perfiles ENV.
- No hacer checkout/reset/stash ni reemplazar el trabajo previo del prototipo.
- Los nombres provisionales 031–034 y 052–055 de esta línea son históricos.
  En la integración, el catálogo conserva 031–059 y Novedades usa 060–063.
  QA confirmó que 052–059 ya estaban instaladas y 060–063 estaban libres;
  comprobar por separado el historial del destino antes de ejecutar.
- No integrar por sustitución de archivos compartidos: revisar por separado
  App, menú, permisos, índices de funciones, manifiesto y ejecutor SQL.
- Los retiros de módulos presentes en la rama antigua no autorizan retirar
  módulos de la rama del catálogo. Integrar sólo los cambios de esta opción.
- No ejecutar suites completas simultáneas: la máquina ha mostrado presión
  de memoria. Los checks enfocados no equivalen a la paridad completa final.

## Roles y puertas

1. Orquestador: conserva el alcance, coordina propietarios, revisa contratos
   y decide cuándo congelar el candidato.
2. QA: diseñó primero la matriz de permisos, estados, historial, reportes,
   aislamiento público, texto enriquecido y límites. Verifica después de
   Desarrollo de forma independiente; no despliega.
3. Desarrollo backend y frontend: ámbitos de archivos separados y un único
   contrato de transporte. Pruebas de regresión antes de las correcciones.
4. Despliegue: especialista separado, sólo después de QA y autorización
   explícita de publicación. Esta continuación no ha aplicado migraciones ni
   publicado paquetes de esta opción.

## Aceptación esencial

- Desarrollador fijado al creador; permisos y área vigentes comprobados en
  backend, sin identidades de usuarios simulados en el modo real.
- Rutas manuales con Barra lateral/Barra de navegación, submenús y opción.
- Editor conserva el JSON validado y rechaza contenido peligroso; no HTML
  libre ni pérdida silenciosa del texto.
- Asesor: Sin probar, En pruebas y Probadas; Fallidas es un filtro de Probadas.
  Soltar conserva la ronda histórica y reinicia la siguiente sin enviar correo.
- Las transiciones exigen versiones y no permiten dos propietarios activos.
- Reportes HTML sólo de resultados probados/fallidos; selección de 1–30
  usuarios activos. El enlace requiere sesión activa, pero no permiso de esta
  opción, área específica ni pertenecer a la lista de destinatarios.
- Un reporte enviado debe conservar una instantánea inmutable, no reconstruir
  el pasado desde entradas editadas después. Mientras falte almacenamiento,
  no fingir un envío ni una persistencia completa.
- `/novedades` sin sidebar y sin sesión; proyección pública cerrada, fecha por
  mes de aprobación de Bogotá y filtros antes de paginar. Nunca cliente,
  desarrollador, asesores, reglas, videos, notas o hallazgos internos.
- Ningún archivo interno se vuelve público sólo por copiar su referencia al
  editor público. Sin conector, las operaciones de archivos quedan pendientes.
- Prototipo sólo de desarrollo, separado del modo API real y sin fallback.

## Evidencia inicial y pendientes

QA encontró un defecto P0: el validador reconstruía el documento y luego
reemplazaba sus hijos por un arreglo vacío. Desarrollo reprodujo cinco fallos
de seis pruebas, corrigió el buffer y reportó seis pruebas aprobadas. La
verificación independiente se solicita por separado; ese resultado no acredita
el resto del backend.

La revisión adversarial independiente añadió 47 pruebas en un archivo propio.
Encontró cuatro fallos de atributos heredados (`toString`, `constructor` y
`__proto__`), incluido un TypeError no controlado. Desarrollo corrigió las
comprobaciones de propiedades propias; QA repitió los 47 casos junto a los
seis de conservación del contenido: **53/53 aprobados**, dos archivos, 1,32 s.
Esto acredita ese validador, no todos los endpoints ni la persistencia SQL.

La revisión de rendimiento del orquestador detectó el patrón de cargar el
agregado completo por cada fila del listado. Se pidió una proyección resumida
con consultas acotadas y detalle separado, y evitar la misma multiplicación
de viajes SQL al construir reportes. Las pruebas de esos cambios se registran
cuando el candidato quede congelado; no se presuponen aprobadas aquí.

## Estado de la implementación local

- Los handlers ya están registrados en el índice de Azure Functions. La API y
  la interfaz real siguen desactivadas por defecto. La demostración queda
  exclusivamente en desarrollo y no actúa como respaldo cuando falla la API.
- El paquete integrado usa 060 (áreas), 061 (configuración y permisos),
  062 (entradas y pruebas) y 063 (reportes y outbox). Solo se selecciona con
  `-IncludeWhatsNew` en el ejecutor oficial. Si se solicita además
  `-IncludeCatalog`, se verifica primero el catálogo. No se aplicaron estas
  migraciones en esta integración; la ejecución y el ensayo de recuperación
  contra SQL Server real siguen siendo puertas de entrega.
- El panel de áreas en Usuarios distingue consulta y edición, usa `If-Match`
  y no modifica roles ni el estado del usuario. Las pruebas del panel y de
  Usuarios dieron 14/14 en conjunto.
- QA confirmó que un perfil exclusivo de Configuración puede consultar sus
  capacidades sin ganar acceso a las entradas.
- Las dos auditorías de cada paquete y el guard SQL-only pasaron.
- El build integrado del API y las **782/782 pruebas (103 archivos)** pasaron.
  El frontend pasó **295/295 pruebas (38 archivos)**, TypeScript y el build de
  Vite. El paquete compilado no contiene las rutas de demostración ni los
  nombres de los usuarios simulados que se buscaron en la verificación.
- Si no llega la confirmación del primer guardado de un borrador, el formulario
  reutiliza la clave y el cuerpo originales antes de actualizarlo. Si hubo un
  rechazo definitivo de validación, permite corregir el cuerpo y volver a
  enviarlo. La protección de reintento vive en el formulario montado, no en
  almacenamiento persistente del navegador.
- SeaweedFS, el envío real de reportes y la conexión al catálogo de clientes
  siguen pendientes. La vista previa HTML no envía correo ni programa una
  entrega. No se cambiaron recursos externos ni se desplegó.

## Reintento y recuperación del paquete SQL

- Antes de producción, exigir respaldo restaurable reciente, aprobación del
  destino, verificación en QA y un solo ejecutor. Mantener desactivados la API,
  la interfaz y la publicación pública hasta superar sus puertas de salida.
- El ejecutor omite un ID registrado solo si la ejecución fue exitosa y su
  SHA-256 coincide. Si hay un ID con otro hash, detenerse: no borrar ni editar
  el historial. Si falla un lote sin registrar su ID, revisar la causa antes
  de reejecutar el mismo artefacto; nombres, inserciones de inicialización y
  disparadores están diseñados para reintento. La 063 preserva la expresión
  de validación confiable del outbox y verifica sus tipos publicados.
- Para revertir el código, desactivar la opción y restaurar el paquete previo
  de API/interfaz; no borrar tablas, permisos, historial ni elementos de
  correo. Si se requiere volver físicamente al esquema anterior, usar el plan
  de restauración aprobado y reconciliar primero escrituras posteriores y
  efectos externos; no hay una migración inversa destructiva.
