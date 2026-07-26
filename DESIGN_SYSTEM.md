# Portal SAG Web Design System

Portal SAG Web uses a compact enterprise operations UI with handcrafted global
CSS. There is no component framework, Tailwind, CSS Modules, shadcn, or MUI.
Extend the existing visual language instead of introducing a second one.

## Canonical tokens

Defined in `frontend/src/styles.css`:

| Token | Value | Use |
|---|---:|---|
| `--color-primary` | `#1C3664` | Brand, headings, primary actions, sidebar |
| `--color-primary-hover` | `#14264a` | Primary hover/pressed |
| `--color-secondary` | `#7E99B2` | Secondary accents |
| `--color-neutral` | `#D1D3D2` | Neutral surfaces |
| `--color-accent` | `#D3C193` | Navigation/accent emphasis |
| `--color-bg` | `#f4f5f7` | Application background |
| `--color-card` | `#ffffff` | Cards, tables, dialogs |
| `--color-border` | `#d1d3d2` | One-pixel borders |
| `--color-text` | `#1f2937` | Primary text |
| `--color-text-muted` | `#6b7280` | Help and secondary text |
| `--color-error` | `#b91c1c` | Destructive/error |
| `--color-error-bg` | `#fee2e2` | Error feedback background |
| `--color-success` | `#047857` | Success/active |
| `--color-success-bg` | `#d1fae5` | Success feedback background |

Prefer these variables over new raw colors. `--color-danger` is not currently
defined; use `--color-error` unless a deliberate alias is added and documented.

## Typography

- Stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- Base: `14px`
- Supporting text: `12px` and `13px`
- Brand title: `20px`
- Login title: `26px`
- Dashboard metric: `28px`
- Common weights: `500`, `600`, `700`, `800`
- Use monospace only for connection/database values, endpoints, or comparable
  machine identifiers.

Text and labels are primarily Spanish. Match the terminology already used by
the owning module.

## Spacing and radius

Spacing is convention-based, not exposed as CSS variables. Reuse the observed
scale: `4, 6, 8, 10, 12, 14, 16, 24, 32px`.

- Main content padding: `24px`
- Card padding: `16px`
- Modal padding: `24px`
- Standard gaps: `8px`, `12px`, `16px`
- Inputs, tables, alerts, and task rows: `6px` radius
- Cards, accordions, standard modals, sidebar search: `8px`
- Login card: `12px`
- Badges/chips: `999px`
- Circular icon controls: `50%`

## Application shell

The authenticated shell is `aside + nav + main/Outlet`.

- Keep the desktop sidebar at `260px`; do not invent a collapsed mobile shell
  without a product decision.
- Keep sidebar search, the compact SAG icon, `PORTAL / SAG WEB`, and the
  authenticated user name/email/role footer.
- Preserve this module order:
  1. Clientes
  2. Actualizaciones
  3. Implementación
  4. Configuración
  5. Auditoría y Visibilidad
  6. Ayudas SAG Web
- Hide a module when the user can see none of its options.
- Sidebar visibility comes from `*.view` permissions, not hard-coded role names.

## Components and interaction patterns

### Buttons

Use the existing base button and variants:

- `.primario`
- `.secundario`
- `.peligro`
- `.exito`
- `.advertencia`

Use semantic `<button>` elements. Icon-only actions need an accessible name and
visible focus.

### Cards, tables, and lists

- Cards use a white surface, one-pixel neutral border, `8px` radius, and `16px`
  padding.
- Tables use `6px` radius; table cells use `8px 10px` padding.
- Page headings use primary blue.
- Tables need semantic headers and should gain a caption or accessible label
  when a visible title does not identify the data.
- Preserve horizontal overflow where the existing operational table cannot
  collapse safely.

### Forms

- Bind every visible label with `htmlFor`/`id`.
- Mark required fields consistently and validate on the API as well as the UI.
- Show actionable inline feedback without exposing technical internals.
- Preserve typed API models; do not submit arbitrary unvalidated objects.
- Reuse `SelectorBuscable` for searchable selections, improving its keyboard
  semantics when touched rather than copying its current limitations.

### Feedback and state

- Alerts use existing `.alerta-*` styles.
- State badges use `.estado-*`.
- New dynamic alerts should use an appropriate live region or `role="alert"`.
- Loading, empty, error, disabled, and success states are part of feature
  completion.

### Dialogs

Reuse `Modal` and `DialogoConfirmar`, but when modifying dialogs improve:

- `role="dialog"` and `aria-modal="true"`
- title association
- Escape close where safe
- focus entry, trap, and restoration
- destructive confirmation language

### Public file behavior

- Public downloads use attachment delivery.
- Public files use safe inline display for supported images, PDF, and video.
- File type, size, upload progress, replacement, failed upload compensation,
  and browser behavior must be explicit.
- Do not infer inline/attachment behavior from the current storage provider.

### Long-running guided workflows

- Represent multi-step work with a semantic ordered list and `aria-current`.
- Preserve the current session in the URL so a refresh can restore server state.
- Announce upload and processing progress with live regions without moving focus
  on every poll.
- Keep upload, review, clarification, finalization, and download as distinct
  states. A disabled action must explain the unresolved requirement.
- Cancellation is explicit and destructive; it is not the same as navigating
  away from a recoverable session.

## Responsive behavior

The portal is desktop-first with selective responsive rules:

- Task columns adapt around `1024px`.
- The public print-format catalog adapts around `1100px` and `720px`.
- Main operational content may retain horizontal scrolling.
- Do not redesign the global sidebar during an unrelated page change.

## Accessibility baseline

Preserve and extend:

- semantic `aside`, `nav`, `main`, and footer landmarks
- labeled primary navigation
- `aria-expanded`/`aria-controls` for module controls
- hidden links removed from keyboard order
- decorative icons marked `aria-hidden`
- `.sr-only` labels
- visible focus states
- reduced-motion behavior
- role/name-based Testing Library assertions

Do not copy known gaps: unbound labels, mouse-only selectors, unlabeled
icon buttons, alerts without announcement, or dialogs without focus management.

## Reference implementations

| Concern | Reference |
|---|---|
| Shell/navigation/permissions | `frontend/src/components/AppLayout.tsx` and `AppLayout.test.tsx` |
| Shared primitives | `frontend/src/components/Comunes.tsx` |
| Searchable selector | `frontend/src/components/SelectorBuscable.tsx` |
| CRUD/query/mutation page | `frontend/src/pages/ClientesPage.tsx` |
| Granular role permissions | `frontend/src/pages/UsuariosPage.tsx` |
| Task visibility and sensitive actions | `frontend/src/pages/TareasPage.tsx` |
| Accessible auth form | `frontend/src/pages/LoginPage.tsx` |
| File administration | `frontend/src/pages/ArchivosPublicosAdminPage.tsx` |
| Public responsive catalog | `frontend/src/pages/FormatosImpresionPublicPage.tsx` |
