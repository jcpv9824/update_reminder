import {
  BellRing,
  BookOpenCheck,
  BookOpenText,
  BriefcaseBusiness,
  CalendarPlus,
  CircleHelp,
  ClipboardList,
  Database,
  DownloadCloud,
  Eye,
  FileImage,
  ImageUp,
  FileText,
  Gauge,
  KeyRound,
  Megaphone,
  Sparkles,
  Server,
  Settings,
  PlugZap,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { GUIDE_BUILDER_UI_ENABLED, WHATS_NEW_ENABLED } from "./featureFlags";
import type { RoleDefinition } from "./permissionModel";
import { hasPermissionForRoleIds } from "./permissionAccess";

/* Menú lateral del portal. Lo usan la barra lateral y la página de inicio. */

export type ElementoMenu = {
  ruta: string;
  etiqueta: string;
  permiso?: string;
  permisos?: string[];
  Icono: LucideIcon;
};

export type ModuloMenu = {
  etiqueta: string;
  Icono: LucideIcon;
  elementos: ElementoMenu[];
};

export const MODULOS: ModuloMenu[] = [
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
      ...(WHATS_NEW_ENABLED
        ? [{ ruta: "/actualizaciones/que-hay-de-nuevo", etiqueta: "Qué hay de nuevo", permiso: "updates.whats_new.view", Icono: Megaphone }]
        : []),
    ],
  },
  {
    etiqueta: "Implementación",
    Icono: ShieldCheck,
    elementos: [
      { ruta: "/admin/descargas-publicas", etiqueta: "Descargas Públicas", permiso: "implementation.public_downloads.view", Icono: DownloadCloud },
      { ruta: "/admin/archivos-publicos", etiqueta: "Archivos Públicos", permiso: "implementation.public_files.view", Icono: FileImage },
      { ruta: "/implementacion/logo-compania", etiqueta: "Almacenamiento de archivos y logo", permiso: "implementation.company_logo.view", Icono: ImageUp },
    ],
  },
  {
    etiqueta: "Configuración",
    Icono: Settings,
    elementos: [
      { ruta: "/alertas-correos", etiqueta: "Alertas y Correos", permiso: "configuration.alerts.view", Icono: BellRing },
      { ruta: "/usuarios", etiqueta: "Usuarios y Roles", permisos: ["configuration.users.view", "configuration.roles.view"], Icono: Users },
      { ruta: "/admin/formatos-impresion", etiqueta: "Formatos de Impresión", permiso: "configuration.print_formats.view", Icono: FileText },
      { ruta: "/configuracion/conexiones", etiqueta: "Conexiones", permiso: "configuration.integrations.view", Icono: PlugZap },
      ...(WHATS_NEW_ENABLED
        ? [{ ruta: "/configuracion/que-hay-de-nuevo", etiqueta: "Qué hay de nuevo", permiso: "configuration.whats_new.view", Icono: Sparkles }]
        : []),
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
  ...(GUIDE_BUILDER_UI_ENABLED ? [{
    etiqueta: "Ayudas SAG Web",
    Icono: CircleHelp,
    elementos: [
      { ruta: "/ayudas/constructor-guias", etiqueta: "Constructor de guías", permiso: "help.guide_builder.view", Icono: BookOpenText },
    ],
  }] : []),
];

/** Opciones del menú a las que la persona tiene acceso, en el orden del menú. */
export function opcionesPermitidas(roleIds: string[], definicionesRoles: RoleDefinition[]): ElementoMenu[] {
  return MODULOS.flatMap((modulo) => modulo.elementos).filter((elemento) => {
    const permisos = elemento.permisos ?? (elemento.permiso ? [elemento.permiso] : []);
    return permisos.some((permiso) => hasPermissionForRoleIds(roleIds, permiso, definicionesRoles));
  });
}

/**
 * Adónde entra la persona al iniciar sesión:
 * Tareas si tiene acceso; si no, la única opción que tenga; si tiene varias, la bienvenida (null).
 */
export function rutaInicial(opciones: ElementoMenu[]): string | null {
  if (opciones.some((opcion) => opcion.ruta === "/tareas")) return "/tareas";
  if (opciones.length === 1) return opciones[0].ruta;
  return null;
}
