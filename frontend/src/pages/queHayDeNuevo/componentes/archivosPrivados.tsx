import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { api } from "../../../api/client";

export type TipoArchivoPrivado = "imagen" | "documento" | "video";
export type DestinoArchivoPrivado = "que_cambio" | "reglas_negocio" | "video";
export type ArchivoPrivado = { fileId: string; name: string; mime: string; bytes: number };
const valido = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const ruta = (id: string) => `/whats-new/files/${encodeURIComponent(id)}`;
export const tiposImagenPrivada = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const tiposDocumentoPrivado = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
export const aceptaDocumentoPrivado = [...tiposDocumentoPrivado, ".pdf", ".docx", ".xlsx"].join(",");
export const tiposVideoPrivado = ["video/mp4", "video/webm"];
const tiposPorClase = { imagen: tiposImagenPrivada, documento: tiposDocumentoPrivado, video: tiposVideoPrivado };
const limiteMb = { imagen: 5, documento: 20, video: 30 };
let imageReads: Promise<unknown> = Promise.resolve();

function leerImagen(id: string, signal: AbortSignal) {
  // A long draft renders both the editor and the preview; serialize image
  // reads so neither leaves the Function saturated or images blank on load.
  const request = imageReads.then(() => {
    signal.throwIfAborted();
    return api.getBlob(ruta(id), { signal });
  });
  imageReads = request.catch(() => undefined);
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

function VistaImagenPrivada({ node }: NodeViewProps) {
  const id = node.attrs.fileId;
  const [attempt, setAttempt] = useState(0);
  const [media, setMedia] = useState<{ id: string; url?: string; attempt: number }>();
  useEffect(() => {
    if (!valido(id)) return;
    const control = new AbortController();
    let url: string | undefined;
    void leerImagen(id, control.signal).then(blob => {
      if (control.signal.aborted) return;
      if (!tiposImagenPrivada.includes(blob.type)) throw new Error();
      url = URL.createObjectURL(blob);
      setMedia({ id, url, attempt });
    }).catch(() => { if (!control.signal.aborted) setMedia({ id, attempt }); });
    return () => { control.abort(); if (url) URL.revokeObjectURL(url); };
  }, [id, attempt]);
  const texto = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  return <NodeViewWrapper className="qhdn-imagen" contentEditable={false}>
    {!valido(id) ? <span>Imagen no disponible.</span> : media?.id !== id || media.attempt !== attempt ? <span role="status">Cargando imagen…</span>
      : media.url ? <img src={media.url} alt={texto} loading="lazy" /> : <span role="status">Imagen no disponible. <button type="button" onClick={() => setAttempt(attempt + 1)}>Reintentar</button></span>}
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
