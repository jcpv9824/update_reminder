import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alerta, DialogoConfirmar, EtiquetaEstado, Modal, Paginacion } from "../components/Comunes";
import { ETIQUETAS_ROLES, type RespuestaPaginada } from "../types";
import { hasPermissionForRoleIds } from "../permissionAccess";
import {
  DEFAULT_ROLE_DEFINITIONS,
  PERMISSION_CATALOG,
  modulePermissionKeys,
  optionPermissionKeys,
  permissionKey,
  type PermissionModule,
  type PermissionOption,
  type RoleDefinition,
  type TaskVisibility,
  type TaskVisibilityLevel,
} from "../permissionModel";

type Usuario = {
  id: string;
  displayName: string;
  email: string;
  roles: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
  mustChangePassword?: boolean;
};

const VISIBILIDAD_TAREAS: Array<{ valor: TaskVisibilityLevel; etiqueta: string }> = [
  { valor: "none", etiqueta: "Sin acceso" },
  { valor: "assigned", etiqueta: "Solo asignadas" },
  { valor: "all", etiqueta: "Todas" },
];

export default function UsuariosPage() {
  const qc = useQueryClient();
  const auth = useAuth();
  const usuarioActual = auth.cargando ? null : auth.usuario;
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Usuario | null>(null);
  const [reset, setReset] = useState<Usuario | null>(null);
  const [reenviar, setReenviar] = useState<Usuario | null>(null);
  const [modalRolAbierto, setModalRolAbierto] = useState(false);
  const [rolEditando, setRolEditando] = useState<RoleDefinition | null>(null);
  const [rolAEliminar, setRolAEliminar] = useState<RoleDefinition | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pagina, setPagina] = useState(1);
  const [pestana, setPestana] = useState<"usuarios" | "roles">("usuarios");

  const { data: rolesRespuesta } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
  });
  const rolesDefinidos = Array.isArray(rolesRespuesta) && rolesRespuesta.length > 0 ? rolesRespuesta : DEFAULT_ROLE_DEFINITIONS;
  const rolesDisponibles = rolesDefinidos.filter((rol) => rol.active !== false);
  const rolesUsuarioActual = usuarioActual?.roles ?? [];
  const puedeVerUsuarios = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.view", rolesDefinidos);
  const puedeCrearUsuarios = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.create", rolesDefinidos)
    && hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.assign_roles", rolesDefinidos);
  const puedeEditarUsuarios = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.edit", rolesDefinidos);
  const puedeResetearPasswords = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.reset_password", rolesDefinidos);
  const puedeReenviarCredenciales = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.resend_credentials", rolesDefinidos);
  const puedeDesactivarUsuarios = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.deactivate", rolesDefinidos);
  const puedeReactivarUsuarios = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.users.reactivate", rolesDefinidos);
  const puedeVerRoles = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.view", rolesDefinidos);
  const puedeCrearRoles = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.create", rolesDefinidos)
    && hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.manage_permissions", rolesDefinidos)
    && hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.manage_task_visibility", rolesDefinidos);
  const puedeEditarRoles = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.edit", rolesDefinidos)
    && hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.manage_permissions", rolesDefinidos)
    && hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.manage_task_visibility", rolesDefinidos);
  const puedeEliminarRoles = hasPermissionForRoleIds(rolesUsuarioActual, "configuration.roles.delete", rolesDefinidos);

  useEffect(() => {
    if (pestana === "usuarios" && !puedeVerUsuarios && puedeVerRoles) setPestana("roles");
    if (pestana === "roles" && !puedeVerRoles && puedeVerUsuarios) setPestana("usuarios");
  }, [pestana, puedeVerRoles, puedeVerUsuarios]);

  const { data: paginaUsuarios, isLoading } = useQuery({
    queryKey: ["usuarios", "pagina", pagina],
    queryFn: () => api.get<RespuestaPaginada<Usuario>>(`/users?page=${pagina}&pageSize=10`),
    enabled: puedeVerUsuarios,
  });
  const usuarios: Usuario[] = Array.isArray(paginaUsuarios) ? paginaUsuarios : paginaUsuarios?.items ?? [];
  const infoPagina = !Array.isArray(paginaUsuarios) ? paginaUsuarios : undefined;
  const crear = useMutation({
    mutationFn: (b: any) => api.post("/users", b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["usuarios"] }); setModalAbierto(false); setExito("Usuario creado correctamente."); },
    onError: (e: any) => setError(e?.message),
  });
  const actualizar = useMutation({
    mutationFn: ({ id, body }: any) => api.put(`/users/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["usuarios"] }); setEditando(null); setExito("Usuario actualizado."); },
    onError: (e: any) => setError(e?.message),
  });
  const resetMut = useMutation({
    mutationFn: ({ id, password }: any) => api.post(`/users/${id}/reset-password`, { password }),
    onSuccess: () => { setReset(null); setExito("Contraseña actualizada."); },
    onError: (e: any) => setError(e?.message),
  });
  const reenviarMut = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/resend-credentials`),
    onSuccess: () => { setReenviar(null); setExito("Se generó una nueva contraseña temporal y se envió por correo al usuario."); },
    onError: (e: any) => { setReenviar(null); setError(e?.message ?? "No se pudo reenviar la contraseña."); },
  });
  const crearRol = useMutation({
    mutationFn: (b: any) => api.post("/roles", b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["roles"] }); setModalRolAbierto(false); setExito("Rol creado correctamente."); },
    onError: (e: any) => setError(e?.message),
  });
  const actualizarRol = useMutation({
    mutationFn: ({ id, body }: any) => api.put(`/roles/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["roles"] }); setRolEditando(null); setExito("Rol actualizado."); },
    onError: (e: any) => setError(e?.message),
  });
  const eliminarRol = useMutation({
    mutationFn: (id: string) => api.del(`/roles/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["roles"] }); setRolAEliminar(null); setExito("Rol eliminado correctamente."); },
    onError: (e: any) => { setRolAEliminar(null); setError(e?.message ?? "No se pudo eliminar el rol."); },
  });
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/users/${id}/deactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["usuarios"] }) });
  const reactivar = useMutation({ mutationFn: (id: string) => api.post(`/users/${id}/reactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["usuarios"] }) });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Usuarios y roles</h2>
        {pestana === "usuarios" && puedeCrearUsuarios
          ? <button className="primario" onClick={() => setModalAbierto(true)}>Nuevo usuario</button>
          : pestana === "roles" && puedeCrearRoles
            ? <button className="primario" onClick={() => setModalRolAbierto(true)}>Nuevo rol</button>
            : null}
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="pestanas" role="tablist" aria-label="Usuarios y roles">
        {puedeVerUsuarios && <button className={pestana === "usuarios" ? "activo" : ""} role="tab" aria-selected={pestana === "usuarios"} onClick={() => setPestana("usuarios")}>Usuarios</button>}
        {puedeVerRoles && <button className={pestana === "roles" ? "activo" : ""} role="tab" aria-selected={pestana === "roles"} onClick={() => setPestana("roles")}>Roles</button>}
      </div>

      {pestana === "usuarios" && puedeVerUsuarios && (isLoading ? <div className="cargando">Cargando...</div> : (
        <>
          <table>
            <thead><tr><th>Nombre</th><th>Correo</th><th>Roles</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {usuarios.length === 0 ? (<tr><td colSpan={5} className="vacio">No hay usuarios registrados.</td></tr>) :
              usuarios.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td>{u.email}</td>
                  <td>{u.roles.map((r) => ETIQUETAS_ROLES[r] ?? r).join(", ")}</td>
                  <td><EtiquetaEstado estado={u.active ? "active" : "inactive"} /></td>
                  <td className="acciones-tabla">
                    {puedeEditarUsuarios && <button onClick={() => setEditando(u)}>Editar</button>}
                    {puedeResetearPasswords && <button onClick={() => setReset(u)}>Restablecer contraseña</button>}
                    {puedeReenviarCredenciales && <button onClick={() => setReenviar(u)}>Reenviar contraseña</button>}
                    {u.active && puedeDesactivarUsuarios
                      ? <button className="advertencia" onClick={() => desactivar.mutate(u.id)}>Desactivar</button>
                      : !u.active && puedeReactivarUsuarios
                        ? <button className="exito" onClick={() => reactivar.mutate(u.id)}>Reactivar</button>
                        : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {infoPagina && (
            <Paginacion
              page={infoPagina.page}
              pageSize={infoPagina.pageSize}
              total={infoPagina.total}
              onPageChange={setPagina}
            />
          )}
        </>
      ))}

      {pestana === "roles" && puedeVerRoles && (
        <table>
          <thead><tr><th>Rol</th><th>Permisos</th><th>Visibilidad de tareas</th><th>Estado</th><th>Acciones</th></tr></thead>
          <tbody>
            {rolesDefinidos.map((rol) => (
              <tr key={rol.id}>
                <td>
                  <strong>{rol.name}</strong>
                  <br />
                  <small>{rol.id}{rol.protected ? " · protegido" : rol.system ? " · sistema" : ""}</small>
                </td>
                <td>{resumenPermisos(rol.permissions)}</td>
                <td>{resumenVisibilidadTareas(rol.taskVisibility)}</td>
                <td><EtiquetaEstado estado={rol.active === false ? "inactive" : "active"} /></td>
                <td className="acciones-tabla">
                  {puedeEditarRoles && <button onClick={() => setRolEditando(rol)}>Editar</button>}
                  {puedeEliminarRoles && !rol.system && (
                    <button type="button" className="peligro" title={`Eliminar rol ${rol.name}`} aria-label={`Eliminar rol ${rol.name}`} onClick={() => setRolAEliminar(rol)}>
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal titulo="Nuevo usuario" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioCrear rolesDisponibles={rolesDisponibles} onSubmit={(v) => crear.mutate(v)} cargando={crear.isPending} />
      </Modal>
      <Modal titulo="Editar usuario" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && <FormularioEditar inicial={editando} rolesDisponibles={rolesDisponibles} onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })} cargando={actualizar.isPending} />}
      </Modal>
      <Modal titulo="Nuevo rol" abierto={modalRolAbierto} onCerrar={() => setModalRolAbierto(false)} className="modal-rol">
        <FormularioRol onSubmit={(v) => crearRol.mutate(v)} cargando={crearRol.isPending} />
      </Modal>
      <Modal titulo={`Editar rol ${rolEditando?.name ?? ""}`} abierto={!!rolEditando} onCerrar={() => setRolEditando(null)} className="modal-rol">
        {rolEditando && <FormularioRol inicial={rolEditando} onSubmit={(v) => actualizarRol.mutate({ id: rolEditando.id, body: v })} cargando={actualizarRol.isPending} />}
      </Modal>
      <DialogoConfirmar
        abierto={!!rolAEliminar}
        titulo={`Eliminar rol ${rolAEliminar?.name ?? ""}`}
        mensaje="Este rol solo se puede eliminar cuando no está asignado a usuarios, programaciones activas ni tareas abiertas."
        textoConfirmar="Eliminar rol"
        variante="peligro"
        onCancelar={() => setRolAEliminar(null)}
        onConfirmar={() => rolAEliminar && eliminarRol.mutate(rolAEliminar.id)}
      />
      <Modal titulo={`Restablecer contraseña de ${reset?.displayName ?? ""}`} abierto={!!reset} onCerrar={() => setReset(null)}>
        {reset && <FormularioReset onSubmit={(p) => resetMut.mutate({ id: reset.id, password: p })} cargando={resetMut.isPending} />}
      </Modal>
      <Modal titulo={`Reenviar contraseña a ${reenviar?.displayName ?? ""}`} abierto={!!reenviar} onCerrar={() => setReenviar(null)}>
        {reenviar && (
          <div>
            <p>Se generará una <strong>nueva contraseña temporal</strong> para <strong>{reenviar.email}</strong> y se enviará por correo junto con sus datos de acceso y el enlace de inicio de sesión.</p>
            <p style={{ color: "#607086", fontSize: 13 }}>Por seguridad, las contraseñas se guardan cifradas y no se pueden recuperar; por eso se envía una contraseña nueva que reemplaza la anterior.</p>
            <div className="acciones-formulario">
              <button onClick={() => setReenviar(null)} disabled={reenviarMut.isPending}>Cancelar</button>
              <button className="primario" onClick={() => reenviarMut.mutate(reenviar.id)} disabled={reenviarMut.isPending}>{reenviarMut.isPending ? "Enviando..." : "Generar y enviar"}</button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function FormularioCrear({ rolesDisponibles, onSubmit, cargando }: { rolesDisponibles: RoleDefinition[]; onSubmit: (v: any) => void; cargando: boolean }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  function alternar(r: string) {
    setRoles((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!displayName.trim()) return setErr("El nombre es obligatorio.");
      if (!email.trim()) return setErr("El correo es obligatorio.");
      if (password.length < 14) return setErr("La contraseña debe tener al menos 14 caracteres.");
      if (password !== confirmacion) return setErr("Las contraseñas no coinciden.");
      onSubmit({ displayName, email: email.trim(), password, roles, active });
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      <div className="fila-formulario"><label>Nombre *</label><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></div>
      <div className="fila-formulario"><label>Correo electrónico *</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
      <div className="fila-formulario"><label>Contraseña temporal *</label><input type="password" maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required /><small>Use al menos 14 caracteres. El usuario deberá cambiarla en su primer acceso.</small></div>
      <div className="fila-formulario"><label>Confirmar contraseña *</label><input type="password" value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} required /></div>
      <div className="fila-formulario"><label>Roles</label>
        {rolesDisponibles.map((r) => (
          <label key={r.id} style={{ display: "flex", fontWeight: 400, alignItems: "center" }}>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={roles.includes(r.id)} onChange={() => alternar(r.id)} />
            {r.name}
          </label>
        ))}
      </div>
      <div className="fila-formulario"><label>
        <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={active} onChange={(e) => setActive(e.target.checked)} />
        Usuario activo
      </label></div>
      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Crear"}</button>
      </div>
    </form>
  );
}

function FormularioEditar({ inicial, rolesDisponibles, onSubmit, cargando }: { inicial: Usuario; rolesDisponibles: RoleDefinition[]; onSubmit: (v: any) => void; cargando: boolean }) {
  const [displayName, setDisplayName] = useState(inicial.displayName ?? "");
  const [roles, setRoles] = useState<string[]>(inicial.roles ?? []);
  const [active, setActive] = useState(inicial.active);

  function alternar(r: string) {
    setRoles((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ displayName, roles, active }); }}>
      <div className="fila-formulario"><label>Nombre</label><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
      <div className="fila-formulario"><label>Correo electrónico</label><input value={inicial.email} disabled /></div>
      <div className="fila-formulario"><label>Roles</label>
        {rolesDisponibles.map((r) => (
          <label key={r.id} style={{ display: "flex", fontWeight: 400, alignItems: "center" }}>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={roles.includes(r.id)} onChange={() => alternar(r.id)} />
            {r.name}
          </label>
        ))}
      </div>
      <div className="fila-formulario"><label>
        <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={active} onChange={(e) => setActive(e.target.checked)} />
        Usuario activo
      </label></div>
      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
      </div>
    </form>
  );
}

function FormularioRol({ inicial, onSubmit, cargando }: { inicial?: RoleDefinition; onSubmit: (v: any) => void; cargando: boolean }) {
  const [id, setId] = useState(inicial?.id ?? "");
  const [name, setName] = useState(inicial?.name ?? "");
  const [permissions, setPermissions] = useState<string[]>(inicial?.permissions ?? []);
  const [taskVisibility, setTaskVisibility] = useState<TaskVisibility>(inicial?.taskVisibility ?? { domain: "none", database: "none" });
  const [active, setActive] = useState(inicial?.active !== false);
  const [err, setErr] = useState<string | null>(null);
  const protegido = inicial?.protected === true;

  function alternarPermisos(keys: string[]) {
    if (protegido) return;
    setPermissions((prev) => {
      const set = new Set(prev);
      const todos = keys.every((key) => set.has(key));
      keys.forEach((key) => todos ? set.delete(key) : set.add(key));
      return Array.from(set);
    });
  }

  function alternarPermiso(key: string) {
    if (protegido) return;
    setPermissions((prev) => prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]);
  }

  function actualizarVisibilidad(tipo: keyof TaskVisibility, valor: TaskVisibilityLevel) {
    if (protegido) return;
    setTaskVisibility((prev) => ({ ...prev, [tipo]: valor }));
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim()) return setErr("El nombre del rol es obligatorio.");
      onSubmit({
        ...(inicial ? {} : { id: id.trim() || undefined }),
        name: name.trim(),
        permissions,
        taskVisibility,
        active: protegido ? true : active,
      });
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      {protegido && <Alerta tipo="info">Este rol está protegido: siempre conserva todos los permisos y toda la visibilidad.</Alerta>}
      {!inicial && <div className="fila-formulario"><label htmlFor="rol-id">ID opcional</label><input id="rol-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="se genera desde el nombre" /></div>}
      <div className="fila-formulario"><label htmlFor="rol-nombre">Nombre *</label><input id="rol-nombre" value={name} onChange={(e) => setName(e.target.value)} required /></div>
      {!protegido && (
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={active} onChange={(e) => setActive(e.target.checked)} />
          Rol activo
        </label></div>
      )}

      <div className="fila-formulario">
        <label>Visibilidad de tareas</label>
        <div className="visibilidad-tareas-rol">
          <SelectorVisibilidad label="Dominios" valor={taskVisibility.domain} disabled={protegido} onChange={(valor) => actualizarVisibilidad("domain", valor)} />
          <SelectorVisibilidad label="Bases de Datos" valor={taskVisibility.database} disabled={protegido} onChange={(valor) => actualizarVisibilidad("database", valor)} />
        </div>
      </div>

      <div className="fila-formulario">
        <label>Permisos</label>
        <div className="permisos-rol">
          {PERMISSION_CATALOG.map((modulo) => (
            <ModuloPermisos
              key={modulo.id}
              modulo={modulo}
              permisos={permissions}
              disabled={protegido}
              onToggleModulo={() => alternarPermisos(modulePermissionKeys(modulo))}
              onToggleOpcion={(opcion) => alternarPermisos(optionPermissionKeys(opcion))}
              onTogglePermiso={alternarPermiso}
            />
          ))}
        </div>
      </div>

      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar rol"}</button>
      </div>
    </form>
  );
}

function ModuloPermisos({
  modulo,
  permisos,
  disabled,
  onToggleModulo,
  onToggleOpcion,
  onTogglePermiso,
}: {
  modulo: PermissionModule;
  permisos: string[];
  disabled: boolean;
  onToggleModulo: () => void;
  onToggleOpcion: (opcion: PermissionOption) => void;
  onTogglePermiso: (key: string) => void;
}) {
  const clavesModulo = modulePermissionKeys(modulo);
  const moduloCompleto = clavesModulo.every((key) => permisos.includes(key));

  return (
    <section className="modulo-permisos-rol">
      <label className="modulo-permisos-titulo">
        <input type="checkbox" checked={moduloCompleto} disabled={disabled} onChange={onToggleModulo} />
        {modulo.label}
      </label>
      {modulo.options.map((opcion) => {
        const clavesOpcion = optionPermissionKeys(opcion);
        const opcionCompleta = clavesOpcion.every((key) => permisos.includes(key));
        return (
          <div className="opcion-permisos-rol" key={opcion.id}>
            <label className="opcion-permisos-titulo">
              <input type="checkbox" checked={opcionCompleta} disabled={disabled} onChange={() => onToggleOpcion(opcion)} />
              {opcion.label}
            </label>
            <div className="acciones-permisos-rol">
              {opcion.actions.map((accion) => {
                const key = permissionKey(opcion, accion.id);
                return (
                  <label key={key}>
                    <input type="checkbox" checked={permisos.includes(key)} disabled={disabled} onChange={() => onTogglePermiso(key)} />
                    {accion.label}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function SelectorVisibilidad({ label, valor, disabled, onChange }: { label: string; valor: TaskVisibilityLevel; disabled: boolean; onChange: (valor: TaskVisibilityLevel) => void }) {
  return (
    <label>
      {label}
      <select value={valor} disabled={disabled} onChange={(e) => onChange(e.target.value as TaskVisibilityLevel)}>
        {VISIBILIDAD_TAREAS.map((opcion) => <option key={opcion.valor} value={opcion.valor}>{opcion.etiqueta}</option>)}
      </select>
    </label>
  );
}

function FormularioReset({ onSubmit, cargando }: { onSubmit: (p: string) => void; cargando: boolean }) {
  const [pwd, setPwd] = useState("");
  const [conf, setConf] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (pwd.length < 14) return setErr("La contraseña debe tener al menos 14 caracteres.");
      if (pwd !== conf) return setErr("Las contraseñas no coinciden.");
      onSubmit(pwd);
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      <div className="fila-formulario"><label>Nueva contraseña temporal *</label><input type="password" maxLength={72} value={pwd} onChange={(e) => setPwd(e.target.value)} /><small>El usuario deberá cambiarla en su siguiente acceso.</small></div>
      <div className="fila-formulario"><label>Confirmar *</label><input type="password" value={conf} onChange={(e) => setConf(e.target.value)} /></div>
      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Cambiar contraseña"}</button>
      </div>
    </form>
  );
}

function resumenPermisos(permisos: string[] = []): string {
  const total = PERMISSION_CATALOG.flatMap(modulePermissionKeys).length;
  if (permisos.length === 0) return "Sin permisos";
  if (permisos.length >= total) return "Todos los permisos";
  return `${permisos.length} permisos`;
}

function resumenVisibilidadTareas(visibilidad: TaskVisibility = { domain: "none", database: "none" }): string {
  return `Dominios: ${etiquetaVisibilidad(visibilidad.domain)} · Bases de Datos: ${etiquetaVisibilidad(visibilidad.database)}`;
}

function etiquetaVisibilidad(valor: TaskVisibilityLevel): string {
  return VISIBILIDAD_TAREAS.find((opcion) => opcion.valor === valor)?.etiqueta ?? valor;
}
