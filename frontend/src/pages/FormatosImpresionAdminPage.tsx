import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUrl } from "../api/client";
import { Alerta, DialogoConfirmar, EtiquetaEstado, Modal } from "../components/Comunes";
import type { FormatoImpresion, FuenteFormato } from "../types";

type Tab = "fuentes" | "formatos";

type PdfPayload = {
  pdfBase64: string;
  pdfNombreOriginal: string;
};

export default function FormatosImpresionAdminPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("fuentes");
  const [busqueda, setBusqueda] = useState("");
  const [modalFuente, setModalFuente] = useState<FuenteFormato | "nuevo" | null>(null);
  const [modalFormato, setModalFormato] = useState<FormatoImpresion | "nuevo" | null>(null);
  const [eliminarFuente, setEliminarFuente] = useState<FuenteFormato | null>(null);
  const [eliminarFormato, setEliminarFormato] = useState<FormatoImpresion | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: fuentes = [], isLoading: cargandoFuentes } = useQuery({
    queryKey: ["fuentes-formatos-admin"],
    queryFn: () => api.get<FuenteFormato[]>("/admin/fuentes-formatos"),
  });
  const { data: formatos = [], isLoading: cargandoFormatos } = useQuery({
    queryKey: ["formatos-impresion-admin"],
    queryFn: () => api.get<FormatoImpresion[]>("/admin/formatos-impresion"),
  });

  const fuentesFiltradas = useMemo(() => filtrar(fuentes, busqueda), [fuentes, busqueda]);
  const formatosFiltrados = useMemo(() => filtrar(formatos, busqueda), [formatos, busqueda]);
  const fuentesActivas = fuentes.filter((fuente) => fuente.activa && fuente.status !== "deleted");

  function onSuccess(texto: string) {
    qc.invalidateQueries({ queryKey: ["fuentes-formatos-admin"] });
    qc.invalidateQueries({ queryKey: ["formatos-impresion-admin"] });
    setMensaje(texto);
    setError(null);
    setModalFuente(null);
    setModalFormato(null);
    setEliminarFuente(null);
    setEliminarFormato(null);
  }

  const guardarFuente = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: any }) => id ? api.put(`/admin/fuentes-formatos/${id}`, body) : api.post("/admin/fuentes-formatos", body),
    onSuccess: (_, vars) => onSuccess(vars.id ? "Fuente actualizada correctamente." : "Fuente creada correctamente."),
    onError: (e: any) => setError(e?.message ?? "No se pudo guardar la Fuente."),
  });
  const guardarFormato = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: any }) => id ? api.put(`/admin/formatos-impresion/${id}`, body) : api.post("/admin/formatos-impresion", body),
    onSuccess: (_, vars) => onSuccess(vars.id ? "Formato actualizado correctamente." : "Formato creado correctamente."),
    onError: (e: any) => setError(e?.message ?? "No se pudo guardar el formato."),
  });
  const borrarFuente = useMutation({
    mutationFn: (id: string) => api.del(`/admin/fuentes-formatos/${id}`),
    onSuccess: () => onSuccess("Fuente eliminada."),
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar la Fuente."),
  });
  const borrarFormato = useMutation({
    mutationFn: (id: string) => api.del(`/admin/formatos-impresion/${id}`),
    onSuccess: () => onSuccess("Formato eliminado."),
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar el formato."),
  });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Formatos de Impresión</h2>
        <button className="primario" onClick={() => tab === "fuentes" ? setModalFuente("nuevo") : setModalFormato("nuevo")}>
          {tab === "fuentes" ? "Nueva Fuente" : "Nuevo formato"}
        </button>
      </div>
      {mensaje && <Alerta tipo="exito">{mensaje}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="pestanas">
        <button className={tab === "fuentes" ? "activo" : ""} onClick={() => setTab("fuentes")}>Fuentes</button>
        <button className={tab === "formatos" ? "activo" : ""} onClick={() => setTab("formatos")}>Formatos</button>
      </div>
      <div className="barra-filtros">
        <div className="campo">
          <label>Buscar</label>
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar por nombre o descripción..." />
        </div>
      </div>

      {tab === "fuentes" && (
        cargandoFuentes ? <div className="cargando">Cargando Fuentes...</div> : (
          <table>
            <thead><tr><th>Nombre de la Fuente</th><th>Descripción</th><th>Orden</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {fuentesFiltradas.map((fuente) => (
                <tr key={fuente.id}>
                  <td>{fuente.nombre}</td>
                  <td>{fuente.descripcion || "-"}</td>
                  <td>{fuente.orden ?? "-"}</td>
                  <td><EtiquetaEstado estado={fuente.activa ? "active" : "inactive"} /></td>
                  <td className="acciones-tabla">
                    <button onClick={() => setModalFuente(fuente)}>Editar</button>
                    <button className="peligro" onClick={() => setEliminarFuente(fuente)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {fuentesFiltradas.length === 0 && <tr><td colSpan={5}><div className="vacio">No hay Fuentes para mostrar.</div></td></tr>}
            </tbody>
          </table>
        )
      )}

      {tab === "formatos" && (
        cargandoFormatos ? <div className="cargando">Cargando formatos...</div> : (
          <table>
            <thead><tr><th>Nombre del formato</th><th>Fuente</th><th>Descripción</th><th>PDF</th><th>Orden</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {formatosFiltrados.map((formato) => (
                <tr key={formato.id}>
                  <td>{formato.nombre}</td>
                  <td>{formato.fuenteNombre}</td>
                  <td>{formato.descripcion}</td>
                  <td><a href={apiUrl(`/public/formatos-impresion/${formato.id}/pdf`)} target="_blank" rel="noreferrer">Ver PDF</a></td>
                  <td>{formato.orden ?? "-"}</td>
                  <td><EtiquetaEstado estado={formato.activo ? "active" : "inactive"} /></td>
                  <td className="acciones-tabla">
                    <button onClick={() => setModalFormato(formato)}>Editar</button>
                    <button className="peligro" onClick={() => setEliminarFormato(formato)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {formatosFiltrados.length === 0 && <tr><td colSpan={7}><div className="vacio">No hay formatos para mostrar.</div></td></tr>}
            </tbody>
          </table>
        )
      )}

      <Modal titulo={modalFuente === "nuevo" ? "Nueva Fuente" : "Editar Fuente"} abierto={!!modalFuente} onCerrar={() => setModalFuente(null)}>
        <FormularioFuente
          inicial={modalFuente && modalFuente !== "nuevo" ? modalFuente : undefined}
          cargando={guardarFuente.isPending}
          onSubmit={(body) => guardarFuente.mutate({ id: modalFuente && modalFuente !== "nuevo" ? modalFuente.id : undefined, body })}
        />
      </Modal>
      <Modal titulo={modalFormato === "nuevo" ? "Nuevo formato" : "Editar formato"} abierto={!!modalFormato} onCerrar={() => setModalFormato(null)}>
        <FormularioFormato
          inicial={modalFormato && modalFormato !== "nuevo" ? modalFormato : undefined}
          fuentes={fuentesActivas}
          cargando={guardarFormato.isPending}
          onSubmit={(body) => guardarFormato.mutate({ id: modalFormato && modalFormato !== "nuevo" ? modalFormato.id : undefined, body })}
        />
      </Modal>
      <DialogoConfirmar
        abierto={!!eliminarFuente}
        titulo="Eliminar Fuente"
        mensaje={eliminarFuente ? `¿Eliminar la Fuente "${eliminarFuente.nombre}"? Solo se permite si no tiene formatos asociados.` : ""}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => eliminarFuente && borrarFuente.mutate(eliminarFuente.id)}
        onCancelar={() => setEliminarFuente(null)}
      />
      <DialogoConfirmar
        abierto={!!eliminarFormato}
        titulo="Eliminar formato"
        mensaje={eliminarFormato ? `¿Eliminar el formato "${eliminarFormato.nombre}"?` : ""}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => eliminarFormato && borrarFormato.mutate(eliminarFormato.id)}
        onCancelar={() => setEliminarFormato(null)}
      />
    </>
  );
}

function filtrar<T extends { nombre: string; descripcion?: string; fuenteNombre?: string }>(items: T[], busqueda: string): T[] {
  const q = busqueda.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => `${item.nombre} ${item.descripcion ?? ""} ${item.fuenteNombre ?? ""}`.toLowerCase().includes(q));
}

function FormularioFuente({ inicial, cargando, onSubmit }: { inicial?: FuenteFormato; cargando: boolean; onSubmit: (body: any) => void }) {
  const [nombre, setNombre] = useState(inicial?.nombre ?? "");
  const [descripcion, setDescripcion] = useState(inicial?.descripcion ?? "");
  const [activa, setActiva] = useState(inicial?.activa ?? true);
  const [orden, setOrden] = useState(inicial?.orden?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) { setError("El nombre de la Fuente es obligatorio."); return; }
    onSubmit({ nombre, descripcion, activa, orden: orden.trim() ? Number(orden) : null });
  }

  return (
    <form onSubmit={submit}>
      {error && <Alerta tipo="error">{error}</Alerta>}
      <div className="fila-formulario"><label>Nombre de la Fuente *</label><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></div>
      <div className="fila-formulario"><label>Descripción</label><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={3} /></div>
      <div className="fila-formulario"><label>Orden</label><input type="number" min={0} value={orden} onChange={(e) => setOrden(e.target.value)} /></div>
      <div className="fila-formulario"><label><input type="checkbox" checked={activa} onChange={(e) => setActiva(e.target.checked)} style={{ width: "auto", marginRight: 6 }} />Activa</label></div>
      <div className="acciones-formulario"><button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button></div>
    </form>
  );
}

function FormularioFormato({ inicial, fuentes, cargando, onSubmit }: { inicial?: FormatoImpresion; fuentes: FuenteFormato[]; cargando: boolean; onSubmit: (body: any) => void }) {
  const [nombre, setNombre] = useState(inicial?.nombre ?? "");
  const [fuenteId, setFuenteId] = useState(inicial?.fuenteId ?? fuentes[0]?.id ?? "");
  const [descripcion, setDescripcion] = useState(inicial?.descripcion ?? "");
  const [activo, setActivo] = useState(inicial?.activo ?? true);
  const [orden, setOrden] = useState(inicial?.orden?.toString() ?? "");
  const [pdf, setPdf] = useState<PdfPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fuenteId && fuentes[0]) setFuenteId(fuentes[0].id);
  }, [fuenteId, fuentes]);

  async function cargarPdf(file?: File) {
    setError(null);
    if (!file) { setPdf(null); return; }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Solo se aceptan archivos PDF.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setPdf({ pdfBase64: dataUrl.split(",")[1] ?? "", pdfNombreOriginal: file.name });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) { setError("El nombre del formato es obligatorio."); return; }
    if (!fuenteId) { setError("La Fuente es obligatoria."); return; }
    if (!descripcion.trim()) { setError("La descripción es obligatoria."); return; }
    if (!inicial && !pdf) { setError("Debe cargar un PDF."); return; }
    onSubmit({
      nombre,
      fuenteId,
      descripcion,
      activo,
      orden: orden.trim() ? Number(orden) : null,
      ...(pdf ?? {}),
    });
  }

  return (
    <form onSubmit={submit}>
      {error && <Alerta tipo="error">{error}</Alerta>}
      <div className="fila-formulario"><label>Nombre del formato *</label><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></div>
      <div className="fila-formulario"><label>Fuente *</label><select value={fuenteId} onChange={(e) => setFuenteId(e.target.value)}>{fuentes.map((fuente) => <option key={fuente.id} value={fuente.id}>{fuente.nombre}</option>)}</select></div>
      <div className="fila-formulario"><label>Descripción *</label><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={3} /></div>
      <div className="fila-formulario"><label>PDF {inicial ? "(opcional para reemplazar)" : "*"}</label><input type="file" accept="application/pdf,.pdf" onChange={(e) => cargarPdf(e.target.files?.[0])} /></div>
      {inicial && <p className="texto-ayuda">PDF actual: {inicial.pdfNombreOriginal}</p>}
      {pdf && <p className="texto-ayuda">PDF seleccionado: {pdf.pdfNombreOriginal}</p>}
      <div className="fila-formulario"><label>Orden</label><input type="number" min={0} value={orden} onChange={(e) => setOrden(e.target.value)} /></div>
      <div className="fila-formulario"><label><input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} style={{ width: "auto", marginRight: 6 }} />Activo</label></div>
      <div className="acciones-formulario"><button type="submit" className="primario" disabled={cargando}>{cargando ? "Guardando..." : "Guardar"}</button></div>
    </form>
  );
}
