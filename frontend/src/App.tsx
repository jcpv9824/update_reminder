import { Routes, Route, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import AppLayout from "./components/AppLayout";
import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import DashboardPage from "./pages/DashboardPage";
import ClientesPage from "./pages/ClientesPage";
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
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "./permissionModel";
import { hasPermissionForRoleIds } from "./permissionAccess";

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
  if (auth.cargando) return <div className="cargando">Cargando aplicación...</div>;

  return (
    <Routes>
      <Route path="/login" element={auth.usuario ? <Navigate to="/tareas" replace /> : <LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/formatos-impresion" element={<FormatosImpresionPublicPage />} />
      {!auth.usuario ? (
        <Route path="*" element={<Navigate to="/login" replace />} />
      ) : (
        <Route element={<AppLayout />}>
          {/* Página inicial: tareas */}
          <Route index element={<Navigate to="/tareas" replace />} />
          <Route path="tareas" element={<Protegido permiso="updates.tasks.view" element={<TareasPage />} />} />
          <Route path="clientes" element={<Protegido permiso="clients.clients.view" element={<ClientesPage />} />} />
          <Route path="dominios" element={<Protegido permiso="clients.domains.view" element={<DominiosPage />} />} />
          <Route path="bases-de-datos" element={<Protegido permiso="clients.databases.view" element={<BasesDeDatosPage />} />} />
          <Route path="licenciamiento" element={<Protegido permiso="clients.licensing.view" element={<LicenciamientoPage />} />} />
          <Route path="frecuencias" element={<Protegido permiso="updates.schedules.view" element={<FrecuenciasPage />} />} />
          <Route path="admin/formatos-impresion" element={<Protegido permiso="configuration.print_formats.view" element={<FormatosImpresionAdminPage />} />} />
          <Route path="admin/descargas-publicas" element={<Protegido permiso="implementation.public_downloads.view" element={<DescargasPublicasAdminPage />} />} />
          <Route path="admin/archivos-publicos" element={<Protegido permiso="implementation.public_files.view" element={<ArchivosPublicosAdminPage />} />} />
          <Route path="alertas-correos" element={<Protegido permiso="configuration.alerts.view" element={<AlertasCorreosPage />} />} />
          <Route path="auditoria" element={<Protegido permiso="visibility.audit.view" element={<AuditoriaPage />} />} />
          <Route path="usuarios" element={<Protegido permisos={["configuration.users.view", "configuration.roles.view"]} element={<UsuariosPage />} />} />
          <Route path="tablero" element={<Protegido permiso="visibility.dashboard.view" element={<DashboardPage />} />} />
          <Route path="*" element={<Navigate to="/tareas" replace />} />
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
