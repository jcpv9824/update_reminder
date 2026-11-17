import { useEffect } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

/*
  Aviso anclado arriba de la ventana visible: se ve aunque la persona haya
  bajado con el scroll. El éxito y la información se ocultan solos; el error se
  queda hasta que la persona lo cierre.
*/

export type Aviso = { id: number; tipo: "error" | "exito" | "info"; texto: string };

const SEGUNDOS_VISIBLE = 8;

let siguienteId = 1;
export function nuevoAviso(tipo: Aviso["tipo"], texto: string): Aviso {
  return { id: siguienteId++, tipo, texto };
}

export default function AvisoFlotante({ aviso, onCerrar }: { aviso: Aviso | null; onCerrar: () => void }) {
  useEffect(() => {
    if (!aviso || aviso.tipo === "error") return;
    const temporizador = window.setTimeout(onCerrar, SEGUNDOS_VISIBLE * 1000);
    return () => window.clearTimeout(temporizador);
  }, [aviso, onCerrar]);

  if (!aviso) return null;
  const Icono = aviso.tipo === "error" ? CircleAlert : aviso.tipo === "exito" ? CircleCheck : Info;
  return (
    <div
      className={`aviso-flotante aviso-flotante-${aviso.tipo}`}
      role={aviso.tipo === "error" ? "alert" : "status"}
      aria-live={aviso.tipo === "error" ? "assertive" : "polite"}
    >
      <Icono size={20} aria-hidden="true" />
      <span className="aviso-flotante-texto">{aviso.texto}</span>
      <button type="button" className="aviso-flotante-cerrar" aria-label="Cerrar aviso" onClick={onCerrar}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
