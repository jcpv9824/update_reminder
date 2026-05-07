import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BaseDeDatos, Cliente, Dominio } from "../types";
import { Alerta, EtiquetaEstado, Modal, DialogoConfirmar } from "../components/Comunes";
import { AccesoBdParseado } from "../components/AccesoBdParseado";
import { PanelAccesoBd } from "../components/PanelAccesoBd";
import { ETIQUETAS_AMBIENTE } from "../types";
import { SeleccionFrecuencia, valoresFrecuenciaPorDefecto, depurarFrecuenciaParaEnvio, type ValoresFrecuencia } from "../components/SeleccionFrecuencia";

export default function BasesDeDatosPage() {
  const qc = useQueryClient();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [verAcceso, setVerAcceso] = useState<BaseDeDatos | null>(null);
  const [confirmar, setConfirmar] = useState<{ tipo: "eliminar" | "desactivar"; bd: BaseDeDatos } | null>(null);
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroDominio, setFiltroDominio] = useState("");
  const [filtroAmbiente, setFiltroAmbiente] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: dominios = [] } = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });
  const { data: bds = [], isLoading } = useQuery({ queryKey: ["bases-de-datos"], queryFn: () => api.get<BaseDeDatos[]>("/databases") });

  const crear = useMutation({
    mutationFn: (body: any) => api.post<BaseDeDatos>("/databases", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bases-de-datos"] }); setModalAbierto(false); setExito("Base de datos creada correctamente."); },
    onError: (e: any) => setError(e?.message ?? "Error al crear la base de datos."),
  });
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/databases/${id}/deactivate`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["bases-de-datos"] }); setConfirmar(null); setExito("Base de datos desactivada."); } });
  const eliminar = useMutation({ mutationFn: (id: string) => api.del(`/databases/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["bases-de-datos"] }); setConfirmar(null); setExito("Base de datos eliminada."); } });

  const filtradas = bds.filter((b) => {
    if (filtroCliente && b.clientId !== filtroCliente) return false;
    if (filtroDominio && b.domainId !== filtroDominio) return false;
    if (filtroAmbiente && b.environment !== filtroAmbiente) return false;
    if (filtroEstado && b.status !== filtroEstado) return false;
    if (busqueda) {
      const q = busqueda.toLowerCase();
      if (!b.companyName.toLowerCase().includes(q) && !b.dbAccess.initialCatalog.toLowerCase().includes(q) && !b.dbAccess.serverHostPort.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Bases de datos</h2>
        <button className="primario" onClick={() => setModalAbierto(true)}>Nueva base de datos</button>
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="barra-filtros">
        <div className="campo"><label>Cliente</label>
          <select value={filtroCliente} onChange={(e) => setFiltroCliente(e.target.value)}>
            <option value="">Todos</option>
            {clientes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        <div className="campo"><label>Dominio</label>
          <select value={filtroDominio} onChange={(e) => setFiltroDominio(e.target.value)}>
            <option value="">Todos</option>
            {dominios.map((d) => <option key={d.id} value={d.id}>{d.domainName}</option>)}
          </select></div>
        <div className="campo"><label>Ambiente</label>
          <select value={filtroAmbiente} onChange={(e) => setFiltroAmbiente(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(ETIQUETAS_AMBIENTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        <div className="campo"><label>Estado</label>
          <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
            <option value="">Todos</option>
            <option value="active">Activo</option>
            <option value="inactive">Inactivo</option>
            <option value="deleted">Eliminado</option>
          </select></div>
        <div className="campo"><label>Buscar empresa/servidor</label>
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} /></div>
      </div>

      {isLoading ? <div className="cargando">Cargando...</div> : (
        <table>
          <thead><tr>
            <th>Cliente</th><th>Dominio</th><th>Empresa</th><th>Base de datos</th><th>Servidor</th><th>Estado</th><th>Versión</th><th>Última actualización</th><th>Acciones</th>
          </tr></thead>
          <tbody>
            {filtradas.length === 0 ? (<tr><td colSpan={9} className="vacio">No hay bases de datos para mostrar.</td></tr>) :
            filtradas.map((b) => (
              <tr key={b.id}>
                <td>{b.clientName}</td>
                <td>{b.domainName}</td>
                <td>{b.companyName}</td>
                <td>{b.dbAccess.initialCatalog}</td>
                <td>{b.dbAccess.serverHostPort}</td>
                <td><EtiquetaEstado estado={b.status} /></td>
                <td>{b.currentDbVersion ?? "-"}</td>
                <td>{b.lastUpdatedAt ? new Date(b.lastUpdatedAt).toLocaleDateString("es-CO") : "-"}</td>
                <td className="acciones-tabla">
                  <button onClick={() => setVerAcceso(b)}>Ver acceso</button>
                  {b.status === "active" && <button className="advertencia" onClick={() => setConfirmar({ tipo: "desactivar", bd: b })}>Desactivar</button>}
                  <button className="peligro" onClick={() => setConfirmar({ tipo: "eliminar", bd: b })}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal titulo="Nueva base de datos" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioBd clientes={clientes} dominios={dominios} cargando={crear.isPending} onSubmit={(v) => crear.mutate(v)} />
      </Modal>

      <Modal titulo={`Acceso: ${verAcceso?.companyName ?? ""}`} abierto={!!verAcceso} onCerrar={() => setVerAcceso(null)}>
        {verAcceso && <PanelAccesoBd bd={verAcceso} />}
      </Modal>

      <DialogoConfirmar
        abierto={!!confirmar}
        titulo={confirmar?.tipo === "eliminar" ? "Eliminar base de datos" : "Desactivar base de datos"}
        mensaje={confirmar?.tipo === "eliminar" ? `¿Eliminar la base de datos "${confirmar?.bd.companyName}"?` : `¿Desactivar la base de datos "${confirmar?.bd.companyName}"?`}
        textoConfirmar={confirmar?.tipo === "eliminar" ? "Eliminar" : "Desactivar"}
        variante={confirmar?.tipo === "eliminar" ? "peligro" : "primario"}
        onConfirmar={() => {
          if (!confirmar) return;
          if (confirmar.tipo === "eliminar") eliminar.mutate(confirmar.bd.id);
          else desactivar.mutate(confirmar.bd.id);
        }}
        onCancelar={() => setConfirmar(null)}
      />
    </>
  );
}

function FormularioBd({ clientes, dominios, onSubmit, cargando }: { clientes: Cliente[]; dominios: Dominio[]; onSubmit: (v: any) => void; cargando: boolean }) {
  const [clientId, setClientId] = useState("");
  const [domainId, setDomainId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [rawDbAccess, setRawDbAccess] = useState("");
  const [currentDbVersion, setCurrentDbVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [crearFrecuencia, setCrearFrecuencia] = useState(true);
  const [frecuencia, setFrecuencia] = useState<ValoresFrecuencia>(valoresFrecuenciaPorDefecto("database_updater"));
  const [err, setErr] = useState<string | null>(null);

  const dominiosFiltrados = useMemo(() => dominios.filter((d) => d.clientId === clientId && d.status === "active"), [dominios, clientId]);

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!clientId) return setErr("Seleccione el cliente.");
      if (!domainId) return setErr("Seleccione el dominio.");
      if (!companyName.trim()) return setErr("El nombre de la empresa es obligatorio.");
      if (!rawDbAccess.trim()) return setErr("La cadena de acceso es obligatoria.");
      const body: any = { clientId, domainId, companyName: companyName.trim(), environment, rawDbAccess, currentDbVersion: currentDbVersion || undefined, notes, assignedUpdaterIds: [] };
      if (crearFrecuencia) body.frequency = depurarFrecuenciaParaEnvio(frecuencia);
      onSubmit(body);
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      <div className="fila-formulario"><label>Cliente *</label>
        <select value={clientId} onChange={(e) => { setClientId(e.target.value); setDomainId(""); }}>
          <option value="">Seleccione...</option>
          {clientes.filter((c) => c.status === "active").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></div>
      <div className="fila-formulario"><label>Dominio *</label>
        <select value={domainId} onChange={(e) => setDomainId(e.target.value)} disabled={!clientId}>
          <option value="">Seleccione...</option>
          {dominiosFiltrados.map((d) => <option key={d.id} value={d.id}>{d.domainName}</option>)}
        </select></div>
      <div className="fila-formulario"><label>Nombre de la empresa *</label>
        <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></div>
      <div className="fila-formulario"><label>Ambiente *</label>
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          {Object.entries(ETIQUETAS_AMBIENTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></div>
      <div className="fila-formulario"><label>Versión actual de la base de datos</label>
        <input value={currentDbVersion} onChange={(e) => setCurrentDbVersion(e.target.value)} /></div>
      <div className="fila-formulario">
        <label>Cadena de acceso a la base de datos *</label>
        <textarea rows={3} value={rawDbAccess} onChange={(e) => setRawDbAccess(e.target.value)}
          placeholder="data12.sagerp.co,54101; Initial Catalog = LA-COCINA-DE-LA-CASA; User ID = ATYNCONSULS-INS01; Password = ejemplo;" />
        <div style={{ marginTop: 8 }}><AccesoBdParseado texto={rawDbAccess} /></div>
      </div>
      <div className="fila-formulario"><label>Notas</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

      <h4>Frecuencia de actualización de la base de datos</h4>
      <div className="fila-formulario">
        <label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={crearFrecuencia} onChange={(e) => setCrearFrecuencia(e.target.checked)} />
          Crear frecuencia automática para esta base de datos
        </label>
      </div>
      {crearFrecuencia && (
        <SeleccionFrecuencia valor={frecuencia} onChange={setFrecuencia} rolesPermitidos={["database_updater", "admin", "client_manager"]} />
      )}

      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
      </div>
    </form>
  );
}
