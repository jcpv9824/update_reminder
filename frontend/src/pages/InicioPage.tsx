import { Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../permissionModel";
import { opcionesPermitidas, rutaInicial } from "../menu";

/*
  Página de inicio al entrar al portal:
  - Tareas, si la persona tiene acceso.
  - Si no, la única opción que tenga asignada.
  - Si tiene varias, la bienvenida con la marca del portal.
*/
export default function InicioPage() {
  const auth = useAuth();
  const usuario = auth.cargando ? null : auth.usuario;
  const { data: rolesRespuesta, isLoading } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
    enabled: !!usuario,
  });
  if (!usuario || isLoading) return null;
  const definicionesRoles = Array.isArray(rolesRespuesta) && rolesRespuesta.length > 0 ? rolesRespuesta : DEFAULT_ROLE_DEFINITIONS;
  const destino = rutaInicial(opcionesPermitidas(usuario.roles, definicionesRoles));
  if (destino) return <Navigate to={destino} replace />;

  return (
    <div className="bienvenida">
      <div className="bienvenida-marca">
        <img src="/brand/sag-white-icon.png" alt="SAG" />
        <div className="marca-portal-texto" aria-label="PORTAL SAG WEB">
          <span>PORTAL</span>
          <strong>SAG WEB</strong>
        </div>
      </div>
      <h1>Bienvenido al Portal SAG Web</h1>
    </div>
  );
}
