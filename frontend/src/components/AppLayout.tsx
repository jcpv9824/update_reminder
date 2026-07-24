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
  FileImage,
  FileText,
  Gauge,
  KeyRound,
  LogOut,
  ChevronDown,
  ChevronRight,
  Search,
  Server,
  Settings,
  ShieldCheck,
  UserCircle,
  Users,
  type LucideIcon,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ETIQUETAS_ROLES } from "../types";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../permissionModel";
import { hasPermissionForRoleIds } from "../permissionAccess";

type ElementoMenu = {
  ruta: string;
  etiqueta: string;
  permiso?: string;
  permisos?: string[];
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
      { ruta: "/clientes", etiqueta: "Clientes", permiso: "clients.clients.view", Icono: Users },
      { ruta: "/dominios", etiqueta: "Dominios", permiso: "clients.domains.view", Icono: Server },
      { ruta: "/bases-de-datos", etiqueta: "Bases de Datos", permiso: "clients.databases.view", Icono: Database },
      { ruta: "/licenciamiento", etiqueta: "Licenciamiento", permiso: "clients.licensing.view", Icono: KeyRound },
    ],
  },
  {
    etiqueta: "Actualizaciones",
    Icono: ClipboardList,
    elementos: [
      { ruta: "/tareas", etiqueta: "Tareas", permiso: "updates.tasks.view", Icono: BookOpenCheck },
      { ruta: "/frecuencias", etiqueta: "Programar Actualizaciones", permiso: "updates.schedules.view", Icono: CalendarPlus },
    ],
  },
  {
    etiqueta: "Implementación",
    Icono: ShieldCheck,
    elementos: [
      { ruta: "/admin/descargas-publicas", etiqueta: "Descargas Públicas", permiso: "implementation.public_downloads.view", Icono: DownloadCloud },
      { ruta: "/admin/archivos-publicos", etiqueta: "Archivos Públicos", permiso: "implementation.public_files.view", Icono: FileImage },
    ],
  },
  {
    etiqueta: "Configuración",
    Icono: Settings,
    elementos: [
      { ruta: "/alertas-correos", etiqueta: "Alertas y Correos", permiso: "configuration.alerts.view", Icono: BellRing },
      { ruta: "/usuarios", etiqueta: "Usuarios y Roles", permisos: ["configuration.users.view", "configuration.roles.view"], Icono: Users },
      { ruta: "/admin/formatos-impresion", etiqueta: "Formatos de Impresión", permiso: "configuration.print_formats.view", Icono: FileText },
    ],
  },
  {
    etiqueta: "Auditoría y Visibilidad",
    Icono: Eye,
    elementos: [
      { ruta: "/auditoria", etiqueta: "Auditoría", permiso: "visibility.audit.view", Icono: ShieldCheck },
      { ruta: "/tablero", etiqueta: "Tablero", permiso: "visibility.dashboard.view", Icono: Gauge },
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
  const [modulosContraidos, setModulosContraidos] = useState<Set<string>>(
    () => new Set(MODULOS.map((modulo) => modulo.etiqueta))
  );
  const usuario = auth.cargando ? null : auth.usuario;
  const rolesUsuario = usuario?.roles ?? [];
  const { data: rolesRespuesta } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
    enabled: !!usuario,
  });
  const definicionesRoles = Array.isArray(rolesRespuesta) && rolesRespuesta.length > 0
    ? rolesRespuesta
    : DEFAULT_ROLE_DEFINITIONS;
  const terminoBusqueda = normalizarBusqueda(busqueda.trim());
  const modulosVisibles = useMemo(
    () =>
      MODULOS.map((modulo) => {
        const moduloCoincide = normalizarBusqueda(modulo.etiqueta).includes(terminoBusqueda);
        const elementos = modulo.elementos.filter((elemento) => {
          const permisos = elemento.permisos ?? (elemento.permiso ? [elemento.permiso] : []);
          const tienePermiso = permisos.some((permiso) => hasPermissionForRoleIds(rolesUsuario, permiso, definicionesRoles));
          const elementoCoincide = normalizarBusqueda(elemento.etiqueta).includes(terminoBusqueda);
          return tienePermiso && (!terminoBusqueda || moduloCoincide || elementoCoincide);
        });
        return { ...modulo, elementos };
      }).filter((modulo) => modulo.elementos.length > 0),
    [definicionesRoles, terminoBusqueda, rolesUsuario]
  );

  if (!usuario) return null;
  function alternarModulo(etiqueta: string) {
    setModulosContraidos((actual) => {
      const siguiente = new Set(actual);
      if (siguiente.has(etiqueta)) siguiente.delete(etiqueta);
      else siguiente.add(etiqueta);
      return siguiente;
    });
  }

  return (
    <div className="contenedor-app">
      <aside className="barra-lateral">
        <div className="barra-lateral-contenido">
          <header className="marca-portal">
            <img src="/brand/sag-white-icon.png" alt="SAG" className="marca-portal-logo" />
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
            {modulosVisibles.map((modulo) => {
              const abierto = Boolean(terminoBusqueda) || !modulosContraidos.has(modulo.etiqueta);
              const panelId = `menu-modulo-${normalizarBusqueda(modulo.etiqueta).replace(/\s+/g, "-")}`;
              return (
              <section key={modulo.etiqueta} className="menu-modulo">
                <button
                  type="button"
                  className="menu-modulo-titulo"
                  aria-expanded={abierto}
                  aria-controls={panelId}
                  aria-label={`${abierto ? "Contraer" : "Expandir"} ${modulo.etiqueta}`}
                  onClick={() => alternarModulo(modulo.etiqueta)}
                >
                  <modulo.Icono size={16} aria-hidden="true" />
                  <span>{modulo.etiqueta}</span>
                  {abierto
                    ? <ChevronDown size={16} aria-hidden="true" />
                    : <ChevronRight size={16} aria-hidden="true" />}
                </button>
                <div
                  id={panelId}
                  className={`menu-modulo-opciones ${abierto ? "abierto" : "cerrado"}`}
                  aria-hidden={!abierto}
                >
                  <div className="menu-modulo-opciones-contenido">
                    {modulo.elementos.map((elemento) => (
                      <NavLink key={elemento.ruta} to={elemento.ruta} tabIndex={abierto ? undefined : -1} className={({ isActive }) => (isActive ? "activo" : "")}>
                        <elemento.Icono size={16} aria-hidden="true" />
                        <span>{elemento.etiqueta}</span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              </section>
            )})}
            {modulosVisibles.length === 0 ? <p className="menu-sin-resultados">No hay opciones visibles.</p> : null}
          </nav>

          <footer className="usuario-sidebar">
            <UserCircle size={34} aria-hidden="true" className="usuario-sidebar-icono" data-testid="usuario-sidebar-icon" />
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
