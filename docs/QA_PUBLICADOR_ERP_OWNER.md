# Publicación controlada del catálogo ERP (065)

## Problema y alcance

En producción, el trabajador puede reclamar la fuente ERP, pero su conexión
directa `SAGWebDev` pertenece a `db_owner` **y** a `portal_runtime`. La 033
niega expresamente UPDATE de la secuencia y DML directo en las tablas
publicadas. La membresía `db_owner` no elimina esa denegación. El intento se
detiene antes de leer el ERP: queda `claimed`, sin `reserved`. El SAG v2
ya usa las entradas específicas de la 064; no se modifica.

La 065 agrega entradas de reserva, publicación y fallo para el trabajador
`erp_v1`. El mismo login entra sólo por los módulos tipados, con la identidad,
el ambiente, el contrato, la concesión, el vínculo, las versiones y la prueba
de la clave vigentes. El delegado nuevo no tiene login ni membresías ni
permisos explícitos sobre las tablas. Los procedimientos fijos usan la cadena
de propiedad cerrada verificada por la migración. La ejecución directa sobre
secuencia y tablas sigue denegada. No se modifica ninguna membresía ni
permiso existente; no se cambia el ERP ni SAG Admin. La ruta manual antigua
no es una alternativa para este productor ni cambia con esta entrega.

## Ensayo y promoción

1. Verificar SHA-256 y analizar tanto el lote 065 como sus módulos fijos con
   TSql150. Ensayar aplicar/reaplicar/revertir en `PortalSAGWeb-TEST`; comparar
   los permisos y las membresías existentes y verificar que el delegado no
   tenga derechos nuevos fuera de su `CONNECT` implícito. No reservar una
   secuencia real en el ensayo de rollback (el número no se revierte).
2. Respaldar e instalar en QA mediante
   `-Environment qa -IncludeCatalog -IncludeCatalogOwnerPublisher -IncludeCatalogErpOwnerPublisher`.
   Usar una segunda conexión **directa y TLS** como `SAGWebDev`, no el
   contexto `dbo` del ejecutor, para probar una reclamación ERP única del
   perfil certificado. Mantener apagados los temporizadores de QA. Probar
   ambiente/concesión incorrectos, publicación repetida, rechazo de destino
   SAG y conservación de las denegaciones directas. Conciliar head vigente,
   auditoría y estado terminal, sin tocar otras fuentes, tareas o correo.
3. Repetir compuertas del candidato exacto en CI. Tras aprobación, respaldo
   y verificación del destino, aplicar sólo 065 en producción con los mismos
   interruptores (`-Environment production`). Desplegar el API exacto y
   habilitar sólo `PORTAL_CATALOG_ERP_PUBLISHER_MODE=portal-owner`. Con el
   modo habilitado no hay fallback a DML directo ante un error.
4. Verificar HTTP 200 de salud, 401 anónimo y que los dos orígenes tengan
   revisiones vigentes y coincidencias autenticadas en Clientes antes del
   push a `main`. Esto no activa inventario completo, tareas, corte ni
   reportes. No crear usuarios, cambiar roles, simular publicaciones ni
   mostrar nombres, documentos, secretos o datos de conexión.

Contención: retirar el opt-in y, si se autorizó, restaurar el paquete SQL-only
previo preservando App Settings, historia SQL y revisiones existentes. No
remover el delegado ni revertir datos automáticamente. El API previo no podrá
volver a publicar ERP directamente; no usarlo como prueba de recuperación de
la importación.
