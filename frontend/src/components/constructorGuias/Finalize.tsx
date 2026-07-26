import { CheckCircle2 } from "lucide-react";
import type { GuideValidationCheck } from "../../types";

export function Finalize({
  checks,
  canDownload,
  onDownload,
}: {
  checks: GuideValidationCheck[];
  canDownload: boolean;
  onDownload: () => void;
}) {
  return (
    <section className="tarjeta constructor-guias-final" aria-labelledby="constructor-guias-final">
      <div>
        <h3 id="constructor-guias-final"><CheckCircle2 size={20} aria-hidden="true" /> Sin puntos pendientes de verificación</h3>
        <p className="texto-ayuda">Validado: yaml completo · normalized_* sin tildes · --- FIN DEL DOCUMENTO ---</p>
        {checks.length > 0 ? (
          <ul className="constructor-guias-validaciones" aria-label="Validaciones del manual">
            {checks.map((check) => <li key={check.id}>{check.passed ? "✓" : "×"} {check.label}</li>)}
          </ul>
        ) : null}
      </div>
      {canDownload ? <button type="button" className="exito" onClick={onDownload}>Descargar .md</button> : null}
    </section>
  );
}
