import { useState } from "react";
import { api } from "../api/client";
import { BotonCopiar } from "./Comunes";
import type { BaseDeDatos } from "../types";

// Copia robusta: el Clipboard API moderno exige activación de usuario reciente;
// tras un await de red puede fallar. Se intenta el API moderno y, si falla,
// se usa textarea + execCommand como respaldo.
async function copiarAlPortapapeles(texto: string): Promise<boolean> {
  if (!texto) return false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {/* respaldo */}
  try {
    const ta = document.createElement("textarea");
    ta.value = texto;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Panel que muestra las cuatro partes del acceso a la base de datos
// con botones de copiar individualmente. La contraseña queda oculta hasta
// que el usuario la revele explícitamente; cada acción se audita.
export function PanelAccesoBd({ bd }: { bd: BaseDeDatos }) {
  const [contrasena, setContrasena] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function copiarParte(parte: "serverHostPort" | "initialCatalog" | "userId") {
    try {
      await api.post(`/databases/${bd.id}/copy-access-part`, { part: parte });
    } catch {/* no bloquea la copia local */}
  }

  async function revelarContrasena() {
    setError(null);
    setMensaje(null);
    setCargando(true);
    try {
      const r = await api.post<{ password: string }>(`/databases/${bd.id}/reveal-password`, {});
      setContrasena(r.password);
    } catch (e: any) {
      setError(e?.message ?? "No se pudo revelar la contraseña.");
    } finally {
      setCargando(false);
    }
  }

  async function copiarContrasena() {
    setError(null);
    setMensaje(null);
    setCargando(true);
    try {
      const r = await api.post<{ part: string; value: string }>(`/databases/${bd.id}/copy-access-part`, { part: "password" });
      const ok = await copiarAlPortapapeles(r.value);
      if (ok) {
        setMensaje("Contraseña copiada al portapapeles.");
      } else {
        setContrasena(r.value);
        setError("No se pudo copiar automáticamente. La contraseña se muestra para copiarla manualmente.");
      }
    } catch (e: any) {
      setError(e?.message ?? "No se pudo copiar la contraseña.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="acceso-bd">
      <div className="campo">
        <strong>Servidor y puerto:</strong>
        <span className="valor">{bd.dbAccess.serverHostPort}</span>
        <BotonCopiar valor={bd.dbAccess.serverHostPort} onCopia={() => copiarParte("serverHostPort")} />
      </div>
      <div className="campo">
        <strong>Base de datos:</strong>
        <span className="valor">{bd.dbAccess.initialCatalog}</span>
        <BotonCopiar valor={bd.dbAccess.initialCatalog} onCopia={() => copiarParte("initialCatalog")} />
      </div>
      <div className="campo">
        <strong>Usuario:</strong>
        <span className="valor">{bd.dbAccess.userId}</span>
        <BotonCopiar valor={bd.dbAccess.userId} onCopia={() => copiarParte("userId")} />
      </div>
      <div className="campo">
        <strong>Contraseña:</strong>
        <span className="valor">{contrasena ?? "••••••••"}</span>
        <button disabled={cargando} onClick={() => (contrasena ? setContrasena(null) : revelarContrasena())}>{contrasena ? "Ocultar" : "Revelar"}</button>
        <button className="primario" disabled={cargando} onClick={copiarContrasena}>Copiar contraseña</button>
      </div>
      {error && <div className="alerta alerta-error">{error}</div>}
      {mensaje && <div className="alerta alerta-exito">{mensaje}</div>}
    </div>
  );
}
