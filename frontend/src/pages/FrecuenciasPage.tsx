import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { BaseDeDatos, Cliente, Dominio, Frecuencia, ModuloLicencia, RespuestaPaginada, Usuario } from "../types";
import { Alerta, EtiquetaEstado, Modal, DialogoConfirmar, Paginacion } from "../components/Comunes";
import { DIAS_SEMANA, ETIQUETAS_AMBIENTE, ETIQUETAS_FRECUENCIA, ETIQUETAS_ROLES } from "../types";
import { SelectorBuscable } from "../components/SelectorBuscable";

const DIAS_LISTA = Object.keys(DIAS_SEMANA);

export default function FrecuenciasPage() {
  const qc = useQueryClient();
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState<Frecuencia | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: clientes = [] } = useQuery({ queryKey: ["clientes"], queryFn: () => api.get<Cliente[]>("/clients") });
  const { data: dominios = [] } = useQuery({ queryKey: ["dominios"], queryFn: () => api.get<Dominio[]>("/domains") });
  const { data: bds = [] } = useQuery({ queryKey: ["bases-de-datos"], queryFn: () => api.get<BaseDeDatos[]>("/databases") });
  const { data: usuarios = [] } = useQuery({ queryKey: ["usuarios"], queryFn: () => api.get<Usuario[]>("/users") });
  const { data: modulosLicencia = [] } = useQuery({ queryKey: ["license-modules"], queryFn: () => api.get<ModuloLicencia[]>("/license-modules") });
  const { data: paginaFrecuencias, isLoading } = useQuery({
    queryKey: ["frecuencias", "special", pagina, busqueda],
    queryFn: () => {
      const params = new URLSearchParams({ origin: "special", page: String(pagina), pageSize: "10" });
      if (busqueda) params.set("search", busqueda);
      return api.get<RespuestaPaginada<Frecuencia>>(`/schedules?${params.toString()}`);
    },
  });
  const frecuenciasItems = Array.isArray(paginaFrecuencias) ? paginaFrecuencias : paginaFrecuencias?.items ?? [];
  const frecuenciasPage = !Array.isArray(paginaFrecuencias) ? paginaFrecuencias : undefined;
  const programacionesEspeciales = useMemo(() => frecuenciasItems.filter((f) => f.origin === "special"), [frecuenciasItems]);

  const crear = useMutation({
    mutationFn: (body: any) => api.post<Frecuencia>("/schedules", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["frecuencias"] }); setModalAbierto(false); setExito("Programación especial creada correctamente."); },
    onError: (e: any) => setError(e?.message ?? "Error al crear la programación especial."),
  });
  const actualizar = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.put<Frecuencia>(`/schedules/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["frecuencias"] }); setEditando(null); setExito("Programación especial actualizada correctamente."); },
    onError: (e: any) => setError(e?.message ?? "Error al actualizar la programación especial."),
  });
  const desactivar = useMutation({ mutationFn: (id: string) => api.post(`/schedules/${id}/deactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["frecuencias"] }) });
  const reactivar = useMutation({ mutationFn: (id: string) => api.post(`/schedules/${id}/reactivate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["frecuencias"] }) });
  const eliminar = useMutation({
    mutationFn: (id: string) => api.del(`/schedules/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["frecuencias"] }); setExito("Programación especial eliminada."); setConfirmarEliminar(null); },
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar."),
  });
  const [confirmarEliminar, setConfirmarEliminar] = useState<Frecuencia | null>(null);
  useEffect(() => { setPagina(1); }, [busqueda]);

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Programaciones especiales</h2>
        <button className="primario" onClick={() => setModalAbierto(true)}>Nueva programación especial</button>
      </div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}
      <p className="texto-ayuda">
        Esta vista es para programaciones excepcionales o manuales. La frecuencia normal de actualización se configura desde cada dominio y se hereda automáticamente por sus bases de datos.
      </p>
      <div className="barra-filtros">
        <div className="campo">
          <label>Buscar</label>
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar..." />
        </div>
      </div>

      {isLoading ? <div className="cargando">Cargando...</div> : (
        <>
          <table>
            <thead><tr>
              <th>Cliente</th><th>Tipo</th><th>Objetivos</th><th>Frecuencia</th><th>Inicio</th><th>Fin</th><th>Responsable inferido</th><th>Estado</th><th>Acciones</th>
            </tr></thead>
            <tbody>
              {programacionesEspeciales.length === 0 ? (
                <tr>
                  <td colSpan={9} className="vacio">
                    <div>No hay programaciones especiales configuradas.</div>
                    <div>Para configurar la frecuencia normal de un dominio, ve a Dominios y edita la frecuencia del dominio.</div>
                  </td>
                </tr>
              ) :
              programacionesEspeciales.map((f) => (
                <tr key={f.id}>
                  <td>{f.clientName}</td>
                  <td>{f.targetType === "database" ? "Base de datos" : "Dominio"}</td>
                  <td>{f.targetIds.length}</td>
                  <td>{ETIQUETAS_FRECUENCIA[f.frequencyType]}</td>
                  <td>{f.startDate}</td>
                  <td>{f.endDate ?? "-"}</td>
                  <td>{ETIQUETAS_ROLES[f.assignedRole] ?? f.assignedRole}</td>
                  <td><EtiquetaEstado estado={f.active ? "active" : "inactive"} /></td>
                  <td className="acciones-tabla">
                    <button onClick={() => setEditando(f)}>Editar</button>
                    {f.active
                      ? <button className="advertencia" onClick={() => desactivar.mutate(f.id)}>Desactivar</button>
                      : <button className="exito" onClick={() => reactivar.mutate(f.id)}>Reactivar</button>}
                    <button className="peligro" onClick={() => setConfirmarEliminar(f)}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {frecuenciasPage && <Paginacion page={frecuenciasPage.page} pageSize={frecuenciasPage.pageSize} total={frecuenciasPage.total} onPageChange={setPagina} />}
        </>
      )}

      <Modal titulo="Nueva programación especial" abierto={modalAbierto} onCerrar={() => setModalAbierto(false)}>
        <FormularioFrecuencia clientes={clientes} dominios={dominios} bds={bds} usuarios={usuarios} modulosLicencia={modulosLicencia} cargando={crear.isPending} onSubmit={(v) => crear.mutate(v)} />
      </Modal>
      <Modal titulo="Editar programación especial" abierto={!!editando} onCerrar={() => setEditando(null)}>
        {editando && <FormularioFrecuencia inicial={editando} clientes={clientes} dominios={dominios} bds={bds} usuarios={usuarios} modulosLicencia={modulosLicencia} cargando={actualizar.isPending} onSubmit={(v) => actualizar.mutate({ id: editando.id, body: v })} />}
      </Modal>

      <DialogoConfirmar
        abierto={!!confirmarEliminar}
        titulo="Eliminar programación especial"
        mensaje={confirmarEliminar
          ? `¿Eliminar la programación especial para ${confirmarEliminar.clientName}? Esta acción no se puede deshacer.`
          : ""}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => confirmarEliminar && eliminar.mutate(confirmarEliminar.id)}
        onCancelar={() => setConfirmarEliminar(null)}
      />
    </>
  );
}

type ScopeGroup = NonNullable<Frecuencia["scopeGroups"]>[number];
type LicensingScope = NonNullable<Frecuencia["licensingScope"]>;
type LicensingPreview = {
  clientsCount: number;
  domainsCount: number;
  databasesCount: number;
  groups: Array<{
    client: { id: string; name: string; licenses: string[] };
    domains: Array<{
      id: string;
      name: string;
      environment: string;
      databases: Array<{ id: string; companyName: string; databaseName: string; environment: string }>;
    }>;
  }>;
};

function FormularioFrecuencia({ inicial, clientes, dominios, bds, usuarios, modulosLicencia, onSubmit, cargando }: { inicial?: Frecuencia; clientes: Cliente[]; dominios: Dominio[]; bds: BaseDeDatos[]; usuarios: Usuario[]; modulosLicencia: ModuloLicencia[]; onSubmit: (v: any) => void; cargando: boolean }) {
  const [selectionMode, setSelectionMode] = useState<"manual" | "licensing">(inicial?.selectionMode ?? "manual");
  const [scopeGroups, setScopeGroups] = useState<ScopeGroup[]>(inicial?.scopeGroups ?? []);
  const [licenseModuleIds, setLicenseModuleIds] = useState<string[]>(inicial?.licensingScope?.licenseModuleIds ?? []);
  const [licenseMatchMode, setLicenseMatchMode] = useState<"any" | "all">(inicial?.licensingScope?.licenseMatchMode ?? "any");
  const [licenseEnvironment, setLicenseEnvironment] = useState(inicial?.licensingScope?.environment ?? "all");
  const [licenseTargetTypes, setLicenseTargetTypes] = useState<LicensingScope["targetTypes"]>(inicial?.licensingScope?.targetTypes ?? "domains_and_databases");
  const [licenseSearch, setLicenseSearch] = useState("");
  const [preview, setPreview] = useState<LicensingPreview | null>(null);
  const [clienteAAgregar, setClienteAAgregar] = useState("");
  const [selectorDominios, setSelectorDominios] = useState<{ clientId: string } | null>(null);
  const [selectorBases, setSelectorBases] = useState<{ clientId: string; domainId: string } | null>(null);
  const [assignmentMode, setAssignmentMode] = useState<"role" | "users">(inicial?.assignmentMode ?? ((inicial?.assignedUserIds?.length || inicial?.databaseAssignedUserIds?.length) ? "users" : "role"));
  const [domainUsers, setDomainUsers] = useState<string[]>(inicial?.assignedUserIds ?? []);
  const [databaseUsers, setDatabaseUsers] = useState<string[]>(inicial?.databaseAssignedUserIds ?? []);
  const [frequencyType, setFrequencyType] = useState<"weekly" | "interval" | "monthly" | "manual">(inicial?.frequencyType ?? "weekly");
  const [everyNWeeks, setEveryNWeeks] = useState(inicial?.everyNWeeks ?? 1);
  const [weekdays, setWeekdays] = useState<string[]>(inicial?.weekdays ?? ["FRIDAY"]);
  const [intervalDays, setIntervalDays] = useState(inicial?.intervalDays ?? 15);
  const [dayOfMonth, setDayOfMonth] = useState(inicial?.dayOfMonth ?? 15);
  const [startDate, setStartDate] = useState(inicial?.startDate ?? new Date().toISOString().slice(0, 10));
  const [hasEndDate, setHasEndDate] = useState(!!inicial?.endDate);
  const [endDate, setEndDate] = useState(inicial?.endDate ?? "");
  const [active, setActive] = useState(inicial?.active ?? true);
  const [err, setErr] = useState<string | null>(null);

  const previewLicencias = useMutation({
    mutationFn: (body: LicensingScope) => api.post<LicensingPreview>("/special-schedules/preview-licensing-scope", body),
    onSuccess: (data) => { setPreview(data); setErr(null); },
    onError: (e: any) => setErr(e?.message ?? "No se pudo previsualizar el alcance por licenciamiento."),
  });

  const resumen = useMemo(() => {
    let domainsCount = 0;
    let dbsCount = 0;
    for (const group of scopeGroups) {
      const groupDomains = group.includeAllDomains
        ? dominios.filter((d) => d.clientId === group.clientId && d.status === "active")
        : group.domains.map((d) => dominios.find((x) => x.id === d.domainId)).filter(Boolean) as Dominio[];
      domainsCount += groupDomains.length;
      for (const domain of groupDomains) {
        const config = group.domains.find((d) => d.domainId === domain.id);
        dbsCount += (group.includeAllDomains || config?.includeAllDatabases)
          ? bds.filter((db) => db.domainId === domain.id && db.status === "active").length
          : (config?.databaseIds.length ?? 0);
      }
    }
    return { clientes: scopeGroups.length, dominios: domainsCount, bases: dbsCount };
  }, [scopeGroups, dominios, bds]);

  function alternarDia(d: string) {
    setWeekdays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]));
  }
  function licensingScope(): LicensingScope {
    return { licenseModuleIds, licenseMatchMode, environment: licenseEnvironment, targetTypes: licenseTargetTypes, activeOnly: true };
  }
  function alternarLicencia(id: string) {
    setLicenseModuleIds((actuales) => actuales.includes(id) ? actuales.filter((x) => x !== id) : [...actuales, id]);
    setPreview(null);
  }
  const modulosActivos = modulosLicencia.filter((m) => m.status === "active" && (!licenseSearch.trim() || `${m.name} ${m.code ?? ""}`.toLowerCase().includes(licenseSearch.trim().toLowerCase())));
  const licenciasSeleccionadas = licenseModuleIds
    .map((id) => modulosLicencia.find((module) => module.id === id))
    .filter(Boolean) as ModuloLicencia[];

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (selectionMode === "manual" && (scopeGroups.length === 0 || (resumen.dominios === 0 && resumen.bases === 0))) return setErr("Agregue al menos un cliente, dominio o base al alcance.");
      if (selectionMode === "licensing" && licenseModuleIds.length === 0) return setErr("Seleccione al menos una licencia.");
      if (selectionMode === "licensing" && !preview) return setErr("Previsualice el alcance antes de guardar.");
      if (selectionMode === "licensing" && preview && preview.clientsCount === 0) return setErr("No se encontraron clientes activos con las licencias y filtros seleccionados.");
      if (assignmentMode === "users" && domainUsers.length === 0 && databaseUsers.length === 0) return setErr("Seleccione responsables o cambie a asignación por rol.");
      onSubmit({
        clientId: selectionMode === "licensing" ? (preview?.groups[0]?.client.id ?? clientes.find((c) => c.status === "active")?.id ?? "") : scopeGroups[0].clientId,
        targetType: "domain",
        targetIds: [],
        scopeGroups: selectionMode === "manual" ? scopeGroups : [],
        selectionMode,
        licensingScope: selectionMode === "licensing" ? licensingScope() : undefined,
        assignmentMode,
        domainAssignedRole: "domain_updater",
        databaseAssignedRole: "database_updater",
        frequencyType,
        everyNWeeks: frequencyType === "weekly" ? everyNWeeks : undefined,
        weekdays: frequencyType === "weekly" ? weekdays : undefined,
        intervalDays: frequencyType === "interval" ? intervalDays : undefined,
        dayOfMonth: frequencyType === "monthly" ? dayOfMonth : undefined,
        startDate, endDate: hasEndDate ? endDate || null : null, timezone: "America/Bogota",
        assignedRole: "domain_updater",
        assignedUserIds: assignmentMode === "users" ? domainUsers : [],
        databaseAssignedUserIds: assignmentMode === "users" ? databaseUsers : [],
        origin: "special", active,
      });
    }}>
      {err && <Alerta tipo="error">{err}</Alerta>}
      <h4>Alcance de la programación especial</h4>
      <div className="fila-formulario">
        <label>Tipo de alcance</label>
        <select value={selectionMode} onChange={(e) => { setSelectionMode(e.target.value as "manual" | "licensing"); setErr(null); }}>
          <option value="manual">Selección manual</option>
          <option value="licensing">Por licenciamiento</option>
        </select>
      </div>
      {selectionMode === "licensing" ? (
        <div className="tarjeta tarjeta-compacta">
          <h4>Licencias a actualizar</h4>
          <input value={licenseSearch} onChange={(e) => setLicenseSearch(e.target.value)} placeholder="Buscar licencia..." />
          <div className="lista-seleccion" style={{ marginTop: 8, maxHeight: 220 }}>
            {modulosActivos.map((module) => (
              <label key={module.id} className="fila-seleccion">
                <input type="checkbox" checked={licenseModuleIds.includes(module.id)} onChange={() => alternarLicencia(module.id)} />
                <span><strong>{module.name}</strong><small>{module.code ?? ""}</small></span>
              </label>
            ))}
            {modulosActivos.length === 0 && <div className="vacio">No hay licencias activas para seleccionar.</div>}
          </div>
          <div className="seleccion-resumen">
            <strong>Licencias seleccionadas</strong>
            {licenciasSeleccionadas.length === 0 ? (
              <p className="texto-ayuda">Sin licencias seleccionadas.</p>
            ) : (
              <div className="chips">
                {licenciasSeleccionadas.map((licencia) => (
                  <span key={licencia.id} className="chip">
                    {licencia.name}
                    <button type="button" aria-label={`Quitar ${licencia.name}`} onClick={() => alternarLicencia(licencia.id)}>x</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="fila-formulario">
            <label>Coincidencia de licencias</label>
            <select value={licenseMatchMode} onChange={(e) => { setLicenseMatchMode(e.target.value as "any" | "all"); setPreview(null); }}>
              <option value="any">Cualquiera de las licencias seleccionadas</option>
              <option value="all">Todas las licencias seleccionadas</option>
            </select>
          </div>
          <div className="fila-formulario">
            <label>Ambiente</label>
            <select value={licenseEnvironment} onChange={(e) => { setLicenseEnvironment(e.target.value); setPreview(null); }}>
              <option value="all">Todos</option>
              <option value="production">Producción</option>
              <option value="test">Pruebas</option>
              <option value="demo">Demo</option>
            </select>
          </div>
          <div className="fila-formulario">
            <label>Objetivo de actualización</label>
            <select value={licenseTargetTypes} onChange={(e) => { setLicenseTargetTypes(e.target.value as LicensingScope["targetTypes"]); setPreview(null); }}>
              <option value="domains_and_databases">Dominios y bases de datos</option>
              <option value="domains_only">Solo dominios</option>
              <option value="databases_only">Solo bases de datos</option>
            </select>
          </div>
          <div className="fila-formulario"><label>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked readOnly disabled />
            Solo clientes, dominios y bases activos
          </label></div>
          <button type="button" className="primario" onClick={() => {
            if (licenseModuleIds.length === 0) { setErr("Seleccione al menos una licencia."); return; }
            previewLicencias.mutate(licensingScope());
          }}>{previewLicencias.isPending ? "Previsualizando..." : "Previsualizar alcance"}</button>
          {preview && <PreviewLicenciamiento preview={preview} />}
        </div>
      ) : (
      <>
      <div className="fila-formulario"><label>Agregar cliente al alcance</label>
        <SelectorBuscable
          opciones={clientes.filter((c) => c.status === "active" && !scopeGroups.some((g) => g.clientId === c.id)).map((c) => ({ id: c.id, etiqueta: c.name }))}
          valor={clienteAAgregar}
          onChange={(id) => {
            if (!id) return;
            setScopeGroups((prev) => [...prev, { clientId: id, includeAllDomains: false, domains: [] }]);
            setClienteAAgregar("");
          }}
          placeholder="Buscar cliente..."
        /></div>
      {scopeGroups.map((group) => {
        const cliente = clientes.find((c) => c.id === group.clientId);
        const dominiosCliente = dominios.filter((d) => d.clientId === group.clientId && d.status === "active");
        return (
          <div className="tarjeta tarjeta-compacta" key={group.clientId}>
            <h4>Cliente: {cliente?.name ?? group.clientId}</h4>
            <button type="button" className="peligro" onClick={() => setScopeGroups((prev) => prev.filter((g) => g.clientId !== group.clientId))}>Eliminar cliente del alcance</button>
            <div className="fila-formulario"><label>
              <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={group.includeAllDomains} onChange={(e) => setScopeGroups((prev) => prev.map((g) => g.clientId === group.clientId ? { ...g, includeAllDomains: e.target.checked, domains: e.target.checked ? [] : g.domains } : g))} />
              Incluir todos los dominios activos de este cliente
            </label></div>
            {!group.includeAllDomains && (
              <>
                <div className="acciones-formulario" style={{ justifyContent: "flex-start" }}>
                  <button type="button" className="primario" onClick={() => setSelectorDominios({ clientId: group.clientId })}>+ Agregar dominios</button>
                </div>
                <p className="texto-ayuda">Dominios seleccionados: {group.domains.length || "ninguno"}</p>
                {group.domains.map((domainScope) => {
                  const domain = dominios.find((d) => d.id === domainScope.domainId);
                  const basesDominio = bds.filter((bd) => bd.domainId === domainScope.domainId && bd.status === "active");
                  return (
                    <div className="tarjeta tarjeta-compacta" key={domainScope.domainId}>
                      <strong>Dominio: {domain?.domainName ?? domainScope.domainId}</strong>
                      <p className="texto-ayuda">Ambiente: {domain?.environment ?? "-"}</p>
                      <button type="button" onClick={() => setScopeGroups((prev) => prev.map((g) => g.clientId === group.clientId ? { ...g, domains: g.domains.filter((d) => d.domainId !== domainScope.domainId) } : g))}>Eliminar dominio</button>
                      <div className="fila-formulario"><label>
                        <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={domainScope.includeAllDatabases} onChange={(e) => setScopeGroups((prev) => prev.map((g) => g.clientId === group.clientId ? { ...g, domains: g.domains.map((d) => d.domainId === domainScope.domainId ? { ...d, includeAllDatabases: e.target.checked, databaseIds: e.target.checked ? [] : d.databaseIds } : d) } : g))} />
                        Incluir todas las bases activas de este dominio
                      </label></div>
                      {!domainScope.includeAllDatabases && (
                        <>
                          <button type="button" className="primario" onClick={() => setSelectorBases({ clientId: group.clientId, domainId: domainScope.domainId })}>+ Agregar bases</button>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                            {domainScope.databaseIds.map((id) => {
                              const bd = bds.find((x) => x.id === id);
                              return <span className="estado estado-active" key={id}>{bd ? `${bd.companyName} — ${bd.dbAccess.initialCatalog} — ${bd.environment}` : id} <button type="button" onClick={() => setScopeGroups((prev) => prev.map((g) => g.clientId === group.clientId ? { ...g, domains: g.domains.map((d) => d.domainId === domainScope.domainId ? { ...d, databaseIds: d.databaseIds.filter((x) => x !== id) } : d) } : g))}>x</button></span>;
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        );
      })}
      <Alerta tipo="info">Resumen del alcance: {resumen.clientes} cliente(s), {resumen.dominios} dominio(s), {resumen.bases} base(s) de datos.</Alerta>
      </>
      )}
      <ModalSeleccionDominios
        abierto={!!selectorDominios}
        clientId={selectorDominios?.clientId ?? ""}
        dominios={dominios}
        seleccionados={scopeGroups.find((g) => g.clientId === selectorDominios?.clientId)?.domains.map((d) => d.domainId) ?? []}
        onCerrar={() => setSelectorDominios(null)}
        onAgregar={(ids) => {
          const clientId = selectorDominios?.clientId;
          if (!clientId) return;
          setScopeGroups((prev) => prev.map((g) => {
            if (g.clientId !== clientId) return g;
            const actuales = new Set(g.domains.map((d) => d.domainId));
            const nuevos = ids.filter((id) => !actuales.has(id)).map((domainId) => ({ domainId, includeAllDatabases: false, databaseIds: [] }));
            return { ...g, domains: [...g.domains, ...nuevos] };
          }));
          setSelectorDominios(null);
        }}
      />
      <ModalSeleccionBases
        abierto={!!selectorBases}
        domainId={selectorBases?.domainId ?? ""}
        bds={bds}
        seleccionadas={scopeGroups.find((g) => g.clientId === selectorBases?.clientId)?.domains.find((d) => d.domainId === selectorBases?.domainId)?.databaseIds ?? []}
        onCerrar={() => setSelectorBases(null)}
        onAgregar={(ids) => {
          const ctx = selectorBases;
          if (!ctx) return;
          setScopeGroups((prev) => prev.map((g) => g.clientId === ctx.clientId ? {
            ...g,
            domains: g.domains.map((d) => {
              if (d.domainId !== ctx.domainId) return d;
              return { ...d, databaseIds: Array.from(new Set([...d.databaseIds, ...ids])) };
            }),
          } : g));
          setSelectorBases(null);
        }}
      />
      <h4>Responsables de la programación</h4>
      <div className="fila-formulario"><label>Modo de asignación</label>
        <select value={assignmentMode} onChange={(e) => setAssignmentMode(e.target.value as any)}>
          <option value="role">Asignar por rol</option>
          <option value="users">Asignar a usuarios específicos</option>
        </select></div>
      {assignmentMode === "users" && (
        <>
          <div className="fila-formulario"><label>Responsables para dominios</label>
            <select multiple value={domainUsers} onChange={(e) => setDomainUsers(Array.from(e.target.selectedOptions).map((o) => o.value))} style={{ height: 90 }}>
              {usuarios.filter((u) => u.active !== false).map((u) => <option key={u.id} value={u.id}>{u.displayName || u.email}</option>)}
            </select></div>
          <div className="fila-formulario"><label>Responsables para bases de datos</label>
            <select multiple value={databaseUsers} onChange={(e) => setDatabaseUsers(Array.from(e.target.selectedOptions).map((o) => o.value))} style={{ height: 90 }}>
              {usuarios.filter((u) => u.active !== false).map((u) => <option key={u.id} value={u.id}>{u.displayName || u.email}</option>)}
            </select></div>
        </>
      )}
      {assignmentMode === "role" && <p className="texto-ayuda">Tareas de dominio → Actualizador de dominios. Tareas de base de datos → Actualizador de bases de datos.</p>}
      <div className="fila-formulario"><label>Tipo de frecuencia *</label>
        <select value={frequencyType} onChange={(e) => setFrequencyType(e.target.value as any)}>
          {Object.entries(ETIQUETAS_FRECUENCIA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></div>
      {frequencyType === "weekly" && (
        <>
          <div className="fila-formulario"><label>Cada cuántas semanas</label>
            <input type="number" min={1} value={everyNWeeks} onChange={(e) => setEveryNWeeks(Number(e.target.value))} /></div>
          <div className="fila-formulario"><label>Días de la semana</label>
            {DIAS_LISTA.map((d) => (
              <label key={d} style={{ display: "inline-flex", alignItems: "center", marginRight: 12, fontWeight: 400 }}>
                <input type="checkbox" style={{ width: "auto", marginRight: 4 }} checked={weekdays.includes(d)} onChange={() => alternarDia(d)} />
                {DIAS_SEMANA[d]}
              </label>
            ))}
          </div>
        </>
      )}
      {frequencyType === "interval" && (
        <div className="fila-formulario"><label>Intervalo en días *</label>
          <input type="number" min={1} value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value))} /></div>
      )}
      {frequencyType === "monthly" && (
        <div className="fila-formulario"><label>Día del mes (1-31) *</label>
          <input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} /></div>
      )}
      <div className="fila-formulario"><label>Fecha de inicio *</label>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
      <div className="fila-formulario"><label>
        <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={hasEndDate} onChange={(e) => setHasEndDate(e.target.checked)} />
        Tiene fecha de fin
      </label></div>
      {hasEndDate && (
        <div className="fila-formulario"><label>Fecha de fin</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
      )}
      <div className="fila-formulario"><label>
        <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={active} onChange={(e) => setActive(e.target.checked)} />
        Frecuencia activa
      </label></div>
      <p className="texto-ayuda">Las tareas usarán responsables por rol o usuarios específicos según la sección de responsables.</p>
      <div className="acciones-formulario">
        <button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button>
      </div>
    </form>
  );
}

function ModalSeleccionDominios({ abierto, clientId, dominios, seleccionados, onCerrar, onAgregar }: {
  abierto: boolean;
  clientId: string;
  dominios: Dominio[];
  seleccionados: string[];
  onCerrar: () => void;
  onAgregar: (ids: string[]) => void;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [marcados, setMarcados] = useState<string[]>([]);
  const opciones = dominios.filter((d) => d.clientId === clientId && d.status === "active" && (
    !busqueda.trim() || `${d.domainName} ${d.environment} ${d.status}`.toLowerCase().includes(busqueda.trim().toLowerCase())
  ));
  useEffect(() => { if (abierto) { setMarcados(seleccionados); setBusqueda(""); } }, [abierto, seleccionados.join("|")]);
  return (
    <Modal titulo="Seleccionar dominios" abierto={abierto} onCerrar={onCerrar}>
      <div className="fila-formulario">
        <label htmlFor="buscar-dominios">Buscar dominio</label>
        <input id="buscar-dominios" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
      </div>
      <div className="lista-seleccion">
        {opciones.map((d) => (
          <label key={d.id} className="fila-seleccion">
            <input type="checkbox" checked={marcados.includes(d.id)} onChange={() => setMarcados((prev) => prev.includes(d.id) ? prev.filter((x) => x !== d.id) : [...prev, d.id])} />
            <span><strong>{d.domainName}</strong><small>Ambiente: {d.environment} · Estado: {d.status}</small></span>
          </label>
        ))}
        {opciones.length === 0 && <div className="vacio">No hay dominios activos para seleccionar.</div>}
      </div>
      <div className="acciones-formulario">
        <button type="button" onClick={onCerrar}>Cancelar</button>
        <button type="button" className="primario" onClick={() => onAgregar(marcados)}>Agregar seleccionados</button>
      </div>
    </Modal>
  );
}

function PreviewLicenciamiento({ preview }: { preview: LicensingPreview }) {
  return (
    <div className="tarjeta tarjeta-compacta" style={{ marginTop: 12 }}>
      <strong>Se incluirán:</strong>
      <ul>
        <li>{preview.clientsCount} cliente(s)</li>
        <li>{preview.domainsCount} dominio(s)</li>
        <li>{preview.databasesCount} base(s) de datos</li>
      </ul>
      {preview.groups.length === 0 ? (
        <Alerta tipo="info">No se encontraron clientes activos con las licencias y filtros seleccionados.</Alerta>
      ) : preview.groups.map((group) => (
        <details key={group.client.id} open>
          <summary><strong>Cliente: {group.client.name}</strong> · Licencias: {group.client.licenses.join(", ") || "Sin licencias registradas"}</summary>
          {group.domains.map((domain) => (
            <div key={domain.id} style={{ margin: "8px 0 8px 16px" }}>
              <div><strong>Dominio:</strong> {domain.name}</div>
              <div className="texto-ayuda">Ambiente: {ETIQUETAS_AMBIENTE[domain.environment] ?? domain.environment}</div>
              {domain.databases.map((db) => (
                <div key={db.id} style={{ marginLeft: 16 }}>
                  Base: {db.databaseName} · Empresa: {db.companyName} · Ambiente: {ETIQUETAS_AMBIENTE[db.environment] ?? db.environment}
                </div>
              ))}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}

function ModalSeleccionBases({ abierto, domainId, bds, seleccionadas, onCerrar, onAgregar }: {
  abierto: boolean;
  domainId: string;
  bds: BaseDeDatos[];
  seleccionadas: string[];
  onCerrar: () => void;
  onAgregar: (ids: string[]) => void;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const opciones = bds.filter((bd) => bd.domainId === domainId && bd.status === "active" && (
    !busqueda.trim() || `${bd.companyName} ${bd.dbAccess.initialCatalog} ${bd.environment} ${bd.status}`.toLowerCase().includes(busqueda.trim().toLowerCase())
  ));
  useEffect(() => { if (abierto) { setMarcadas(seleccionadas); setBusqueda(""); } }, [abierto, seleccionadas.join("|")]);
  return (
    <Modal titulo="Seleccionar bases de datos" abierto={abierto} onCerrar={onCerrar}>
      <div className="fila-formulario">
        <label htmlFor="buscar-bases">Buscar base</label>
        <input id="buscar-bases" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
      </div>
      <div className="lista-seleccion">
        {opciones.map((bd) => (
          <label key={bd.id} className="fila-seleccion">
            <input type="checkbox" checked={marcadas.includes(bd.id)} onChange={() => setMarcadas((prev) => prev.includes(bd.id) ? prev.filter((x) => x !== bd.id) : [...prev, bd.id])} />
            <span><strong>{bd.companyName}</strong><small>Base: {bd.dbAccess.initialCatalog} · Ambiente: {bd.environment} · Estado: {bd.status}</small></span>
          </label>
        ))}
        {opciones.length === 0 && <div className="vacio">No hay bases activas para seleccionar.</div>}
      </div>
      <div className="acciones-formulario">
        <button type="button" onClick={onCerrar}>Cancelar</button>
        <button type="button" className="primario" onClick={() => onAgregar(marcadas)}>Agregar seleccionadas</button>
      </div>
    </Modal>
  );
}
