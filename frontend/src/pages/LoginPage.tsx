import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

type Step = "credentials" | "password-change" | "mfa" | "mfa-setup" | "recovery";

export default function LoginPage() {
  const auth = useAuth();
  const { entrar } = auth;
  const mensaje = "mensaje" in auth ? auth.mensaje : undefined;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaSecret, setMfaSecret] = useState("");
  const [mfaUri, setMfaUri] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [step, setStep] = useState<Step>("credentials");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  function restart() {
    setPassword(""); setNewPassword(""); setConfirmation(""); setMfaCode("");
    setMfaSecret(""); setMfaUri(""); setRecoveryCodes([]); setStep("credentials");
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setInfo(null);
    if (!email.trim() || !password) return setError("Debe ingresar correo electrónico y contraseña.");
    if (step === "password-change") {
      if (newPassword.length < 14) return setError("La nueva contraseña debe tener al menos 14 caracteres.");
      if (newPassword !== confirmation) return setError("Las contraseñas no coinciden.");
    }
    if ((step === "mfa" || step === "mfa-setup") && !mfaCode.trim()) return setError("Ingrese el código de su aplicación autenticadora.");
    setCargando(true);
    try {
      const result = await entrar(email.trim(), password, {
        ...(step === "password-change" ? { newPassword } : {}),
        ...(step === "mfa" || step === "mfa-setup" ? { mfaCode } : {}),
      });
      if (result.passwordChangeRequired) setStep("password-change");
      else if (result.passwordChanged) { restart(); setInfo(result.message || "Contraseña actualizada. Inicie sesión nuevamente."); }
      else if (result.mfaRequired) setStep("mfa");
      else if (result.mfaSetupRequired && result.mfaSetup) {
        setMfaSecret(result.mfaSetup.secret); setMfaUri(result.mfaSetup.otpauthUri); setStep("mfa-setup");
      } else if (result.mfaEnrollmentCompleted) {
        setRecoveryCodes(result.recoveryCodes || []); setStep("recovery");
      }
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
        <p style={{ textAlign: "center", color: "#6b7280", marginBottom: 24 }}>Gestión de actualizaciones de dominios y bases de datos</p>
        {mensaje && <div className="alerta alerta-info">{mensaje}</div>}
        {info && <div className="alerta alerta-exito">{info}</div>}
        {error && <div className="alerta alerta-error">{error}</div>}

        {step === "recovery" ? (
          <div>
            <h2 style={{ fontSize: 18 }}>Guarde sus códigos de recuperación</h2>
            <p>Cada código permite un solo acceso si pierde su aplicación autenticadora. No volverán a mostrarse.</p>
            <pre aria-label="Códigos de recuperación" style={{ whiteSpace: "pre-wrap", background: "#f3f4f6", padding: 12 }}>{recoveryCodes.join("\n")}</pre>
            <button className="primario" style={{ width: "100%" }} onClick={() => { restart(); setInfo("MFA configurada. Inicie sesión con un código de su autenticador."); }}>Ya guardé los códigos</button>
          </div>
        ) : (
          <form onSubmit={enviar}>
            <div className="fila-formulario"><label htmlFor="login-email">Correo electrónico</label><input id="login-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={step !== "credentials"} required /></div>
            <div className="fila-formulario"><label htmlFor="login-password">Contraseña</label><input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={step !== "credentials"} required /></div>

            {step === "password-change" && <>
              <div className="alerta alerta-info">Debe cambiar la contraseña temporal o vencida antes de continuar.</div>
              <div className="fila-formulario"><label htmlFor="new-password">Nueva contraseña</label><input id="new-password" type="password" autoComplete="new-password" maxLength={72} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required /><small>Use una frase de al menos 14 caracteres que no contenga su nombre o correo.</small></div>
              <div className="fila-formulario"><label htmlFor="confirm-password">Confirmar nueva contraseña</label><input id="confirm-password" type="password" autoComplete="new-password" maxLength={72} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required /></div>
            </>}

            {step === "mfa-setup" && <>
              <div className="alerta alerta-info">Configure MFA en Microsoft Authenticator, Google Authenticator u otra aplicación TOTP.</div>
              <div className="fila-formulario"><label>Clave de configuración</label><input value={mfaSecret} readOnly /></div>
              <details><summary>Enlace técnico de configuración</summary><code style={{ wordBreak: "break-all" }}>{mfaUri}</code></details>
            </>}

            {(step === "mfa" || step === "mfa-setup") && <div className="fila-formulario"><label htmlFor="mfa-code">Código MFA o código de recuperación</label><input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required /></div>}

            <button type="submit" className="primario" style={{ width: "100%", padding: 10, marginTop: 8 }} disabled={cargando}>
              {cargando ? "Verificando..." : step === "password-change" ? "Cambiar contraseña" : step === "mfa-setup" ? "Activar MFA" : step === "mfa" ? "Verificar código" : "Entrar"}
            </button>
            {step === "credentials" ? <p style={{ textAlign: "center", marginTop: 12, fontSize: 13 }}><Link to="/forgot-password">¿Olvidaste tu contraseña?</Link></p> : <button type="button" style={{ width: "100%", marginTop: 8 }} onClick={restart}>Volver al inicio</button>}
          </form>
        )}
      </div>
    </div>
  );
}
