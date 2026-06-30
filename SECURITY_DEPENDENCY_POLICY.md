# Politica de seguridad de dependencias

Fecha de vigencia: 2026-06-30

## Alcance

Esta politica aplica a dependencias npm del backend, frontend y GitHub Actions del Programador de Actualizaciones ERP.

## Controles obligatorios

1. Todo pull request y push a `main` ejecuta `npm ci`, auditoria de dependencias de produccion, auditoria total, pruebas y build para backend y frontend.
2. El umbral de bloqueo es `moderate`: una vulnerabilidad moderada, alta o critica impide desplegar.
3. Dependabot revisa semanalmente `/api`, `/frontend` y GitHub Actions.
4. Los cambios mayores se revisan por compatibilidad; no se usa `npm audit fix --force` sin pruebas y aprobacion tecnica.
5. Los lockfiles se versionan y el despliegue usa `npm ci` o el ZIP backend construido desde el lockfile aprobado.

## SLA de remediacion

| Severidad | Contencion inicial | Correccion objetivo |
|---|---:|---:|
| Critica | 24 horas | 72 horas |
| Alta | 2 dias habiles | 5 dias habiles |
| Moderada | 5 dias habiles | 14 dias calendario |
| Baja | 15 dias calendario | 30 dias calendario |

La contencion puede incluir deshabilitar temporalmente la funcionalidad afectada, bloquear el vector, retirar una dependencia o limitar exposicion de red.

## Excepciones

Toda excepcion debe quedar en un issue con propietario, impacto, dependencia y advisory, controles compensatorios, fecha de expiracion y plan de actualizacion. Una excepcion vencida bloquea el siguiente despliegue.

## Verificacion local

```powershell
cd api
npm ci
npm run security:audit:prod
npm run security:audit
npm test
npm run build

cd ..\frontend
npm ci
npm run security:audit:prod
npm run security:audit
npm test
npm run build
```
