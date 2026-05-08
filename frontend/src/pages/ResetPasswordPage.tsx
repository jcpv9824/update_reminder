import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setExito(null);
    if (!token) { setError("El enlace no es válido o ya expiró. Solicita uno nuevo."); return; }
    if (password.length < 6) { setError("La contraseña debe tener al menos 6 caracteres."); return; }
    if (password !== confirm) { setError("Las contraseñas no coinciden."); return; }
    setCargando(true);
    try {
      const r = await api.post<{ message: string }>("/auth/reset-password", { token, password });
      setExito(r.message ?? "Tu contraseña fue actualizada correctamente.");
    } catch (err: any) {
      setError(err?.message ?? "El enlace no es válido o ya expiró. Solicita uno nuevo.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="login-pantalla">
      <div className="login-tarjeta">
        <h1>Restablecer contraseña</h1>
        {error && <div className="alerta alerta-error">{error}</div>}
        {exito ? (
          <>
            <div className="alerta alerta-exito">{exito}</div>
            <p style={{ textAlign: "center", marginTop: 12 }}>
              <Link to="/login">Iniciar sesión</Link>
            </p>
          </>
        ) : (
          <form onSubmit={enviar}>
            <div className="fila-formulario">
              <label htmlFor="reset-pwd">Nueva contraseña</label>
              <input id="reset-pwd" type="password" autoComplete="new-password" maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <div className="fila-formulario">
              <label htmlFor="reset-conf">Confirmar contraseña</label>
              <input id="reset-conf" type="password" autoComplete="new-password" maxLength={200} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            <button type="submit" className="primario" style={{ width: "100%", padding: "10px", marginTop: 8 }} disabled={cargando}>
              {cargando ? "Guardando..." : "Restablecer contraseña"}
            </button>
            <p style={{ textAlign: "center", marginTop: 12 }}>
              <Link to="/login">Volver</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
