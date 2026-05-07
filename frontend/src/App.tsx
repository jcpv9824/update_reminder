import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import AppLayout from "./components/AppLayout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import ClientesPage from "./pages/ClientesPage";
import DominiosPage from "./pages/DominiosPage";
import BasesDeDatosPage from "./pages/BasesDeDatosPage";
import FrecuenciasPage from "./pages/FrecuenciasPage";
import TareasPage from "./pages/TareasPage";
import AuditoriaPage from "./pages/AuditoriaPage";
import UsuariosPage from "./pages/UsuariosPage";
import NoAutorizadoPage from "./pages/NoAutorizadoPage";

function Protegido({ roles, element }: { roles: string[]; element: JSX.Element }) {
  const auth = useAuth();
  if (auth.cargando) return null;
  if (!auth.usuario) return <Navigate to="/login" replace />;
  if (!roles.some((r) => auth.usuario.roles.includes(r))) return <NoAutorizadoPage />;
  return element;
}

function Enrutador() {
  const auth = useAuth();
  if (auth.cargando) return <div className="cargando">Cargando aplicación...</div>;

  return (
    <Routes>
      <Route path="/login" element={auth.usuario ? <Navigate to="/tareas" replace /> : <LoginPage />} />
      {!auth.usuario ? (
        <Route path="*" element={<Navigate to="/login" replace />} />
      ) : (
        <Route element={<AppLayout />}>
          {/* Página inicial: tareas */}
          <Route index element={<Navigate to="/tareas" replace />} />
          <Route path="tareas" element={<TareasPage />} />
          <Route path="clientes" element={<Protegido roles={["admin", "client_manager", "viewer"]} element={<ClientesPage />} />} />
          <Route path="dominios" element={<Protegido roles={["admin", "client_manager", "viewer", "domain_updater"]} element={<DominiosPage />} />} />
          <Route path="bases-de-datos" element={<Protegido roles={["admin", "client_manager", "viewer", "database_updater"]} element={<BasesDeDatosPage />} />} />
          <Route path="frecuencias" element={<Protegido roles={["admin", "client_manager"]} element={<FrecuenciasPage />} />} />
          <Route path="auditoria" element={<Protegido roles={["admin", "client_manager", "viewer", "database_updater", "domain_updater"]} element={<AuditoriaPage />} />} />
          <Route path="usuarios" element={<Protegido roles={["admin"]} element={<UsuariosPage />} />} />
          <Route path="tablero" element={<DashboardPage />} />
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
