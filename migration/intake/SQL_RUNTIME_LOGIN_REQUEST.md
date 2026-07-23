# Portal SAG Web — registro de acceso SQL runtime

## Estado

Resuelto el 2026-07-21. El login existente `SAGWebDev` fue retirado de `db_owner` y asignado únicamente a `portal_runtime` mediante una transacción auditada. La validación posterior confirmó una membresía runtime y cero membresías elevadas.

La aplicación puede usar `SAGWebDev` como nombre de usuario runtime. La contraseña permanece en el canal seguro y nunca se almacena en el repositorio. Para DDL futuro, el proveedor debe usar o suministrar una identidad de migración separada; no se debe volver a elevar la cuenta runtime.

## Alternativa futura

Solicitar al proveedor de infraestructura un login SQL dedicado para la aplicación. La contraseña debe entregarse por su canal seguro y no debe aparecer en tickets, correo, Git ni chat.

Valores confirmados:

- Servidor: `data14.sagerp.co,54103`
- Base: `PortalSAGWeb`
- Nombre recomendado del login: `PortalSAGRuntime`
- Autenticación: SQL Server Authentication
- Política: `CHECK_POLICY=ON`, `CHECK_EXPIRATION=ON`
- Base predeterminada: `PortalSAGWeb`

El proveedor ejecuta la parte de servidor con una contraseña fuerte suministrada por canal seguro:

```sql
USE [master];
GO
CREATE LOGIN [PortalSAGRuntime]
  WITH PASSWORD = N'<SUMINISTRAR_POR_CANAL_SEGURO>',
       CHECK_POLICY = ON,
       CHECK_EXPIRATION = ON,
       DEFAULT_DATABASE = [PortalSAGWeb];
GO
```

Después, el propietario de `PortalSAGWeb` puede ejecutar la asignación de base:

```sql
USE [PortalSAGWeb];
GO
CREATE USER [PortalSAGRuntime] FOR LOGIN [PortalSAGRuntime] WITH DEFAULT_SCHEMA = [dbo];
ALTER ROLE [portal_runtime] ADD MEMBER [PortalSAGRuntime];
GO
```

Verificación obligatoria:

- Es miembro de `portal_runtime`.
- No es miembro de `db_owner`, `db_ddladmin`, `portal_migrator` ni roles de servidor elevados.
- No recibe `CONTROL DATABASE`, `ALTER ANY SCHEMA` ni permisos DDL directos.
- Puede conectarse con TLS validado, `Encrypt=True` y `TrustServerCertificate=False`.

Si en el futuro se crea `PortalSAGRuntime`, primero se valida su acceso, se cambia la configuración de la aplicación y solo después se retira `SAGWebDev` del rol runtime.
