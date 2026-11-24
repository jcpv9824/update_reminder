import { useId } from "react";
import { Plus, X } from "lucide-react";
import {
  agregarSubmenu,
  cambiarNivel,
  MAX_NIVELES,
  MAX_RUTAS,
  MIN_NIVELES,
  quitarSubmenu,
  rutaTexto,
  rutaVacia,
  VIAS,
} from "../logica";
import type { Ruta } from "../tipos";

/*
 * Constructor de rutas. Decisión del propietario (3.ª ronda): todo se escribe a mano.
 * Nivel 1: lista fija (Barra de navegación / Barra lateral). Submenús y Opción: texto libre.
 * «+ Submenú» agrega un submenú antes de la Opción; «× Submenú» quita el último. De 3 a 5 niveles.
 */
export function ConstructorRutas({
  rutas,
  onChange,
  error,
  idError,
}: {
  rutas: Ruta[];
  onChange: (rutas: Ruta[]) => void;
  error?: string;
  idError?: string;
}) {
  return (
    <div className="qhdn-constructor-rutas">
      {rutas.map((ruta, i) => (
        <FilaRuta
          key={ruta.id}
          ruta={ruta}
          indice={i}
          invalido={Boolean(error)}
          idError={idError}
          onChange={(r) => onChange(rutas.map((x) => (x.id === ruta.id ? r : x)))}
          onQuitar={i > 0 ? () => onChange(rutas.filter((x) => x.id !== ruta.id)) : undefined}
        />
      ))}
      <button type="button" className="qhdn-boton-enlace" disabled={rutas.length >= MAX_RUTAS} onClick={() => onChange([...rutas, rutaVacia()])}>
        <Plus size={14} aria-hidden="true" /> Agregar ruta relacionada
      </button>
      {rutas.length >= MAX_RUTAS && <p className="texto-ayuda">Llegaste al máximo de {MAX_RUTAS} rutas.</p>}
    </div>
  );
}

function nombreNivel(i: number, total: number) {
  if (i === 0) return "Vía";
  if (i === total - 1) return "Opción";
  return total > MIN_NIVELES ? `Submenú ${i}` : "Submenú";
}

function FilaRuta({
  ruta,
  indice,
  invalido,
  idError,
  onChange,
  onQuitar,
}: {
  ruta: Ruta;
  indice: number;
  invalido: boolean;
  idError?: string;
  onChange: (r: Ruta) => void;
  onQuitar?: () => void;
}) {
  const base = useId();
  const titulo = indice === 0 ? "Ruta principal" : `Ruta relacionada ${indice}`;
  const total = ruta.niveles.length;
  return (
    <fieldset className="qhdn-ruta" aria-describedby={invalido ? idError : undefined}>
      <legend>{titulo}</legend>
      <div className="qhdn-ruta-niveles">
        {ruta.niveles.map((nivel, i) => {
          const id = `${base}-n${i}`;
          const etiqueta = nombreNivel(i, total);
          return (
            <div key={i} className="qhdn-nivel">
              {i > 0 && <span className="qhdn-separador-ruta" aria-hidden="true">›</span>}
              <div>
                <label htmlFor={id}>{etiqueta}</label>
                {i === 0 ? (
                  <select id={id} value={nivel.valor} onChange={(e) => onChange(cambiarNivel(ruta, 0, e.target.value))}>
                    {VIAS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <input
                    id={id}
                    value={nivel.valor}
                    maxLength={120}
                    placeholder={i === total - 1 ? "Nombre de la opción" : "Nombre del submenú"}
                    aria-invalid={invalido && !nivel.valor.trim() ? true : undefined}
                    onChange={(e) => onChange(cambiarNivel(ruta, i, e.target.value))}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="qhdn-ruta-acciones">
        <button type="button" onClick={() => onChange(agregarSubmenu(ruta))} disabled={total >= MAX_NIVELES} aria-label={`Agregar submenú a ${titulo}`} title="Agregar submenú">
          <Plus size={14} aria-hidden="true" /> Submenú
        </button>
        <button type="button" onClick={() => onChange(quitarSubmenu(ruta))} disabled={total <= MIN_NIVELES} aria-label={`Quitar último submenú de ${titulo}`} title="Quitar último submenú">
          <X size={14} aria-hidden="true" /> Submenú
        </button>
        {onQuitar && <button type="button" className="qhdn-boton-enlace" onClick={onQuitar}>Quitar esta ruta</button>}
        <span className="texto-ayuda qhdn-ruta-niveles-ayuda">{total} de {MAX_NIVELES} niveles · mínimo {MIN_NIVELES}</span>
      </div>
      <p className="qhdn-ruta-texto" aria-live="polite">{rutaTexto(ruta)}</p>
    </fieldset>
  );
}
