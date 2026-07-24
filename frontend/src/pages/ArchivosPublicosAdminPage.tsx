import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUrl } from "../api/client";
import { Alerta, BotonCopiar, DialogoConfirmar, EtiquetaEstado, Modal } from "../components/Comunes";
import type { PublicFile } from "../types";

const INLINE_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.gif,.webp,.mp4,.m4v,.mov,.webm,application/pdf,image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,video/x-m4v";
const MAX_IMAGE_BYTES = 12_000_000;
const MAX_DOCUMENT_BYTES = 8_000_000;
const MAX_VIDEO_BYTES = 100_000_000;
const ADMIN_API = "/public-files/admin";

type FilePayload = {
  archivoBase64: string;
  archivoNombreOriginal: string;
  archivoMimeType: string;
};

export default function ArchivosPublicosAdminPage() {
  const qc = useQueryClient();
  const [busqueda, setBusqueda] = useState("");
  const [modal, setModal] = useState<PublicFile | "nuevo" | null>(null);
  const [eliminar, setEliminar] = useState<PublicFile | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: archivos = [], isLoading } = useQuery({
    queryKey: ["public-files-admin"],
    queryFn: () => api.get<PublicFile[]>(ADMIN_API),
  });
  const filtrados = useMemo(() => filterFiles(archivos, busqueda), [archivos, busqueda]);

  function onSuccess(text: string) {
    qc.invalidateQueries({ queryKey: ["public-files-admin"] });
    setMensaje(text);
    setError(null);
    setModal(null);
    setEliminar(null);
  }

  const guardar = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: unknown }) =>
      id ? api.put(`${ADMIN_API}/${id}`, body) : api.post(ADMIN_API, body),
    onSuccess: (_, variables) => onSuccess(variables.id ? "Archivo actualizado correctamente." : "Archivo creado correctamente."),
    onError: (e: any) => setError(e?.message ?? "No se pudo guardar el archivo."),
  });
  const remover = useMutation({
    mutationFn: (id: string) => api.del(`${ADMIN_API}/${id}`),
    onSuccess: () => onSuccess("Archivo eliminado."),
    onError: (e: any) => setError(e?.message ?? "No se pudo eliminar el archivo."),
  });

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Archivos públicos</h2>
        <button className="primario" onClick={() => setModal("nuevo")}>Nuevo archivo</button>
      </div>
      {mensaje && <Alerta tipo="exito">{mensaje}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}
      <p className="texto-ayuda">
        Estos endpoints se abren en el navegador y no fuerzan una descarga.
        Se admiten imágenes, PDF y videos con formatos seguros para visualización.
      </p>

      <div className="barra-filtros">
        <div className="campo campo-busqueda-formatos">
          <label>Buscar</label>
          <div className="buscador-limpiable">
            <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar por título o endpoint..." />
            {busqueda && <button type="button" onClick={() => setBusqueda("")} aria-label="Limpiar busqueda" title="Limpiar busqueda">x</button>}
          </div>
        </div>
      </div>

      {isLoading ? <div className="cargando">Cargando archivos...</div> : (
        <table>
          <thead>
            <tr><th>Archivo</th><th>Tipo</th><th>Archivo cargado</th><th>Endpoint público</th><th>Estado</th><th>Acciones</th></tr>
          </thead>
          <tbody>
            {filtrados.map((archivo) => {
              const url = apiUrl(`/public/files/${archivo.slug}`);
              return (
                <tr key={archivo.id}>
                  <td>
                    <strong>{archivo.titulo}</strong>
                    {archivo.descripcion && <div className="texto-ayuda">{archivo.descripcion}</div>}
                  </td>
                  <td>{assetLabel(archivo.assetKind)}</td>
                  <td>{archivo.archivoNombreOriginal}<div className="texto-ayuda">{formatBytes(archivo.archivoBytes)}</div></td>
                  <td>
                    <div className="endpoint-publico">
                      <code>{url}</code>
                      <BotonCopiar valor={url} etiqueta="Copiar" />
                    </div>
                  </td>
                  <td><EtiquetaEstado estado={archivo.activo ? "active" : "inactive"} /></td>
                  <td className="acciones-tabla">
                    <a href={url} target="_blank" rel="noreferrer">Visualizar</a>
                    <button onClick={() => setModal(archivo)}>Editar</button>
                    <button className="peligro" onClick={() => setEliminar(archivo)}>Eliminar</button>
                  </td>
                </tr>
              );
            })}
            {filtrados.length === 0 && <tr><td colSpan={6}><div className="vacio">No hay archivos para mostrar.</div></td></tr>}
          </tbody>
        </table>
      )}

      <Modal titulo={modal === "nuevo" ? "Nuevo archivo público" : "Editar archivo público"} abierto={!!modal} onCerrar={() => setModal(null)} className="modal-descarga-publica">
        <PublicFileForm
          initial={modal && modal !== "nuevo" ? modal : undefined}
          loading={guardar.isPending}
          onSubmit={(body) => guardar.mutate({ id: modal && modal !== "nuevo" ? modal.id : undefined, body })}
        />
      </Modal>
      <DialogoConfirmar
        abierto={!!eliminar}
        titulo="Eliminar archivo público"
        mensaje={eliminar ? `¿Eliminar el archivo "${eliminar.titulo}"? El endpoint dejará de estar disponible.` : ""}
        textoConfirmar="Eliminar"
        variante="peligro"
        onConfirmar={() => eliminar && remover.mutate(eliminar.id)}
        onCancelar={() => setEliminar(null)}
      />
    </>
  );
}

function filterFiles(items: PublicFile[], search: string): PublicFile[] {
  const query = search.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) =>
    `${item.titulo} ${item.slug} ${item.descripcion ?? ""} ${item.archivoNombreOriginal}`.toLowerCase().includes(query)
  );
}

function assetLabel(kind: PublicFile["assetKind"]): string {
  if (kind === "image") return "Imagen";
  if (kind === "video") return "Video";
  return "PDF";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function PublicFileForm({
  initial,
  loading,
  onSubmit,
}: {
  initial?: PublicFile;
  loading: boolean;
  onSubmit: (body: unknown) => void;
}) {
  const [titulo, setTitulo] = useState(initial?.titulo ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [descripcion, setDescripcion] = useState(initial?.descripcion ?? "");
  const [activo, setActivo] = useState(initial?.activo ?? true);
  const [file, setFile] = useState<FilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadFile(selected?: File) {
    setError(null);
    if (!selected) return setFile(null);
    const isVideo = selected.type.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/i.test(selected.name);
    const isImage = selected.type.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(selected.name);
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    if (selected.size > maxBytes) {
      setFile(null);
      return setError(`El archivo supera el tamaño máximo permitido de ${Math.floor(maxBytes / 1_000_000)} MB.`);
    }
    const dataUrl = await readDataUrl(selected);
    setFile({
      archivoBase64: dataUrl.split(",")[1] ?? "",
      archivoNombreOriginal: selected.name,
      archivoMimeType: selected.type,
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!titulo.trim()) return setError("El título del archivo es obligatorio.");
    if (!initial && !file) return setError("Debe cargar un archivo.");
    onSubmit({ titulo, slug, descripcion, activo, ...(file ?? {}) });
  }

  return (
    <form onSubmit={submit}>
      {error && <Alerta tipo="error">{error}</Alerta>}
      <div className="fila-formulario"><label>Título *</label><input value={titulo} onChange={(e) => setTitulo(e.target.value)} /></div>
      <div className="fila-formulario"><label>Endpoint del archivo</label><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="Se genera desde el título si se deja vacío" /></div>
      <div className="fila-formulario"><label>Descripción</label><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={3} /></div>
      <div className="fila-formulario"><label htmlFor="public-inline-file">Archivo {!initial ? "*" : ""}</label><input id="public-inline-file" type="file" accept={INLINE_FILE_ACCEPT} onChange={(e) => loadFile(e.target.files?.[0])} /></div>
      <p className="texto-ayuda">PDF hasta 8 MB, imágenes JPG/PNG/GIF/WebP hasta 12 MB y videos MP4/M4V/MOV/WebM hasta 100 MB.</p>
      {initial && <p className="texto-ayuda">Archivo actual: {initial.archivoNombreOriginal}</p>}
      {file && <p className="texto-ayuda">Archivo seleccionado: {file.archivoNombreOriginal}</p>}
      <div className="fila-formulario"><label><input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} style={{ width: "auto", marginRight: 6 }} />Activo</label></div>
      <div className="acciones-formulario"><button type="submit" className="primario" disabled={loading}>{loading ? "Guardando..." : "Guardar"}</button></div>
    </form>
  );
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
