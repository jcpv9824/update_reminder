import { mergeAttributes, Node, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extensions";
import { AdjuntoPrivado, ImagenPrivada } from "./archivosPrivados";

/* Extensiones del editor enriquecido. El mismo conjunto valida el JSON en el backend (documento 05). */

/** H-14: la mención inserta el nombre resaltado de un usuario del portal, sin notificación. */
export const Mencion = Node.create({
  name: "mencion",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-usuario"),
        renderHTML: (attrs) => ({ "data-usuario": attrs.id }),
      },
      etiqueta: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-etiqueta") ?? "",
        renderHTML: (attrs) => ({ "data-etiqueta": attrs.etiqueta }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-usuario]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "qhdn-mencion" }), `@${node.attrs.etiqueta}`];
  },
  renderText({ node }) {
    return `@${node.attrs.etiqueta}`;
  },
});

/** Archivo adjunto dentro del texto. En el prototipo, `href` es una URL de objeto local; con la API será el id del archivo. */
export const AdjuntoArchivo = Node.create({
  name: "adjuntoArchivo",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      href: { default: "" },
      nombre: { default: "archivo" },
      tamano: { default: 0 },
    };
  },
  parseHTML() {
    return [{ tag: "a[data-adjunto]" }];
  },
  renderHTML({ node }) {
    return [
      "a",
      {
        "data-adjunto": "true",
        class: "qhdn-adjunto",
        href: node.attrs.href,
        download: node.attrs.nombre,
        target: "_blank",
        rel: "noopener noreferrer",
      },
      `${node.attrs.nombre} (${formatoTamano(node.attrs.tamano)})`,
    ];
  },
  renderText({ node }) {
    return `[${node.attrs.nombre}]`;
  },
});

export function formatoTamano(bytes: number): string {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extensionesEditor({ placeholder, soloLectura, perfil, archivosPrivados }: { placeholder?: string; soloLectura?: boolean; perfil?: "medio" | "compacto" | "cliente"; archivosPrivados?: boolean } = {}): Extensions {
  return [
    StarterKit.configure({
      heading: perfil === "compacto" ? false : { levels: [3] },
      blockquote: perfil === "compacto" ? false : undefined,
      codeBlock: perfil && perfil !== "medio" ? false : undefined,
      code: perfil === "cliente" ? false : undefined,
      horizontalRule: false,
      link: {
        openOnClick: Boolean(soloLectura),
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      },
    }),
    TextStyle,
    Color,
    ...(perfil === "medio" && archivosPrivados ? [ImagenPrivada, AdjuntoPrivado] :
      !perfil ? [Image.configure({ inline: false, allowBase64: false, HTMLAttributes: { class: "qhdn-imagen" } }), AdjuntoArchivo] : []),
    ...(perfil !== "cliente" ? [Mencion] : []),
    Placeholder.configure({ placeholder: placeholder ?? "" }),
  ];
}
