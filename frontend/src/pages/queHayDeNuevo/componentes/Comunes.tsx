import { useEffect, useId, useRef, type ReactNode } from "react";
import { CLASE_ESTADO, ETIQUETAS_ESTADO_QHDN, ETIQUETAS_SISTEMA, ETIQUETAS_TIPO_CORTAS, rutaTexto } from "../logica";
import type { Adjunto, EstadoEntrada, Ruta, Sistema, TipoEntrada } from "../tipos";
import { formatoTamano } from "./extensiones";

/*
 * Diálogo accesible con las clases `.modal-fondo` / `.modal` del portal.
 * Añade lo que el Modal compartido aún no tiene (DESIGN_SYSTEM.md › Dialogs):
 * role="dialog", aria-modal, título asociado, Escape, foco inicial, trampa de foco y restauración.
 */
export function Dialogo({
  titulo,
  abierto,
  onCerrar,
  children,
  className = "",
  pie,
}: {
  titulo: string;
  abierto: boolean;
  onCerrar: () => void;
  children: ReactNode;
  className?: string;
  pie?: ReactNode;
}) {
  const idTitulo = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCerrarRef = useRef(onCerrar);
  onCerrarRef.current = onCerrar;

  useEffect(() => {
    if (!abierto) return;
    const anterior = document.activeElement as HTMLElement | null;
    const enfocables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const primero = ref.current?.querySelector<HTMLElement>("[data-autofoco]") ?? enfocables()[1] ?? enfocables()[0];
    primero?.focus();
    function alTeclear(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCerrarRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const lista = enfocables();
      if (lista.length === 0) return;
      const inicio = lista[0];
      const fin = lista[lista.length - 1];
      if (e.shiftKey && document.activeElement === inicio) { e.preventDefault(); fin.focus(); }
      else if (!e.shiftKey && document.activeElement === fin) { e.preventDefault(); inicio.focus(); }
    }
    const nodo = ref.current;
    nodo?.addEventListener("keydown", alTeclear);
    return () => {
      nodo?.removeEventListener("keydown", alTeclear);
      anterior?.focus?.();
    };
  }, [abierto]);

  if (!abierto) return null;
  return (
    <div className="modal-fondo">
      <div ref={ref} className={`modal qhdn-dialogo ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={idTitulo}>
        <div className="qhdn-dialogo-cabecera">
          <h3 id={idTitulo}>{titulo}</h3>
          <button type="button" onClick={onCerrar}>Cerrar</button>
        </div>
        <div className="modal-body">{children}</div>
        {pie && <div className="acciones-formulario">{pie}</div>}
      </div>
    </div>
  );
}

export function EtiquetaTipo({ tipo }: { tipo: TipoEntrada | null }) {
  if (!tipo) return <span className="qhdn-tipo qhdn-tipo-vacio">Sin tipo</span>;
  return <span className={`qhdn-tipo qhdn-tipo-${tipo}`}>{ETIQUETAS_TIPO_CORTAS[tipo]}</span>;
}

export function EtiquetaSistema({ sistema }: { sistema: Sistema | null }) {
  return <span className="qhdn-sistema">{sistema ? ETIQUETAS_SISTEMA[sistema] : "Sin sistema"}</span>;
}

export function EtiquetaEstadoQhdn({ estado }: { estado: EstadoEntrada | "eliminada" }) {
  if (estado === "eliminada") return <span className={`estado ${CLASE_ESTADO.archivada}`}>Eliminada</span>;
  return <span className={`estado ${CLASE_ESTADO[estado]}`}>{ETIQUETAS_ESTADO_QHDN[estado]}</span>;
}

export function ListaRutas({ rutas }: { rutas: Ruta[] }) {
  if (rutas.length === 0) return <p className="texto-ayuda">Sin rutas.</p>;
  return (
    <ul className="qhdn-rutas">
      {rutas.map((ruta, i) => (
        <li key={ruta.id}>
          <span className="qhdn-ruta-tipo">{i === 0 ? "Principal" : "Relacionada"}</span>
          <span>{rutaTexto(ruta)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ListaAdjuntosLectura({ titulo, adjuntos }: { titulo: string; adjuntos: Adjunto[] }) {
  return (
    <div className="qhdn-referencia">
      <h4>{titulo}</h4>
      {adjuntos.length === 0 ? <p className="texto-ayuda">Sin adjuntos.</p> : (
        <ul>
          {adjuntos.map((a) => (
            <li key={a.id}>
              <a href={a.url} target="_blank" rel="noopener noreferrer">{a.nombre || a.url}</a>
              <small> · {a.clase === "enlace" ? "Enlace" : `Archivo${a.tamano ? `, ${formatoTamano(a.tamano)}` : ""}`}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Aviso de prototipo: deja claro que nada llega al servidor. */
export function AvisoPrototipo() {
  return (
    <p className="qhdn-aviso-prototipo" role="note">
      Prototipo con datos simulados. Nada se guarda en el servidor y todo vuelve al estado inicial al recargar la página.
    </p>
  );
}
