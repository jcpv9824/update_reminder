import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { MoveDiagonal } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client";
import { privateImageWidth, validPrivateImageWidth } from "../contrato";
import { escribirAlLado, permiteTextoLateral } from "./imagenConTexto";

export type TipoArchivoPrivado = "imagen" | "documento" | "video";
export type DestinoArchivoPrivado = "que_cambio" | "reglas_negocio" | "video";
export type ArchivoPrivado = { fileId: string; name: string; mime: string; bytes: number };
const valido = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const ruta = (id: string) => `/whats-new/files/${encodeURIComponent(id)}`;
/** Optional module-scoped reader. Default remains the authenticated Novedades endpoint. */
export type PrivateImageReader = (id: string, signal: AbortSignal) => Promise<Blob>;
const defaultImageReader: PrivateImageReader = (id, signal) => api.getBlob(ruta(id), { signal });
export const PrivateImageReaderContext = createContext<PrivateImageReader>(defaultImageReader);
export const tiposImagenPrivada = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const tiposDocumentoPrivado = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
export const aceptaDocumentoPrivado = [...tiposDocumentoPrivado, ".pdf", ".docx", ".xlsx"].join(",");
export const tiposVideoPrivado = ["video/mp4", "video/webm"];
const tiposPorClase = { imagen: tiposImagenPrivada, documento: tiposDocumentoPrivado, video: tiposVideoPrivado };
const limiteMb = { imagen: 5, documento: 20, video: 30 };
let imageReads: Promise<unknown> = Promise.resolve();

function leerImagen(id: string, signal: AbortSignal, reader: PrivateImageReader) {
  // A long draft renders both the editor and the preview; serialize image
  // reads so neither leaves the Function saturated or images blank on load.
  const request = imageReads.then(() => {
    signal.throwIfAborted();
    return reader(id, signal);
  });
  imageReads = request.then(() => undefined, () => undefined);
  return request;
}

export function validarArchivoPrivado(file: File, kind: TipoArchivoPrivado) {
  if (!tiposPorClase[kind].includes(file.type) &&
      !(kind === "documento" && (!file.type || file.type === "application/octet-stream") && /\.(pdf|docx|xlsx)$/i.test(file.name))) throw new Error("Formato de archivo no admitido.");
  if (!file.size || file.size > limiteMb[kind] * 1_000_000) throw new Error(`El archivo debe pesar hasta ${limiteMb[kind]} MB y no estar vacío.`);
}
export async function subirArchivoPrivado(entrada: string, file: File, kind: TipoArchivoPrivado, target: DestinoArchivoPrivado, key: string) {
  validarArchivoPrivado(file, kind);
  const form = new FormData();
  form.set("file", file);
  form.set("kind", kind);
  form.set("target", target);
  const result = await api.postForm<ArchivoPrivado>(`/whats-new/entries/${encodeURIComponent(entrada)}/uploads`, form, { headers: { "Idempotency-Key": key } });
  if (!valido(result?.fileId) || !tiposPorClase[kind].includes(result.mime) || result.bytes !== file.size || typeof result.name !== "string" || !result.name) throw new Error("No se pudo verificar la respuesta de almacenamiento.");
  return result;
}

export function BotonDescargaPrivada({ id, name }: { id: string; name: string }) {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState(false);
  if (!valido(id)) return <span>Archivo no disponible.</span>;
  return <span className="qhdn-adjunto"><button type="button" disabled={ocupado} onClick={async () => {
    setOcupado(true); setError(false);
    try {
      const blob = await api.getBlob(ruta(id));
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url; link.download = name; link.click();
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch { setError(true); } finally { setOcupado(false); }
  }}>{ocupado ? "Descargando…" : name === "Archivo adjunto" ? "Descargar archivo adjunto" : `Descargar ${name}`}</button>
  {error && <span role="alert"> No se pudo descargar. Vuelve a intentarlo.</span>}</span>;
}

const MAX_ANCHO_INICIAL_IMAGEN = 640;

function limitarAncho(width: number) {
  return Math.max(privateImageWidth.min, Math.min(privateImageWidth.max, Math.round(width)));
}

function VistaImagenPrivada({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const reader = useContext(PrivateImageReaderContext);
  const id = node.attrs.fileId;
  const [attempt, setAttempt] = useState(0);
  const [media, setMedia] = useState<{ id: string; url?: string; attempt: number }>();
  const [anchoTemporal, setAnchoTemporal] = useState<number>();
  const [anchoNatural, setAnchoNatural] = useState<number>();
  const imagen = useRef<HTMLImageElement>(null);
  const arrastre = useRef<{ pointerId: number; x: number; width: number }>();
  useEffect(() => {
    if (!valido(id)) return;
    const control = new AbortController();
    let url: string | undefined;
    void leerImagen(id, control.signal, reader).then(blob => {
      if (control.signal.aborted) return;
      if (!tiposImagenPrivada.includes(blob.type)) throw new Error();
      url = URL.createObjectURL(blob);
      setMedia({ id, url, attempt });
    }).catch(() => { if (!control.signal.aborted) setMedia({ id, attempt }); });
    return () => { control.abort(); if (url) URL.revokeObjectURL(url); };
  }, [id, attempt, reader]);
  const texto = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const anchoGuardado = validPrivateImageWidth(node.attrs.width);
  const ancho = anchoTemporal ?? anchoGuardado;
  const anchoBase = () => limitarAncho(imagen.current?.getBoundingClientRect().width || anchoGuardado ||
    Math.min(imagen.current?.naturalWidth || 320, MAX_ANCHO_INICIAL_IMAGEN));
  const aplicarAncho = (width: number) => {
    if (editor.isEditable && anchoGuardado !== width) updateAttributes({ width, height: null });
  };
  function cancelarArrastre(pointerId: number) {
    if (arrastre.current?.pointerId !== pointerId) return;
    arrastre.current = undefined;
    setAnchoTemporal(undefined);
  }
  const permiteAlLado = valido(id) && permiteTextoLateral(editor, getPos());
  return <NodeViewWrapper className={`qhdn-imagen-privada${permiteAlLado ? " qhdn-imagen-privada-con-accion" : ""}`} contentEditable={false}>
    {!valido(id) ? <span>Imagen no disponible.</span> : media?.id !== id || media.attempt !== attempt ? <span role="status">Cargando imagen…</span>
      : media.url ? <div className="qhdn-imagen-marco" style={ancho === undefined ? { maxWidth: `min(100%, ${MAX_ANCHO_INICIAL_IMAGEN}px)` } : undefined}>
        <img ref={imagen} src={media.url} alt={texto} loading="lazy" width={ancho}
          onLoad={() => setAnchoNatural(anchoBase())} />
        {editor.isEditable && <button type="button" className="qhdn-imagen-redimensionar" role="slider"
          aria-label={texto ? `Redimensionar imagen: ${texto}` : "Redimensionar imagen"}
          title="Arrastra o usa las flechas para cambiar el ancho"
          aria-valuemin={privateImageWidth.min} aria-valuemax={privateImageWidth.max}
          aria-valuenow={ancho ?? anchoNatural ?? 320} aria-valuetext={`${ancho ?? anchoNatural ?? 320} píxeles de ancho`}
          onKeyDown={event => {
            const smaller = event.key === "ArrowLeft" || event.key === "ArrowDown";
            // In the side-by-side view a previously wide image may be clamped
            // by its column. Shrink from its visible width, not a hidden one.
            const current = smaller ? Math.min(anchoGuardado ?? Infinity, anchoBase()) : anchoGuardado ?? anchoBase();
            const step = event.shiftKey ? 64 : 16;
            const next = smaller ? current - step
              : event.key === "ArrowRight" || event.key === "ArrowUp" ? current + step
              : event.key === "Home" ? privateImageWidth.min
              : event.key === "End" ? privateImageWidth.max : undefined;
            if (next === undefined) return;
            event.preventDefault(); event.stopPropagation();
            aplicarAncho(limitarAncho(next));
          }}
          onPointerDown={event => {
            if (!event.isPrimary || event.button !== 0 || arrastre.current) return;
            // Resize rather than initiating the editor node's native drag.
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            arrastre.current = { pointerId: event.pointerId, x: event.clientX, width: anchoBase() };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const inicio = arrastre.current;
            if (inicio?.pointerId === event.pointerId) setAnchoTemporal(limitarAncho(inicio.width + event.clientX - inicio.x));
          }}
          onPointerUp={event => {
            const inicio = arrastre.current;
            if (inicio?.pointerId !== event.pointerId) return;
            cancelarArrastre(event.pointerId);
            if (event.clientX !== inicio.x) aplicarAncho(limitarAncho(inicio.width + event.clientX - inicio.x));
          }}
          onPointerCancel={event => cancelarArrastre(event.pointerId)}
          onLostPointerCapture={event => cancelarArrastre(event.pointerId)}>
          <MoveDiagonal size={15} aria-hidden="true" />
        </button>}
      </div> : <span role="status">Imagen no disponible. <button type="button" onClick={() => setAttempt(attempt + 1)}>Reintentar</button></span>}
    {permiteAlLado && <button type="button" className="qhdn-imagen-escribir-al-lado"
      aria-label={texto ? `Escribir al lado de la imagen: ${texto}` : "Escribir al lado de la imagen"}
      onClick={() => escribirAlLado(editor, getPos())}>
      Escribir al lado
    </button>}
  </NodeViewWrapper>;
}

function VistaAdjuntoPrivado({ node }: NodeViewProps) {
  return <NodeViewWrapper as="span" contentEditable={false}><BotonDescargaPrivada id={node.attrs.fileId} name={node.attrs.nombre || "Archivo adjunto"} /></NodeViewWrapper>;
}

// These nodes do not accept network URLs, including pasting arbitrary HTML.
// The authorization-aware node view fetches by ID, never via a URL in the document.
export const ImagenPrivada = Node.create({
  name: "image", group: "block", atom: true, draggable: true,
  addAttributes: () => ({ fileId: { default: null, rendered: false }, alt: { default: null }, title: { default: null }, width: { default: null }, height: { default: null } }),
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { class: "qhdn-imagen" }), "Imagen privada"],
  addNodeView: () => ReactNodeViewRenderer(VistaImagenPrivada),
});

export const AdjuntoPrivado = Node.create({
  name: "adjuntoArchivo", inline: true, group: "inline", atom: true,
  addAttributes: () => ({ fileId: { default: null, rendered: false }, nombre: { default: "Archivo adjunto", rendered: false }, tamano: { default: 0, rendered: false } }),
  renderHTML: () => ["span", { class: "qhdn-adjunto" }, "Archivo privado"],
  addNodeView: () => ReactNodeViewRenderer(VistaAdjuntoPrivado),
});
