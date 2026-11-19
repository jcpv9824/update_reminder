import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import AppLayout from "./components/AppLayout";
import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import DashboardPage from "./pages/DashboardPage";
import CatalogoClientesRoute from "./pages/CatalogoClientesRoute";
import CatalogoInventarioRoute from "./pages/CatalogoInventarioRoute";
import DominiosPage from "./pages/DominiosPage";
import BasesDeDatosPage from "./pages/BasesDeDatosPage";
import LicenciamientoPage from "./pages/LicenciamientoPage";
import FrecuenciasPage from "./pages/FrecuenciasPage";
import TareasPage from "./pages/TareasPage";
import AuditoriaPage from "./pages/AuditoriaPage";
import UsuariosPage from "./pages/UsuariosPage";
import AlertasCorreosPage from "./pages/AlertasCorreosPage";
import NoAutorizadoPage from "./pages/NoAutorizadoPage";
import FormatosImpresionAdminPage from "./pages/FormatosImpresionAdminPage";
import FormatosImpresionPublicPage from "./pages/FormatosImpresionPublicPage";
import DescargasPublicasAdminPage from "./pages/DescargasPublicasAdminPage";
import ArchivosPublicosAdminPage from "./pages/ArchivosPublicosAdminPage";
import ConstructorGuiasPage from "./pages/ConstructorGuiasPage";
import ConexionesPage from "./pages/ConexionesPage";
import LogoCompaniaPage from "./pages/LogoCompaniaPage";
import InicioPage from "./pages/InicioPage";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "./permissionModel";
import { hasPermissionForRoleIds } from "./permissionAccess";
import { GUIDE_BUILDER_UI_ENABLED, WHATS_NEW_PROTOTYPE_ENABLED, WHATS_NEW_ENABLED } from "./featureFlags";

const DevPreview = import.meta.env.DEV ? lazy(() => import("./pages/queHayDeNuevo/DevPreview")) : null;
// Literal Vite checks let the compiler discard these dynamic imports altogether when off.
const LiveWhatsNew = import.meta.env.VITE_WHATS_NEW_ENABLED === "true" ? lazy(() => import("./pages/queHayDeNuevo/LivePages").then(m => ({ default: m.LiveWhatsNewPage }))) : null;
const LiveConfig = import.meta.env.VITE_WHATS_NEW_ENABLED === "true" ? lazy(() => import("./pages/queHayDeNuevo/LivePages").then(m => ({ default: m.LiveConfigPage }))) : null;
const LivePublic = import.meta.env.VITE_WHATS_NEW_ENABLED === "true" ? lazy(() => import("./pages/queHayDeNuevo/LivePages").then(m => ({ default: m.LivePublicPage }))) : null;
const LiveReport = import.meta.env.VITE_WHATS_NEW_ENABLED === "true" ? lazy(() => import("./pages/queHayDeNuevo/LivePages").then(m => ({ default: m.LiveReportPage }))) : null;
function Live({ children }: { children: JSX.Element }) { return <Suspense fallback={<div role="status">Cargando...</div>}>{children}</Suspense>; }
function Preview({ kind }: { kind: "internal" | "config" | "public" }) { return DevPreview ? <Live><DevPreview kind={kind} /></Live> : null; }
function ReportSession() {
  const auth = useAuth(); const location = useLocation();
  if (auth.cargando || !LiveReport) return null;
  // The report is deliberately not guarded by an option permission, area or recipient ACL.
  if (!auth.usuario) return <Navigate to="/login" state={{ returnTo: location.pathname }} replace />;
  return <Live><LiveReport /></Live>;
}

function Protegido({ permiso, permisos, element }: { permiso?: string; permisos?: string[]; element: JSX.Element }) {
  const auth = useAuth();
  const permisosRequeridos = permisos ?? (permiso ? [permiso] : []);
  const { data: rolesRespuesta } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
    enabled: !auth.cargando && !!auth.usuario && permisosRequeridos.length > 0,
  });
  if (auth.cargando) return null;
  if (!auth.usuario) return <Navigate to="/login" replace />;
  if (permisosRequeridos.length > 0) {
    const definicionesRoles = Array.isArray(rolesRespuesta) && rolesRespuesta.length > 0 ? rolesRespuesta : DEFAULT_ROLE_DEFINITIONS;
    if (!permisosRequeridos.some((item) => hasPermissionForRoleIds(auth.usuario.roles, item, definicionesRoles))) return <NoAutorizadoPage />;
  }
  return element;
}

function Enrutador() {
  const auth = useAuth();
  const location = useLocation();
  const requestedReturn = location.state?.returnTo;
  const reportReturn = WHATS_NEW_ENABLED && typeof requestedReturn === "string" && /^\/actualizaciones\/que-hay-de-nuevo\/reportes\/[A-Za-z0-9_-]+$/.test(requestedReturn) ? requestedReturn : "/";
  if (auth.cargando) return <div className="cargando">Cargando aplicación...</div>;

  return (
    <Routes>
      <Route path="/login" element={auth.usuario ? <Navigate to={reportReturn} replace /> : <LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/formatos-impresion" element={<FormatosImpresionPublicPage />} />
      {/* La página pública y el reporte histórico no usan el menú autenticado. */}
      {LivePublic && <Route path="/novedades" element={<Live><LivePublic /></Live>} />}
      {LiveReport && <Route path="/actualizaciones/que-hay-de-nuevo/reportes/:id" element={<ReportSession />} />}
      {WHATS_NEW_PROTOTYPE_ENABLED && <Route path="/__dev/que-hay-de-nuevo/*" element={<Preview kind="internal" />} />}
      {WHATS_NEW_PROTOTYPE_ENABLED && <Route path="/__dev/configuracion-que-hay-de-nuevo" element={<Preview kind="config" />} />}
      {WHATS_NEW_PROTOTYPE_ENABLED && <Route path="/__dev/novedades" element={<Preview kind="public" />} />}
      {!auth.usuario ? (
        <Route path="*" element={<Navigate to="/login" replace />} />
      ) : (
        <Route element={<AppLayout />}>
          {/* Página inicial: Tareas, la única opción asignada o la bienvenida */}
          <Route index element={<InicioPage />} />
          <Route path="tareas" element={<Protegido permiso="updates.tasks.view" element={<TareasPage />} />} />
          <Route path="clientes" element={<Protegido permiso="clients.clients.view" element={<CatalogoClientesRoute />} />} />
          <Route path="dominios" element={<Protegido permiso="clients.domains.view" element={<CatalogoInventarioRoute vista="domains" legado={<DominiosPage />} />} />} />
          <Route path="bases-de-datos" element={<Protegido permiso="clients.databases.view" element={<CatalogoInventarioRoute vista="databases" legado={<BasesDeDatosPage />} />} />} />
          <Route path="licenciamiento" element={<Protegido permiso="clients.licensing.view" element={<CatalogoInventarioRoute vista="licenses" legado={<LicenciamientoPage />} />} />} />
          <Route path="frecuencias" element={<Protegido permiso="updates.schedules.view" element={<FrecuenciasPage />} />} />
          <Route path="admin/formatos-impresion" element={<Protegido permiso="configuration.print_formats.view" element={<FormatosImpresionAdminPage />} />} />
          {LiveWhatsNew && (
            <Route path="actualizaciones/que-hay-de-nuevo/*" element={<Protegido permiso="updates.whats_new.view" element={<Live><LiveWhatsNew /></Live>} />} />
          )}
          {LiveConfig && (
            <Route path="configuracion/que-hay-de-nuevo" element={<Protegido permiso="configuration.whats_new.view" element={<Live><LiveConfig /></Live>} />} />
          )}
          <Route path="admin/descargas-publicas" element={<Protegido permiso="implementation.public_downloads.view" element={<DescargasPublicasAdminPage />} />} />
          <Route path="admin/archivos-publicos" element={<Protegido permiso="implementation.public_files.view" element={<ArchivosPublicosAdminPage />} />} />
          <Route path="implementacion/logo-compania" element={<Protegido permiso="implementation.company_logo.view" element={<LogoCompaniaPage />} />} />
          <Route path="alertas-correos" element={<Protegido permiso="configuration.alerts.view" element={<AlertasCorreosPage />} />} />
          <Route path="configuracion/conexiones" element={<Protegido permiso="configuration.integrations.view" element={<ConexionesPage />} />} />
          <Route path="auditoria" element={<Protegido permiso="visibility.audit.view" element={<AuditoriaPage />} />} />
          <Route path="usuarios" element={<Protegido permisos={["configuration.users.view", "configuration.roles.view"]} element={<UsuariosPage />} />} />
          <Route path="tablero" element={<Protegido permiso="visibility.dashboard.view" element={<DashboardPage />} />} />
          {GUIDE_BUILDER_UI_ENABLED ? (
            <Route path="ayudas/constructor-guias" element={<Protegido permiso="help.guide_builder.view" element={<ConstructorGuiasPage />} />} />
          ) : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Enrutador />
    </AuthProvider>
  );
}
