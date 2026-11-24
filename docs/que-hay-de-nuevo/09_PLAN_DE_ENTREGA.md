# Qué hay de nuevo · Plan de entrega

## Equipo y orden

Se trabaja con los agentes del repositorio, descritos en `.codex/agents/`: Orquestador, Desarrollador, QA y Despliegue en Azure.

1. **QA diseña primero:** escribe el documento `08` con los criterios de aceptación y la matriz de casos. El orquestador lo confirma antes de construir.
2. **Contratos congelados:** el DTO de los documentos `04` y `05` y la máquina de estados del `03`. El frontend reemplaza los datos simulados por el cliente de API solo contra ese contrato.
3. **Desarrolladores en paralelo**, sin compartir archivos:
   - **SQL y API:** nuevas migraciones `052`–`055`, `api/src/lib/whatsNew*`, `api/src/functions/whatsNew*`;
   - **Frontend:** `frontend/src/pages/queHayDeNuevo/**`.
4. **QA independiente** sobre el candidato fijado, con su SHA, según el documento `08`. Incluye la seguridad del texto enriquecido, el enlace público y las cargas a SeaweedFS.
5. **Despliegue**, solo con autorización explícita: migraciones en QA, luego producción y luego el frontend. Lo hace un agente distinto de QA.

## Hitos

| Hito | Contenido | Puerta para avanzar |
|---|---|---|
| H0 | Diseño y prototipo previo | Continuación autorizada; decisiones finales del relevo y contrato `11` |
| H1 | Marca de área en Usuarios, permisos nuevos y catálogo de acciones requeridas; sin menú de referencia | Scripts compatibles y pruebas de permisos; ensayo de migración sólo con autorización |
| H2 | Visión Desarrollador: entradas, rutas, borrador y publicar | Casos del documento `08` para el desarrollador en verde |
| H3 | Editor enriquecido validado y frontera de archivos SeaweedFS | Pruebas de XSS; conector pendiente permitido y operaciones dependientes fallan sin efectos; conexión real se certifica aparte |
| H4 | Visión Asesor: tres pestañas, ciclo de pruebas, hallazgos y reportes HTML | Máquina de estados/versiones e historial probados; vista previa segura y envío pendiente mientras falte almacenamiento, sin éxitos ficticios |
| H5 | Página del cliente `/novedades` y archivos públicos de las novedades | Sin fugas de datos internos; aislamiento probado |
| H6 | Despliegue | Autorización explícita del propietario |

## Integración con la otra línea

El catálogo trabaja en otra carpeta y rama; no se cambia ni se reemplaza desde
esta entrega. La numeración provisional 031–034 de este prototipo se retira y
se reserva 052–055, porque 031–051 pertenecen al catálogo. La integración futura
requiere volver a comprobar numeración y revisar manualmente archivos
compartidos; no fusionar los retiros ajenos presentes en la base antigua.
Ver `12_INTEGRACION_PARALELA.md`.

## Lo que no se hace sin autorización

- Hacer commit en `main`, push o desplegar.
- Aplicar migraciones SQL en QA o en producción.
- Cambiar los App Settings o el proveedor de almacenamiento.
- Conectar el selector Cliente a una fuente. Eso depende de la línea de trabajo del catálogo multiempresa.
