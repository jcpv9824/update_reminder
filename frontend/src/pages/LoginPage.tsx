import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ETIQUETAS_ROLES } from "../types";

const ROLES_DISPONIBLES = ["admin", "client_manager", "database_updater", "domain_updater", "viewer"];

// El modo desarrollo solo se activa cuando VITE_DEV_MODE=true en el build.
// En producción la pantalla muestra únicamente el botón de Microsoft.
const DEV_MODE_ACTIVO = (import.meta as any).env?.VITE_DEV_MODE === "true";

export default function LoginPage() {
  const { iniciarSesionDev, mensaje } = useAuth() as any;
  const [verModoDev, setVerModoDev] = useState(false);

  function entrarConMicrosoft() {
    // Static Web Apps redirige al proveedor configurado (aad/Microsoft Entra ID).
    // Después del login Static Web Apps regresa al usuario al sitio.
    const post = encodeURIComponent(window.location.origin + "/");
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${post}`;
  }

  return (
    <div className="login-pantalla">
      <div className="login-tarjeta">
        <h1>Programador de Actualizaciones</h1>
        <p style={{ textAlign: "center", color: "#6b7280", marginBottom: 24 }}>
          Gestión de actualizaciones de dominios y bases de datos
        </p>

        {mensaje && <div className="alerta alerta-info">{mensaje}</div>}

        <button className="primario boton-microsoft" style={{ width: "100%", padding: "12px" }} onClick={entrarConMicrosoft}>
          Iniciar sesión con Microsoft
        </button>
        <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 12, marginTop: 12 }}>
          Usa tu cuenta corporativa de Microsoft 365.
        </p>

        {DEV_MODE_ACTIVO && (
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px dashed #e5e7eb" }}>
            {!verModoDev ? (
              <button onClick={() => setVerModoDev(true)} style={{ width: "100%", fontSize: 12, color: "#9ca3af" }}>
                Mostrar modo desarrollo
              </button>
            ) : (
              <FormularioDev onEntrar={iniciarSesionDev} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FormularioDev({ onEntrar }: { onEntrar: (u: any) => void }) {
  const [id, setId] = useState("admin@empresa.com");
  const [nombre, setNombre] = useState("Administrador");
  const [email, setEmail] = useState("admin@empresa.com");
  const [roles, setRoles] = useState<string[]>(["admin"]);

  function alternarRol(r: string) {
    setRoles((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  }

  return (
    <div>
      <div className="alerta alerta-info" style={{ fontSize: 12, marginBottom: 12 }}>
        ⚠️ Modo desarrollo. Solo se activa cuando <code>VITE_DEV_MODE=true</code>. No usar en producción.
      </div>
      <div className="fila-formulario">
        <label>Identificador</label>
        <input value={id} onChange={(e) => setId(e.target.value)} />
      </div>
      <div className="fila-formulario">
        <label>Nombre</label>
        <input value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </div>
      <div className="fila-formulario">
        <label>Correo electrónico</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="fila-formulario">
        <label>Roles (solo desarrollo)</label>
        {ROLES_DISPONIBLES.map((r) => (
          <label key={r} style={{ display: "flex", fontWeight: 400 }}>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={roles.includes(r)} onChange={() => alternarRol(r)} />
            {ETIQUETAS_ROLES[r]}
          </label>
        ))}
      </div>
      <button onClick={() => onEntrar({ id, displayName: nombre, email, roles })} style={{ width: "100%" }}>
        Entrar (modo desarrollo)
      </button>
    </div>
  );
}
