import { ReactNode, useState } from "react";
import { ETIQUETAS_ESTADO } from "../types";

export function EtiquetaEstado({ estado }: { estado: string }) {
  return <span className={`estado estado-${estado}`}>{ETIQUETAS_ESTADO[estado] ?? estado}</span>;
}

export function BotonCopiar({ valor, etiqueta = "Copiar", onCopia }: { valor: string; etiqueta?: string; onCopia?: () => void }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(valor);
          setCopiado(true);
          onCopia?.();
          setTimeout(() => setCopiado(false), 1500);
        } catch {
          alert("No se pudo copiar al portapapeles.");
        }
      }}
    >
      {copiado ? "¡Copiado!" : etiqueta}
    </button>
  );
}

type ModalProps = { titulo: string; abierto: boolean; onCerrar: () => void; children: ReactNode };
export function Modal({ titulo, abierto, onCerrar, children }: ModalProps) {
  if (!abierto) return null;
  return (
    <div className="modal-fondo" onClick={onCerrar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{titulo}</h3>
          <button onClick={onCerrar}>Cerrar</button>
        </div>
        {children}
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
