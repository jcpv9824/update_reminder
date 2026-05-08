import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ETIQUETAS_ROLES } from "../types";

const ELEMENTOS = [
  { ruta: "/tareas", etiqueta: "Tareas", roles: ["admin", "client_manager", "database_updater", "domain_updater", "viewer"] },
  { ruta: "/clientes", etiqueta: "Clientes", roles: ["admin", "client_manager", "viewer"] },
  { ruta: "/dominios", etiqueta: "Dominios", roles: ["admin", "client_manager", "viewer", "domain_updater"] },
  { ruta: "/bases-de-datos", etiqueta: "Bases de datos", roles: ["admin", "client_manager", "viewer", "database_updater"] },
  { ruta: "/frecuencias", etiqueta: "Programaciones especiales", roles: ["admin", "client_manager"] },
  { ruta: "/alertas-correos", etiqueta: "Alertas y correos", roles: ["admin"] },
  { ruta: "/auditoria", etiqueta: "Auditoría", roles: ["admin", "client_manager", "viewer", "database_updater", "domain_updater"] },
  { ruta: "/usuarios", etiqueta: "Usuarios y roles", roles: ["admin"] },
  { ruta: "/tablero", etiqueta: "Tablero", roles: ["admin", "client_manager", "viewer"] },
];

export default function AppLayout() {
  const auth = useAuth();
  if (auth.cargando || !auth.usuario) return null;
  const usuario = auth.usuario;
  const elementosVisibles = ELEMENTOS.filter((e) => e.roles.some((r) => usuario.roles.includes(r)));

  return (
    <div className="contenedor-app">
      <aside className="barra-lateral">
        <h1>Programador de Actualizaciones</h1>
        <nav>
          {elementosVisibles.map((e) => (
            <NavLink key={e.ruta} to={e.ruta} className={({ isActive }) => (isActive ? "activo" : "")}>
              {e.etiqueta}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: 24, fontSize: 12, color: "#94a3b8" }}>
          <div><strong>{usuario.displayName}</strong></div>
          <div>{usuario.email}</div>
          <div style={{ marginTop: 6 }}>
            {usuario.roles.map((r) => ETIQUETAS_ROLES[r] ?? r).join(", ")}
          </div>
          <button style={{ marginTop: 12, width: "100%" }} onClick={auth.cerrarSesion}>Cerrar sesión</button>
        </div>
      </aside>
      <main className="contenido-principal">
        <Outlet />
      </main>
    </div>
  );
}
