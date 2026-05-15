import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BaseDeDatos, Cliente, Dominio, Frecuencia, Usuario } from "../types";
import { Alerta, BotonCopiar, EtiquetaEstado, Modal, DialogoConfirmar } from "../components/Comunes";
import { ETIQUETAS_AMBIENTE } from "../types";
import { SeleccionFrecuencia, valoresFrecuenciaPorDefecto, depurarFrecuenciaParaEnvio, type ValoresFrecuencia } from "../components/SeleccionFrecuencia";
import { SelectorBuscable } from "../components/SelectorBuscable";
import { formatDomainForPublishing } from "../utils/dominio";

type AccionDominio = "guardar" | "agregarBase" | "crearNuevo";

export default function DominiosPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Dominio | null>(null);
  const [confirmar, setConfirmar] = useState<{ tipo: "eliminar" | "desactivar"; dominio: Dominio } | null>(null);
  const [verBases, setVerBases] = useState<Dominio | null>(null);
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroAmbiente, setFiltroAmbiente] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: dominios = [], isLoading } = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });
  const { data: frecuencias = [] } = useQuery({ queryKey: ["frecuencias"], queryFn: () => api.get<Frecuencia[]>("/schedules") });
  const { data: usuarios = [] } = useQuery({ queryKey: ["usuarios"], queryFn: () => api.get<Usuario[]>("/users") });

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setModalAbierto(true);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("new");
        return next;
      });
    }
  }, [searchParams, setSearchParams]);

  const crear = useMutation({
    mutationFn: ({ body }: { body: any; accion: AccionDominio }) => api.post<Dominio>("/domains", body),
    onSuccess: (dominio, variables) => {
      qc.invalidateQueries({ queryKey: ["dominios"] });
      qc.invalidateQueries({ queryKey: ["frecuencias"] });
      setExito("Dominio creado correctamente.");
      if (variables.accion === "agregarBase") {
        setModalAbierto(false);
        navigate(`/bases-de-datos?clientId=${encodeURIComponent(dominio.clientId)}&domainId=${encodeURIComponent(dominio.id)}&new=1`);
      } else if (variables.accion === "crearNuevo") {
        setModalAbierto(true);
      } else {
        setModalAbierto(false);
      }
    },
    onError: (e: any) => setError(e?.message ?? "Error al crear dominio."),
  });
  const actualizar = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.put<Dominio>(`/domains/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dominios"] }); qc.invalidateQueries({ queryKey: ["frecuencias"] }); setEditando(null); setExito("Dominio actualizado."); },
    onError: (e: any) => setError(e?.message ?? "Error al actualizar."),
  });
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/domains/${id}/deactivate`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["dominios"] }); setConfirmar(null); setExito("Dominio desactivado."); } });
  const eliminar = useMutation({
    mutationFn: (id: string) => api.del(`/domains/${id}?cascade=true`),
    onSuccess: (_r, id) => {
      qc.setQueryData<Dominio[]>(["dominios"], (actuales = []) => actuales.filter((d) => d.id !== id));
      qc.invalidateQueries({ queryKey: ["dominios"] });
      setConfirmar(null);
      setExito("Dominio eliminado con bases y programaciones asociadas.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar el dominio."),
  });

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
                <td>
                  <div>{d.domainName}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
                    Para publicar: {formatDomainForPublishing(d.domainName)}
                  </div>
                </td>
                <td>{ETIQUETAS_AMBIENTE[d.environment] ?? d.environment}</td>
                <td>{d.currentWebVersion ?? "-"}</td>
                <td><EtiquetaEstado estado={d.status} /></td>
                <td>{d.lastUpdatedAt ? new Date(d.lastUpdatedAt).toLocaleDateString("es-CO") : "-"}</td>
                <td className="acciones-tabla">
                  <button onClick={() => setEditando(d)}>Editar</button>
                  <button onClick={() => setVerBases(d)}>Ver bases asociadas</button>
                  {d.status === "active" && <button className="advertencia" onClick={() => setConfirmar({ tipo: "desactivar", dominio: d })}>Desactivar</button>}
                  <button className="peligro" onClick={() => setConfirmar({ tipo: "eliminar", dominio: d })}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal titulo="Nuevo dominio" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioDominio
          key={crear.submittedAt || searchParams.get("clientId") || "nuevo"}
          clientes={clientes}
          usuarios={usuarios}
          clienteInicialId={searchParams.get("clientId") ?? ""}
          cargando={crear.isPending}
          onSubmit={(v, accion) => crear.mutate({ body: v, accion })}
        />
      </Modal>
      <Modal titulo="Editar dominio" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && <FormularioDominio inicial={editando} frecuenciaInicial={frecuencias.find((f) => f.targetType === "domain" && (f.domainId === editando.id || f.targetIds.includes(editando.id)))} clientes={clientes} usuarios={usuarios} cargando={actualizar.isPending} onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })} />}
      </Modal>
      <Modal titulo="Bases asociadas al dominio" abierto={!!verBases} onCerrar={() => setVerBases(null)}>
        {verBases && <BasesAsociadasDominio dominio={verBases} />}
      </Modal>

      <DialogoConfirmar
        abierto={!!confirmar}
        titulo={confirmar?.tipo === "eliminar" ? "Eliminar dominio" : "Desactivar dominio"}
        mensaje={confirmar?.tipo === "eliminar"
          ? `Está a punto de eliminar el dominio "${confirmar?.dominio.domainName}". Este dominio tiene bases de datos y programaciones asociadas que también se eliminarán. Esta acción no eliminará los registros de auditoría.`
          : `¿Desactivar el dominio "${confirmar?.dominio.domainName}"?`}
        textoConfirmar={confirmar?.tipo === "eliminar" ? "Sí, eliminar todo" : "Desactivar"}
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

function BasesAsociadasDominio({ dominio }: { dominio: Dominio }) {
  const { data: bases = [], isLoading, isError } = useQuery({
    queryKey: ["dominio-bases", dominio.id],
    queryFn: () => api.get<BaseDeDatos[]>(`/domains/${dominio.id}/databases`),
  });
  return (
    <div>
      <p><strong>Dominio:</strong> {dominio.domainName}</p>
      <p><strong>Cliente:</strong> {dominio.clientName}</p>
      <p><strong>Ambiente:</strong> {ETIQUETAS_AMBIENTE[dominio.environment] ?? dominio.environment}</p>
      {isLoading && <div className="cargando">Cargando bases asociadas...</div>}
      {isError && <Alerta tipo="error">No se pudieron cargar las bases asociadas.</Alerta>}
      {!isLoading && bases.length === 0 && <p className="vacio">No hay bases asociadas activas para este dominio.</p>}
      {bases.map((bd) => (
        <div className="tarjeta tarjeta-compacta" key={bd.id}>
          <h4>{bd.companyName}</h4>
          <p><strong>Base de datos:</strong> {bd.dbAccess.initialCatalog}</p>
          <p><strong>Ambiente:</strong> {ETIQUETAS_AMBIENTE[bd.environment] ?? bd.environment}</p>
          <p><strong>Estado:</strong> <EtiquetaEstado estado={bd.status} /></p>
          <p><strong>Servidor y puerto:</strong> <code>{bd.dbAccess.serverHostPort}</code></p>
          <p><strong>Usuario:</strong> <code>{bd.dbAccess.userId}</code></p>
          <p><strong>Contraseña:</strong> ••••••••••••</p>
          <div className="acciones-tabla">
            <BotonCopiar valor={bd.dbAccess.serverHostPort} etiqueta="Copiar servidor y puerto" />
            <BotonCopiar valor={bd.dbAccess.initialCatalog} etiqueta="Copiar base de datos" />
            <BotonCopiar valor={bd.dbAccess.userId} etiqueta="Copiar usuario" />
            <button type="button" disabled title="La contraseña se revela solo desde Ver acceso o detalle de tarea según permisos.">Contraseña oculta</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function valoresDesdeFrecuencia(f?: Frecuencia): ValoresFrecuencia {
  const base = valoresFrecuenciaPorDefecto("domain_updater");
  if (!f) return base;
  return {
    ...base,
    frequencyType: f.frequencyType,
    everyNWeeks: f.everyNWeeks ?? base.everyNWeeks,
    weekdays: f.weekdays ?? base.weekdays,
    intervalDays: f.intervalDays ?? base.intervalDays,
    dayOfMonth: f.dayOfMonth ?? base.dayOfMonth,
    startDate: f.startDate,
    hasEndDate: !!f.endDate,
    endDate: f.endDate ?? null,
    timezone: f.timezone,
    assignedRole: "domain_updater",
    assignedUserIds: f.assignedUserIds ?? [],
    databaseAssignedUserIds: f.databaseAssignedUserIds ?? [],
    databaseReminderRecipientsMode: f.databaseReminderRecipientsMode ?? ((f.databaseAssignedUserIds ?? []).length > 0 ? "assignedUsers" : "roleUsers"),
    active: f.active,
    reminders: f.reminders ?? base.reminders,
  };
}

function FormularioDominio({ inicial, frecuenciaInicial, clienteInicialId = "", clientes, usuarios, onSubmit, cargando }: { inicial?: Dominio; frecuenciaInicial?: Frecuencia; clienteInicialId?: string; clientes: Cliente[]; usuarios: Usuario[]; onSubmit: (v: any, accion: AccionDominio) => void; cargando: boolean }) {
  const [clientId, setClientId] = useState(inicial?.clientId ?? clienteInicialId);
  const [domainName, setDomainName] = useState(inicial?.domainName ?? "");
  const [environment, setEnvironment] = useState(inicial?.environment ?? "production");
  const [currentWebVersion, setCurrentWebVersion] = useState(inicial?.currentWebVersion ?? "");
  const [notes, setNotes] = useState(inicial?.notes ?? "");
  const [crearFrecuencia, setCrearFrecuencia] = useState(!inicial || !!frecuenciaInicial);
  const [frecuencia, setFrecuencia] = useState<ValoresFrecuencia>(valoresDesdeFrecuencia(frecuenciaInicial));
  const [err, setErr] = useState<string | null>(null);
  function enviar(accion: AccionDominio) {
    if (!clientId) return setErr("Seleccione un cliente.");
    if (!domainName.trim()) return setErr("El dominio es obligatorio.");
    setErr(null);
    const body: any = { clientId, domainName: domainName.trim(), environment, currentWebVersion: currentWebVersion || undefined, assignedUpdaterIds: [], notes };
    if (crearFrecuencia) {
      body.frequency = { ...depurarFrecuenciaParaEnvio(frecuencia), assignedRole: "domain_updater", origin: "domain_default" };
    }
    onSubmit(body, accion);
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      enviar("guardar");
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

      <h4>Frecuencia de actualización del dominio</h4>
      <div className="fila-formulario">
        <label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={crearFrecuencia} onChange={(e) => setCrearFrecuencia(e.target.checked)} />
          Activar frecuencia automática para este dominio
        </label>
      </div>
      {crearFrecuencia && (
        <SeleccionFrecuencia valor={frecuencia} onChange={setFrecuencia} rolesPermitidos={["domain_updater"]} usuarios={usuarios} tipoObjetivo="domain" />
      )}
      <p className="texto-ayuda">Las bases de datos asociadas heredarán esta frecuencia. Puedes dejar responsables por rol o asignar personas específicas.</p>

      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
        {!inicial && (
          <>
            <button type="button" onClick={() => enviar("agregarBase")} disabled={cargando}>Guardar y agregar base de datos</button>
            <button type="button" onClick={() => enviar("crearNuevo")} disabled={cargando}>Guardar y crear nuevo dominio</button>
          </>
        )}
      </div>
    </form>
  );
}
