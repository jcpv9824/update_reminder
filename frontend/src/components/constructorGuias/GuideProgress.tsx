const STEPS = [
  "Subir video",
  "Extracción",
  "Borrador y preguntas",
  "Finalizar y exportar",
];

export function GuideProgress({ currentStep }: { currentStep: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="constructor-guias-progreso" aria-label="Progreso de creación de la guía">
      {STEPS.map((label, index) => {
        const step = index + 1;
        const state = step < currentStep ? "completo" : step === currentStep ? "actual" : "pendiente";
        return (
          <li key={label} className={`constructor-guias-progreso-${state}`} aria-current={step === currentStep ? "step" : undefined}>
            <span aria-hidden="true">{step < currentStep ? "✓" : step}</span>
            <strong>{label}</strong>
          </li>
        );
      })}
    </ol>
  );
}
