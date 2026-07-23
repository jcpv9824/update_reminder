import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUrl } from "../api/client";
import { Alerta, BotonCopiar, DialogoConfirmar, EtiquetaEstado, Modal } from "../components/Comunes";
import type { PublicDownloadDocument, PublicDownloadSection } from "../types";

type Tab = "sections" | "documents";
const PUBLIC_FILE_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.vsd,.vsdx,.html,.htm,.md,.txt,.csv,.url,.mp4,.m4v,.mov,.webm,video/mp4,video/webm,video/quicktime,video/x-m4v";
const MAX_DOCUMENT_BYTES = 8_000_000;
const MAX_VIDEO_BYTES = 100_000_000;
type FilePayload = {
  archivoBase64: string;
  archivoNombreOriginal: string;
  archivoMimeType: string;
};

const ADMIN_API = "/public-downloads/admin";

export default function DescargasPublicasAdminPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("documents");
  const [busqueda, setBusqueda] = useState("");
  const [modalSection, setModalSection] = useState<PublicDownloadSection | "nuevo" | null>(null);
  const [modalDocument, setModalDocument] = useState<PublicDownloadDocument | "nuevo" | null>(null);
  const [deleteSection, setDeleteSection] = useState<PublicDownloadSection | null>(null);
  const [deleteDocument, setDeleteDocument] = useState<PublicDownloadDocument | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: sections = [], isLoading: loadingSections } = useQuery({
    queryKey: ["public-download-sections-admin"],
    queryFn: () => api.get<PublicDownloadSection[]>(`${ADMIN_API}/sections`),
  });
  const { data: documents = [], isLoading: loadingDocuments } = useQuery({
    queryKey: ["public-download-documents-admin"],
    queryFn: () => api.get<PublicDownloadDocument[]>(`${ADMIN_API}/documents`),
  });

  const activeSections = sections.filter((section) => section.activa && section.status !== "deleted");
  const filteredSections = useMemo(() => filterSections(sections, busqueda), [sections, busqueda]);
  const filteredDocuments = useMemo(() => filterDocuments(documents, busqueda), [documents, busqueda]);

  function onSuccess(text: string) {
    qc.invalidateQueries({ queryKey: ["public-download-sections-admin"] });
    qc.invalidateQueries({ queryKey: ["public-download-documents-admin"] });
    setMensaje(text);
    setError(null);
    setModalSection(null);
    setModalDocument(null);
    setDeleteSection(null);
    setDeleteDocument(null);
  }

  const saveSection = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: any }) => id ? api.put(`${ADMIN_API}/sections/${id}`, body) : api.post(`${ADMIN_API}/sections`, body),
    onSuccess: (_, vars) => onSuccess(vars.id ? "Sección actualizada correctamente." : "Sección creada correctamente."),
    onError: (e: any) => setError(e?.message ?? "No se pudo guardar la sección."),
  });
  const saveDocument = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: any }) => id ? api.put(`${ADMIN_API}/documents/${id}`, body) : api.post(`${ADMIN_API}/documents`, body),
    onSuccess: (_, vars) => onSuccess(vars.id ? "Archivo actualizado correctamente." : "Archivo creado correctamente."),
    onError: (e: any) => setError(e?.message ?? "No se pudo guardar el archivo."),
  });
  const removeSection = useMutation({
    mutationFn: (id: string) => api.del(`${ADMIN_API}/sections/${id}`),
    onSuccess: () => onSuccess("Sección eliminada."),
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar la sección."),
  });
  const removeDocument = useMutation({
    mutationFn: (id: string) => api.del(`${ADMIN_API}/documents/${id}`),
    onSuccess: () => onSuccess("Archivo eliminado."),
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar el archivo."),
  });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Descargas públicas</h2>
        <button className="primario" onClick={() => tab === "sections" ? setModalSection("nuevo") : setModalDocument("nuevo")}>
          {tab === "sections" ? "Nueva sección" : "Nuevo archivo"}
        </button>
      </div>
      {mensaje && <Alerta tipo="exito">{mensaje}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="pestanas">
        <button className={tab === "documents" ? "activo" : ""} onClick={() => setTab("documents")}>Archivos</button>
        <button className={tab === "sections" ? "activo" : ""} onClick={() => setTab("sections")}>Secciones</button>
      </div>
      <p className="texto-ayuda">Las secciones organizan los archivos públicos y forman parte de su dirección; cada archivo puede ser un documento o un video.</p>

      <div className="barra-filtros">
        <div className="campo campo-busqueda-formatos">
          <label>Buscar</label>
          <div className="buscador-limpiable">
            <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar por título, sección o endpoint..." />
            {busqueda && <button type="button" onClick={() => setBusqueda("")} aria-label="Limpiar busqueda" title="Limpiar busqueda">x</button>}
          </div>
        </div>
      </div>

      {tab === "sections" && (
        loadingSections ? <div className="cargando">Cargando secciones...</div> : (
          <table>
            <thead><tr><th>Sección</th><th>Endpoint</th><th>Descripción</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {filteredSections.map((section) => (
                <tr key={section.id}>
                  <td>{section.nombre}</td>
                  <td><code>{section.slug}</code></td>
                  <td>{section.descripcion || "-"}</td>
                  <td><EtiquetaEstado estado={section.activa ? "active" : "inactive"} /></td>
                  <td className="acciones-tabla">
                    <button onClick={() => setModalSection(section)}>Editar</button>
                    <button className="peligro" onClick={() => setDeleteSection(section)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {filteredSections.length === 0 && <tr><td colSpan={5}><div className="vacio">No hay secciones para mostrar.</div></td></tr>}
            </tbody>
          </table>
        )
      )}

      {tab === "documents" && (
        loadingDocuments ? <div className="cargando">Cargando documentos...</div> : (
          <table>
            <thead><tr><th>Archivo</th><th>Tipo</th><th>Sección</th><th>Archivo cargado</th><th>Endpoint público</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {filteredDocuments.map((doc) => {
                const url = apiUrl(`/public/downloads/${doc.sectionSlug}/${doc.slug}`);
                return (
                  <tr key={doc.id}>
                    <td>
                      <strong>{doc.titulo}</strong>
                      {doc.descripcion && <div className="texto-ayuda">{doc.descripcion}</div>}
                    </td>
                    <td>{doc.assetKind === "video" || doc.archivoMimeType.startsWith("video/") ? "Video" : "Documento"}</td>
                    <td>{doc.sectionName}</td>
                    <td>{doc.archivoNombreOriginal}<div className="texto-ayuda">{formatBytes(doc.archivoBytes)}</div></td>
                    <td>
                      <div className="endpoint-publico">
                        <code>{url}</code>
                        <BotonCopiar valor={url} etiqueta="Copiar" />
                      </div>
                    </td>
                    <td><EtiquetaEstado estado={doc.activo ? "active" : "inactive"} /></td>
                    <td className="acciones-tabla">
                      <a href={url} target="_blank" rel="noreferrer">Descargar</a>
                      <button onClick={() => setModalDocument(doc)}>Editar</button>
                      <button className="peligro" onClick={() => setDeleteDocument(doc)}>Eliminar</button>
                    </td>
                  </tr>
                );
              })}
              {filteredDocuments.length === 0 && <tr><td colSpan={7}><div className="vacio">No hay archivos para mostrar.</div></td></tr>}
            </tbody>
          </table>
        )
      )}

      <Modal titulo={modalSection === "nuevo" ? "Nueva sección" : "Editar sección"} abierto={!!modalSection} onCerrar={() => setModalSection(null)}>
        <SectionForm
          initial={modalSection && modalSection !== "nuevo" ? modalSection : undefined}
          loading={saveSection.isPending}
          onSubmit={(body) => saveSection.mutate({ id: modalSection && modalSection !== "nuevo" ? modalSection.id : undefined, body })}
        />
      </Modal>
      <Modal titulo={modalDocument === "nuevo" ? "Nuevo archivo" : "Editar archivo"} abierto={!!modalDocument} onCerrar={() => setModalDocument(null)} className="modal-descarga-publica">
        <DocumentForm
          initial={modalDocument && modalDocument !== "nuevo" ? modalDocument : undefined}
          sections={activeSections}
          loading={saveDocument.isPending}
          onSubmit={(body) => saveDocument.mutate({ id: modalDocument && modalDocument !== "nuevo" ? modalDocument.id : undefined, body })}
        />
      </Modal>
      <DialogoConfirmar
        abierto={!!deleteSection}
        titulo="Eliminar sección"
        mensaje={deleteSection ? `¿Eliminar la sección "${deleteSection.nombre}"? Solo se permite si no tiene documentos asociados.` : ""}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => deleteSection && removeSection.mutate(deleteSection.id)}
        onCancelar={() => setDeleteSection(null)}
      />
      <DialogoConfirmar
        abierto={!!deleteDocument}
        titulo="Eliminar archivo"
        mensaje={deleteDocument ? `¿Eliminar el archivo "${deleteDocument.titulo}"? El endpoint dejará de estar disponible.` : ""}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => deleteDocument && removeDocument.mutate(deleteDocument.id)}
        onCancelar={() => setDeleteDocument(null)}
      />
    </>
  );
}

function filterSections(items: PublicDownloadSection[], search: string): PublicDownloadSection[] {
  const q = search.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => `${item.nombre} ${item.slug} ${item.descripcion ?? ""}`.toLowerCase().includes(q));
}

function filterDocuments(items: PublicDownloadDocument[], search: string): PublicDownloadDocument[] {
  const q = search.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => `${item.titulo} ${item.slug} ${item.sectionName} ${item.sectionSlug} ${item.descripcion ?? ""}`.toLowerCase().includes(q));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function SectionForm({ initial, loading, onSubmit }: { initial?: PublicDownloadSection; loading: boolean; onSubmit: (body: any) => void }) {
  const [nombre, setNombre] = useState(initial?.nombre ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [descripcion, setDescripcion] = useState(initial?.descripcion ?? "");
  const [activa, setActiva] = useState(initial?.activa ?? true);
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) return setError("El nombre de la sección es obligatorio.");
    onSubmit({ nombre, slug, descripcion, activa });
  }

  return (
    <form onSubmit={submit}>
      {error && <Alerta tipo="error">{error}</Alerta>}
      <div className="fila-formulario"><label>Nombre *</label><input value={nombre} onChange={(e) => setNombre(e.target.value)} /></div>
      <div className="fila-formulario"><label>Endpoint de la sección</label><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="Se genera desde el nombre si se deja vacío" /></div>
      <div className="fila-formulario"><label>Descripción</label><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={3} /></div>
      <div className="fila-formulario"><label><input type="checkbox" checked={activa} onChange={(e) => setActiva(e.target.checked)} style={{ width: "auto", marginRight: 6 }} />Activa</label></div>
      <div className="acciones-formulario"><button type="submit" className="primario" disabled={loading}>{loading ? "Guardando..." : "Guardar"}</button></div>
    </form>
  );
}

function DocumentForm({ initial, sections, loading, onSubmit }: { initial?: PublicDownloadDocument; sections: PublicDownloadSection[]; loading: boolean; onSubmit: (body: any) => void }) {
  const [sectionId, setSectionId] = useState(initial?.sectionId ?? sections[0]?.id ?? "");
  const [titulo, setTitulo] = useState(initial?.titulo ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [descripcion, setDescripcion] = useState(initial?.descripcion ?? "");
  const [activo, setActivo] = useState(initial?.activo ?? true);
  const [file, setFile] = useState<FilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sectionId && sections[0]) setSectionId(sections[0].id);
  }, [sectionId, sections]);

  async function loadFile(selected?: File) {
    setError(null);
    if (!selected) {
      setFile(null);
      return;
    }
    const isVideo = selected.type.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/i.test(selected.name);
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_DOCUMENT_BYTES;
    if (selected.size > maxBytes) {
      setFile(null);
      setError(`El archivo supera el tamaño máximo permitido de ${Math.floor(maxBytes / 1_000_000)} MB.`);
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(selected);
    });
    setFile({
      archivoBase64: dataUrl.split(",")[1] ?? "",
      archivoNombreOriginal: selected.name,
      archivoMimeType: selected.type,
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!sectionId) return setError("Seleccione una sección.");
    if (!titulo.trim()) return setError("El título del archivo es obligatorio.");
    if (!initial && !file) return setError("Debe cargar un archivo.");
    onSubmit({
      sectionId,
      titulo,
      slug,
      descripcion,
      activo,
      ...(file ?? {}),
    });
  }

  return (
    <form onSubmit={submit}>
      {error && <Alerta tipo="error">{error}</Alerta>}
      {sections.length === 0 && <Alerta tipo="info">Cree una sección activa antes de agregar archivos.</Alerta>}
      <div className="fila-formulario"><label>Sección *</label><select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>{sections.map((section) => <option key={section.id} value={section.id}>{section.nombre}</option>)}</select></div>
      <div className="fila-formulario"><label>Título *</label><input value={titulo} onChange={(e) => setTitulo(e.target.value)} /></div>
      <div className="fila-formulario"><label>Endpoint del archivo</label><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="Se genera desde el título si se deja vacío" /></div>
      <div className="fila-formulario"><label>Descripción</label><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={3} /></div>
      <div className="fila-formulario"><label htmlFor="public-download-file">Archivo {!initial ? "*" : ""}</label><input id="public-download-file" type="file" accept={PUBLIC_FILE_ACCEPT} onChange={(e) => loadFile(e.target.files?.[0])} /></div>
      <p className="texto-ayuda">Documentos hasta 8 MB. Videos MP4, M4V, MOV o WebM hasta 100 MB.</p>
      {initial && <p className="texto-ayuda">Archivo actual: {initial.archivoNombreOriginal}</p>}
      {file && <p className="texto-ayuda">Archivo seleccionado: {file.archivoNombreOriginal}</p>}
      <div className="fila-formulario"><label><input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} style={{ width: "auto", marginRight: 6 }} />Activo</label></div>
      <div className="acciones-formulario"><button type="submit" className="primario" disabled={loading || sections.length === 0}>{loading ? "Guardando..." : "Guardar"}</button></div>
    </form>
  );
}
