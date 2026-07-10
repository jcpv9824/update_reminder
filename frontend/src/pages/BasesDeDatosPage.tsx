import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BaseDeDatos, Cliente, Dominio, Frecuencia, RespuestaPaginada } from "../types";
import { Alerta, EtiquetaEstado, Modal, DialogoConfirmar, Paginacion } from "../components/Comunes";
import { AccesoBdParseado } from "../components/AccesoBdParseado";
import { PanelAccesoBd } from "../components/PanelAccesoBd";
import { AMBIENTES_OPERATIVOS, ETIQUETAS_AMBIENTE } from "../types";
import { SelectorBuscable } from "../components/SelectorBuscable";

type AccionBd = "guardar" | "crearNueva";

export default function BasesDeDatosPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<BaseDeDatos | null>(null);
  const [verAcceso, setVerAcceso] = useState<BaseDeDatos | null>(null);
  const [confirmar, setConfirmar] = useState<{ tipo: "eliminar" | "desactivar"; bd: BaseDeDatos } | null>(null);
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroDominio, setFiltroDominio] = useState("");
  const [filtroAmbiente, setFiltroAmbiente] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: dominios = [] } = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });
  const { data: paginaBds, isLoading } = useQuery({
    queryKey: ["bases-de-datos", "pagina", pagina, filtroCliente, filtroDominio, filtroAmbiente, filtroEstado, busqueda],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(pagina), pageSize: "10" });
      if (filtroCliente) params.set("clientId", filtroCliente);
      if (filtroDominio) params.set("domainId", filtroDominio);
      if (filtroAmbiente) params.set("environment", filtroAmbiente);
      if (filtroEstado) params.set("status", filtroEstado);
      if (busqueda) params.set("search", busqueda);
      return api.get<RespuestaPaginada<BaseDeDatos>>(`/databases?${params.toString()}`);
    },
  });
  const { data: frecuencias = [] } = useQuery({ queryKey: ["frecuencias"], queryFn: () => api.get<Frecuencia[]>("/schedules") });

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

  useEffect(() => {
    const editId = searchParams.get("edit");
    if (!editId) return;
    let cancelado = false;
    api.get<BaseDeDatos>(`/databases/${editId}`)
      .then((bd) => { if (!cancelado) setEditando(bd); })
      .catch((e: any) => setError(e?.message ?? "No se pudo cargar la base de datos."))
      .finally(() => {
        if (!cancelado) {
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("edit");
            return next;
          });
        }
      });
    return () => { cancelado = true; };
  }, [searchParams, setSearchParams]);

  const crear = useMutation({
    mutationFn: ({ body }: { body: any; accion: AccionBd }) => api.post<BaseDeDatos>("/databases", body),
    onSuccess: (_bd, variables) => {
      qc.invalidateQueries({ queryKey: ["bases-de-datos"] });
      setExito("Base de datos creada correctamente.");
      if (variables.accion === "crearNueva") {
        setSearchParams({ clientId: variables.body.clientId, domainId: variables.body.domainId });
        setModalAbierto(true);
      } else {
        setModalAbierto(false);
      }
    },
    onError: (e: any) => setError(e?.message ?? "Error al crear la base de datos."),
  });
  const actualizar = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.put<BaseDeDatos>(`/databases/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bases-de-datos"] });
      setEditando(null);
      setExito("Base de datos actualizada correctamente.");
    },
    onError: (e: any) => setError(e?.message ?? "Error al actualizar la base de datos."),
  });
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/databases/${id}/deactivate`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["bases-de-datos"] }); setConfirmar(null); setExito("Base de datos desactivada."); } });
  const eliminar = useMutation({
    mutationFn: (id: string) => api.del(`/databases/${id}?cascade=true`),
    onSuccess: (_r, id) => {
      qc.setQueryData<BaseDeDatos[]>(["bases-de-datos"], (actuales = []) => actuales.filter((b) => b.id !== id));
      qc.invalidateQueries({ queryKey: ["bases-de-datos"] });
      setConfirmar(null);
      setExito("Base de datos eliminada con sus programaciones asociadas.");
    },
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar la base de datos."),
  });

  const filtradas = Array.isArray(paginaBds) ? paginaBds : paginaBds?.items ?? [];
  const infoPagina = !Array.isArray(paginaBds) ? paginaBds : undefined;

  useEffect(() => { setPagina(1); }, [filtroCliente, filtroDominio, filtroAmbiente, filtroEstado, busqueda]);

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
          <SelectorBuscable
            opciones={clientes.map((c) => ({ id: c.id, etiqueta: c.name }))}
            valor={filtroCliente}
            onChange={setFiltroCliente}
            permiteVacio
            textoVacio="Todos los clientes"
            placeholder="Buscar cliente..."
          /></div>
        <div className="campo"><label>Dominio</label>
          <SelectorBuscable
            opciones={dominios.map((d) => ({ id: d.id, etiqueta: d.domainName, subtitulo: d.clientName }))}
            valor={filtroDominio}
            onChange={setFiltroDominio}
            permiteVacio
            textoVacio="Todos los dominios"
            placeholder="Buscar dominio..."
          /></div>
        <div className="campo"><label>Ambiente</label>
          <select value={filtroAmbiente} onChange={(e) => setFiltroAmbiente(e.target.value)}>
            <option value="">Todos</option>
            {AMBIENTES_OPERATIVOS.map((k) => <option key={k} value={k}>{ETIQUETAS_AMBIENTE[k]}</option>)}
          </select></div>
        <div className="campo"><label>Estado</label>
          <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
            <option value="">Todos</option>
            <option value="active">Activo</option>
            <option value="inactive">Inactivo</option>
            <option value="deleted">Eliminado</option>
          </select></div>
        <div className="campo"><label>Buscar empresa/base/servidor</label>
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} /></div>
      </div>

      {isLoading ? <div className="cargando">Cargando...</div> : (
        <>
        <table>
          <thead><tr>
            <th>Cliente</th><th>Dominio</th><th>Empresa</th><th>Base de datos</th><th>Ambiente</th><th>Estado</th><th>Última actualización</th><th>Acciones</th>
          </tr></thead>
          <tbody>
            {filtradas.length === 0 ? (<tr><td colSpan={8} className="vacio">No hay bases de datos para mostrar.</td></tr>) :
            filtradas.map((b) => (
              <tr key={b.id}>
                <td>{b.clientName}</td>
                <td>{b.domainName}</td>
                <td>{b.companyName}</td>
                <td>{b.dbAccess.initialCatalog}</td>
                <td>{ETIQUETAS_AMBIENTE[b.environment] ?? b.environment}</td>
                <td><EtiquetaEstado estado={b.status} /></td>
                <td>{b.lastUpdatedAt ? new Date(b.lastUpdatedAt).toLocaleDateString("es-CO") : "-"}</td>
                <td className="acciones-tabla">
                  <button onClick={() => setEditando(b)}>Editar</button>
                  <button onClick={() => setVerAcceso(b)}>Ver acceso</button>
                  {b.status === "active" && <button className="advertencia" onClick={() => setConfirmar({ tipo: "desactivar", bd: b })}>Desactivar</button>}
                  <button className="peligro" onClick={() => setConfirmar({ tipo: "eliminar", bd: b })}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {infoPagina && <Paginacion page={infoPagina.page} pageSize={infoPagina.pageSize} total={infoPagina.total} onPageChange={setPagina} />}
        </>
      )}

      <Modal titulo="Nueva base de datos" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioBd
          key={crear.submittedAt || `${searchParams.get("clientId") ?? ""}-${searchParams.get("domainId") ?? ""}`}
          clienteInicialId={searchParams.get("clientId") ?? ""}
          dominioInicialId={searchParams.get("domainId") ?? ""}
          clientes={clientes}
          dominios={dominios}
          frecuencias={frecuencias}
          cargando={crear.isPending}
          onSubmit={(v, accion) => crear.mutate({ body: v, accion })}
        />
      </Modal>

      <Modal titulo={`Editar base de datos${editando ? `: ${editando.companyName}` : ""}`} abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && (
          <FormularioBd
            inicial={editando}
            clientes={clientes}
            dominios={dominios}
            frecuencias={frecuencias}
            cargando={actualizar.isPending}
            onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })}
          />
        )}
      </Modal>

      <Modal titulo={`Acceso: ${verAcceso?.companyName ?? ""}`} abierto={!!verAcceso} onCerrar={() => setVerAcceso(null)}>
        {verAcceso && <PanelAccesoBd bd={verAcceso} />}
      </Modal>

      <DialogoConfirmar
        abierto={!!confirmar}
        titulo={confirmar?.tipo === "eliminar" ? "Eliminar base de datos" : "Desactivar base de datos"}
        mensaje={confirmar?.tipo === "eliminar"
          ? `Está a punto de eliminar la base de datos "${confirmar?.bd.companyName} / ${confirmar?.bd.dbAccess.initialCatalog}". Esta base tiene ${frecuencias.filter((f) => f.targetIds.includes(confirmar?.bd.id ?? "")).length} programación(es) asociada(s). Si continúa, se eliminarán también sus programaciones asociadas. Esta acción no eliminará auditoría.`
          : `¿Desactivar la base de datos "${confirmar?.bd.companyName}"?`}
        textoConfirmar={confirmar?.tipo === "eliminar" ? "Sí, eliminar todo" : "Desactivar"}
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

function FormularioBd({ inicial, clientes, dominios, frecuencias, clienteInicialId = "", dominioInicialId = "", onSubmit, cargando }: { inicial?: BaseDeDatos; clientes: Cliente[]; dominios: Dominio[]; frecuencias: Frecuencia[]; clienteInicialId?: string; dominioInicialId?: string; onSubmit: (v: any, accion: AccionBd) => void; cargando: boolean }) {
  const editando = !!inicial;
  const [clientId, setClientId] = useState(inicial?.clientId ?? clienteInicialId);
  const [domainId, setDomainId] = useState(inicial?.domainId ?? dominioInicialId);
  const [companyName, setCompanyName] = useState(inicial?.companyName ?? "");
  const [environment, setEnvironment] = useState(inicial?.environment ?? "production");
  const [rawDbAccess, setRawDbAccess] = useState("");
  const [cambiarAcceso, setCambiarAcceso] = useState(false);
  const [currentDbVersion, setCurrentDbVersion] = useState(inicial?.currentDbVersion ?? "");
  const [notes, setNotes] = useState(inicial?.notes ?? "");
  const [err, setErr] = useState<string | null>(null);

  const dominiosFiltrados = useMemo(() => dominios.filter((d) => d.clientId === clientId && d.status === "active"), [dominios, clientId]);
  function enviar(accion: AccionBd) {
    if (!clientId) return setErr("Seleccione el cliente.");
    if (!domainId) return setErr("Seleccione el dominio.");
    if (!companyName.trim()) return setErr("El nombre de la empresa es obligatorio.");
    // Al crear, la cadena de acceso es obligatoria. Al editar, solo si el
    // usuario decidió cambiarla.
    if (!editando && !rawDbAccess.trim()) return setErr("La cadena de acceso es obligatoria.");
    if (editando && cambiarAcceso && !rawDbAccess.trim()) return setErr("Escriba la nueva cadena de acceso o cancele el cambio.");
    setErr(null);
    const body: any = {
      clientId,
      domainId,
      companyName: companyName.trim(),
      environment,
      currentDbVersion: currentDbVersion || undefined,
      notes,
    };
    if (!editando) {
      body.rawDbAccess = rawDbAccess;
    } else if (cambiarAcceso && rawDbAccess.trim()) {
      // Solo se manda si el admin decidió reemplazar la cadena de conexión.
      body.rawDbAccess = rawDbAccess;
    }
    onSubmit(body, accion);
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      enviar("guardar");
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      <div className="fila-formulario"><label>Cliente *</label>
        <SelectorBuscable
          opciones={clientes.filter((c) => c.status === "active").map((c) => ({ id: c.id, etiqueta: c.name }))}
          valor={clientId}
          onChange={(id) => { setClientId(id); if (!editando) setDomainId(""); }}
          placeholder="Buscar cliente..."
          disabled={editando}
        /></div>
      <div className="fila-formulario"><label>Dominio *</label>
        <SelectorBuscable
          opciones={dominiosFiltrados.map((d) => ({ id: d.id, etiqueta: d.domainName }))}
          valor={domainId}
          onChange={setDomainId}
          disabled={!clientId || editando}
          placeholder={clientId ? "Buscar dominio..." : "Seleccione un cliente primero"}
        /></div>
      <div className="fila-formulario"><label>Nombre de la empresa *</label>
        <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></div>
      <div className="fila-formulario"><label>Ambiente *</label>
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          {AMBIENTES_OPERATIVOS.map((k) => <option key={k} value={k}>{ETIQUETAS_AMBIENTE[k]}</option>)}
        </select></div>
      <div className="fila-formulario"><label>Versión actual de la base de datos</label>
        <input value={currentDbVersion} onChange={(e) => setCurrentDbVersion(e.target.value)} /></div>
      {!editando && (
        <div className="fila-formulario">
          <label>Cadena de acceso a la base de datos *</label>
          <textarea rows={3} value={rawDbAccess} onChange={(e) => setRawDbAccess(e.target.value)}
            placeholder="data12.sagerp.co,54101; Initial Catalog = LA-COCINA-DE-LA-CASA; User ID = ATYNCONSULS-INS01; Password = ejemplo;" />
          <div style={{ marginTop: 8 }}><AccesoBdParseado texto={rawDbAccess} /></div>
        </div>
      )}

      {editando && (
        <div className="fila-formulario">
          <label>Acceso a la base de datos</label>
          <p className="texto-ayuda" style={{ marginBottom: 6 }}>
            Base / Initial Catalog: <code>{inicial!.dbAccess.initialCatalog}</code><br />
            Servidor, usuario y contraseña se consultan únicamente desde la acción <strong>Ver acceso</strong>.
          </p>
          {!cambiarAcceso ? (
            <button type="button" onClick={() => setCambiarAcceso(true)}>
              Cambiar cadena de acceso
            </button>
          ) : (
            <>
              <textarea
                rows={3}
                value={rawDbAccess}
                onChange={(e) => setRawDbAccess(e.target.value)}
                placeholder="data12.sagerp.co,54101; Initial Catalog = ...; User ID = ...; Password = ...;"
              />
              <p className="texto-ayuda" style={{ marginTop: 4 }}>
                Si deja este campo vacío al guardar, se conservará la cadena actual.
              </p>
              {rawDbAccess.trim() && (
                <div style={{ marginTop: 8 }}><AccesoBdParseado texto={rawDbAccess} /></div>
              )}
              <button type="button" style={{ marginTop: 6 }} onClick={() => { setCambiarAcceso(false); setRawDbAccess(""); }}>
                Descartar nueva cadena
              </button>
            </>
          )}
        </div>
      )}
      <div className="fila-formulario"><label>Notas</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

      <h4>Programación de actualizaciones</h4>
      <Alerta tipo="info">
        Las tareas de esta base de datos se generan desde <strong>Programar Actualizaciones</strong>. Allí puede seleccionarla de forma puntual o incluir todas las bases activas de su dominio.
      </Alerta>

      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
        {!editando && (
          <button type="button" onClick={() => enviar("crearNueva")} disabled={cargando}>Guardar y crear nueva base de datos</button>
        )}
      </div>
    </form>
  );
}
