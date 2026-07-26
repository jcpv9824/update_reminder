import { ChangeEvent, DragEvent, KeyboardEvent, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

type Props = {
  selectedFile: File | null;
  uploading: boolean;
  uploadProgress: number | null;
  canCreate: boolean;
  onSelect: (file: File | null) => void;
  onStart: () => void;
  onCancel: () => void;
};

const VIDEO_ACCEPT = ".mp4,.m4v,.mov,.webm,video/mp4,video/x-m4v,video/quicktime,video/webm";

export function UploadStep({
  selectedFile,
  uploading,
  uploadProgress,
  canCreate,
  onSelect,
  onStart,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    onSelect(event.target.files?.[0] ?? null);
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (!canCreate || uploading) return;
    onSelect(event.dataTransfer.files?.[0] ?? null);
  }
  function openFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!canCreate || uploading) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    inputRef.current?.click();
  }

  return (
    <section className="tarjeta constructor-guias-panel" aria-labelledby="constructor-guias-carga">
      <h3 id="constructor-guias-carga">Nuevo manual desde video</h3>
      <p className="texto-ayuda">Suba una grabación narrada del procedimiento en SAG Web.</p>
      <label className="sr-only" htmlFor="constructor-guias-video">Video narrado del procedimiento</label>
      <input
        ref={inputRef}
        className="sr-only"
        id="constructor-guias-video"
        type="file"
        accept={VIDEO_ACCEPT}
        onChange={chooseFile}
        disabled={!canCreate || uploading}
      />
      <div
        className={`constructor-guias-dropzone ${dragActive ? "activo" : ""}`}
        role="button"
        tabIndex={canCreate && !uploading ? 0 : -1}
        aria-disabled={!canCreate || uploading}
        aria-describedby="constructor-guias-formatos"
        onClick={() => canCreate && !uploading && inputRef.current?.click()}
        onKeyDown={openFromKeyboard}
        onDragOver={(event) => { event.preventDefault(); if (canCreate && !uploading) setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={drop}
      >
        <UploadCloud size={30} aria-hidden="true" />
        <strong>Arrastre el archivo o haga clic para seleccionar</strong>
        <span id="constructor-guias-formatos">MP4 · M4V · MOV · WebM · máximo 100 MB · audio en español</span>
      </div>
      {selectedFile ? (
        <p className="constructor-guias-archivo" aria-live="polite">
          Archivo seleccionado: <strong>{selectedFile.name}</strong>
        </p>
      ) : null}
      {uploading ? (
        <div className="constructor-guias-procesando" aria-live="polite">
          <label htmlFor="constructor-guias-upload-progress">Cargando video… {uploadProgress ?? 0}%</label>
          <progress id="constructor-guias-upload-progress" max={100} value={uploadProgress ?? 0} />
        </div>
      ) : null}
      <div className="acciones-formulario constructor-guias-acciones">
        <button type="button" className="primario" onClick={onStart} disabled={!canCreate || !selectedFile || uploading}>
          {uploading ? "Cargando video…" : "Iniciar procesamiento"}
        </button>
        {(selectedFile || uploading) ? <button type="button" onClick={onCancel}>Cancelar</button> : null}
      </div>
      {!canCreate ? <p className="texto-ayuda">No tienes permiso para iniciar una nueva guía.</p> : null}
    </section>
  );
}
