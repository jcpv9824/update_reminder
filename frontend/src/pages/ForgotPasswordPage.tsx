import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

const MENSAJE_GENERICO =
  "Si el correo existe y está activo, enviaremos instrucciones para restablecer la contraseña.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [enviado, setEnviado] = useState(false);
  const [cargando, setCargando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setCargando(true);
    try {
      await api.post<{ message: string }>("/auth/forgot-password", { email: email.trim() });
    } catch {/* siempre mostramos el mismo mensaje */}
    setEnviado(true);
    setCargando(false);
  }

  return (
    <div className="login-pantalla">
      <div className="login-tarjeta">
        <h1>Recuperar contraseña</h1>
        <p style={{ textAlign: "center", color: "#6b7280", marginBottom: 16 }}>
          Te enviaremos un enlace para restablecerla.
        </p>
        {enviado ? (
          <>
            <div className="alerta alerta-info">{MENSAJE_GENERICO}</div>
            <p style={{ textAlign: "center", marginTop: 12 }}>
              <Link to="/login">Volver a iniciar sesión</Link>
            </p>
          </>
        ) : (
          <form onSubmit={enviar}>
            <div className="fila-formulario">
              <label htmlFor="forgot-email">Correo electrónico</label>
              <input id="forgot-email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <button type="submit" className="primario" style={{ width: "100%", padding: "10px", marginTop: 8 }} disabled={cargando}>
              {cargando ? "Enviando..." : "Enviar instrucciones"}
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
