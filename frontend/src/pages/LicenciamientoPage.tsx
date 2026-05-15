import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alerta, DialogoConfirmar, EtiquetaEstado, Modal } from "../components/Comunes";
import type { AsignacionLicencia, BaseDeDatos, Cliente, Dominio, ModuloLicencia, NivelAsignacionLicencia } from "../types";
import { ETIQUETAS_AMBIENTE } from "../types";

type Tab = "modulos" | "asignaciones";
type Estado = "active" | "inactive";

const NIVELES: Array<{ value: NivelAsignacionLicencia; label: string }> = [
  { value: "client", label: "Cliente completo" },
  { value: "domain", label: "Dominio específico" },
  { value: "database", label: "Base de datos específica" },
];

const AMBIENTES_BASE = ["all", "production", "test", "demo"];

function ambienteTexto(value?: string) {
  return ETIQUETAS_AMBIENTE[value ?? "all"] ?? value ?? "Todos";
}

function nivelTexto(value?: NivelAsignacionLicencia) {
  return NIVELES.find((n) => n.value === value)?.label ?? value ?? "";
}

export default function LicenciamientoPage() {
  const qc = useQueryClient();
  const auth = useAuth();
  const roles = auth.cargando ? [] : auth.usuario?.roles ?? [];
  const puedeAdministrarModulos = roles.includes("admin");
  const puedeAdministrarAsignaciones = roles.includes("admin") || roles.includes("client_manager");
  const [tab, setTab] = useState<Tab>("modulos");
  const [modalModulo, setModalModulo] = useState<ModuloLicencia | "nuevo" | null>(null);
  const [modalAsignacion, setModalAsignacion] = useState<AsignacionLicencia | "nuevo" | null>(null);
  const [eliminarModulo, setEliminarModulo] = useState<ModuloLicencia | null>(null);
  const [eliminarAsignacion, setEliminarAsignacion] = useState<AsignacionLicencia | null>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const modulos = useQuery({ queryKey: ["license-modules"], queryFn: () => api.get<ModuloLicencia[]>("/license-modules") });
  const asignaciones = useQuery({ queryKey: ["license-assignments"], queryFn: () => api.get<AsignacionLicencia[]>("/license-assignments") });
  const clientes = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const dominios = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });
  const bases = useQuery({ queryKey: ["bases-de-datos"], queryFn: () => api.get<BaseDeDatos[]>("/databases") });

  const ambientes = useMemo(() => {
    const existentes = [...(dominios.data ?? []).map((d) => d.environment), ...(bases.data ?? []).map((b) => b.environment)].filter(Boolean);
    return Array.from(new Set([...AMBIENTES_BASE, ...existentes]));
  }, [bases.data, dominios.data]);

  const crearModulo = useMutation({
    mutationFn: (body: ModuloPayload) => api.post<ModuloLicencia>("/license-modules", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license-modules"] });
      setModalModulo(null);
      setExito("Módulo creado correctamente.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo guardar el módulo."),
  });
  const actualizarModulo = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<ModuloPayload> }) => api.put<ModuloLicencia>(`/license-modules/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license-modules"] });
      setModalModulo(null);
      setExito("Módulo actualizado.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo actualizar el módulo."),
  });
  const borrarModulo = useMutation({
    mutationFn: (id: string) => api.del(`/license-modules/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license-modules"] });
      setEliminarModulo(null);
      setExito("Módulo eliminado.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar el módulo porque tiene asignaciones asociadas."),
  });

  const crearAsignacion = useMutation({
    mutationFn: (body: AsignacionPayload) => api.post<AsignacionLicencia>("/license-assignments", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license-assignments"] });
      setModalAsignacion(null);
      setExito("Asignación creada correctamente.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo guardar la asignación."),
  });
  const actualizarAsignacion = useMutation({
    mutationFn: ({ id, body }: { id: string; body: AsignacionPayload }) => api.put<AsignacionLicencia>(`/license-assignments/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license-assignments"] });
      setModalAsignacion(null);
      setExito("Asignación actualizada.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo actualizar la asignación."),
  });
  const borrarAsignacion = useMutation({
    mutationFn: (id: string) => api.del(`/license-assignments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license-assignments"] });
      setEliminarAsignacion(null);
      setExito("Asignación eliminada.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar la asignación."),
  });

  function cambiarEstadoModulo(modulo: ModuloLicencia) {
    actualizarModulo.mutate({ id: modulo.id, body: { status: modulo.status === "active" ? "inactive" : "active" } });
  }

  function cambiarEstadoAsignacion(asignacion: AsignacionLicencia) {
    actualizarAsignacion.mutate({
      id: asignacion.id,
      body: asignacionPayloadDesdeRegistro(asignacion, asignacion.status === "active" ? "inactive" : "active"),
    });
  }

  const cargandoDatos = modulos.isLoading || asignaciones.isLoading || clientes.isLoading || dominios.isLoading || bases.isLoading;

  return (
    <>
      <div className="encabezado-pagina">
        <div>
          <h2>Licenciamiento</h2>
          <p className="texto-ayuda">Gestione módulos licenciados y sus asignaciones por cliente, dominio o base de datos.</p>
        </div>
        {tab === "modulos" && puedeAdministrarModulos && (
          <button className="primario" onClick={() => setModalModulo("nuevo")}>Nuevo módulo</button>
        )}
        {tab === "asignaciones" && puedeAdministrarAsignaciones && (
          <button className="primario" onClick={() => setModalAsignacion("nuevo")}>Nueva asignación</button>
        )}
      </div>

      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="pestanas" role="tablist" aria-label="Licenciamiento">
        <button className={tab === "modulos" ? "activo" : ""} role="tab" aria-selected={tab === "modulos"} onClick={() => setTab("modulos")}>Módulos</button>
        <button className={tab === "asignaciones" ? "activo" : ""} role="tab" aria-selected={tab === "asignaciones"} onClick={() => setTab("asignaciones")}>Asignaciones</button>
      </div>

      {cargandoDatos ? <div className="cargando">Cargando licenciamiento...</div> : (
        tab === "modulos" ? (
          <TablaModulos
            modulos={modulos.data ?? []}
            puedeAdministrar={puedeAdministrarModulos}
            onEditar={setModalModulo}
            onCambiarEstado={cambiarEstadoModulo}
            onEliminar={setEliminarModulo}
          />
        ) : (
          <TablaAsignaciones
            asignaciones={asignaciones.data ?? []}
            puedeAdministrar={puedeAdministrarAsignaciones}
            onEditar={setModalAsignacion}
            onCambiarEstado={cambiarEstadoAsignacion}
            onEliminar={setEliminarAsignacion}
          />
        )
      )}

      <Modal titulo={modalModulo === "nuevo" ? "Nuevo módulo" : "Editar módulo"} abierto={!!modalModulo} onCerrar={() => setModalModulo(null)}>
        {modalModulo && (
          <FormularioModulo
            inicial={modalModulo === "nuevo" ? undefined : modalModulo}
            cargando={crearModulo.isPending || actualizarModulo.isPending}
            onSubmit={(body) => {
              setError(null);
              if (modalModulo === "nuevo") crearModulo.mutate(body);
              else actualizarModulo.mutate({ id: modalModulo.id, body });
            }}
          />
        )}
      </Modal>

      <Modal titulo={modalAsignacion === "nuevo" ? "Nueva asignación" : "Editar asignación"} abierto={!!modalAsignacion} onCerrar={() => setModalAsignacion(null)}>
        {modalAsignacion && (
          <FormularioAsignacion
            inicial={modalAsignacion === "nuevo" ? undefined : modalAsignacion}
            modulos={(modulos.data ?? []).filter((m) => m.status === "active")}
            clientes={(clientes.data ?? []).filter((c) => c.status === "active")}
            dominios={(dominios.data ?? []).filter((d) => d.status === "active")}
            bases={(bases.data ?? []).filter((b) => b.status === "active")}
            ambientes={ambientes}
            cargando={crearAsignacion.isPending || actualizarAsignacion.isPending}
            onSubmit={(body) => {
              setError(null);
              if (modalAsignacion === "nuevo") crearAsignacion.mutate(body);
              else actualizarAsignacion.mutate({ id: modalAsignacion.id, body });
            }}
          />
        )}
      </Modal>

      <DialogoConfirmar
        abierto={!!eliminarModulo}
        titulo="Eliminar módulo"
        mensaje={`¿Desea eliminar el módulo "${eliminarModulo?.name}"? Si tiene asignaciones activas, el sistema impedirá la eliminación y mostrará el motivo.`}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => eliminarModulo && borrarModulo.mutate(eliminarModulo.id)}
        onCancelar={() => setEliminarModulo(null)}
      />

      <DialogoConfirmar
        abierto={!!eliminarAsignacion}
        titulo="Eliminar asignación"
        mensaje={`¿Desea eliminar la asignación de "${eliminarAsignacion?.moduleName ?? "este módulo"}"?`}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => eliminarAsignacion && borrarAsignacion.mutate(eliminarAsignacion.id)}
        onCancelar={() => setEliminarAsignacion(null)}
      />
    </>
  );
}

function TablaModulos({
  modulos,
  puedeAdministrar,
  onEditar,
  onCambiarEstado,
  onEliminar,
}: {
  modulos: ModuloLicencia[];
  puedeAdministrar: boolean;
  onEditar: (m: ModuloLicencia) => void;
  onCambiarEstado: (m: ModuloLicencia) => void;
  onEliminar: (m: ModuloLicencia) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Nombre</th>
          <th>Código</th>
          <th>Descripción</th>
          <th>Estado</th>
          <th className="columna-acciones">Acciones</th>
        </tr>
      </thead>
      <tbody>
        {modulos.length === 0 ? (
          <tr><td colSpan={5} className="vacio">No hay módulos registrados.</td></tr>
        ) : modulos.map((modulo) => (
          <tr key={modulo.id}>
            <td>{modulo.name}</td>
            <td>{modulo.code}</td>
            <td>{modulo.description}</td>
            <td><EtiquetaEstado estado={modulo.status} /></td>
            <td className="acciones-tabla">
              <button onClick={() => onEditar(modulo)} disabled={!puedeAdministrar}>Editar</button>
              <button className="advertencia" onClick={() => onCambiarEstado(modulo)} disabled={!puedeAdministrar}>
                {modulo.status === "active" ? "Desactivar" : "Activar"}
              </button>
              <button className="peligro" onClick={() => onEliminar(modulo)} disabled={!puedeAdministrar}>Eliminar</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TablaAsignaciones({
  asignaciones,
  puedeAdministrar,
  onEditar,
  onCambiarEstado,
  onEliminar,
}: {
  asignaciones: AsignacionLicencia[];
  puedeAdministrar: boolean;
  onEditar: (a: AsignacionLicencia) => void;
  onCambiarEstado: (a: AsignacionLicencia) => void;
  onEliminar: (a: AsignacionLicencia) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Módulo</th>
          <th>Nivel</th>
          <th>Cliente</th>
          <th>Dominio / Base</th>
          <th>Ambiente</th>
          <th>Estado</th>
          <th className="columna-acciones">Acciones</th>
        </tr>
      </thead>
      <tbody>
        {asignaciones.length === 0 ? (
          <tr><td colSpan={7} className="vacio">No hay asignaciones registradas.</td></tr>
        ) : asignaciones.map((asignacion) => (
          <tr key={asignacion.id}>
            <td>{asignacion.moduleName ?? asignacion.moduleId}</td>
            <td>{nivelTexto(asignacion.targetType)}</td>
            <td>{asignacion.clientName ?? asignacion.clientId}</td>
            <td>{asignacion.targetType === "client" ? "Cliente completo" : asignacion.targetType === "domain" ? asignacion.domainName : `${asignacion.domainName ?? ""} / ${asignacion.databaseName ?? ""}`}</td>
            <td>{ambienteTexto(asignacion.environment)}</td>
            <td><EtiquetaEstado estado={asignacion.status} /></td>
            <td className="acciones-tabla">
              <button onClick={() => onEditar(asignacion)} disabled={!puedeAdministrar}>Editar</button>
              <button className="advertencia" onClick={() => onCambiarEstado(asignacion)} disabled={!puedeAdministrar}>
                {asignacion.status === "active" ? "Desactivar" : "Activar"}
              </button>
              <button className="peligro" onClick={() => onEliminar(asignacion)} disabled={!puedeAdministrar}>Eliminar</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type ModuloPayload = {
  name: string;
  code: string;
  description?: string;
  status: Estado;
};

function FormularioModulo({ inicial, cargando, onSubmit }: { inicial?: ModuloLicencia; cargando: boolean; onSubmit: (body: ModuloPayload) => void }) {
  const [name, setName] = useState(inicial?.name ?? "");
  const [code, setCode] = useState(inicial?.code ?? "");
  const [description, setDescription] = useState(inicial?.description ?? "");
  const [status, setStatus] = useState<Estado>((inicial?.status as Estado) ?? "active");
  const [error, setError] = useState<string | null>(null);

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("El nombre es obligatorio.");
    if (!code.trim()) return setError("El código es obligatorio.");
    setError(null);
    onSubmit({ name: name.trim(), code: code.trim(), description: description.trim(), status });
  }

  return (
    <form onSubmit={enviar}>
      {error && <Alerta tipo="error">{error}</Alerta>}
      <div className="fila-formulario">
        <label>Nombre *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="fila-formulario">
        <label>Código *</label>
        <input value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      <div className="fila-formulario">
        <label>Descripción</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="fila-formulario">
        <label>Estado</label>
        <select value={status} onChange={(e) => setStatus(e.target.value as Estado)}>
          <option value="active">Activo</option>
          <option value="inactive">Inactivo</option>
        </select>
      </div>
      <div className="acciones-formulario">
        <button className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
      </div>
    </form>
  );
}

type AsignacionPayload = {
  moduleId: string;
  targetType: NivelAsignacionLicencia;
  clientId: string;
  domainId?: string;
  databaseId?: string;
  environment: string;
  status: Estado;
};

function asignacionPayloadDesdeRegistro(asignacion: AsignacionLicencia, status: Estado = asignacion.status as Estado): AsignacionPayload {
  return {
    moduleId: asignacion.moduleId,
    targetType: asignacion.targetType,
    clientId: asignacion.clientId,
    domainId: asignacion.domainId,
    databaseId: asignacion.databaseId,
    environment: asignacion.environment ?? "all",
    status,
  };
}

function FormularioAsignacion({
  inicial,
  modulos,
  clientes,
  dominios,
  bases,
  ambientes,
  cargando,
  onSubmit,
}: {
  inicial?: AsignacionLicencia;
  modulos: ModuloLicencia[];
  clientes: Cliente[];
  dominios: Dominio[];
  bases: BaseDeDatos[];
  ambientes: string[];
  cargando: boolean;
  onSubmit: (body: AsignacionPayload) => void;
}) {
  const [moduleId, setModuleId] = useState(inicial?.moduleId ?? "");
  const [targetType, setTargetType] = useState<NivelAsignacionLicencia>(inicial?.targetType ?? "client");
  const [clientId, setClientId] = useState(inicial?.clientId ?? "");
  const [domainId, setDomainId] = useState(inicial?.domainId ?? "");
  const [databaseId, setDatabaseId] = useState(inicial?.databaseId ?? "");
  const [environment, setEnvironment] = useState(inicial?.environment ?? "all");
  const [status, setStatus] = useState<Estado>((inicial?.status as Estado) ?? "active");
  const [error, setError] = useState<string | null>(null);

  const dominiosFiltrados = dominios.filter((d) => d.clientId === clientId);
  const basesFiltradas = bases.filter((b) => b.clientId === clientId && b.domainId === domainId);

  function cambiarNivel(nivel: NivelAsignacionLicencia) {
    setTargetType(nivel);
    if (nivel === "client") {
      setDomainId("");
      setDatabaseId("");
    }
    if (nivel === "domain") {
      setDatabaseId("");
    }
  }

  function cambiarCliente(id: string) {
    setClientId(id);
    setDomainId("");
    setDatabaseId("");
  }

  function cambiarDominio(id: string) {
    setDomainId(id);
    setDatabaseId("");
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!moduleId) return setError("Seleccione un módulo.");
    if (!clientId) return setError("Seleccione un cliente.");
    if ((targetType === "domain" || targetType === "database") && !domainId) return setError("Seleccione un dominio.");
    if (targetType === "database" && !databaseId) return setError("Seleccione una base de datos.");
    setError(null);
    onSubmit({
      moduleId,
      targetType,
      clientId,
      domainId: targetType === "client" ? undefined : domainId,
      databaseId: targetType === "database" ? databaseId : undefined,
      environment,
      status,
    });
  }

  return (
    <form onSubmit={enviar}>
      {error && <Alerta tipo="error">{error}</Alerta>}
      <div className="fila-formulario">
        <label>Módulo *</label>
        <select value={moduleId} onChange={(e) => setModuleId(e.target.value)} required>
          <option value="">Seleccione un módulo</option>
          {modulos.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <div className="fila-formulario">
        <label>Nivel de asignación *</label>
        <select value={targetType} onChange={(e) => cambiarNivel(e.target.value as NivelAsignacionLicencia)}>
          {NIVELES.map((nivel) => <option key={nivel.value} value={nivel.value}>{nivel.label}</option>)}
        </select>
      </div>
      <div className="fila-formulario">
        <label>Cliente *</label>
        <select value={clientId} onChange={(e) => cambiarCliente(e.target.value)} required>
          <option value="">Seleccione un cliente</option>
          {clientes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {(targetType === "domain" || targetType === "database") && (
        <div className="fila-formulario">
          <label>Dominio *</label>
          <select value={domainId} onChange={(e) => cambiarDominio(e.target.value)} required>
            <option value="">Seleccione un dominio</option>
            {dominiosFiltrados.map((d) => <option key={d.id} value={d.id}>{d.domainName} · {ambienteTexto(d.environment)}</option>)}
          </select>
        </div>
      )}
      {targetType === "database" && (
        <div className="fila-formulario">
          <label>Base de datos *</label>
          <select value={databaseId} onChange={(e) => setDatabaseId(e.target.value)} required>
            <option value="">Seleccione una base de datos</option>
            {basesFiltradas.map((b) => <option key={b.id} value={b.id}>{b.companyName} · {b.dbAccess.initialCatalog} · {ambienteTexto(b.environment)}</option>)}
          </select>
        </div>
      )}
      <div className="fila-formulario">
        <label>Ambiente</label>
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          {ambientes.map((ambiente) => <option key={ambiente} value={ambiente}>{ambienteTexto(ambiente)}</option>)}
        </select>
      </div>
      <div className="fila-formulario">
        <label>Estado</label>
        <select value={status} onChange={(e) => setStatus(e.target.value as Estado)}>
          <option value="active">Activo</option>
          <option value="inactive">Inactivo</option>
        </select>
      </div>
      <div className="acciones-formulario">
        <button className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
      </div>
    </form>
  );
}
