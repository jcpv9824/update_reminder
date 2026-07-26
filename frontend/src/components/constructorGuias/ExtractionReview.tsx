import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { GuideFrame } from "../../types";

function timestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function AuthenticatedFrame({ sessionId, frame }: { sessionId: string; frame: GuideFrame }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let currentUrl: string | null = null;
    let active = true;
    api.getBlob(`/guide-sessions/${sessionId}/frames/${frame.id}`)
      .then((blob) => {
        if (!active) return;
        currentUrl = URL.createObjectURL(blob);
        setSrc(currentUrl);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [frame.id, sessionId]);
  if (failed) return <div className="constructor-guias-captura-error">No se pudo cargar la captura.</div>;
  if (!src) return <div className="constructor-guias-captura-cargando">Cargando captura…</div>;
  return <img src={src} alt={`Captura a ${timestamp(frame.timestampMs)} — ${frame.caption}`} />;
}

export function ExtractionReview({
  sessionId,
  transcript,
  frames,
  canDownloadTranscript,
  onDownloadTranscript,
}: {
  sessionId: string;
  transcript: string;
  frames: GuideFrame[];
  canDownloadTranscript: boolean;
  onDownloadTranscript: () => void;
}) {
  return (
    <section className="constructor-guias-paso" aria-labelledby="constructor-guias-extraccion">
      <p className="constructor-guias-etiqueta-paso">Paso 2 · Extracción (una sola vez)</p>
      <h3 id="constructor-guias-extraccion" className="sr-only">Extracción</h3>
      <div className="constructor-guias-grid-dos">
        <article className="tarjeta constructor-guias-panel">
          <div className="constructor-guias-panel-titulo">
            <h4>Transcripción</h4>
            {canDownloadTranscript ? <button type="button" onClick={onDownloadTranscript}>Descargar transcripción</button> : null}
          </div>
          <pre className="constructor-guias-transcripcion">{transcript || "Preparando transcripción…"}</pre>
        </article>
        <article className="tarjeta constructor-guias-panel">
          <h4>Capturas alineadas</h4>
          {frames.length === 0 ? <p className="texto-ayuda">Preparando capturas…</p> : (
            <div className="constructor-guias-capturas">
              {frames.map((frame) => (
                <figure key={frame.id}>
                  <AuthenticatedFrame sessionId={sessionId} frame={frame} />
                  <figcaption>{timestamp(frame.timestampMs)} · {frame.caption}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
