import { WhatsNewError } from "./whatsNewModel";

/* Texto enriquecido de Qué hay de nuevo (`05` §8). El contenido es JSON de
   TipTap/ProseMirror validado contra un esquema CERRADO; nunca se guarda HTML.
   - Tipos, marcas y atributos fuera del esquema son error (no se filtran en silencio).
   - Imágenes y adjuntos solo por id interno de archivo (`fileId`), nunca por URL.
   - Enlaces solo http, https y mailto (mailto no en el perfil cliente).
   - Recorrido iterativo con pila explícita: sin recursión, con límites de nodos y profundidad.
   Nombres de nodo alineados con el editor del portal (`mencion`, `adjuntoArchivo`). */

export type RichProfile = "medio" | "compacto" | "cliente";
export type RichNode = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
  content?: RichNode[];
};
export type RichDoc = { type: "doc"; content?: RichNode[] };

export type RichDocResult = {
  doc: RichDoc;
  plainText: string;
  isEmpty: boolean;
  imageFileIds: string[];
  attachmentFileIds: string[];
  mentionUserIds: string[];
};

export const RICH_LIMITS = {
  nodes: 3000,
  depth: 10,
  blocksInDoc: 500,
  itemsInList: 200,
  images: 20,
  attachments: 10,
  links: 100,
  hrefLength: 2000,
  marksPerText: 6,
  plainText: { medio: 60_000, compacto: 6_000, cliente: 20_000 } as Record<RichProfile, number>,
  /** Caracteres del JSON serializado por campo. */
  jsonChars: { que_cambio: 200_000, accion: 20_000, nota: 100_000, cliente: 50_000 },
} as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_OBJECT_KEYS = new Set(["type", "attrs", "marks", "text", "content"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BLOCKS = new Set(["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "image"]);
const INLINES = new Set(["text", "hardBreak", "mencion", "adjuntoArchivo"]);

type AttrRule = (value: unknown) => boolean;
const isNullish = (value: unknown) => value === null || value === undefined;
const optionalInt = (min: number, max: number): AttrRule => (value) =>
  isNullish(value) || (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max);
const optionalString = (max: number): AttrRule => (value) =>
  isNullish(value) || (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));

const NODE_RULES: Record<string, { profiles: RichProfile[]; attrs: Record<string, AttrRule>; required?: string[] }> = {
  doc: { profiles: ["medio", "compacto", "cliente"], attrs: {} },
  paragraph: { profiles: ["medio", "compacto", "cliente"], attrs: { textAlign: (v) => isNullish(v) || v === "left" } },
  heading: { profiles: ["medio", "cliente"], attrs: { level: (v) => v === 2 || v === 3 }, required: ["level"] },
  bulletList: { profiles: ["medio", "compacto", "cliente"], attrs: {} },
  orderedList: { profiles: ["medio", "compacto", "cliente"], attrs: { start: optionalInt(1, 999), type: (v) => isNullish(v) || v === "1" } },
  listItem: { profiles: ["medio", "compacto", "cliente"], attrs: {} },
  blockquote: { profiles: ["medio", "cliente"], attrs: {} },
  codeBlock: { profiles: ["medio"], attrs: { language: (v) => isNullish(v) || v === "sql" } },
  horizontalRule: { profiles: ["medio", "cliente"], attrs: {} },
  hardBreak: { profiles: ["medio", "compacto", "cliente"], attrs: {} },
  text: { profiles: ["medio", "compacto", "cliente"], attrs: {} },
  image: {
    profiles: ["medio", "cliente"],
    attrs: {
      fileId: (v) => typeof v === "string" && GUID.test(v),
      // `src` solo puede venir vacío o apuntar al propio archivo; el servidor lo elimina al guardar.
      src: () => true,
      alt: optionalString(200),
      title: optionalString(200),
      width: optionalInt(16, 2000),
      height: optionalInt(16, 2000),
    },
    required: ["fileId"],
  },
  adjuntoArchivo: {
    profiles: ["medio"],
    attrs: {
      fileId: (v) => typeof v === "string" && GUID.test(v),
      href: () => true,
      nombre: (v) => typeof v === "string" && v.trim().length >= 1 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v),
      tamano: optionalInt(0, 100_000_000),
    },
    required: ["fileId", "nombre"],
  },
  mencion: {
    profiles: ["medio", "compacto"],
    attrs: {
      id: (v) => typeof v === "string" && v.length >= 1 && v.length <= 150 && /^[A-Za-z0-9_.@:-]+$/.test(v),
      etiqueta: (v) => typeof v === "string" && v.length <= 160 && !/[\u0000-\u001f\u007f]/.test(v),
    },
    required: ["id"],
  },
};

const MARK_RULES: Record<string, Record<string, AttrRule>> = {
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  code: {},
  link: { href: () => true, target: () => true, rel: () => true, class: () => true },
  textStyle: {
    color: (v) => isNullish(v) || (typeof v === "string" && (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) || /^rgba?\(\s*[\d.\s,%]+\)$/i.test(v))),
  },
};

function invalid(path: string, rule: string): WhatsNewError {
  return new WhatsNewError(400, "texto_enriquecido_invalido", "El contenido tiene un formato no permitido.", { path, rule });
}

export function validateHref(href: unknown, profile: RichProfile): string | null {
  if (typeof href !== "string" || href.length === 0 || href.length > RICH_LIMITS.hrefLength) return null;
  if (/[\u0000- \u007f]/.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!url.hostname || url.username || url.password) return null;
    return url.toString();
  }
  if (url.protocol === "mailto:" && profile !== "cliente") {
    const address = href.slice("mailto:".length);
    if (!/^[^\s@?&#/]+@[^\s@?&#/]+\.[^\s@?&#/]+$/.test(address)) return null;
    return `mailto:${address}`;
  }
  return null;
}

/** Analiza JSON rechazando claves peligrosas (`__proto__`, `constructor`). */
export function parseRichJson(raw: string, maxChars: number): unknown {
  if (raw.length > maxChars) {
    throw new WhatsNewError(413, "contenido_muy_grande", `El contenido supera el tamaño permitido (${maxChars}).`);
  }
  try {
    return JSON.parse(raw, (key, value) => {
      if (FORBIDDEN_KEYS.has(key)) throw new Error("forbidden key");
      return value;
    });
  } catch {
    throw invalid("$", "json");
  }
}

/** Valida y normaliza un documento. Devuelve el documento limpio (sin `src`, `href` de archivo, `target`, `rel`). */
export function validateRichDoc(input: unknown, profile: RichProfile, maxJsonChars: number): RichDocResult {
  const serialized = JSON.stringify(input ?? null);
  if (serialized === undefined || serialized.length > maxJsonChars) {
    throw new WhatsNewError(413, "contenido_muy_grande", `El contenido supera el tamaño permitido (${maxJsonChars}).`);
  }
  if (!input || typeof input !== "object" || Array.isArray(input) || (input as RichNode).type !== "doc") {
    throw invalid("$", "doc");
  }

  const imageFileIds: string[] = [];
  const attachmentFileIds: string[] = [];
  const mentionUserIds: string[] = [];
  let nodeCount = 0;
  let linkCount = 0;

  const root: RichNode = { type: "doc" };
  type Frame = { source: unknown; path: string; depth: number; parentType: string | null; output: RichNode[] };
  const rootOutput: RichNode[] = [];
  const stack: Frame[] = [{ source: input, path: "$", depth: 1, parentType: null, output: rootOutput }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { source, path, depth, parentType } = frame;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw invalid(path, "nodo");
    const node = source as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      if (!ALLOWED_OBJECT_KEYS.has(key)) throw invalid(path, `clave:${key}`);
    }
    nodeCount += 1;
    if (nodeCount > RICH_LIMITS.nodes) throw invalid(path, "demasiados_nodos");
    if (depth > RICH_LIMITS.depth) throw invalid(path, "profundidad");

    const type = node.type;
    if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(NODE_RULES, type)) throw invalid(path, "tipo");
    const rule = NODE_RULES[type];
    if (!rule.profiles.includes(profile)) throw invalid(path, `tipo_no_permitido:${type}`);
    if (type === "doc" && parentType !== null) throw invalid(path, "doc_anidado");
    if (parentType === null && type !== "doc") throw invalid(path, "doc");

    // Ubicación: bloques dentro de doc/blockquote/listItem; en línea dentro de párrafo/encabezado/código.
    if (parentType) {
      const inlineParent = parentType === "paragraph" || parentType === "heading" || parentType === "codeBlock";
      if (inlineParent && !INLINES.has(type)) throw invalid(path, "ubicacion");
      if (!inlineParent && INLINES.has(type)) throw invalid(path, "ubicacion");
      if ((parentType === "bulletList" || parentType === "orderedList") && type !== "listItem") throw invalid(path, "ubicacion");
      if (type === "listItem" && parentType !== "bulletList" && parentType !== "orderedList") throw invalid(path, "ubicacion");
      if (parentType === "codeBlock" && type !== "text") throw invalid(path, "ubicacion");
      if (!inlineParent && type !== "listItem" && !BLOCKS.has(type)) throw invalid(path, "ubicacion");
    }

    // Atributos
    const out: RichNode = type === "doc" ? root : { type };
    const attrsIn = node.attrs;
    if (attrsIn !== undefined && attrsIn !== null) {
      if (typeof attrsIn !== "object" || Array.isArray(attrsIn)) throw invalid(`${path}.attrs`, "attrs");
      for (const [key, value] of Object.entries(attrsIn as Record<string, unknown>)) {
        const check = Object.prototype.hasOwnProperty.call(rule.attrs, key) ? rule.attrs[key] : undefined;
        if (!check || FORBIDDEN_KEYS.has(key) || !check(value)) throw invalid(`${path}.attrs.${key}`, "atributo");
      }
    }
    const attrs = (attrsIn ?? {}) as Record<string, unknown>;
    for (const key of rule.required ?? []) {
      if (isNullish(attrs[key])) throw invalid(`${path}.attrs.${key}`, "atributo_obligatorio");
    }
    const cleanAttrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (isNullish(value) || key === "src" || key === "href" || key === "textAlign") continue;
      cleanAttrs[key] = value;
    }

    if (type === "image" || type === "adjuntoArchivo") {
      const fileId = String(attrs.fileId).toLowerCase();
      const pointer = type === "image" ? attrs.src : attrs.href;
      if (!isNullish(pointer) && pointer !== "" && pointer !== `/api/whats-new/files/${fileId}`) {
        throw invalid(`${path}.attrs`, "origen_externo");
      }
      cleanAttrs.fileId = fileId;
      if (type === "image") imageFileIds.push(fileId); else attachmentFileIds.push(fileId);
      if (imageFileIds.length > RICH_LIMITS.images) throw invalid(path, "demasiadas_imagenes");
      if (attachmentFileIds.length > RICH_LIMITS.attachments) throw invalid(path, "demasiados_adjuntos");
    }
    if (type === "mencion") {
      mentionUserIds.push(String(attrs.id));
      cleanAttrs.etiqueta = typeof attrs.etiqueta === "string" ? attrs.etiqueta : "";
    }
    if (Object.keys(cleanAttrs).length > 0) out.attrs = cleanAttrs;

    // Texto y marcas
    if (type === "text") {
      if (typeof node.text !== "string" || node.text.length === 0 || node.text.includes("\u0000")) throw invalid(path, "texto");
      out.text = node.text;
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks) || node.marks.length > RICH_LIMITS.marksPerText) throw invalid(`${path}.marks`, "marcas");
        if (parentType === "codeBlock" && node.marks.length > 0) throw invalid(`${path}.marks`, "marcas_en_codigo");
        const seen = new Set<string>();
        const marksOut: NonNullable<RichNode["marks"]> = [];
        node.marks.forEach((mark, index) => {
          const markPath = `${path}.marks[${index}]`;
          if (!mark || typeof mark !== "object" || Array.isArray(mark)) throw invalid(markPath, "marca");
          for (const key of Object.keys(mark)) {
            if (key !== "type" && key !== "attrs") throw invalid(markPath, `clave:${key}`);
          }
          const markType = (mark as { type?: unknown }).type;
          if (typeof markType !== "string" || !Object.prototype.hasOwnProperty.call(MARK_RULES, markType) || seen.has(markType)) {
            throw invalid(markPath, "marca");
          }
          seen.add(markType);
          const markAttrs = (mark as { attrs?: unknown }).attrs ?? {};
          if (typeof markAttrs !== "object" || Array.isArray(markAttrs) || markAttrs === null) throw invalid(markPath, "attrs");
          for (const [key, value] of Object.entries(markAttrs as Record<string, unknown>)) {
            const check = Object.prototype.hasOwnProperty.call(MARK_RULES[markType], key) ? MARK_RULES[markType][key] : undefined;
            if (!check || FORBIDDEN_KEYS.has(key) || !check(value)) throw invalid(`${markPath}.attrs.${key}`, "atributo");
          }
          if (markType === "link") {
            const href = validateHref((markAttrs as { href?: unknown }).href, profile);
            if (!href) throw invalid(`${markPath}.attrs.href`, "enlace");
            linkCount += 1;
            if (linkCount > RICH_LIMITS.links) throw invalid(markPath, "demasiados_enlaces");
            marksOut.push({ type: "link", attrs: { href } });
          } else if (markType === "textStyle") {
            const color = (markAttrs as { color?: unknown }).color;
            if (!isNullish(color)) marksOut.push({ type: "textStyle", attrs: { color } });
          } else {
            marksOut.push({ type: markType });
          }
        });
        if (seen.has("code") && seen.has("link")) throw invalid(`${path}.marks`, "codigo_con_enlace");
        if (marksOut.length > 0) out.marks = marksOut;
      }
    } else if (node.text !== undefined || node.marks !== undefined) {
      throw invalid(path, "texto_fuera_de_text");
    }

    // Contenido
    const leaf = type === "text" || type === "hardBreak" || type === "horizontalRule" || type === "image"
      || type === "adjuntoArchivo" || type === "mencion";
    if (node.content !== undefined) {
      if (leaf || !Array.isArray(node.content)) throw invalid(`${path}.content`, "contenido");
      const max = type === "doc" ? RICH_LIMITS.blocksInDoc
        : type === "bulletList" || type === "orderedList" ? RICH_LIMITS.itemsInList
          : RICH_LIMITS.nodes;
      if (node.content.length > max) throw invalid(`${path}.content`, "demasiados_hijos");
      if ((type === "bulletList" || type === "orderedList") && node.content.length === 0) throw invalid(`${path}.content`, "lista_vacia");
      // The root must share its output buffer with the final document. A
      // separate array here would discard every validated root child below.
      const children: RichNode[] = type === "doc" ? rootOutput : [];
      out.content = children;
      // Se apilan en orden inverso para procesar en orden y conservar el orden de salida.
      const childFrames: Frame[] = node.content.map((child, index) => ({
        source: child, path: `${path}.content[${index}]`, depth: depth + 1, parentType: type, output: children,
      }));
      for (let index = childFrames.length - 1; index >= 0; index -= 1) stack.push(childFrames[index]);
    }
    if (type === "listItem") {
      const first = Array.isArray(node.content) ? (node.content[0] as { type?: unknown } | undefined) : undefined;
      if (!first || first.type !== "paragraph") throw invalid(path, "item_sin_parrafo");
    }
    if (type !== "doc") frame.output.push(out);
  }

  root.content = rootOutput;
  if (rootOutput.length === 0) delete root.content;
  const doc = root as RichDoc;
  const plainText = extractPlainText(doc);
  if (plainText.length > RICH_LIMITS.plainText[profile]) {
    throw new WhatsNewError(413, "contenido_muy_grande", `El contenido supera el tamaño permitido (${RICH_LIMITS.plainText[profile]}).`);
  }
  return {
    doc,
    plainText,
    isEmpty: plainText.trim().length === 0 && imageFileIds.length === 0 && attachmentFileIds.length === 0,
    imageFileIds,
    attachmentFileIds,
    mentionUserIds,
  };
}

/** Texto plano (`05` §9). Iterativo. Sirve para búsqueda, resumen, reporte y correo; siempre se escapa al mostrar. */
export function extractPlainText(doc: RichDoc, options: { forReport?: boolean } = {}): string {
  const parts: string[] = [];
  type Item = { node: RichNode; indent: number; listIndex?: number } | { close: string };
  const stack: Item[] = [{ node: doc as RichNode, indent: 0 }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if ("close" in item) {
      parts.push(item.close);
      continue;
    }
    const { node, indent } = item;
    switch (node.type) {
      case "text": {
        const link = node.marks?.find((mark) => mark.type === "link");
        const href = link?.attrs?.href;
        parts.push(node.text ?? "");
        if (options.forReport && typeof href === "string" && href !== node.text) parts.push(` (${href})`);
        continue;
      }
      case "hardBreak":
      case "horizontalRule":
        parts.push("\n");
        continue;
      case "mencion":
        parts.push(`@${String(node.attrs?.etiqueta ?? "")}`);
        continue;
      case "image":
        parts.push(node.attrs?.alt ? `[Imagen: ${String(node.attrs.alt)}]` : "[Imagen]");
        continue;
      case "adjuntoArchivo":
        parts.push(`[Adjunto: ${String(node.attrs?.nombre ?? "")}]`);
        continue;
      default:
        break;
    }
    const children = node.content ?? [];
    const isBlockWithText = node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock";
    if (node.type === "listItem") {
      const prefix = item.listIndex === undefined ? "• " : `${item.listIndex}. `;
      parts.push(`${" ".repeat(indent * 2)}${prefix}`);
    }
    if (isBlockWithText || node.type === "blockquote") stack.push({ close: "\n" });
    const nextIndent = node.type === "bulletList" || node.type === "orderedList" ? indent + 1 : indent;
    const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      const listIndex = node.type === "orderedList" ? start + index : undefined;
      // Los ítems se sangran respecto de su lista (indent-1 → 0 para el primer nivel).
      stack.push({ node: child, indent: child.type === "listItem" ? nextIndent - 1 : nextIndent, listIndex });
    }
  }
  return parts.join("")
    .normalize("NFC")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function summaryLine(plainText: string, max = 300): string | null {
  const line = plainText.split("\n").map((value) => value.trim()).find((value) => value.length > 0);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Reescribe `etiqueta` de cada mención con el nombre vigente (no se puede suplantar). */
export function rewriteMentions(doc: RichDoc, names: Map<string, string>): RichDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as RichDoc;
  const stack: RichNode[] = [copy as RichNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "mencion") {
      const id = String(node.attrs?.id ?? "");
      const name = names.get(id);
      if (name === undefined) throw invalid("$", "mencion_desconocida");
      node.attrs = { id, etiqueta: name };
    }
    for (const child of node.content ?? []) stack.push(child);
  }
  return copy;
}

/** Copia «Qué cambió» al perfil cliente (QA-13): quita menciones, adjuntos y bloques de código; quita mailto. */
export function toClientProfile(doc: RichDoc): RichDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as RichDoc;
  const stack: RichNode[] = [copy as RichNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!node.content) continue;
    const next: RichNode[] = [];
    for (const child of node.content) {
      if (child.type === "mencion" || child.type === "adjuntoArchivo" || child.type === "image") continue;
      if (child.type === "codeBlock") {
        continue;
      }
      if (child.type === "text" && child.marks) {
        child.marks = child.marks.filter((mark) => !(mark.type === "link" && String(mark.attrs?.href ?? "").startsWith("mailto:")));
        if (child.marks.length === 0) delete child.marks;
      }
      next.push(child);
    }
    node.content = next;
    for (const child of next) stack.push(child);
  }
  return copy;
}

/** Reemplaza ids de archivo (para las copias públicas de imágenes del texto para clientes). */
export function replaceFileIds(doc: RichDoc, mapping: Map<string, string>): RichDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as RichDoc;
  const stack: RichNode[] = [copy as RichNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ((node.type === "image" || node.type === "adjuntoArchivo") && node.attrs?.fileId) {
      const replacement = mapping.get(String(node.attrs.fileId));
      if (replacement) node.attrs = { ...node.attrs, fileId: replacement };
    }
    for (const child of node.content ?? []) stack.push(child);
  }
  return copy;
}

/** Agrega `src` a las imágenes para una salida pública (la ruta pública la decide el servidor). */
export function withImageSources(doc: RichDoc, srcFor: (fileId: string) => string): RichDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as RichDoc;
  const stack: RichNode[] = [copy as RichNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "image" && node.attrs?.fileId) node.attrs = { ...node.attrs, src: srcFor(String(node.attrs.fileId)) };
    for (const child of node.content ?? []) stack.push(child);
  }
  return copy;
}
