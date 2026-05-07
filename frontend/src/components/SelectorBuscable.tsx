import { useEffect, useMemo, useRef, useState } from "react";

export type OpcionBuscable = {
  id: string;
  etiqueta: string;
  subtitulo?: string;
};

type Props = {
  opciones: OpcionBuscable[];
  valor: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  permiteVacio?: boolean;
  textoVacio?: string;
};

// Selector con búsqueda incremental. Filtra por etiqueta y subtítulo
// (case-insensitive). Muestra un dropdown con las coincidencias.
export function SelectorBuscable({ opciones, valor, onChange, placeholder, disabled, permiteVacio, textoVacio }: Props) {
  const seleccionada = useMemo(() => opciones.find((o) => o.id === valor) ?? null, [opciones, valor]);
  const [abierto, setAbierto] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const contenedorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (contenedorRef.current && !contenedorRef.current.contains(e.target as Node)) {
        setAbierto(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return opciones;
    return opciones.filter((o) =>
      o.etiqueta.toLowerCase().includes(q) ||
      (o.subtitulo ?? "").toLowerCase().includes(q)
    );
  }, [opciones, busqueda]);

  const valorMostrado = abierto ? busqueda : (seleccionada?.etiqueta ?? "");

  function elegir(id: string) {
    onChange(id);
    setAbierto(false);
    setBusqueda("");
  }

  return (
    <div className="selector-buscable" ref={contenedorRef}>
      <input
        ref={inputRef}
        value={valorMostrado}
        placeholder={placeholder ?? "Escriba para buscar..."}
        disabled={disabled}
        onFocus={() => { setBusqueda(""); setAbierto(true); }}
        onChange={(e) => { setBusqueda(e.target.value); setAbierto(true); }}
      />
      {valor && !abierto && permiteVacio && (
        <button
          type="button"
          aria-label="Limpiar selección"
          className="selector-buscable-limpiar"
          onClick={() => onChange("")}
        >
          ×
        </button>
      )}
      {abierto && (
        <ul className="selector-buscable-lista" role="listbox">
          {permiteVacio && (
            <li onMouseDown={(e) => { e.preventDefault(); elegir(""); }} className="selector-buscable-vacio">
              {textoVacio ?? "(sin selección)"}
            </li>
          )}
          {filtradas.length === 0 ? (
            <li className="selector-buscable-vacio">Sin coincidencias.</li>
          ) : (
            filtradas.map((o) => (
              <li
                key={o.id}
                role="option"
                aria-selected={o.id === valor}
                className={o.id === valor ? "activo" : ""}
                onMouseDown={(e) => { e.preventDefault(); elegir(o.id); }}
              >
                <span>{o.etiqueta}</span>
                {o.subtitulo && <small> · {o.subtitulo}</small>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
