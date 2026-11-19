import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Subida simulada: avanza el progreso y devuelve una URL de objeto local.
 * Con la API real se reemplaza por la carga a SeaweedFS (documento 05):
 * pedir URL de escritura, subir con progreso y confirmar.
 */

export function urlDeObjeto(archivo: File): string {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") return URL.createObjectURL(archivo);
  return `blob:prototipo/${encodeURIComponent(archivo.name)}`;
}

export function useSubidaSimulada(pasoMs = 120) {
  const [progreso, setProgreso] = useState<number | null>(null);
  const [nombre, setNombre] = useState("");
  const temporizador = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (temporizador.current) clearInterval(temporizador.current);
  }, []);

  const subir = useCallback((archivo: File) => new Promise<string>((resolver) => {
    setNombre(archivo.name);
    setProgreso(0);
    let actual = 0;
    temporizador.current = setInterval(() => {
      actual += 25;
      if (actual >= 100) {
        if (temporizador.current) clearInterval(temporizador.current);
        temporizador.current = null;
        setProgreso(null);
        resolver(urlDeObjeto(archivo));
      } else {
        setProgreso(actual);
      }
    }, pasoMs);
  }), [pasoMs]);

  return { progreso, nombre, subir };
}
