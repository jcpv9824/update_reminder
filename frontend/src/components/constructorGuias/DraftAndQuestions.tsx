import type { GuideQuestion } from "../../types";

export function DraftAndQuestions({
  draft,
  draftVersion,
  questions,
  answers,
  pendingCount,
  canRegenerate,
  showFinalize,
  canFinalize,
  regenerating,
  finalizing,
  onAnswer,
  onRegenerate,
  onFinalize,
}: {
  draft: string;
  draftVersion: number;
  questions: GuideQuestion[];
  answers: Record<string, string>;
  pendingCount: number;
  canRegenerate: boolean;
  showFinalize: boolean;
  canFinalize: boolean;
  regenerating: boolean;
  finalizing: boolean;
  onAnswer: (questionId: string, answer: string) => void;
  onRegenerate: () => void;
  onFinalize: () => void;
}) {
  const hasAnswers = Object.values(answers).some((answer) => answer.trim());
  return (
    <section className="constructor-guias-paso" aria-labelledby="constructor-guias-borrador">
      <p className="constructor-guias-etiqueta-paso">Paso 3 · Borrador + preguntas (se repite)</p>
      <h3 id="constructor-guias-borrador" className="sr-only">Borrador y preguntas</h3>
      <div className="constructor-guias-grid-borrador">
        <article className="tarjeta constructor-guias-panel">
          <h4 tabIndex={-1}>Borrador v{draftVersion} · manual .md</h4>
          <pre className="constructor-guias-borrador">{draft || "Preparando borrador…"}</pre>
          {pendingCount > 0 ? <p className="alerta alerta-info">{pendingCount} punto(s) pendiente(s) de verificación.</p> : null}
        </article>
        <article className="tarjeta constructor-guias-panel">
          <fieldset disabled={regenerating || finalizing}>
            <legend>Preguntas de aclaración</legend>
            {questions.length === 0 ? <p className="texto-ayuda">No hay preguntas pendientes.</p> : questions.map((question, index) => (
              <div className="fila-formulario" key={question.id}>
                <label htmlFor={`guide-question-${question.id}`}>{index + 1}. {question.text}</label>
                <textarea
                  id={`guide-question-${question.id}`}
                  rows={3}
                  value={answers[question.id] ?? ""}
                  onChange={(event) => onAnswer(question.id, event.target.value)}
                  placeholder="Su respuesta…"
                />
              </div>
            ))}
          </fieldset>
          <div className="constructor-guias-acciones-verticales">
            {canRegenerate ? (
              <button type="button" className="primario" onClick={onRegenerate} disabled={!hasAnswers || regenerating || finalizing}>
                {regenerating ? "Regenerando…" : "Regenerar con respuestas"}
              </button>
            ) : null}
            {showFinalize ? (
              <button type="button" className="exito" onClick={onFinalize} disabled={!canFinalize || finalizing || regenerating}>
                {finalizing ? "Finalizando…" : "Finalizar manual"}
              </button>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  );
}
