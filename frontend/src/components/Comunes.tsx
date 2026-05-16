import { ReactNode, useState } from "react";
import { ETIQUETAS_ESTADO } from "../types";

export function EtiquetaEstado({ estado }: { estado: string }) {
  return <span className={`estado estado-${estado}`}>{ETIQUETAS_ESTADO[estado] ?? estado}</span>;
}

export function BotonCopiar({ valor, etiqueta = "Copiar", onCopia }: { valor: string; etiqueta?: string; onCopia?: () => void }) {
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState(false);
  return (
    <span className="boton-copiar-wrapper">
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(valor);
            setCopiado(true);
            setError(false);
            onCopia?.();
            setTimeout(() => setCopiado(false), 1500);
          } catch {
            setError(true);
            setTimeout(() => setError(false), 2500);
          }
        }}
      >
        {copiado ? "¡Copiado!" : etiqueta}
      </button>
      {error && <span className="texto-ayuda error-inline">No se pudo copiar.</span>}
    </span>
  );
}

type ModalProps = {
  titulo: string;
  abierto: boolean;
  onCerrar: () => void;
  children: ReactNode;
  // Por defecto los formularios NO se cierran al hacer clic fuera
  // (evita pérdida accidental de datos al seleccionar texto y soltar fuera).
  // Las modales puramente informativas pueden pasar `cerrarPorFondo`.
  cerrarPorFondo?: boolean;
  className?: string;
};
export function Modal({ titulo, abierto, onCerrar, children, cerrarPorFondo = false, className = "" }: ModalProps) {
  if (!abierto) return null;
  return (
    <div
      className="modal-fondo"
      onClick={cerrarPorFondo ? onCerrar : undefined}
      onMouseDown={(e) => {
        // Si el usuario soltó el clic en el fondo pero el botón empezó dentro
        // de la modal (drag de selección), no debemos cerrar.
        if (cerrarPorFondo) return;
        e.stopPropagation();
      }}
    >
      <div
        className={`modal ${className}`.trim()}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{titulo}</h3>
          <button type="button" onClick={onCerrar} aria-label="Cerrar">Cerrar</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

export function DialogoConfirmar({
  abierto,
  titulo,
  mensaje,
  onConfirmar,
  onCancelar,
  textoConfirmar = "Confirmar",
  variante = "primario",
}: {
  abierto: boolean;
  titulo: string;
  mensaje: string;
  onConfirmar: () => void;
  onCancelar: () => void;
  textoConfirmar?: string;
  variante?: "primario" | "peligro";
}) {
  if (!abierto) return null;
  return (
    <Modal titulo={titulo} abierto onCerrar={onCancelar}>
      <p>{mensaje}</p>
      <div className="acciones-formulario">
        <button onClick={onCancelar}>Cancelar</button>
        <button className={variante} onClick={onConfirmar}>{textoConfirmar}</button>
      </div>
    </Modal>
  );
}

export function Alerta({ tipo, children }: { tipo: "error" | "exito" | "info"; children: ReactNode }) {
  return <div className={`alerta alerta-${tipo}`}>{children}</div>;
}

export function Paginacion({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return (
    <div className="paginacion">
      <span>Mostrando {start}-{end} de {total}</span>
      <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>Anterior</button>
      <span>Página {page} de {totalPages}</span>
      <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>Siguiente</button>
    </div>
  );
}
