# Portal SAG Web App Guidelines

## Product Direction

Portal SAG Web is a multi-module operations portal for managing SAG Web customer work. Treat it as an operational workspace for clients, updates, implementations, configuration, audit, and visibility. Do not frame new product decisions as if the app were only an update scheduler.

For engineering execution, follow `docs/ENGINEERING_SKILLS_AND_TESTING.md` before coding. In particular, choose the relevant tests before implementation and rerun the focused suite after the change.

For roles, permissions, and task visibility, follow `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md`. Do not implement or deploy permission changes until that design is explicitly accepted.

## Default Experience

The default authenticated page is **Tareas**. This remains true even though Tareas belongs to the **Actualizaciones** module. The app should open on the user's work queue first, then let the sidebar provide stable access to the broader operational areas.

## Sidebar Information Architecture

The sidebar is the primary navigation system and should remain fixed, open, and predictable. Its width is `260px`.

Module order:

1. Clientes
2. Actualizaciones
3. Implementación
4. Configuración
5. Auditoría y Visibilidad

Current module contents:

| Module | Options |
| --- | --- |
| Clientes | Clientes, Dominios, Bases de Datos, Licenciamiento |
| Actualizaciones | Tareas, Programar Actualizaciones |
| Implementación | Descargas Públicas |
| Configuración | Alertas y Correos, Usuarios y Roles, Formatos de Impresión |
| Auditoría y Visibilidad | Auditoría, Tablero |

## Navigation Rules

- Preserve role-based visibility for every option.
- Hide a module when none of its options are visible to the current user.
- Keep **Tablero** named exactly as **Tablero**.
- Keep **Programar Actualizaciones** capitalized with the first letter of each word.
- Add new options to the module that matches the user's operational intent, not the page's historical implementation.
- Keep sidebar search available for faster navigation as the portal grows.

## Design Rules

- Use the compact SAG symbol in the sidebar brand area.
- Display the product name as two levels: `PORTAL` and `SAG WEB`.
- Keep the logged-in user's name, email, and role visible in the sidebar footer.
- If the sidebar content overflows, scroll inside the sidebar rather than compressing or hiding navigation.
- Prefer icon-assisted navigation labels for scanability.
