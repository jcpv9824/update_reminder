# Qué hay de nuevo · Arquitectura

Este diseño incluye el flujo futuro de archivos y correo. Para distinguirlo
del alcance implementado, consultar el contrato 11 y el estado de integración
12: no hay conexión real a SeaweedFS ni envío de reportes habilitado.

## 1. Tecnologías (las del Portal SAG Web, sin agregar otras)

| Capa | Tecnología | Dónde vive el módulo |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite, TanStack Query y React Router, con CSS propio del portal. Se despliega en Azure Static Web Apps. | `frontend/src/pages/queHayDeNuevo/` |
| Editor enriquecido | TipTap (sobre ProseMirror). El contenido se guarda como JSON. Es la única dependencia nueva del frontend. | `frontend/src/pages/queHayDeNuevo/editor/` |
| API | Azure Functions con Node 20 y TypeScript, y zod para validar. Los handlers son delgados y la lógica va en `lib`. | `api/src/functions/whatsNew*.ts` y `api/src/lib/whatsNew*.ts` |
| Base de datos | SQL Server 2019 (compatibilidad 150), con el esquema `whats_new` y migraciones aditivas reservadas 052–055 | `migration/sql/052…055_*.sql` |
| Archivos | **SeaweedFS** por su gateway S3, con conexión directa. **No se usa Azure Blob.** | Sección 3 |
| Correo | El outbox existente (`processEmailOutbox`), con cuerpo HTML | `api/src/lib/whatsNewReport*.ts` |

## 2. Flujo general

```
Desarrollador ──(portal, con sesión)──▶ API /api/whats-new/entries ──▶ SQL whats_new.*
      │ imágenes y adjuntos ──▶ API pide el permiso de carga ──▶ SeaweedFS …/temporales/
      ▼ Publicar
Asesor ──(portal, con sesión)──▶ Tomar / Soltar / Hallazgo / Probado o Fallida ──▶ bitácora
      ▼ desde la pestaña Probadas: «Enviar reporte» (Todas / Aprobadas / Fallidas + destinatarios)
API ──▶ arma el reporte HTML ──▶ lo guarda en SeaweedFS …/reportes/ ──▶ outbox ──▶ correo con resumen y enlace
      ▼ Mostrar a clientes
Cliente ──(enlace abierto /novedades, sin sesión)──▶ API /api/public/novedades ──▶ solo los campos públicos
```

**Lo que nunca sale por el enlace público:** el cliente, el desarrollador, los asesores, los documentos de reglas de negocio, los videos, las notas y los hallazgos. La API pública trabaja con una **proyección cerrada**, con solo estos campos:

- id aleatorio;
- tipo, como «Opción nueva» o «Mejora»;
- mes de liberación;
- título;
- texto para clientes;
- ruta principal;
- imágenes del texto para clientes.

## 3. Estructura de carpetas en SeaweedFS

Supuesto: un bucket para el proyecto, dentro de él la carpeta del portal por ambiente, y dentro de esa una carpeta propia para Qué hay de nuevo. **El servidor genera todos los nombres** con GUID; el nombre original del archivo se guarda en SQL, nunca en la ruta.

```
<bucket del proyecto>/
└── PortalSAGWeb/                         (producción;  PortalSAGWeb-TEST/ en QA)
    ├── Archivos/                          (lo existente del portal: no se toca)
    └── QueHayDeNuevo/
        ├── temporales/                    subidas que todavía no se guardan en una entrada
        │   └── <uploadId>                 se borra si a las 24 h nadie la usó
        ├── entradas/
        │   └── <entryId>/
        │       ├── que-cambio/            imágenes y adjuntos del editor «Qué cambió»
        │       ├── acciones/<actionId>/   imágenes y adjuntos de cada acción requerida
        │       ├── reglas-de-negocio/     Word, PDF o Excel (solo internos)
        │       ├── videos/                mp4 o webm (solo internos)
        │       └── pruebas/
        │           └── ronda-<n>/
        │               ├── notas/         imágenes y adjuntos de las notas del asesor
        │               └── hallazgos/     imágenes y adjuntos de cada hallazgo
        ├── publico/
        │   └── <publicId>/                copias de las imágenes del texto para clientes
        │                                  (lo único que el enlace abierto puede servir)
        └── reportes/
            └── <aaaa>/<mm>/<reportId>.html  reporte HTML enviado, para el enlace del correo
```

**Reglas:**

- **Subir:**
  1. El navegador pide permiso a la API.
  2. La API entrega una URL de **escritura** de vida corta hacia `temporales/<uploadId>`, con tipo y tamaño fijos.
  3. Al guardar la entrada, la API **mueve** a la carpeta de la entrada solo los archivos que el contenido realmente usa, y los registra en SQL con proveedor, llave, tipo, tamaño y SHA-256.
- **Leer:** la API valida el permiso y responde 302 a una URL firmada de vida corta. El enlace abierto solo lee de `publico/`.
- **Limpiar:** lo que quede en `temporales/` después de 24 h se borra. Así se resuelven los **archivos huérfanos**: imágenes que alguien subió al editor y después quitó antes de guardar. Como nunca salieron de `temporales/`, se borran solas y no hace falta buscarlas en el resto del bucket.
- **Nada publicado se borra:** archivar una entrada solo la saca de la página pública.

## 4. Datos (resumen; el detalle está en el documento `03`)

**Tablas:**

| Tabla | Qué guarda |
|---|---|
| `entries` | Tipo, sistema, estado, desarrollador, autor, fechas, `public_id` y mes de aprobación |
| `entry_routes` y `entry_route_levels` | Las rutas de cada entrada y sus niveles |
| `entry_actions` | Las acciones requeridas, con copia del nombre al publicar |
| `entry_attachments` | Los adjuntos, como archivo o enlace |
| `test_rounds` | Las rondas de prueba, solo de anexar |
| `round_checklist` | El avance del checklist en cada ronda |
| `findings` | Los hallazgos, con anulación en lugar de borrado |
| `notes` | Las notas de prueba |
| `entry_participants` | Todos los asesores que participaron y el desarrollador |
| `entry_log` | La bitácora de cada acción, con quién y cuándo |
| `client_texts` | El texto para clientes de cada entrada |
| `reports` y `report_recipients` | Los reportes y sus destinatarios |
| `required_action_catalog` | El catálogo de acciones requeridas |
| `security.user_business_areas` | El área de cada usuario |

**Estados:** `borrador`, `sin_probar`, `en_pruebas`, `probado`, `fallida` y `archivada`. En la pestaña Probadas aparecen `probado` y `fallida`, con el filtro de resultado.

## 5. Reporte por correo

1. El asesor elige, desde Probadas, qué incluir (Todas, Aprobadas o Fallidas) y uno o varios usuarios del portal.
2. La API arma el HTML del reporte. Por cada entrada incluye:
   - ruta y tipo;
   - desarrollador;
   - asesores participantes;
   - resultado;
   - hallazgos;
   - fechas.
3. Lo guarda en `reportes/`.
4. Encola **un correo por destinatario** en el outbox. El correo lleva un resumen con el conteo de aprobadas y fallidas y la lista corta, y el enlace autenticado al reporte completo. Sin PDF.
5. Si el outbox llega a soportar adjuntos, el HTML puede ir también como archivo adjunto. Es opcional.
6. El envío es idempotente: un doble clic no duplica los correos.

## 6. Página pública

- Ruta del frontend `/novedades`, fuera del layout del portal, igual que `/formatos-impresion`.
- Endpoint `GET /api/public/novedades`, con estos filtros:
  - `periodo`: mes_actual, ultimos_3_meses, ultimo_ano, todo o rango, con `desde` y `hasta`;
  - `categoria`: todo, opciones_nuevas o mejoras.
- Las respuestas llevan `Cache-Control: no-store` y límite de tasa por IP.
- El detalle se pide por `public_id` aleatorio.

## 7. Qué se construye y en qué orden

1. **Frontend completo con datos simulados.** Ya está en curso.
2. **Backend:**
   - migraciones 052 a 055;
   - lib y functions de la API;
   - adaptador de SeaweedFS para la carpeta `QueHayDeNuevo`;
   - generador del reporte HTML;
   - endpoint público.
3. **Conexión del frontend a la API real**, quitando los datos simulados.
4. **QA independiente** con el documento `08`, actualizado a estas decisiones.
5. **Despliegue**, solo con autorización.
