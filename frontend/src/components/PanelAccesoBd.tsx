import { useState } from "react";
import { api } from "../api/client";
import { BotonCopiar } from "./Comunes";
import type { BaseDeDatos } from "../types";

// Panel que muestra las cuatro partes del acceso a la base de datos
// con botones de copiar individualmente. La contraseña queda oculta hasta
// que el usuario la revele explícitamente; cada acción se audita.
export function PanelAccesoBd({ bd }: { bd: BaseDeDatos }) {
  const [contrasena, setContrasena] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function copiarParte(parte: "serverHostPort" | "initialCatalog" | "userId") {
    try {
      await api.post(`/databases/${bd.id}/copy-access-part`, { part: parte });
    } catch {/* no bloquea la copia local */}
  }

  async function revelarContrasena() {
    setError(null);
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
    setCargando(true);
    try {
      const r = await api.post<{ part: string; value: string }>(`/databases/${bd.id}/copy-access-part`, { part: "password" });
      await navigator.clipboard.writeText(r.value);
      alert("Contraseña copiada al portapapeles.");
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
        <button disabled={cargando} onClick={revelarContrasena}>{contrasena ? "Ocultar" : "Revelar"}</button>
        <button className="primario" disabled={cargando} onClick={copiarContrasena}>Copiar contraseña</button>
        {contrasena && <button onClick={() => setContrasena(null)}>Ocultar</button>}
      </div>
      {error && <div className="alerta alerta-error">{error}</div>}
    </div>
  );
}
