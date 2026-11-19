import { describe, expect, it } from "vitest";
import { validateRichDoc, type RichDoc, type RichProfile } from "../lib/whatsNewRichText";

describe("Qué hay de nuevo rich-text roundtrip", () => {
  it.each<RichProfile>(["medio", "compacto", "cliente"])("retains paragraphs and formatted text in %s", (profile) => {
    const input: RichDoc = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Primero", marks: [{ type: "bold" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Después" }] },
    ] };
    const result = validateRichDoc(input, profile, 20_000);
    expect(result.doc).toEqual(input);
    expect(result.plainText).toBe("Primero\nDespués");
    expect(result.isEmpty).toBe(false);
    expect(validateRichDoc(result.doc, profile, 20_000).doc).toEqual(input);
  });

  it("retains nested list ordering and inline nodes", () => {
    const input: RichDoc = { type: "doc", content: [{ type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [
        { type: "text", text: "Uno" }, { type: "hardBreak" }, { type: "text", text: "Dos" },
      ] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Tres" }] }] },
    ] }] };
    const result = validateRichDoc(input, "medio", 20_000);
    expect(result.doc).toEqual(input);
    expect(result.plainText).toBe("• Uno\nDos\n• Tres");
    expect(result.isEmpty).toBe(false);
  });

  it("retains sanitized image nodes and extracted references", () => {
    const fileId = "11111111-1111-4111-8111-111111111111";
    const input: RichDoc = { type: "doc", content: [
      { type: "image", attrs: { fileId, src: `/api/whats-new/files/${fileId}`, alt: "Cambio" } },
    ] };
    const result = validateRichDoc(input, "medio", 20_000);
    expect(result.doc).toEqual({ type: "doc", content: [{ type: "image", attrs: { fileId, alt: "Cambio" } }] });
    expect(result.imageFileIds).toEqual([fileId]);
    expect(result.plainText).toBe("[Imagen: Cambio]");
    expect(result.isEmpty).toBe(false);
    expect(input.content?.[0].attrs?.src).toBe(`/api/whats-new/files/${fileId}`);
  });

  it("recognizes a genuinely empty document", () => {
    const result = validateRichDoc({ type: "doc", content: [] }, "medio", 20_000);
    expect(result.doc).toEqual({ type: "doc" });
    expect(result.isEmpty).toBe(true);
  });
});
