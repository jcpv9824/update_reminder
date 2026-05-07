import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Alerta, EtiquetaEstado, Modal } from "../components/Comunes";
import { ETIQUETAS_ROLES } from "../types";

type Usuario = {
  id: string;
  displayName: string;
  email: string;
  roles: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

const ROLES = ["admin", "client_manager", "database_updater", "domain_updater", "viewer"];

export default function UsuariosPage() {
  const qc = useQueryClient();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Usuario | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data = [], isLoading } = useQuery({ queryKey: ["usuarios"], queryFn: () => api.get<Usuario[]>("/users") });
  const crear = useMutation({ mutationFn: (b: any) => api.post("/users", b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["usuarios"] }); setModalAbierto(false); setExito("Usuario creado."); }, onError: (e: any) => setError(e?.message) });
  const actualizar = useMutation({ mutationFn: ({ id, body }: any) => api.put(`/users/${id}`, body), onSuccess: () => { qc.invalidateQueries({ queryKey: ["usuarios"] }); setEditando(null); setExito("Usuario actualizado."); }, onError: (e: any) => setError(e?.message) });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Usuarios y roles</h2>
        <button className="primario" onClick={() => setModalAbierto(true)}>Nuevo usuario</button>
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      {isLoading ? <div className="cargando">Cargando...</div> : (
        <table>
          <thead><tr><th>Nombre</th><th>Correo</th><th>Roles</th><th>Estado</th><th>Acciones</th></tr></thead>
          <tbody>
            {data.length === 0 ? (<tr><td colSpan={5} className="vacio">No hay usuarios registrados.</td></tr>) :
            data.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td>{u.roles.map((r) => ETIQUETAS_ROLES[r] ?? r).join(", ")}</td>
                <td><EtiquetaEstado estado={u.active ? "active" : "inactive"} /></td>
                <td className="acciones-tabla">
                  <button onClick={() => setEditando(u)}>Editar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal titulo="Nuevo usuario" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioUsuario onSubmit={(v) => crear.mutate(v)} cargando={crear.isPending} />
      </Modal>
      <Modal titulo="Editar usuario" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && <FormularioUsuario inicial={editando} onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })} cargando={actualizar.isPending} />}
      </Modal>
    </>
  );
}

function FormularioUsuario({ inicial, onSubmit, cargando }: { inicial?: Usuario; onSubmit: (v: any) => void; cargando: boolean }) {
  const [id, setId] = useState(inicial?.id ?? "");
  const [displayName, setDisplayName] = useState(inicial?.displayName ?? "");
  const [email, setEmail] = useState(inicial?.email ?? "");
  const [roles, setRoles] = useState<string[]>(inicial?.roles ?? []);
  const [active, setActive] = useState(inicial?.active ?? true);

  function alternarRol(r: string) {
    setRoles((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(inicial ? { displayName, email, roles, active } : { id, displayName, email, roles, active }); }}>
      {!inicial && (
        <div className="fila-formulario"><label>Identificador *</label>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="correo@empresa.com" required />
        </div>
      )}
      <div className="fila-formulario"><label>Nombre *</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></div>
      <div className="fila-formulario"><label>Correo electrónico *</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
      <div className="fila-formulario"><label>Roles</label>
        {ROLES.map((r) => (
          <label key={r} style={{ display: "flex", fontWeight: 400, alignItems: "center" }}>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={roles.includes(r)} onChange={() => alternarRol(r)} />
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
