# Cambios V21 - Seguridad de dependencias

Fecha: 2026-06-30

## Actualizaciones

- Backend: Nodemailer 9.0.3, Vitest 4.1.9 y dependencias transitivas seguras.
- Se elimino `uuid`; el backend usa `node:crypto.randomUUID()` para IDs.
- Frontend: Vite 8.1.1, Vitest 4.1.9, React Router 6.30.4, ws 8.21.0 y form-data 4.0.6.
- Se mantuvieron React 18 y React Router 6 para evitar migraciones funcionales innecesarias.

## Prevencion

- Auditoria npm de produccion y total con umbral `moderate` en CI.
- Pruebas y builds completos antes de desplegar Static Web Apps.
- Dependabot semanal para `/api`, `/frontend` y GitHub Actions.
- Politica y SLA en `SECURITY_DEPENDENCY_POLICY.md`.

## Validacion

- Backend: 0 vulnerabilidades, 251 pruebas aprobadas y build correcto.
- Frontend: 0 vulnerabilidades, 143 pruebas aprobadas y build correcto.
