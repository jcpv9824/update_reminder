import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Cliente } from "../types";
import { Alerta, DialogoConfirmar, EtiquetaEstado, Modal } from "../components/Comunes";

type AccionCliente = "guardar" | "agregarDominio" | "crearNuevo";

export default function ClientesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Cliente | null>(null);
  const [confirmar, setConfirmar] = useState<{ tipo: "eliminar" | "desactivar"; cliente: Cliente } | null>(null);
  const [filtroNombre, setFiltroNombre] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["clientes"],
    queryFn: () => api.get<Cliente[]>("/clients"),
  });

  const crear = useMutation({
    mutationFn: ({ body }: { body: { name: string; notes?: string }; accion: AccionCliente }) => api.post<Cliente>("/clients", body),
    onSuccess: (cliente, variables) => {
      qc.invalidateQueries({ queryKey: ["clientes"] });
      setExito("Cliente creado correctamente.");
      if (variables.accion === "agregarDominio") {
        setModalAbierto(false);
        navigate(`/dominios?clientId=${encodeURIComponent(cliente.id)}&new=1`);
      } else if (variables.accion === "crearNuevo") {
        setModalAbierto(true);
      } else {
        setModalAbierto(false);
      }
    },
    onError: (e: any) => setError(e?.message ?? "Error al crear cliente."),
  });
  const actualizar = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.put<Cliente>(`/clients/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["clientes"] }); setEditando(null); setExito("Cliente actualizado."); },
    onError: (e: any) => setError(e?.message ?? "Error al actualizar."),
  });
  const desactivar = useMutation({
    mutationFn: (id: string) => api.post(`/clients/${id}/deactivate`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["clientes"] }); setExito("Cliente desactivado."); setConfirmar(null); },
  });
  const eliminar = useMutation({
    mutationFn: (id: string) => api.del(`/clients/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["clientes"] }); setExito("Cliente eliminado."); setConfirmar(null); },
  });

  const filtrados = data.filter((c) => {
    if (filtroNombre && !c.name.toLowerCase().includes(filtroNombre.toLowerCase())) return false;
    if (filtroEstado && c.status !== filtroEstado) return false;
    return true;
  });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Clientes</h2>
        <button className="primario" onClick={() => setModalAbierto(true)}>Nuevo cliente</button>
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="barra-filtros">
        <div className="campo">
          <label>Buscar por nombre</label>
          <input value={filtroNombre} onChange={(e) => setFiltroNombre(e.target.value)} placeholder="Nombre del cliente" />
        </div>
        <div className="campo">
          <label>Estado</label>
          <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
            <option value="">Todos</option>
            <option value="active">Activo</option>
            <option value="inactive">Inactivo</option>
            <option value="deleted">Eliminado</option>
          </select>
        </div>
      </div>

      {isLoading ? <div className="cargando">Cargando...</div> : (
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Estado</th>
              <th>Notas</th>
              <th>Creado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filtrados.length === 0 ? (
              <tr><td colSpan={5} className="vacio">No hay clientes para mostrar.</td></tr>
            ) : filtrados.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><EtiquetaEstado estado={c.status} /></td>
                <td>{c.notes ?? ""}</td>
                <td>{new Date(c.createdAt).toLocaleDateString("es-CO")}</td>
                <td className="acciones-tabla">
                  <button onClick={() => setEditando(c)}>Editar</button>
                  {c.status === "active" && <button className="advertencia" onClick={() => setConfirmar({ tipo: "desactivar", cliente: c })}>Desactivar</button>}
                  <button className="peligro" onClick={() => setConfirmar({ tipo: "eliminar", cliente: c })}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal titulo="Nuevo cliente" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioCliente key={crear.submittedAt || "nuevo"} onSubmit={(v, accion) => crear.mutate({ body: v, accion })} cargando={crear.isPending} />
      </Modal>
      <Modal titulo="Editar cliente" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && (
          <FormularioCliente
            inicial={editando}
            cargando={actualizar.isPending}
            onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })}
          />
        )}
      </Modal>

      <DialogoConfirmar
        abierto={!!confirmar}
        titulo={confirmar?.tipo === "eliminar" ? "Eliminar cliente" : "Desactivar cliente"}
        mensaje={confirmar?.tipo === "eliminar"
          ? `¿Seguro que desea eliminar el cliente "${confirmar?.cliente.name}"? Esta acción es lógica y puede revertirse.`
          : `¿Desactivar el cliente "${confirmar?.cliente.name}"?`}
        textoConfirmar={confirmar?.tipo === "eliminar" ? "Eliminar" : "Desactivar"}
        variante={confirmar?.tipo === "eliminar" ? "peligro" : "primario"}
        onConfirmar={() => {
          if (!confirmar) return;
          if (confirmar.tipo === "eliminar") eliminar.mutate(confirmar.cliente.id);
          else desactivar.mutate(confirmar.cliente.id);
        }}
        onCancelar={() => setConfirmar(null)}
      />
    </>
  );
}

function FormularioCliente({ inicial, onSubmit, cargando }: { inicial?: Cliente; onSubmit: (v: { name: string; notes?: string }, accion: AccionCliente) => void; cargando: boolean }) {
  const [name, setName] = useState(inicial?.name ?? "");
  const [notes, setNotes] = useState(inicial?.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  function enviar(accion: AccionCliente) {
    if (!name.trim()) { setErr("El nombre es obligatorio."); return; }
    setErr(null);
    onSubmit({ name: name.trim(), notes: notes.trim() || undefined }, accion);
  }
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      enviar("guardar");
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      <div className="fila-formulario">
        <label>Nombre del cliente *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="fila-formulario">
        <label>Notas</label>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
        {!inicial && (
          <>
            <button type="button" onClick={() => enviar("agregarDominio")} disabled={cargando}>Guardar y agregar dominio</button>
            <button type="button" onClick={() => enviar("crearNuevo")} disabled={cargando}>Guardar y crear nuevo cliente</button>
          </>
        )}
      </div>
    </form>
  );
}
