import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { http, points, renderChecklist, resetHttp } from "./checklistTestHelpers";
import { EvidencePanel, PointMediaProvider } from "../pages/checklists/ChecklistEvidence";
import { EditorEnriquecido } from "../pages/queHayDeNuevo/componentes/EditorEnriquecido";
import type { Evidence } from "../pages/checklists/types";
const checklistId = "55555555-5555-4555-8555-555555555555";
const evidenceId = "88888888-8888-4888-8888-888888888888";
const image: Evidence = { id: evidenceId, pointId: points[0].id, kind: "image", status: "saved", fileName: "captura.png", contentType: "image/png", sizeBytes: 20 };
const onAdd = vi.fn(); const onRemove = vi.fn();
const mount = (evidence: Evidence[] = [], editable = true) => renderChecklist(<EvidencePanel checklistId={checklistId} pointId={points[0].id} evidence={evidence} editable={editable} busy={false} onAdd={onAdd} onRemove={onRemove} />);
beforeEach(() => { resetHttp(); onAdd.mockReset(); onRemove.mockReset(); URL.createObjectURL = vi.fn(() => "blob:verified-evidence"); URL.revokeObjectURL = vi.fn(); }); afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("P03 · Evidencias", () => {
  it("CA-17 menú de evidencia permite flechas, Escape y restauración del foco", async () => {
    mount(); const trigger = screen.getByRole("button", { name: "Evidencia" }); fireEvent.click(trigger);
    const first = screen.getByRole("menuitem", { name: "Enlace" }); first.focus(); fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Imagen" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull(); expect(trigger).toHaveFocus();
  });
  it("CA-17 enlace y texto crean pendientes por API y no autoguardan el checklist", async () => {
    http.post.mockResolvedValue({ id: evidenceId, pointId: points[0].id, kind: "link", status: "pending", url: "https://example.test/" }); mount();
    fireEvent.click(screen.getByRole("button", { name: "Evidencia" })); fireEvent.click(screen.getByRole("menuitem", { name: "Enlace" }));
    fireEvent.change(screen.getByLabelText("URL del enlace"), { target: { value: "https://example.test/" } }); fireEvent.click(screen.getByRole("button", { name: "Agregar evidencia" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", kind: "link" })));
    expect(http.post).toHaveBeenCalledWith(`/implementation/checklists/${checklistId}/points/${points[0].id}/evidence`, { kind: "link", url: "https://example.test/" }); expect(http.put).not.toHaveBeenCalled();
  });
  it("CA-18 un archivo de 30MB se rechaza antes de red con mensaje exacto", async () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Evidencia" })); fireEvent.click(screen.getByRole("menuitem", { name: "Archivo" }));
    const file = new File(["a"], "archivo.bin"); Object.defineProperty(file, "size", { value: 30_000_000 });
    fireEvent.change(screen.getByLabelText("Archivo"), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("El archivo supera el límite de 25 MB."); expect(http.postForm).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled();
  });
  it("CA-19 rechazo real del servidor o almacenamiento pendiente no produce ficha de éxito", async () => {
    http.postForm.mockRejectedValue(Object.assign(new Error("storage_unavailable"), { status: 503, data: { error: "storage_unavailable", message: "El almacenamiento privado no está disponible." } }));
    mount(); fireEvent.click(screen.getByRole("button", { name: "Evidencia" })); fireEvent.click(screen.getByRole("menuitem", { name: "Imagen" }));
    fireEvent.change(screen.getByLabelText("Imagen"), { target: { files: [new File(["png"], "fake.png", { type: "image/png" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("El almacenamiento privado no está disponible."); expect(onAdd).not.toHaveBeenCalled();
  });
  it("CA-16 miniatura lee bytes autenticados, limita48px y revoca URL al desmontar", async () => {
    http.getBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" })); const view = mount([image]);
    const img = await screen.findByRole("img", { name: "captura.png" }); expect(img).toHaveAttribute("src", "blob:verified-evidence"); expect(img).toHaveStyle({ maxHeight: "48px" });
    expect(http.getBlob).toHaveBeenCalledWith(`/implementation/checklists/evidence/${evidenceId}/content`, expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
    view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:verified-evidence");
  });
  it("CA-17 lectura ajena no muestra controles de quitar ni agregar; enlace es seguro", () => {
    mount([{ ...image, kind: "link", url: "https://example.test/" }], false);
    expect(screen.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer"); expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("button", { name: "Evidencia" })).toBeNull(); expect(screen.queryByRole("button", { name: /Quitar/ })).toBeNull();
  });
  it("CA-20 editor privado inyectado usa API10, conserva ancho y no consulta Novedades", async () => {
    http.getBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    renderChecklist(<PointMediaProvider checklistId={checklistId} pointId={points[0].id} evidence={[image]}><EditorEnriquecido valor={{ type: "doc", content: [{ type: "image", attrs: { fileId: evidenceId, width: 240, alt: "Nota" } }] }} perfil="medio" archivosPrivados soloLectura /></PointMediaProvider>);
    expect(await screen.findByRole("img", { name: "Nota" })).toHaveAttribute("width", "240");
    expect(http.getBlob.mock.calls.every(([path]) => path.startsWith("/implementation/checklists/evidence/"))).toBe(true);
  });
  it("CA-20 lector compartido conserva por defecto el endpoint de Novedades", async () => {
    http.getBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    renderChecklist(<EditorEnriquecido valor={{ type: "doc", content: [{ type: "image", attrs: { fileId: evidenceId, alt: "Histórica" } }] }} perfil="medio" archivosPrivados soloLectura />);
    await screen.findByRole("img", { name: "Histórica" }); expect(http.getBlob).toHaveBeenCalledWith(`/whats-new/files/${evidenceId}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("CA-20 redimensionar por teclado actualiza el ancho numérico del JSON", async () => {
    http.getBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" })); const onChange = vi.fn();
    renderChecklist(<PointMediaProvider checklistId={checklistId} pointId={points[0].id} evidence={[image]}><EditorEnriquecido valor={{ type: "doc", content: [{ type: "image", attrs: { fileId: evidenceId, width: 240, alt: "Nota" } }] }} onChange={onChange} perfil="medio" archivosPrivados hideFileAttachments /></PointMediaProvider>);
    fireEvent.keyDown(await screen.findByRole("slider", { name: "Redimensionar imagen: Nota" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalled(); expect(onChange.mock.calls.at(-1)![0].content[0].attrs.width).toBe(256);
  });
  it("CA-16 CA-20 una imagen ajena al punto no hace red ni usa fallback de Novedades", async () => {
    http.getBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    renderChecklist(<PointMediaProvider checklistId={checklistId} pointId={points[1].id} evidence={[image]}><EditorEnriquecido valor={{ type: "doc", content: [{ type: "image", attrs: { fileId: evidenceId, alt: "Ajena" } }] }} perfil="medio" archivosPrivados soloLectura /></PointMediaProvider>);
    await screen.findByText(/Imagen no disponible/); expect(http.getBlob).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("CA-16 tipo de respuesta no raster jamás se convierte en imagen Blob", async () => {
    http.getBlob.mockResolvedValue(new Blob(["<svg/>"], { type: "image/svg+xml" })); mount([image]);
    await screen.findByText("Imagen no disponible"); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
