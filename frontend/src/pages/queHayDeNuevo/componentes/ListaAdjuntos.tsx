import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { esUrlHttps, nuevoId } from "../logica";
import type { Adjunto } from "../tipos";
import { formatoTamano } from "./extensiones";
import { useSubidaSimulada } from "./subidaSimulada";

/* Lista de adjuntos editable: cada elemento es Archivo o Enlace (diseño §4.2, campos 8 y 9). */
export function ListaAdjuntos({
  titulo,
  adjuntos,
  onChange,
  acepta,
  ayudaArchivo,
  maxBytes,
}: {
  titulo: string;
  adjuntos: Adjunto[];
  onChange: (a: Adjunto[]) => void;
  acepta: string;
  ayudaArchivo: string;
  maxBytes: number;
}) {
  const idTitulo = useId();
  return (
    <fieldset className="qhdn-adjuntos" aria-labelledby={idTitulo}>
      <legend id={idTitulo}>{titulo} <small>(opcional)</small></legend>
      {adjuntos.length === 0 && <p className="texto-ayuda">Sin elementos.</p>}
      <ul>
        {adjuntos.map((a, i) => (
          <FilaAdjunto
            key={a.id}
            adjunto={a}
            numero={i + 1}
            titulo={titulo}
            acepta={acepta}
            ayudaArchivo={ayudaArchivo}
            maxBytes={maxBytes}
            onChange={(nuevo) => onChange(adjuntos.map((x) => (x.id === a.id ? nuevo : x)))}
            onQuitar={() => onChange(adjuntos.filter((x) => x.id !== a.id))}
          />
        ))}
      </ul>
      <button type="button" className="qhdn-boton-enlace" onClick={() => onChange([...adjuntos, { id: nuevoId("adj"), clase: "archivo", nombre: "", url: "" }])}>
        <Plus size={14} aria-hidden="true" /> Agregar a {titulo.toLowerCase()}
      </button>
    </fieldset>
  );
}

function FilaAdjunto({
  adjunto,
  numero,
  titulo,
  acepta,
  ayudaArchivo,
  maxBytes,
  onChange,
  onQuitar,
}: {
  adjunto: Adjunto;
  numero: number;
  titulo: string;
  acepta: string;
  ayudaArchivo: string;
  maxBytes: number;
  onChange: (a: Adjunto) => void;
  onQuitar: () => void;
}) {
  const base = useId();
  const subida = useSubidaSimulada();
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);
  const nombreGrupo = `${base}-clase`;
  const enlaceInvalido = adjunto.clase === "enlace" && adjunto.url !== "" && !esUrlHttps(adjunto.url);
  return (
    <li className="qhdn-adjunto-fila">
      <div role="radiogroup" aria-label={`Clase del elemento ${numero} de ${titulo}`} className="qhdn-radios-en-linea">
        <label><input type="radio" name={nombreGrupo} checked={adjunto.clase === "archivo"} onChange={() => onChange({ ...adjunto, clase: "archivo", url: "", nombre: "" })} /> Archivo</label>
        <label><input type="radio" name={nombreGrupo} checked={adjunto.clase === "enlace"} onChange={() => onChange({ ...adjunto, clase: "enlace", url: "", nombre: "" })} /> Enlace</label>
      </div>
      {adjunto.clase === "archivo" ? (
        <div className="qhdn-adjunto-campos">
          <label htmlFor={`${base}-archivo`} className="sr-only">Archivo del elemento {numero} de {titulo}</label>
          {adjunto.url ? (
            <span>{adjunto.nombre} <small>· {formatoTamano(adjunto.tamano ?? 0)}</small></span>
          ) : (
            <input
              id={`${base}-archivo`}
              type="file"
              accept={acepta}
              aria-describedby={`${base}-ayuda`}
              onChange={async (e) => {
                const archivo = e.target.files?.[0];
                setErrorArchivo(null);
                if (!archivo) return;
                if (archivo.size > maxBytes) {
                  e.target.value = "";
                  setErrorArchivo(`El archivo supera ${formatoTamano(maxBytes)}. Elige uno más pequeño o usa un enlace.`);
                  return;
                }
                const url = await subida.subir(archivo);
                onChange({ ...adjunto, url, nombre: archivo.name, tamano: archivo.size, tipoMime: archivo.type });
              }}
            />
          )}
          <small id={`${base}-ayuda`} className="texto-ayuda">{ayudaArchivo}</small>
          {errorArchivo && <small className="qhdn-error-campo" role="alert">{errorArchivo}</small>}
          {subida.progreso !== null && (
            <span role="status" aria-live="polite" className="qhdn-subida">
              Subiendo {subida.nombre}… {subida.progreso}% <progress max={100} value={subida.progreso} aria-hidden="true" />
            </span>
          )}
        </div>
      ) : (
        <div className="qhdn-adjunto-campos">
          <label htmlFor={`${base}-url`}>Dirección (https)</label>
          <input
            id={`${base}-url`}
            type="url"
            value={adjunto.url}
            placeholder="https://"
            aria-invalid={enlaceInvalido || undefined}
            aria-describedby={enlaceInvalido ? `${base}-error` : undefined}
            onChange={(e) => onChange({ ...adjunto, url: e.target.value })}
          />
          <label htmlFor={`${base}-nombre`}>Nombre visible</label>
          <input id={`${base}-nombre`} value={adjunto.nombre} maxLength={120} onChange={(e) => onChange({ ...adjunto, nombre: e.target.value })} />
          {enlaceInvalido && <small id={`${base}-error`} className="qhdn-error-campo">El enlace debe empezar por https://.</small>}
        </div>
      )}
      <button type="button" onClick={onQuitar} aria-label={`Quitar elemento ${numero} de ${titulo}`}>Quitar</button>
    </li>
  );
}
