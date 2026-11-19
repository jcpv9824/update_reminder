# Publicador de catálogo con la cuenta owner del Portal

Este modo es una excepción explícita para reutilizar `SAGWebDev`; no altera las membresías o permisos de esa cuenta ni de los usuarios existentes. La cuenta con la que se lee SAG Admin sigue siendo distinta y de solo lectura. No se instala ni se modifica nada en SAG Admin.

## Contrato de despliegue

- Sin `PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE`, el modo dedicado sigue siendo el predeterminado. `portal-owner` reutiliza la credencial SQL ya configurada en el Portal para el mismo destino, mediante una conexión separada que valida TLS, el login original, `db_owner`, `CONTROL`, el motor y la base. No se copia ni se registra la contraseña.
- La 064 requiere la 059 y no depende de las migraciones 060–063 de Novedades. Instala entradas SQL tipadas para reservar, publicar con destinos y registrar fallos. Las entradas existentes, sus denegaciones, y las validaciones de revisión, perfil, ambiente, clave, concesión y vigencia permanecen. El usuario interno de los procedimientos no tiene login.
- Los controladores HTTP no reciben credenciales, un nombre de procedimiento ni un modo de publicación. En caso de rechazo, no se intenta publicar por el modo dedicado ni por la ruta heredada.

## Evidencia mínima de QA (antes de producción)

1. Verificar el commit y los checksums, ejecutar las suites y el analizador SQL Server 2019. Tomar un punto de restauración de `PortalSAGWeb-TEST` y comparar las membresías y permisos de los usuarios existentes antes y después del ensayo 064. No se admite una prueba ejecutada como `dbo` que sustituya el control de la conexión real de `SAGWebDev`.
2. Conservar apagados los temporizadores de QA y mantener el correo simulado sin procesar la cola. No habilitar generación de tareas ni corte como efecto secundario de la prueba. Validar también que el modo predeterminado siga denegando el uso del owner.
3. Verificar el perfil externo `sag_admin_v2` con TLS y una lectura SNAPSHOT; no leer credenciales de las compañías. Probar una única importación con vínculo, revisión de perfil y concesión coincidentes, usando la conexión real del Portal. No suplantar a un administrador de la aplicación, ni iniciar el trabajador general si se pueden encolar otras fuentes o tocar tareas fuera del alcance.
4. Conciliar, con conteos agregados, revisión sellada, observaciones, cierre de la concesión y auditoría. Probar que una concesión inválida o vencida no reemplaza la revisión válida. Confirmar que las revisiones ERP y la cola de correo no cambiaron durante el ensayo exacto de SAG.
5. En Clientes, verificar por separado el selector ERP (SAG Admin no es una opción), las coincidencias positivas por NIT y la ausencia de CRUD. No marcar como fuera de SAG Web a clientes sin cobertura. Dominios y Bases requieren sus propios vínculos operativos confirmados; el sello de SAG no los aprueba de forma automática.

Producción requiere el artefacto exacto aprobado en QA, respaldo verificado y autorización de la migración y configuración del destino. Orden: migración, API, configuración del modo y verificaciones, y frontend únicamente si la entrega incluye un cambio de interfaz aprobado. Para contener una regresión, retirar el opt-in (conservando la configuración previa) y restaurar el paquete anterior según el runbook autorizado. No se elimina historial, se modifica el origen ni se reducen permisos como parte de esa contención.

## Ensayo inicial en QA

- El analizador TSql150 pasó y el SHA-256 de 064 coincide con `MANIFEST.sha256`. En `PortalSAGWeb-TEST` se aplicó y se reaplicó dentro de una transacción, se compararon los permisos y las membresías de usuarios existentes, y se revirtió sin dejar el usuario interno ni los procedimientos. SQL Server registra automáticamente un `CONNECT` no delegable al crear el usuario sin login; el verificador acepta exclusivamente ese registro del usuario nuevo.
- Se generó un respaldo completo `COPY_ONLY` con checksums para QA antes de aplicar 064 de forma persistente. El registro de SQL confirma el respaldo; la sesión de QA no tiene el permiso de servidor necesario para `RESTORE VERIFYONLY`. La validación de restauración no se da por hecha.
- Resultado del ejecutor en QA: `PASS 064`, con 017–059 ya verificados. En las ocho suites enfocadas, 113/113 pasaron con un trabajador; la primera corrida paralela tuvo un timeout en una prueba preexistente de volumen. El build del API pasó. El registro de este ensayo no equivale a aprobación para producción.
