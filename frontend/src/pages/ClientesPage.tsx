import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BaseDeDatos, Cliente, Dominio } from "../types";
import { Alerta, DialogoConfirmar, EtiquetaEstado, Modal } from "../components/Comunes";
import { ETIQUETAS_AMBIENTE } from "../types";

type AccionCliente = "guardar" | "agregarDominio" | "crearNuevo";

export default function ClientesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Cliente | null>(null);
  const [confirmar, setConfirmar] = useState<{ tipo: "eliminar" | "desactivar"; cliente: Cliente } | null>(null);
  const [verArbol, setVerArbol] = useState<Cliente | null>(null);
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
    mutationFn: (id: string) => api.del(`/clients/${id}?cascade=true`),
    onSuccess: (_r, id) => {
      qc.setQueryData<Cliente[]>(["clientes"], (actuales = []) => actuales.filter((c) => c.id !== id));
      qc.invalidateQueries({ queryKey: ["clientes"] });
      setExito("Cliente eliminado con sus dominios, bases y programaciones asociadas.");
      setConfirmar(null);
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar el cliente."),
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
                  <button onClick={() => setVerArbol(c)}>Ver dominios y bases</button>
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
      <Modal titulo="Ver dominios y bases" abierto={!!verArbol} onCerrar={() => setVerArbol(null)}>
        {verArbol && <ArbolCliente cliente={verArbol} />}
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
          ? `Está a punto de eliminar el cliente "${confirmar?.cliente.name}". Se eliminarán también sus dominios, bases de datos y programaciones asociadas. Esta acción no eliminará los registros de auditoría.`
          : `¿Desactivar el cliente "${confirmar?.cliente.name}"?`}
        textoConfirmar={confirmar?.tipo === "eliminar" ? "Sí, eliminar todo" : "Desactivar"}
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

function ArbolCliente({ cliente }: { cliente: Cliente }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["cliente-tree", cliente.id],
    queryFn: () => api.get<{ client: Cliente; domains: Array<{ domain: Dominio; databases: BaseDeDatos[] }> }>(`/clients/${cliente.id}/tree`),
  });
  return (
    <div>
      <h4>Cliente: {cliente.name}</h4>
      {isLoading && <div className="cargando">Cargando dominios y bases...</div>}
      {isError && <Alerta tipo="error">No se pudo cargar la información relacionada.</Alerta>}
      {data?.domains.length === 0 && <p className="vacio">No hay dominios activos asociados.</p>}
      {data?.domains.map(({ domain, databases }) => (
        <div className="tarjeta tarjeta-compacta" key={domain.id}>
          <h4>{domain.domainName}</h4>
          <p><strong>Dominio para publicar:</strong> {domain.domainName}</p>
          <p><strong>Ambiente:</strong> {ETIQUETAS_AMBIENTE[domain.environment] ?? domain.environment}</p>
          <p><strong>Estado:</strong> <EtiquetaEstado estado={domain.status} /></p>
          <div style={{ marginTop: 8 }}>
            <strong>Empresas / bases</strong>
            {databases.length === 0 ? <p className="texto-ayuda">Sin bases activas asociadas.</p> : (
              <ul>
                {databases.map((db) => (
                  <li key={db.id}>
                    {db.companyName} — {db.dbAccess.initialCatalog} — {ETIQUETAS_AMBIENTE[db.environment] ?? db.environment} — {db.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}
    </div>
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
