# Cambios incrementales — Versión 9

## Licenciamiento en reporte maestro

El reporte **Reporte maestro ERP — clientes, dominios y empresas** ahora incluye una sección **Licencias / módulos** debajo de cada cliente.

Reglas implementadas:

- Solo se incluyen clientes activos.
- Solo se incluyen dominios activos.
- Solo se incluyen bases de datos activas.
- Solo se incluyen módulos de licencia activos.
- Solo se incluyen asignaciones de licencia activas.
- Las licencias asignadas a cliente, dominio o base de datos se consolidan bajo el cliente correspondiente.
- Los módulos se deduplican por `moduleId`.
- Los módulos se ordenan alfabéticamente por nombre.
- Si un cliente no tiene licencias activas, el reporte muestra **Sin licencias registradas**.

## Seguridad del reporte

El reporte sigue omitiendo:

- Contraseñas.
- Contraseña SMTP.
- Usuarios SQL.
- Servidor/IP/puerto.
- Cadenas de conexión completas.
- Nombres de secretos de Key Vault.
- JWT/tokens.
- Valores técnicos sensibles.

Los nombres y códigos de módulos/licencias sí pueden mostrarse.

## Eliminación de licencias con dependencias

Se agregó el endpoint:

```text
DELETE /api/license-modules/{id}
```

Si el módulo tiene asignaciones activas, el endpoint responde `409 Conflict` con un mensaje claro en español y un resumen de clientes que bloquean la eliminación:

```json
{
  "message": "No se puede eliminar esta licencia porque tiene asignaciones activas.",
  "dependencies": {
    "assignments": 3,
    "clients": [
      { "clientId": "client_1", "clientName": "P&A Soluciones", "assignments": 2 }
    ]
  }
}
```

La UI de licenciamiento puede usar este payload para mostrar al usuario que primero debe quitar las asignaciones activas del cliente, dominio o base correspondiente.

## Cosmos DB

El reporte lee estos contenedores si existen:

```text
licenseModules
licenseAssignments
```

Si los contenedores aún no existen, el reporte continúa funcionando y muestra clientes sin licencias registradas.

## Pruebas agregadas

- Reporte maestro incluye licencias de cliente.
- Deduplicación de licencias.
- Exclusión de módulos inactivos.
- Exclusión de asignaciones inactivas o eliminadas.
- Cliente sin licencias muestra **Sin licencias registradas**.
- El reporte sigue sin incluir passwords, usuarios SQL, servidor/puerto, connection strings ni secretos.
- Resumen de clientes que bloquean la eliminación de una licencia asignada.
