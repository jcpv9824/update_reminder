# Retirar entradas y reportes privados

«Eliminar» en esta pantalla significa retirar de uso. No borra filas, archivos
ni datos históricos. No activa publicación pública, configuración SMTP,
destinatarios ni el outbox de correo.

## Entradas

- **Desarrollo:** puede retirar las entradas de las que es autor.
- **Soporte:** puede retirar una entrada publicada que tenga a cargo: el titular
  de la ronda activa es responsable mientras la tenga; si no hay ronda abierta,
  aplica el asesor inicial asignado. Haber probado antes o poder ver el tablero
  no basta. Soporte no puede retirar el borrador de otro usuario.
- **super_admin:** puede retirar cualquier entrada, sin requerir área adicional.
  Un permiso de gestión delegado no equivale al rol protegido.

El servidor verifica la sesión y el ETag de la edición en la transacción.
Si cambió la entrada o su responsabilidad, revalida la acción; no sobrescribe.
Si había una ronda abierta, cierra la ronda como soltada, conservando su
responsable, checklist, notas, hallazgos y borrador de notas. El estado queda
`eliminada`, con la fecha de retiro, y se agrega un evento a la bitácora y a
Auditoría. Se conservan la fecha de aprobación, el mes de publicación, la de
archivo y las revisiones. Las retiradas salen de las listas, las colas, la
página pública y de la selección para nuevos reportes. No se autoriza descargar
sus archivos mediante el canal operativo. Super_admin puede consultar el
detalle histórico por su identificador interno.

## Reportes

La vista previa no equivale a un reporte guardado. «Guardar reporte privado»
crea una copia HTML inmutable de las entradas probadas que coinciden con los
filtros; **no envía ningún correo** y no tiene destinatarios. Está disponible
en Desarrollo, en Soporte con el permiso de reportes, y para super_admin.
Desarrollo sin el permiso de reportes puede generar snapshots solo de sus
propias entradas, sin acceso a los resultados del equipo. Como no se asignan
estos reportes a nadie más, el responsable es quien los guardó.
La biblioteca muestra solo los reportes propios, o todos para super_admin.

El HTML se escapa, se limita a 2 MB, se guarda en el almacenamiento privado
SeaweedFS activo y se entrega solo con sesión y después de verificar propiedad,
integridad y estado. El reporte HTML mantiene la representación textual de
imágenes; no distribuye imágenes ni URLs firmadas. El acceso directo al HTML
usa CSP restrictiva y la vista del Portal usa un iframe sin permisos.

Retirar un reporte escribe una única marca append-only
(`whats_new.report_withdrawals`) con actor y hora, además de Auditoría, y
bloquea su consulta por enlace. Ni el snapshot HTML ni el historial previo
se modifican. Repetir el retiro autorizado no crea eventos duplicados. Un
archivo previamente descargado no puede revocarse.

## SQL y publicación

`083_whats_new_retention.sql` permite guardar reportes con cero destinatarios
y conservar los datos de aprobación/archivo al retirar una entrada. Conserva
las restricciones de 062/063 y no toca sus filas ni las notificaciones. Antes
de desplegar, validar el checksum en `MANIFEST.sha256` y SQL Server 2019, ensayar
la aplicación, replay y reversión en QA y verificar un respaldo antes de
producción. El ejecutor `Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1`
con `-WhatsNewRetentionOnly` exige los checksums exactos de 060–063 y no aplica
ninguna otra migración. En producción requiere además autorización explícita
de 083 y `-AuthorizeRetentionProduction`.

Orden: SQL 083, API, frontend. Ante un fallo de aplicación, no desplegar las
capas siguientes. La reversión de aplicaciones no borra archivos ni aplica un
down destructivo de datos. Tras habilitar retiros o guardar el primer reporte
sin destinatarios, no reinstalar las restricciones antiguas sin un plan de
recuperación: rechazarían historia válida. Conservar las marcas de retiro y
priorizar una reversión que mantenga bloqueado el acceso a reportes retirados.
