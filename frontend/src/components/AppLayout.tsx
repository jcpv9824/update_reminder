import { useMemo, useState } from "react";
import {
  BellRing,
  BookOpenCheck,
  BriefcaseBusiness,
  CalendarPlus,
  ClipboardList,
  Database,
  DownloadCloud,
  Eye,
  FileText,
  Gauge,
  KeyRound,
  LogOut,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ETIQUETAS_ROLES } from "../types";

type ElementoMenu = {
  ruta: string;
  etiqueta: string;
  roles: string[];
  Icono: LucideIcon;
};

type ModuloMenu = {
  etiqueta: string;
  Icono: LucideIcon;
  elementos: ElementoMenu[];
};

const MODULOS: ModuloMenu[] = [
  {
    etiqueta: "Clientes",
    Icono: BriefcaseBusiness,
    elementos: [
      { ruta: "/clientes", etiqueta: "Clientes", roles: ["admin", "client_manager", "viewer"], Icono: Users },
      { ruta: "/dominios", etiqueta: "Dominios", roles: ["admin", "client_manager", "viewer", "domain_updater"], Icono: Server },
      { ruta: "/bases-de-datos", etiqueta: "Bases de Datos", roles: ["admin", "client_manager", "viewer", "database_updater"], Icono: Database },
      { ruta: "/licenciamiento", etiqueta: "Licenciamiento", roles: ["admin", "client_manager"], Icono: KeyRound },
    ],
  },
  {
    etiqueta: "Actualizaciones",
    Icono: ClipboardList,
    elementos: [
      { ruta: "/tareas", etiqueta: "Tareas", roles: ["admin", "client_manager", "database_updater", "domain_updater", "viewer"], Icono: BookOpenCheck },
      { ruta: "/frecuencias", etiqueta: "Programar Actualizaciones", roles: ["admin", "client_manager"], Icono: CalendarPlus },
    ],
  },
  {
    etiqueta: "Implementación",
    Icono: ShieldCheck,
    elementos: [
      { ruta: "/admin/descargas-publicas", etiqueta: "Descargas Públicas", roles: ["admin", "public_downloads.admin"], Icono: DownloadCloud },
    ],
  },
  {
    etiqueta: "Configuración",
    Icono: Settings,
    elementos: [
      { ruta: "/alertas-correos", etiqueta: "Alertas y Correos", roles: ["admin"], Icono: BellRing },
      { ruta: "/usuarios", etiqueta: "Usuarios y Roles", roles: ["admin"], Icono: Users },
      { ruta: "/admin/formatos-impresion", etiqueta: "Formatos de Impresión", roles: ["admin", "formatos_impresion.admin"], Icono: FileText },
    ],
  },
  {
    etiqueta: "Auditoría y Visibilidad",
    Icono: Eye,
    elementos: [
      { ruta: "/auditoria", etiqueta: "Auditoría", roles: ["admin", "client_manager", "viewer", "database_updater", "domain_updater"], Icono: ShieldCheck },
      { ruta: "/tablero", etiqueta: "Tablero", roles: ["admin", "client_manager", "viewer"], Icono: Gauge },
    ],
  },
];

function normalizarBusqueda(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export default function AppLayout() {
  const auth = useAuth();
  const [busqueda, setBusqueda] = useState("");
  const usuario = auth.cargando ? null : auth.usuario;
  const rolesUsuario = usuario?.roles ?? [];
  const terminoBusqueda = normalizarBusqueda(busqueda.trim());
  const modulosVisibles = useMemo(
    () =>
      MODULOS.map((modulo) => {
        const moduloCoincide = normalizarBusqueda(modulo.etiqueta).includes(terminoBusqueda);
        const elementos = modulo.elementos.filter((elemento) => {
          const tienePermiso = elemento.roles.some((r) => rolesUsuario.includes(r));
          const elementoCoincide = normalizarBusqueda(elemento.etiqueta).includes(terminoBusqueda);
          return tienePermiso && (!terminoBusqueda || moduloCoincide || elementoCoincide);
        });
        return { ...modulo, elementos };
      }).filter((modulo) => modulo.elementos.length > 0),
    [terminoBusqueda, rolesUsuario]
  );

  if (!usuario) return null;

  return (
    <div className="contenedor-app">
      <aside className="barra-lateral">
        <div className="barra-lateral-contenido">
          <header className="marca-portal">
            <img src="/brand/sag-white-vertical.png" alt="SAG" className="marca-portal-logo" />
            <div className="marca-portal-texto" aria-label="PORTAL SAG WEB">
              <span>PORTAL</span>
              <strong>SAG WEB</strong>
            </div>
          </header>

          <label className="buscador-menu">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Buscar opción</span>
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar Opción"
            />
          </label>

          <nav className="menu-modulos" aria-label="Navegación principal">
            {modulosVisibles.map((modulo) => (
              <section key={modulo.etiqueta} className="menu-modulo">
                <div className="menu-modulo-titulo">
                  <modulo.Icono size={16} aria-hidden="true" />
                  <span>{modulo.etiqueta}</span>
                </div>
                <div className="menu-modulo-opciones">
                  {modulo.elementos.map((elemento) => (
                    <NavLink key={elemento.ruta} to={elemento.ruta} className={({ isActive }) => (isActive ? "activo" : "")}>
                      <elemento.Icono size={16} aria-hidden="true" />
                      <span>{elemento.etiqueta}</span>
                    </NavLink>
                  ))}
                </div>
              </section>
            ))}
            {modulosVisibles.length === 0 ? <p className="menu-sin-resultados">No hay opciones visibles.</p> : null}
          </nav>

          <footer className="usuario-sidebar">
            <img src="/brand/sag-white-vertical.png" alt="" aria-hidden="true" className="usuario-sidebar-logo" />
            <div className="usuario-sidebar-datos">
              <strong>{usuario.displayName}</strong>
              <span>{usuario.email}</span>
              <small>{usuario.roles.map((r) => ETIQUETAS_ROLES[r] ?? r).join(", ")}</small>
            </div>
            <button type="button" onClick={auth.cerrarSesion}>
              <LogOut size={16} aria-hidden="true" />
              <span>Cerrar Sesión</span>
            </button>
          </footer>
        </div>
      </aside>
      <main className="contenido-principal">
        <Outlet />
      </main>
    </div>
  );
}
