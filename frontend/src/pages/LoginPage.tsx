import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function LoginPage() {
  const { entrar, mensaje } = useAuth() as any;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Debe ingresar correo electrónico y contraseña.");
      return;
    }
    setCargando(true);
    try {
      await entrar(email.trim(), password);
    } catch (err: any) {
      setError(err?.message ?? "No se pudo entrar.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="login-pantalla">
      <div className="login-tarjeta">
        <h1>Programador de Actualizaciones</h1>
        <p style={{ textAlign: "center", color: "#6b7280", marginBottom: 24 }}>
          Gestión de actualizaciones de dominios y bases de datos
        </p>
        {mensaje && <div className="alerta alerta-info">{mensaje}</div>}
        {error && <div className="alerta alerta-error">{error}</div>}
        <form onSubmit={enviar}>
          <div className="fila-formulario">
            <label htmlFor="login-email">Correo electrónico</label>
            <input id="login-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="fila-formulario">
            <label htmlFor="login-password">Contraseña</label>
            <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button type="submit" className="primario" style={{ width: "100%", padding: "10px", marginTop: 8 }} disabled={cargando}>
            {cargando ? "Verificando..." : "Entrar"}
          </button>
          <p style={{ textAlign: "center", marginTop: 12, fontSize: 13 }}>
            <Link to="/forgot-password">¿Olvidaste tu contraseña?</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
