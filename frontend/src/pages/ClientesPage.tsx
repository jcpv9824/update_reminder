import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BaseDeDatos, Cliente, Dominio, ModuloLicencia, RespuestaPaginada } from "../types";
import { Alerta, DialogoConfirmar, EtiquetaEstado, Modal, Paginacion } from "../components/Comunes";
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
  const [pagina, setPagina] = useState(1);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: paginaClientes, isLoading } = useQuery({
    queryKey: ["clientes", "pagina", pagina, filtroNombre, filtroEstado],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(pagina), pageSize: "10" });
      if (filtroNombre) params.set("search", filtroNombre);
      if (filtroEstado) params.set("status", filtroEstado);
      return api.get<RespuestaPaginada<Cliente>>(`/clients?${params.toString()}`);
    },
  });
  const { data: modulosLicencia = [] } = useQuery({
    queryKey: ["license-modules"],
    queryFn: () => api.get<ModuloLicencia[]>("/license-modules"),
  });

  const crear = useMutation({
    mutationFn: ({ body }: { body: { name: string; notes?: string; licenseModuleIds?: string[] }; accion: AccionCliente }) => api.post<Cliente>("/clients", body),
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

  const filtrados = Array.isArray(paginaClientes) ? paginaClientes : paginaClientes?.items ?? [];
  const infoPagina = !Array.isArray(paginaClientes) ? paginaClientes : undefined;

  useEffect(() => { setPagina(1); }, [filtroNombre, filtroEstado]);

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
        <>
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
                  <button onClick={() => setVerArbol(c)}>Ver dominios y bases</button>
                  <button onClick={() => navigate(`/dominios?clientId=${encodeURIComponent(c.id)}&new=1`)}>Agregar dominio</button>
                  <button onClick={() => setEditando(c)}>Editar</button>
                  {c.status === "active" && <button className="advertencia" onClick={() => setConfirmar({ tipo: "desactivar", cliente: c })}>Desactivar</button>}
                  <button className="peligro" onClick={() => setConfirmar({ tipo: "eliminar", cliente: c })}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {infoPagina && <Paginacion page={infoPagina.page} pageSize={infoPagina.pageSize} total={infoPagina.total} onPageChange={setPagina} />}
        </>
      )}

      <Modal titulo="Nuevo cliente" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioCliente key={crear.submittedAt || "nuevo"} modulosLicencia={modulosLicencia} onSubmit={(v, accion) => crear.mutate({ body: v, accion })} cargando={crear.isPending} />
      </Modal>
      <Modal titulo="Ver dominios y bases" abierto={!!verArbol} onCerrar={() => setVerArbol(null)}>
        {verArbol && <ArbolCliente cliente={verArbol} />}
      </Modal>
      <Modal titulo="Editar cliente" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && (
          <FormularioCliente
            inicial={editando}
            modulosLicencia={modulosLicencia}
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
  const navigate = useNavigate();
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
      {data?.client && (
        <p><strong>Licencias:</strong> {(data.client.licenseModuleNames ?? []).length > 0 ? data.client.licenseModuleNames?.join(", ") : "Sin licencias registradas"}</p>
      )}
      {data?.domains.map(({ domain, databases }) => (
        <div className="tarjeta tarjeta-compacta" key={domain.id}>
          <h4>{domain.domainName}</h4>
          <p><strong>Dominio para publicar:</strong> {domain.domainName}</p>
          <p><strong>Ambiente:</strong> {ETIQUETAS_AMBIENTE[domain.environment] ?? domain.environment}</p>
          <p><strong>Estado:</strong> <EtiquetaEstado estado={domain.status} /></p>
          <div className="acciones-formulario" style={{ justifyContent: "flex-start", marginTop: 8 }}>
            <button type="button" onClick={() => navigate(`/dominios?edit=${encodeURIComponent(domain.id)}`)}>Editar dominio</button>
            <button type="button" onClick={() => navigate(`/bases-de-datos?clientId=${encodeURIComponent(domain.clientId)}&domainId=${encodeURIComponent(domain.id)}&new=1`)}>Agregar base</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <strong>Empresas / bases</strong>
            {databases.length === 0 ? <p className="texto-ayuda">Sin bases activas asociadas.</p> : (
              <ul>
                {databases.map((db) => (
                  <li key={db.id}>
                    {db.companyName} — {db.dbAccess.initialCatalog} — {ETIQUETAS_AMBIENTE[db.environment] ?? db.environment} — {db.status}
                    {" "}
                    <button type="button" onClick={() => navigate(`/bases-de-datos?edit=${encodeURIComponent(db.id)}`)}>Editar base</button>
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

function FormularioCliente({
  inicial,
  modulosLicencia,
  onSubmit,
  cargando,
}: {
  inicial?: Cliente;
  modulosLicencia: ModuloLicencia[];
  onSubmit: (v: { name: string; notes?: string; licenseModuleIds?: string[] }, accion: AccionCliente) => void;
  cargando: boolean;
}) {
  const [name, setName] = useState(inicial?.name ?? "");
  const [notes, setNotes] = useState(inicial?.notes ?? "");
  const [busquedaLicencia, setBusquedaLicencia] = useState("");
  const [licenseModuleIds, setLicenseModuleIds] = useState<string[]>(inicial?.licenseModuleIds ?? []);
  const [err, setErr] = useState<string | null>(null);
  const modulosVisibles = modulosLicencia.filter((module) => {
    const asignada = licenseModuleIds.includes(module.id);
    if (module.status !== "active" && !asignada) return false;
    if (!busquedaLicencia.trim()) return true;
    return `${module.name} ${module.code ?? ""}`.toLowerCase().includes(busquedaLicencia.trim().toLowerCase());
  });
  function alternarLicencia(id: string) {
    setLicenseModuleIds((actuales) => actuales.includes(id) ? actuales.filter((x) => x !== id) : [...actuales, id]);
  }
  function quitarLicencia(id: string) {
    setLicenseModuleIds((actuales) => actuales.filter((x) => x !== id));
  }
  const modulosSeleccionados = licenseModuleIds
    .map((id) => modulosLicencia.find((module) => module.id === id))
    .filter(Boolean) as ModuloLicencia[];
  function enviar(accion: AccionCliente) {
    if (!name.trim()) { setErr("El nombre es obligatorio."); return; }
    setErr(null);
    onSubmit({ name: name.trim(), notes: notes.trim() || undefined, licenseModuleIds }, accion);
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
      <div className="fila-formulario">
        <label>Licencias del cliente</label>
        <p className="texto-ayuda">Seleccione los módulos que este cliente tiene contratados.</p>
        <input value={busquedaLicencia} onChange={(e) => setBusquedaLicencia(e.target.value)} placeholder="Buscar licencia..." />
        <div className="lista-seleccion" style={{ marginTop: 8, maxHeight: 220 }}>
          {modulosVisibles.map((module) => {
            const inactiva = module.status !== "active";
            return (
              <label key={module.id} className="fila-seleccion">
                <input type="checkbox" checked={licenseModuleIds.includes(module.id)} disabled={inactiva} onChange={() => alternarLicencia(module.id)} />
                <span>
                  <strong>{module.name}</strong>
                  <small>{module.code ?? ""}{inactiva ? " · Inactiva" : ""}</small>
                </span>
              </label>
            );
          })}
          {modulosVisibles.length === 0 && <div className="vacio">No hay licencias activas para seleccionar.</div>}
        </div>
        <div className="seleccion-resumen">
          <strong>Licencias seleccionadas</strong>
          {modulosSeleccionados.length === 0 ? (
            <p className="texto-ayuda">Sin licencias seleccionadas.</p>
          ) : (
            <div className="chips">
              {modulosSeleccionados.map((module) => (
                <span key={module.id} className={`chip ${module.status !== "active" ? "chip-inactivo" : ""}`}>
                  {module.name}{module.status !== "active" ? " (inactiva)" : ""}
                  <button type="button" aria-label={`Quitar ${module.name}`} onClick={() => quitarLicencia(module.id)}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
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
