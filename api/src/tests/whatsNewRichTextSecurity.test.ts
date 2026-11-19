import { describe, expect, it } from "vitest";
import { WhatsNewError } from "../lib/whatsNewModel";
import {
  parseRichJson, RICH_LIMITS, rewriteMentions, toClientProfile, validateHref, validateRichDoc,
  type RichDoc, type RichNode,
} from "../lib/whatsNewRichText";

// Independent QA: only the closed JSON/profile contract is asserted here.
// File ownership/public-image provenance belongs to command/service tests.
const FILE = "abcdef12-1234-4123-8123-123456789abc";
const paragraph = (content: RichNode[]): RichNode => ({ type: "paragraph", content });
const text = (value = "Visible"): RichNode => ({ type: "text", text: value });
const doc = (...content: RichNode[]): RichDoc => ({ type: "doc", content });
const validate = (input: unknown) => validateRichDoc(input, "medio", 200_000);
function rejectsControlled(run: () => unknown, status = 400) {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WhatsNewError);
  expect(error).toMatchObject({ status });
}

describe("Qué hay de nuevo independent rich-text security", () => {
  it("rejects oversized raw JSON before parsing and oversized documents before traversal", () => {
    rejectsControlled(() => parseRichJson("x".repeat(101), 100), 413);
    rejectsControlled(() => validateRichDoc(doc(paragraph([text("x".repeat(101))])), "medio", 100), 413);
    rejectsControlled(() => parseRichJson('{"type":', 100));
  });

  it("rejects depth above ten using a controlled domain error", () => {
    let nested = paragraph([text()]);
    for (let i = 0; i < RICH_LIMITS.depth; i++) nested = { type: "blockquote", content: [nested] };
    rejectsControlled(() => validate(doc(nested)));
  });

  it("rejects node and plain-text budgets independently of serialized size", () => {
    const input = doc(...Array.from({ length: 500 }, () => paragraph(Array.from({ length: 6 }, () => text("x")))));
    rejectsControlled(() => validate(input));
    rejectsControlled(() => validate(doc(paragraph([text("x".repeat(RICH_LIMITS.plainText.medio + 1))]))), 413);
  });

  it.each(["iframe", "script", "video", "__proto__", "constructor", "toString"])("rejects unknown/prototype node %s", (type) => {
    rejectsControlled(() => validate(doc({ type })));
  });

  it.each(["onerror", "style", "toString", "constructor", "__proto__"])("rejects unknown/prototype node attribute %s", (key) => {
    const attrs = JSON.parse(`{${JSON.stringify(key)}:"untrusted"}`) as Record<string, unknown>;
    rejectsControlled(() => validate(doc({ type: "paragraph", attrs, content: [text()] })));
  });

  it.each(["script", "__proto__", "constructor", "toString"])("rejects unknown/prototype mark %s", (type) => {
    rejectsControlled(() => validate(doc(paragraph([{ ...text(), marks: [{ type }] }]))));
  });

  it.each(["onclick", "style", "toString", "constructor", "__proto__"])("rejects unknown/prototype mark attribute %s with a domain error", (key) => {
    const attrs = JSON.parse(`{${JSON.stringify(key)}:"untrusted"}`) as Record<string, unknown>;
    rejectsControlled(() => validate(doc(paragraph([{ ...text(), marks: [{ type: "bold", attrs }] }]))));
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects dangerous JSON key %s at arbitrary nesting", (key) => {
    const raw = `{"type":"doc","content":[{"type":"paragraph","attrs":{${JSON.stringify(key)}:{"polluted":true}}}]}`;
    rejectsControlled(() => parseRichJson(raw, 20_000));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>",
    "blob:https://example.test/id", "file:///private", "//tracking.example.test/x",
    "https://user:password@example.test/", "https://example.test/a b", "https:\n//example.test/",
    "mailto:person@example.test?bcc=other@example.test",
  ])("rejects unsafe hyperlink %s", (href) => {
    expect(validateHref(href, "medio")).toBeNull();
    rejectsControlled(() => validate(doc(paragraph([{ ...text(), marks: [{ type: "link", attrs: { href } }] }]))));
  });

  it.each(["http://tracking.example.test/pixel", "https://tracking.example.test/pixel", "data:image/png;base64,AAAA", "javascript:alert(1)"])("rejects external image source %s", (src) => {
    rejectsControlled(() => validate(doc({ type: "image", attrs: { fileId: FILE, src } })));
  });

  it("allows documented http/https hyperlinks but never preserves target/rel/class supplied by callers", () => {
    for (const href of ["http://example.test/help", "https://example.test/help"]) {
      const input = doc(paragraph([{ ...text(), marks: [{ type: "link", attrs: { href, target: "evil", rel: "opener", class: "injected" } }] }]));
      const before = JSON.stringify(input);
      const result = validate(input);
      expect(result.doc.content?.[0].content?.[0].marks).toEqual([{ type: "link", attrs: { href } }]);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("roundtrips internal mentions and file identifiers without mutating the original input", () => {
    const input = doc(paragraph([
      text("Cambio "), { type: "mencion", attrs: { id: "user-1", etiqueta: "Asesor" } },
      { type: "adjuntoArchivo", attrs: { fileId: FILE, nombre: "Manual.pdf", tamano: 123 } },
    ]), { type: "image", attrs: { fileId: FILE, alt: "Captura" } });
    const before = JSON.stringify(input);
    const result = validate(input);
    expect(result.doc).toEqual(input);
    expect(result.mentionUserIds).toEqual(["user-1"]);
    expect(result.attachmentFileIds).toEqual([FILE]);
    expect(result.imageFileIds).toEqual([FILE]);
    expect(validate(result.doc).doc).toEqual(result.doc);
    const rewritten = rewriteMentions(result.doc, new Map([["user-1", "Nombre autorizado"]]));
    expect(rewritten.content?.[0].content?.[1].attrs?.etiqueta).toBe("Nombre autorizado");
    expect(JSON.stringify(input)).toBe(before);
    expect(result.doc.content?.[0].content?.[1].attrs?.etiqueta).toBe("Asesor");
    rejectsControlled(() => rewriteMentions(result.doc, new Map()));
  });

  it.each([
    doc(paragraph([{ type: "mencion", attrs: { id: "user-1", etiqueta: "Privado" } }])),
    doc(paragraph([{ type: "adjuntoArchivo", attrs: { fileId: FILE, nombre: "Reglas.pdf" } }])),
    doc({ type: "codeBlock", attrs: { language: "sql" }, content: [text("SELECT secreto")] }),
    doc(paragraph([{ ...text(), marks: [{ type: "link", attrs: { href: "mailto:internal@example.test" } }] }])),
  ])("rejects private-only nodes/links in direct client-profile input %#", (input) => {
    rejectsControlled(() => validateRichDoc(input, "cliente", 50_000));
  });

  it("client conversion removes private media, names, code and mailto without changing its source", () => {
    const input = doc(
      paragraph([text("Publico"), { type: "mencion", attrs: { id: "user-1", etiqueta: "NOMBRE_PRIVADO" } },
        { type: "adjuntoArchivo", attrs: { fileId: FILE, nombre: "REGLAS_PRIVADAS.pdf" } },
        { ...text("Ayuda"), marks: [{ type: "link", attrs: { href: "mailto:private@example.test" } }] }]),
      { type: "image", attrs: { fileId: FILE, src: `/api/whats-new/files/${FILE}`, alt: "CAPTURA_PRIVADA" } },
      { type: "codeBlock", attrs: { language: "sql" }, content: [text("SELECT SECRETO_PRIVADO")] },
    );
    const before = JSON.stringify(input);
    const copied = toClientProfile(input);
    const serialized = JSON.stringify(copied);
    for (const forbidden of [FILE, "NOMBRE_PRIVADO", "REGLAS_PRIVADAS", "CAPTURA_PRIVADA", "SECRETO_PRIVADO", "mailto:"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(copied).toEqual(doc(paragraph([text("Publico"), text("Ayuda")])));
    expect(validateRichDoc(copied, "cliente", 50_000).doc).toEqual(copied);
    expect(JSON.stringify(input)).toBe(before);
  });
});
