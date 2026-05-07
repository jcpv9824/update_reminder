# Programador de Actualizaciones del ERP

Aplicación web para gestionar las actualizaciones programadas de los clientes del ERP, sus dominios y bases de datos. Construida sobre Microsoft Azure (Static Web Apps, Azure Functions, Cosmos DB y Key Vault). Toda la interfaz está en español.

## Características

- **Login con correo y contraseña** (JWT). Los roles se administran únicamente desde la página *Usuarios y roles*.
- **Recordatorios por correo** a los actualizadores (configurables por frecuencia: días previos, hora y destinatarios).
- **Alertas diarias** a administradores cuando hay tareas vencidas.
- **Diseño con colores corporativos**: `#1C3664`, `#7E99B2`, `#D1D3D2`, `#D3C193`.
- Página principal **Tareas** con dos columnas (dominios y bases de datos) divididas en *Vencidas / Hoy / Próximas / Completadas*.
- Gestión de **clientes**, **dominios** y **bases de datos**. Al crear un dominio o una base de datos se puede configurar la **frecuencia de actualización** en el mismo formulario.
- **Frecuencias avanzadas** (semanal, intervalo, mensual, manual) accesibles desde una página secundaria solo para administradores.
- **Generación automática diaria** de tareas mediante Azure Functions Timer Trigger.
- Panel del actualizador con las cuatro partes del acceso (servidor, Initial Catalog, usuario y contraseña) y botones independientes para copiar; cada acción se audita.
- **Roles**: administrador, administrador de clientes, actualizador de bases de datos, actualizador de dominios, visualizador.
- **Auditoría completa** de todas las acciones (incluyendo revelar/copiar contraseñas).
- **Contraseñas en Azure Key Vault**, nombres de secreto sanitizados automáticamente (sin guiones bajos ni caracteres inválidos).
- **Parser** de cadenas `servidor; Initial Catalog = X; User ID = Y; Password = Z;`.

## Requisitos

- Node.js 20 LTS
- PowerShell 7+
- Azure CLI
- Azure Functions Core Tools v4
- Una suscripción de Azure activa

## Estructura del proyecto

```
erp-update-scheduler/
├── README.md
├── DESPLIEGUE.md           Guía paso a paso para desplegar en Azure (PowerShell).
├── api/                    Backend en Azure Functions (Node.js + TypeScript).
│   ├── src/lib/            Utilidades (parser, scheduleEngine, permisos, auditoría, etc.)
│   ├── src/functions/      Endpoints HTTP y Timer Trigger.
│   └── src/tests/          Pruebas con vitest.
├── frontend/               Aplicación React + Vite + TypeScript.
└── scripts/
    └── desplegar-azure.ps1 Script de aprovisionamiento en Azure.
```

## Ejecutar localmente

### 1. Instalar dependencias

```powershell
cd api
npm install

cd ..\frontend
npm install
```

### 2. Configurar variables del API

Copie `api/local.settings.json.example` a `api/local.settings.json` y rellene los valores. En modo desarrollo puede dejar `DEV_AUTH_ENABLED=true` para autenticarse con encabezados.

### 3. Ejecutar el backend

```powershell
cd api
npm run build
func start
```

El API queda disponible en `http://localhost:7071/api`.

### 4. Ejecutar el frontend

En otra ventana de PowerShell:

```powershell
cd frontend
"VITE_API_BASE_URL=http://localhost:7071/api" | Out-File -FilePath .env.local -Encoding utf8
npm run dev
```

El frontend queda disponible en `http://localhost:5173`.

## Ejecutar pruebas

### Backend

```powershell
cd api
npm test
```

Cubre el parser de conexión, el motor de frecuencias, la generación idempotente de tareas, las reglas de permisos por rol, la creación de bases de datos sin guardar contraseña en texto plano, y la sanitización de auditoría.

### Frontend

```powershell
cd frontend
npm test
```

Cubre el parser visual y el componente de vista previa.

## Roles y permisos

| Rol | Puede hacer |
|---|---|
| Administrador | Todo: usuarios, roles, clientes, dominios, bases, frecuencias, tareas, auditoría. |
| Administrador de clientes | CRUD de clientes, dominios, bases y frecuencias; ver auditoría. |
| Actualizador de bases de datos | Ver y completar tareas de bases de datos asignadas; revelar/copiar contraseñas autorizadas. |
| Actualizador de dominios | Ver y completar tareas de dominios asignadas. |
| Visualizador | Solo lectura. |

## Seguridad

- La contraseña de cada base de datos se guarda en **Azure Key Vault** con el nombre `db-{databaseId}-password`.
- En Cosmos DB solo se guarda la **referencia** al secreto, nunca la contraseña.
- Los registros de auditoría **eliminan automáticamente** cualquier campo cuyo nombre incluya `password`, `secret`, `rawDbAccess`.
- Cada acción de **revelar** o **copiar** la contraseña genera una entrada de auditoría con el usuario, la fecha y la base de datos asociada.

## Cambios recientes

- [CAMBIOS_V5.md](CAMBIOS_V5.md): fix del 404 al refrescar, listas sin eliminados, eliminación física con integridad y selectores buscables.
- [CAMBIOS_V4.md](CAMBIOS_V4.md): vista administrativa **Alertas y correos** (SMTP, recordatorios, alertas, prueba). Contraseña SMTP en Key Vault.
- [CAMBIOS_V3.md](CAMBIOS_V3.md): login email/password con JWT, recordatorios y alertas por correo, colores corporativos.
- [CAMBIOS.md](CAMBIOS.md): vista unificada de tareas, frecuencia integrada en formularios, sanitización Key Vault.

## Cómo iniciar sesión

1. La pantalla de login pide únicamente correo y contraseña.
2. El backend devuelve un JWT (`Authorization: Bearer …`).
3. Para crear el primer usuario, configure `SETUP_SECRET` en la Function App y llame `POST /api/setup/first-admin` con `id`, `email`, `displayName`, `password`.
4. Para asignar contraseña al admin existente (`camilo.palacio@pya.com.co`), use `POST /api/setup/set-admin-password` (ver `CAMBIOS_V3.md`).
5. Después de configurar el primer admin, vacíe `SETUP_SECRET`.

## Despliegue

Consulte [DESPLIEGUE.md](DESPLIEGUE.md) para la guía completa con PowerShell.

### Modo desarrollo

- Backend: variable `DEV_AUTH_ENABLED=true` permite autenticación con cabeceras `x-dev-user-*`.
- Frontend: variable `VITE_DEV_MODE=true` muestra un formulario oculto en la pantalla de login para entrar como usuario de prueba con roles arbitrarios.
- En producción ambas deben estar en `false`.

### Cómo crear el primer administrador

1. Configure `SETUP_SECRET` en la Function App.
2. Llame `POST /api/setup/first-admin` con `setupSecret`, `id` y `email` (use el correo que va a usar para entrar con Microsoft 365).
3. Borre `SETUP_SECRET` para deshabilitar el endpoint.

### Cómo agregar más usuarios

1. Inicie sesión como administrador.
2. Vaya a **Usuarios y roles → Nuevo usuario**.
3. Use como **Identificador** el correo Microsoft 365 del nuevo usuario.
4. Asigne roles. El usuario podrá entrar con su cuenta corporativa.

## Documento original

El diseño funcional está basado en `azure_erp_update_app_claude_code_instructions.md` (en la carpeta padre).
