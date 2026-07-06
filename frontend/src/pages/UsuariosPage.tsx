import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Alerta, EtiquetaEstado, Modal, Paginacion } from "../components/Comunes";
import { ETIQUETAS_ROLES, type RespuestaPaginada } from "../types";

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

const ROLES = ["admin", "client_manager", "database_updater", "domain_updater", "viewer"];

export default function UsuariosPage() {
  const qc = useQueryClient();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Usuario | null>(null);
  const [reset, setReset] = useState<Usuario | null>(null);
  const [reenviar, setReenviar] = useState<Usuario | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pagina, setPagina] = useState(1);

  const { data: paginaUsuarios, isLoading } = useQuery({
    queryKey: ["usuarios", "pagina", pagina],
    queryFn: () => api.get<RespuestaPaginada<Usuario>>(`/users?page=${pagina}&pageSize=10`),
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
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/users/${id}/deactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["usuarios"] }) });
  const reactivar = useMutation({ mutationFn: (id: string) => api.post(`/users/${id}/reactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["usuarios"] }) });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Usuarios y roles</h2>
        <button className="primario" onClick={() => setModalAbierto(true)}>Nuevo usuario</button>
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      {isLoading ? <div className="cargando">Cargando...</div> : (
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
                    <button onClick={() => setEditando(u)}>Editar</button>
                    <button onClick={() => setReset(u)}>Restablecer contraseña</button>
                    <button onClick={() => setReenviar(u)}>Reenviar contraseña</button>
                    {u.active
                      ? <button className="advertencia" onClick={() => desactivar.mutate(u.id)}>Desactivar</button>
                      : <button className="exito" onClick={() => reactivar.mutate(u.id)}>Reactivar</button>}
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
      )}

      <Modal titulo="Nuevo usuario" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioCrear onSubmit={(v) => crear.mutate(v)} cargando={crear.isPending} />
      </Modal>
      <Modal titulo="Editar usuario" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && <FormularioEditar inicial={editando} onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })} cargando={actualizar.isPending} />}
      </Modal>
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

function FormularioCrear({ onSubmit, cargando }: { onSubmit: (v: any) => void; cargando: boolean }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [roles, setRoles] = useState<string[]>(["viewer"]);
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
        {ROLES.map((r) => (
          <label key={r} style={{ display: "flex", fontWeight: 400, alignItems: "center" }}>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={roles.includes(r)} onChange={() => alternar(r)} />
            {ETIQUETAS_ROLES[r]}
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

function FormularioEditar({ inicial, onSubmit, cargando }: { inicial: Usuario; onSubmit: (v: any) => void; cargando: boolean }) {
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
        {ROLES.map((r) => (
          <label key={r} style={{ display: "flex", fontWeight: 400, alignItems: "center" }}>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={roles.includes(r)} onChange={() => alternar(r)} />
            {ETIQUETAS_ROLES[r]}
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
