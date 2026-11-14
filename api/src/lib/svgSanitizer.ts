import { DOMParser } from "@xmldom/xmldom";

/*
  Limpieza estructural de SVG para el logo de la compañía.

  El SVG es texto y puede traer código. No basta con filtrar el texto con
  expresiones regulares (entidades, mayúsculas, espacios y espacios de nombres
  las esquivan). Aquí el SVG se analiza como XML y se RECONSTRUYE desde cero
  con una lista blanca: solo salen elementos de dibujo y atributos conocidos,
  con valores ya decodificados y revisados. Lo que no está en la lista no se
  escribe. Se sube el resultado reconstruido, nunca el archivo original.

  - Elementos peligrosos (script, foreignObject, animaciones, feImage…) o
    atributos de evento (on*) → se rechaza la imagen con un mensaje claro.
  - Metadatos de editores (Inkscape, Illustrator, RDF), comentarios e
    instrucciones de proceso → se descartan en silencio.
  - Referencias: solo internas (#id). <image> admite además imágenes
    incrustadas PNG/JPG/GIF/WEBP en base64. Ninguna URL externa.
*/

export class UnsafeSvgError extends Error {}
export class InvalidSvgError extends Error {}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

const MAX_DEPTH = 100;
const MAX_ELEMENTS = 50_000;

const ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath",
  "mask", "pattern", "marker", "image", "style", "filter", "feBlend", "feColorMatrix",
  "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
  "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
  "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
  "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
]);

/* Contenedores que no dibujan: se quitan pero se conserva lo que tienen dentro. */
const UNWRAP = new Set(["a", "switch"]);

/* Su sola presencia indica código o carga externa: se rechaza la imagen. */
const FORBIDDEN = new Set([
  "script", "foreignobject", "iframe", "frame", "embed", "object", "audio", "video", "animate",
  "animatemotion", "animatetransform", "animatecolor", "set", "feimage", "handler", "listener",
  "discard", "link", "meta", "base", "html", "body",
]);

const TEXT_CONTAINERS = new Set(["text", "tspan", "textPath", "title", "desc", "style"]);

const ATTRIBUTES = new Set([
  "id", "class", "style", "transform", "viewBox", "preserveAspectRatio", "width", "height", "x", "y",
  "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "pathLength",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "color",
  "display", "visibility", "clip-path", "clip-rule", "mask", "filter", "font-family", "font-size",
  "font-weight", "font-style", "font-variant", "font-stretch", "text-anchor", "dominant-baseline",
  "alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing", "text-decoration",
  "writing-mode", "direction", "dx", "dy", "rotate", "textLength", "lengthAdjust", "startOffset",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits", "maskUnits",
  "maskContentUnits", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  "marker-start", "marker-mid", "marker-end", "filterUnits", "primitiveUnits", "in", "in2", "result",
  "stdDeviation", "mode", "type", "values", "operator", "k1", "k2", "k3", "k4", "scale",
  "xChannelSelector", "yChannelSelector", "flood-color", "flood-opacity", "lighting-color",
  "surfaceScale", "diffuseConstant", "specularConstant", "specularExponent", "kernelMatrix", "order",
  "divisor", "bias", "targetX", "targetY", "edgeMode", "preserveAlpha", "radius", "baseFrequency",
  "numOctaves", "seed", "stitchTiles", "azimuth", "elevation", "pointsAtX", "pointsAtY", "pointsAtZ",
  "limitingConeAngle", "tableValues", "slope", "intercept", "amplitude", "exponent", "version",
  "shape-rendering", "image-rendering", "text-rendering", "color-interpolation",
  "color-interpolation-filters", "vector-effect", "paint-order", "mix-blend-mode", "isolation",
  "overflow", "enable-background",
]);

const EMBEDDED_RASTER = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

type XmlNode = {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  namespaceURI?: string | null;
  nodeValue?: string | null;
  childNodes?: ArrayLike<XmlNode>;
  attributes?: ArrayLike<{ name: string; localName?: string | null; namespaceURI?: string | null; value: string }>;
};

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/[\t\n\r]/g, " ");
}

/* Quita espacios y caracteres de control que los navegadores ignoran dentro de un esquema. */
function compact(value: string): string {
  return value.replace(/[\x00-\x20\x7F-\x9F]+/g, "").toLowerCase();
}

function assertSafeCss(css: string): void {
  const c = compact(css);
  if (/@import|expression\(|javascript:|vbscript:|behavior:|-moz-binding|\\/.test(c)) {
    throw new UnsafeSvgError("css");
  }
  for (const match of c.matchAll(/url\(([^)]*)\)/g)) {
    if (!/^["']?#/.test(match[1])) throw new UnsafeSvgError("css-url");
  }
}

function assertSafeValue(value: string): void {
  const c = compact(value);
  if (/javascript:|vbscript:|data:text|data:application/.test(c)) throw new UnsafeSvgError("scheme");
  for (const match of c.matchAll(/url\(([^)]*)\)/g)) {
    if (!/^["']?#/.test(match[1])) throw new UnsafeSvgError("url");
  }
}

function safeHref(elementName: string, value: string): boolean {
  const trimmed = value.trim();
  if (/^#[A-Za-z_][\w.:-]*$/.test(trimmed)) return true;
  return elementName === "image" && EMBEDDED_RASTER.test(trimmed);
}

function serializeAttributes(element: XmlNode, name: string): string {
  let out = "";
  const attributes = element.attributes ?? [];
  for (let i = 0; i < attributes.length; i++) {
    const attribute = attributes[i];
    const local = attribute.localName ?? attribute.name;
    const ns = attribute.namespaceURI ?? null;
    if (/^on/i.test(local)) throw new UnsafeSvgError("event");
    if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) continue;
    if (local === "href" && (ns === null || ns === XLINK_NS)) {
      if (!safeHref(name, attribute.value)) throw new UnsafeSvgError("href");
      out += ` ${ns === XLINK_NS ? "xlink:href" : "href"}="${escapeAttribute(attribute.value.trim())}"`;
      continue;
    }
    if (ns === XML_NS && local === "space") {
      out += ` xml:space="${attribute.value === "preserve" ? "preserve" : "default"}"`;
      continue;
    }
    if (ns !== null) continue; // inkscape:, sodipodi:, i:, etc.
    if (!ATTRIBUTES.has(local)) continue;
    if (local === "style") assertSafeCss(attribute.value);
    else assertSafeValue(attribute.value);
    out += ` ${local}="${escapeAttribute(attribute.value)}"`;
  }
  return out;
}

function isSvgNamespace(node: XmlNode): boolean {
  return node.namespaceURI === SVG_NS || node.namespaceURI == null;
}

function serializeChildren(node: XmlNode, parentName: string, depth: number, counter: { elements: number }): string {
  let out = "";
  const children = node.childNodes ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 3 || child.nodeType === 4) {
      // Texto y CDATA: solo dentro de elementos de texto o <style>; se re-escapa siempre.
      if (!TEXT_CONTAINERS.has(parentName)) continue;
      const text = child.nodeValue ?? "";
      if (parentName === "style") assertSafeCss(text);
      out += escapeText(text);
    } else if (child.nodeType === 1) {
      out += serializeElement(child, depth + 1, counter);
    }
    // Comentarios (8), instrucciones de proceso (7) y demás: se descartan.
  }
  return out;
}

function serializeElement(element: XmlNode, depth: number, counter: { elements: number }): string {
  if (depth > MAX_DEPTH) throw new InvalidSvgError("depth");
  if (++counter.elements > MAX_ELEMENTS) throw new InvalidSvgError("size");
  const name = element.localName ?? element.nodeName;
  if (FORBIDDEN.has(name.toLowerCase())) throw new UnsafeSvgError(`element:${name}`);
  if (!isSvgNamespace(element)) return ""; // metadatos de editores y espacios de nombres ajenos
  if (UNWRAP.has(name)) {
    // Se valida igual (un <a href="javascript:"> se rechaza) y se conservan sus hijos.
    serializeAttributes(element, name);
    return serializeChildren(element, "g", depth, counter);
  }
  if (!ELEMENTS.has(name)) return "";
  const attributes = serializeAttributes(element, name);
  const root = depth === 0 ? ` xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"` : "";
  const inner = serializeChildren(element, name, depth, counter);
  return inner ? `<${name}${root}${attributes}>${inner}</${name}>` : `<${name}${root}${attributes}/>`;
}

/**
 * Devuelve el SVG reconstruido con la lista blanca.
 * Lanza UnsafeSvgError si trae código o enlaces externos, e InvalidSvgError si no es un SVG válido.
 */
export function sanitizeSvg(text: string): string {
  // Las DTD permiten entidades (expansión y XXE): no hay logo legítimo que las necesite.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new UnsafeSvgError("dtd");
  let documentElement: XmlNode | null;
  try {
    const parser = new DOMParser({
      onError: (level) => {
        if (level !== "warning") throw new InvalidSvgError("parse");
      },
    });
    documentElement = parser.parseFromString(text, "image/svg+xml").documentElement as unknown as XmlNode | null;
  } catch (error) {
    if (error instanceof UnsafeSvgError) throw error;
    throw new InvalidSvgError("parse");
  }
  if (!documentElement || (documentElement.localName ?? documentElement.nodeName) !== "svg" || !isSvgNamespace(documentElement)) {
    throw new InvalidSvgError("root");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeElement(documentElement, 0, { elements: 0 })}\n`;
}
