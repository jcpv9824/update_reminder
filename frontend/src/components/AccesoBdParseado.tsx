import { useMemo } from "react";
import { parseDbAccessString } from "../utils/dbAccessParser";

// Muestra una vista previa del parser de la cadena de acceso a base de datos.
// La contraseña nunca se muestra en texto claro: solo se indica que fue detectada.
export function AccesoBdParseado({ texto }: { texto: string }) {
  const resultado = useMemo(() => {
    if (!texto || !texto.trim()) return { error: "Pegue la cadena de acceso para ver la vista previa." };
    try {
      return { ok: parseDbAccessString(texto) };
    } catch (e: any) {
      return { error: e?.message ?? "Cadena inválida." };
    }
  }, [texto]);

  if ("error" in resultado) {
    return <div className="parser-preview">{resultado.error}</div>;
  }
  const r = resultado.ok!;
  return (
    <div className="parser-preview" data-testid="parser-preview">
      <div className="linea"><span className="clave">Servidor y puerto:</span><span>{r.serverHostPort}</span></div>
      <div className="linea"><span className="clave">Base de datos:</span><span>{r.initialCatalog}</span></div>
      <div className="linea"><span className="clave">Usuario:</span><span>{r.userId}</span></div>
      <div className="linea"><span className="clave">Contraseña:</span><span>Detectada — se almacenará en Azure Key Vault</span></div>
    </div>
  );
}
