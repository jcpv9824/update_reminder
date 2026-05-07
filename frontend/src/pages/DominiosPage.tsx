import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Cliente, Dominio } from "../types";
import { Alerta, EtiquetaEstado, Modal, DialogoConfirmar } from "../components/Comunes";
import { ETIQUETAS_AMBIENTE } from "../types";
import { SeleccionFrecuencia, valoresFrecuenciaPorDefecto, depurarFrecuenciaParaEnvio, type ValoresFrecuencia } from "../components/SeleccionFrecuencia";
import { SelectorBuscable } from "../components/SelectorBuscable";

export default function DominiosPage() {
  const qc = useQueryClient();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Dominio | null>(null);
  const [confirmar, setConfirmar] = useState<{ tipo: "eliminar" | "desactivar"; dominio: Dominio } | null>(null);
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroAmbiente, setFiltroAmbiente] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: dominios = [], isLoading } = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });

  const crear = useMutation({
    mutationFn: (body: any) => api.post<Dominio>("/domains", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dominios"] }); setModalAbierto(false); setExito("Dominio creado correctamente."); },
    onError: (e: any) => setError(e?.message ?? "Error al crear dominio."),
  });
  const actualizar = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.put<Dominio>(`/domains/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dominios"] }); setEditando(null); setExito("Dominio actualizado."); },
    onError: (e: any) => setError(e?.message ?? "Error al actualizar."),
  });
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/domains/${id}/deactivate`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["dominios"] }); setConfirmar(null); setExito("Dominio desactivado."); } });
  const eliminar = useMutation({ mutationFn: (id: string) => api.del(`/domains/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["dominios"] }); setConfirmar(null); setExito("Dominio eliminado."); } });

  const filtrados = dominios.filter((d) => {
    if (filtroCliente && d.clientId !== filtroCliente) return false;
    if (filtroEstado && d.status !== filtroEstado) return false;
    if (filtroAmbiente && d.environment !== filtroAmbiente) return false;
    if (busqueda && !d.domainName.toLowerCase().includes(busqueda.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Dominios</h2>
        <button className="primario" onClick={() => setModalAbierto(true)}>Nuevo dominio</button>
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="barra-filtros">
        <div className="campo"><label>Cliente</label>
          <SelectorBuscable
            opciones={clientes.map((c) => ({ id: c.id, etiqueta: c.name }))}
            valor={filtroCliente}
            onChange={setFiltroCliente}
            permiteVacio
            textoVacio="Todos los clientes"
            placeholder="Buscar cliente..."
          />
        </div>
        <div className="campo"><label>Buscar dominio</label>
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="ejemplo.sagerp.co" />
        </div>
        <div className="campo"><label>Ambiente</label>
          <select value={filtroAmbiente} onChange={(e) => setFiltroAmbiente(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(ETIQUETAS_AMBIENTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="campo"><label>Estado</label>
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
          <thead><tr>
            <th>Cliente</th><th>Dominio</th><th>Ambiente</th><th>Versión web</th><th>Estado</th><th>Última actualización</th><th>Acciones</th>
          </tr></thead>
          <tbody>
            {filtrados.length === 0 ? (<tr><td colSpan={7} className="vacio">No hay dominios para mostrar.</td></tr>) :
            filtrados.map((d) => (
              <tr key={d.id}>
                <td>{d.clientName}</td>
                <td>{d.domainName}</td>
                <td>{ETIQUETAS_AMBIENTE[d.environment] ?? d.environment}</td>
                <td>{d.currentWebVersion ?? "-"}</td>
                <td><EtiquetaEstado estado={d.status} /></td>
                <td>{d.lastUpdatedAt ? new Date(d.lastUpdatedAt).toLocaleDateString("es-CO") : "-"}</td>
                <td className="acciones-tabla">
                  <button onClick={() => setEditando(d)}>Editar</button>
                  {d.status === "active" && <button className="advertencia" onClick={() => setConfirmar({ tipo: "desactivar", dominio: d })}>Desactivar</button>}
                  <button className="peligro" onClick={() => setConfirmar({ tipo: "eliminar", dominio: d })}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal titulo="Nuevo dominio" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioDominio clientes={clientes} cargando={crear.isPending} onSubmit={(v) => crear.mutate(v)} />
      </Modal>
      <Modal titulo="Editar dominio" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && <FormularioDominio inicial={editando} clientes={clientes} cargando={actualizar.isPending} onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })} />}
      </Modal>

      <DialogoConfirmar
        abierto={!!confirmar}
        titulo={confirmar?.tipo === "eliminar" ? "Eliminar dominio" : "Desactivar dominio"}
        mensaje={confirmar?.tipo === "eliminar" ? `¿Eliminar el dominio "${confirmar?.dominio.domainName}"?` : `¿Desactivar el dominio "${confirmar?.dominio.domainName}"?`}
        textoConfirmar={confirmar?.tipo === "eliminar" ? "Eliminar" : "Desactivar"}
        variante={confirmar?.tipo === "eliminar" ? "peligro" : "primario"}
        onConfirmar={() => {
          if (!confirmar) return;
          if (confirmar.tipo === "eliminar") eliminar.mutate(confirmar.dominio.id);
          else desactivar.mutate(confirmar.dominio.id);
        }}
        onCancelar={() => setConfirmar(null)}
      />
    </>
  );
}

function FormularioDominio({ inicial, clientes, onSubmit, cargando }: { inicial?: Dominio; clientes: Cliente[]; onSubmit: (v: any) => void; cargando: boolean }) {
  const [clientId, setClientId] = useState(inicial?.clientId ?? "");
  const [domainName, setDomainName] = useState(inicial?.domainName ?? "");
  const [environment, setEnvironment] = useState(inicial?.environment ?? "production");
  const [currentWebVersion, setCurrentWebVersion] = useState(inicial?.currentWebVersion ?? "");
  const [notes, setNotes] = useState(inicial?.notes ?? "");
  const [crearFrecuencia, setCrearFrecuencia] = useState(!inicial);
  const [frecuencia, setFrecuencia] = useState<ValoresFrecuencia>(valoresFrecuenciaPorDefecto("domain_updater"));
  const [err, setErr] = useState<string | null>(null);

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!clientId) return setErr("Seleccione un cliente.");
      if (!domainName.trim()) return setErr("El dominio es obligatorio.");
      const body: any = { clientId, domainName: domainName.trim(), environment, currentWebVersion: currentWebVersion || undefined, assignedUpdaterIds: [], notes };
      if (!inicial && crearFrecuencia) {
        body.frequency = depurarFrecuenciaParaEnvio(frecuencia);
      }
      onSubmit(body);
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}

      <h4 style={{ marginTop: 0 }}>Información general</h4>
      <div className="fila-formulario">
        <label>Cliente *</label>
        <SelectorBuscable
          opciones={clientes.filter((c) => c.status === "active").map((c) => ({ id: c.id, etiqueta: c.name }))}
          valor={clientId}
          onChange={setClientId}
          disabled={!!inicial}
          placeholder="Buscar cliente..."
        />
      </div>
      <div className="fila-formulario"><label>Nombre del dominio *</label>
        <input value={domainName} onChange={(e) => setDomainName(e.target.value)} placeholder="ejemplo.sagerp.co" /></div>

      <h4>Configuración técnica</h4>
      <div className="fila-formulario"><label>Ambiente *</label>
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          {Object.entries(ETIQUETAS_AMBIENTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></div>
      <div className="fila-formulario"><label>Versión web actual</label>
        <input value={currentWebVersion} onChange={(e) => setCurrentWebVersion(e.target.value)} /></div>
      <div className="fila-formulario"><label>Notas</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

      {!inicial && (
        <>
          <h4>Frecuencia de actualización del dominio</h4>
          <div className="fila-formulario">
            <label>
              <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={crearFrecuencia} onChange={(e) => setCrearFrecuencia(e.target.checked)} />
              Crear frecuencia automática para este dominio
            </label>
          </div>
          {crearFrecuencia && (
            <SeleccionFrecuencia valor={frecuencia} onChange={setFrecuencia} rolesPermitidos={["domain_updater", "admin", "client_manager"]} />
          )}
        </>
      )}

      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
      </div>
    </form>
  );
}
