import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorEnriquecido, VisorEnriquecido } from "../pages/queHayDeNuevo/componentes/EditorEnriquecido";
import { safeDisplayDoc } from "../pages/queHayDeNuevo/contrato";
import type { DocEnriquecido } from "../pages/queHayDeNuevo/tipos";
import { instalarPolyfillsEditor } from "./queHayDeNuevoHelpers";

const { getBlob } = vi.hoisted(() => ({ getBlob: vi.fn() }));
vi.mock("../api/client", () => ({ api: { getBlob } }));

const IMAGE = "55d9c026-33a1-43d8-b719-34f5dad0cb2a";
const ATTACHMENT = "7fc4bf9a-5796-42b3-b2ed-298abe61e146";
const BLOB_URL = "blob:https://portal.test/fixture-media";
const UNTRUSTED_URL = "https://untrusted.invalid/media?private=fixture";
const richText: DocEnriquecido = { type: "doc", content: [{
  type: "paragraph",
  content: [
    { type: "text", text: "Conserva la negrita", marks: [{ type: "bold" }] },
    { type: "text", text: " y la cursiva", marks: [{ type: "italic" }] },
  ],
}] };

function descendants(doc: DocEnriquecido): DocEnriquecido[] {
  return [doc, ...(doc.content ?? []).flatMap(descendants)];
}

describe("Qué hay de nuevo · editor privado", () => {
  beforeAll(instalarPolyfillsEditor);
  beforeEach(() => {
    getBlob.mockReset();
    const OriginalURL = URL;
    vi.stubGlobal("URL", class extends OriginalURL {
      static createObjectURL = vi.fn(() => BLOB_URL);
      static revokeObjectURL = vi.fn();
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("conserva las marcas de texto al guardar una imagen y un adjunto verificados por ID", async () => {
    const image = new File(["fixture PNG"], "diagrama.png", { type: "image/png" });
    const pdf = new File(["fixture PDF"], "guia.pdf", { type: "application/pdf" });
    const upload = vi.fn(async (file: File, kind: "imagen" | "documento") => ({
      fileId: kind === "imagen" ? IMAGE : ATTACHMENT,
      name: file.name,
      mime: file.type,
      bytes: file.size,
      // Even extra fields in a response must never enter the saved rich-text JSON.
      url: UNTRUSTED_URL,
    }));
    const onChange = vi.fn();
    getBlob.mockResolvedValue(new Blob(["fixture PNG"], { type: "image/png" }));
    function ControlledEditor() {
      const [value, setValue] = useState(richText);
      return <EditorEnriquecido valor={value} onChange={(doc) => { setValue(doc); onChange(doc); }}
        ariaLabel="Qué cambió" perfil="medio" archivosPrivados cargarArchivo={upload} />;
    }
    const { container, unmount } = render(<ControlledEditor />);
    await screen.findByRole("textbox", { name: "Qué cambió" });
    const imageInput = container.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]')!;
    const pdfInput = container.querySelector<HTMLInputElement>('input[type="file"][accept*="application/pdf"]')!;
    expect(imageInput).not.toBeNull();
    expect(pdfInput).not.toBeNull();
    fireEvent.change(imageInput, { target: { files: [image] } });
    expect(await screen.findByRole("img", { name: "diagrama.png" })).toHaveAttribute("src", BLOB_URL);
    fireEvent.change(pdfInput, { target: { files: [pdf] } });
    await screen.findByRole("button", { name: "Descargar guia.pdf" });

    const saved = onChange.mock.lastCall?.[0] as DocEnriquecido;
    const nodes = descendants(saved);
    expect(upload.mock.calls).toEqual([[image, "imagen"], [pdf, "documento"]]);
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Conserva la negrita", marks: [{ type: "bold" }] }),
      expect.objectContaining({ type: "text", text: " y la cursiva", marks: [{ type: "italic" }] }),
      expect.objectContaining({ type: "image", attrs: expect.objectContaining({ fileId: IMAGE, alt: image.name }) }),
      expect.objectContaining({ type: "adjuntoArchivo", attrs: expect.objectContaining({ fileId: ATTACHMENT, nombre: pdf.name, tamano: pdf.size }) }),
    ]));
    expect(nodes.filter((n) => ["image", "adjuntoArchivo"].includes(n.type ?? "")).every(
      (n) => !("src" in (n.attrs ?? {})) && !("href" in (n.attrs ?? {})),
    )).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(UNTRUSTED_URL);
    expect(JSON.stringify(saved)).not.toContain(BLOB_URL);
    expect(getBlob).toHaveBeenCalledWith(`/whats-new/files/${IMAGE}`, { signal: expect.any(AbortSignal) });
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
  });

  it("sube una imagen pegada y la inserta en el lugar del portapapeles, aunque el cursor cambie durante la carga", async () => {
    const image = new File(["fixture PNG"], "portapapeles.png", { type: "image/png" });
    const verified = { fileId: IMAGE, name: image.name, mime: image.type, bytes: image.size };
    let completeUpload!: (saved: typeof verified) => void;
    const uploadResult = new Promise<typeof verified>(resolve => { completeUpload = resolve; });
    const upload = vi.fn(() => uploadResult);
    const onChange = vi.fn();
    getBlob.mockResolvedValue(new Blob(["fixture PNG"], { type: "image/png" }));
    function ControlledEditor() {
      const [value, setValue] = useState(richText);
      return <EditorEnriquecido valor={value} onChange={(doc) => { setValue(doc); onChange(doc); }}
        ariaLabel="Qué cambió" perfil="medio" archivosPrivados cargarArchivo={upload} />;
    }
    render(<ControlledEditor />);
    const textbox = await screen.findByRole("textbox", { name: "Qué cambió" }) as HTMLElement & { editor: Editor };
    act(() => { textbox.editor.commands.setTextSelection(1 + "Conserva la negrita".length); });
    fireEvent.paste(textbox, { clipboardData: {
      files: [image],
      items: [{ kind: "file", type: image.type, getAsFile: () => image }],
      getData: () => "",
    } });
    await waitFor(() => expect(upload).toHaveBeenCalledExactlyOnceWith(image, "imagen"));
    act(() => { textbox.editor.commands.setTextSelection(1); });
    await act(async () => { completeUpload(verified); await uploadResult; });
    expect(await screen.findByRole("img", { name: "portapapeles.png" })).toHaveAttribute("src", BLOB_URL);

    const doc = onChange.mock.lastCall?.[0] as DocEnriquecido;
    const nodes = descendants(doc).filter(n => n.type === "text" || n.type === "image");
    expect(nodes).toEqual([
      expect.objectContaining({ type: "text", text: "Conserva la negrita", marks: [{ type: "bold" }] }),
      expect.objectContaining({ type: "image", attrs: expect.objectContaining({ fileId: IMAGE }) }),
      expect.objectContaining({ type: "text", text: " y la cursiva", marks: [{ type: "italic" }] }),
    ]);
    expect(JSON.stringify(doc)).not.toContain(BLOB_URL);
  });

  it("renderiza y descarga por ID privado, pero nunca pide esos archivos al mostrar el texto público", async () => {
    const input: DocEnriquecido = { type: "doc", content: [
      { type: "paragraph", content: [
        { type: "text", text: "Texto seguro", marks: [{ type: "bold" }] },
        { type: "adjuntoArchivo", attrs: { fileId: ATTACHMENT, nombre: "guia.pdf", href: UNTRUSTED_URL } },
      ] },
      { type: "image", attrs: { fileId: IMAGE, alt: "Figura privada", src: UNTRUSTED_URL } },
    ] };
    getBlob.mockImplementation((path: string) => Promise.resolve(path.endsWith(IMAGE)
      ? new Blob(["img"], { type: "image/png" }) : new Blob(["doc"], { type: "application/pdf" })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const privateDoc = safeDisplayDoc(input, false, true);
    expect(JSON.stringify(privateDoc)).not.toContain(UNTRUSTED_URL);
    const { rerender } = render(<VisorEnriquecido valor={privateDoc} archivosPrivados />);
    expect(await screen.findByRole("img", { name: "Figura privada" })).toHaveAttribute("src", BLOB_URL);
    fireEvent.click(screen.getByRole("button", { name: "Descargar guia.pdf" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(getBlob.mock.calls.map(([path]) => path)).toEqual([
      `/whats-new/files/${IMAGE}`, `/whats-new/files/${ATTACHMENT}`,
    ]);

    const publicDoc = safeDisplayDoc(input, true, true);
    expect(JSON.stringify(publicDoc)).not.toMatch(new RegExp(`${IMAGE}|${ATTACHMENT}|untrusted\\.invalid`));
    getBlob.mockClear();
    rerender(<VisorEnriquecido valor={publicDoc} />);
    expect(await screen.findByText("Texto seguro")).toHaveProperty("tagName", "STRONG");
    expect(screen.queryByRole("img", { name: "Figura privada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Descargar guia.pdf" })).not.toBeInTheDocument();
    expect(getBlob).not.toHaveBeenCalled();
  });
});
