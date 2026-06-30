import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { BotonCopiar } from "./Comunes";
import type { AccesoBaseDatos, BaseDeDatos } from "../types";

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
export function PanelAccesoBd({ bd, taskId }: { bd: BaseDeDatos; taskId?: string }) {
  const [contrasena, setContrasena] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const accessQuery = useQuery({
    queryKey: ["acceso-base-datos", bd.id, taskId ?? "master"],
    queryFn: () => api.get<AccesoBaseDatos>(
      `/databases/${bd.id}/access-info${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`
    ),
    retry: false,
  });
  const acceso = accessQuery.data;

  async function copiarParte(parte: "serverHostPort" | "initialCatalog" | "userId") {
    try {
      await api.post(`/databases/${bd.id}/copy-access-part`, { part: parte, ...(taskId ? { taskId } : {}) });
    } catch {/* no bloquea la copia local */}
  }

  async function revelarContrasena() {
    setError(null);
    setMensaje(null);
    setCargando(true);
    try {
      const r = await api.post<{ password: string }>(`/databases/${bd.id}/reveal-password`, taskId ? { taskId, reason: "access_panel" } : {});
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
      const r = await api.post<{ part: string; value: string }>(`/databases/${bd.id}/copy-access-part`, { part: "password", ...(taskId ? { taskId } : {}) });
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

  if (accessQuery.isLoading) return <div className="cargando">Cargando acceso autorizado...</div>;
  if (accessQuery.isError || !acceso) {
    const error = accessQuery.error as Error & { status?: number };
    return <div className="alerta alerta-error">{error?.status === 403 ? "No tiene permisos para ver esta conexión." : "No se pudo cargar la información de acceso."}</div>;
  }

  return (
    <div className="acceso-bd">
      <div className="campo">
        <strong>Servidor y puerto:</strong>
        <span className="valor">{acceso.server}</span>
        <BotonCopiar valor={acceso.server} onCopia={() => copiarParte("serverHostPort")} />
      </div>
      <div className="campo">
        <strong>Base de datos:</strong>
        <span className="valor">{acceso.databaseName}</span>
        <BotonCopiar valor={acceso.databaseName} onCopia={() => copiarParte("initialCatalog")} />
      </div>
      <div className="campo">
        <strong>Usuario:</strong>
        <span className="valor">{acceso.user}</span>
        <BotonCopiar valor={acceso.user} onCopia={() => copiarParte("userId")} />
      </div>
      <div className="campo">
        <strong>Contraseña:</strong>
        <span className="valor">{acceso.hasPassword ? (contrasena ?? "••••••••") : "No configurada"}</span>
        <button disabled={cargando || !acceso.hasPassword} onClick={() => (contrasena ? setContrasena(null) : revelarContrasena())}>{contrasena ? "Ocultar" : "Revelar"}</button>
        <button className="primario" disabled={cargando || !acceso.hasPassword} onClick={copiarContrasena}>Copiar contraseña</button>
      </div>
      {error && <div className="alerta alerta-error">{error}</div>}
      {mensaje && <div className="alerta alerta-exito">{mensaje}</div>}
    </div>
  );
}
