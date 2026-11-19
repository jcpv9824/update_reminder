import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { createDraftSaveSession, draftFromForm, safeDisplayDoc, whatsNewApi, type EntryDto } from "../pages/queHayDeNuevo/contrato";

describe("Qué hay de nuevo · contrato de producción", () => {
  afterEach(() => vi.restoreAllMocks());
  const draft = () => draftFromForm({ tipo: "mejora", sistema: "sag_web", rutas: [], queCambio: null, acciones: [], cliente: "", asesorInicialId: "", reglasNegocio: [], videos: [] });
  it("descarta la creación definitivamente rechazada para poder enviar los campos corregidos", async () => {
    const original = draft(); const corrected = { ...draft(), type: "rediseno" as const };
    const created = { id: "entry", etag: '"v1"' } as EntryDto;
    const post = vi.spyOn(api, "post").mockRejectedValueOnce(Object.assign(new Error("Campos inválidos"), { status: 400 })).mockResolvedValueOnce(created);
    const save = createDraftSaveSession();
    await expect(save(original)).rejects.toThrow("Campos inválidos");
    await expect(save(corrected)).resolves.toBe(created);
    expect(post.mock.calls[1][1]).toEqual(corrected);
    expect(post.mock.calls[0][2]?.headers?.["Idempotency-Key"]).not.toBe(post.mock.calls[1][2]?.headers?.["Idempotency-Key"]);
  });
  it("reintenta la creación incierta con la misma llave y el mismo cuerpo", async () => {
    const body = draft(); const created = { id: "entry", etag: '"v1"' } as EntryDto;
    const post = vi.spyOn(api, "post").mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(created);
    const save = createDraftSaveSession();
    await expect(save(body)).rejects.toThrow("Failed to fetch");
    await expect(save(structuredClone(body))).resolves.toBe(created);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
    vi.restoreAllMocks();
  });
  it("si se editó después de perder la respuesta, resuelve la creación original y después actualiza por PUT", async () => {
    const original = draft(); const changed = { ...draft(), type: "rediseno" as const };
    const created = { id: "entry", etag: '"v1"' } as EntryDto; const updated = { id: "entry", etag: '"v2"' } as EntryDto;
    const post = vi.spyOn(api, "post").mockRejectedValueOnce(Object.assign(new Error("Indisponible"), { status: 503 })).mockResolvedValueOnce(created);
    const put = vi.spyOn(api, "put").mockResolvedValue(updated);
    const save = createDraftSaveSession();
    await expect(save(original)).rejects.toThrow("Indisponible");
    await expect(save(changed)).resolves.toBe(updated);
    expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
    expect(post.mock.calls[1][1]).toEqual(original);
    expect(put).toHaveBeenCalledWith("/whats-new/entries/entry/draft", changed, { headers: { "If-Match": '"v1"' } });
    vi.restoreAllMocks();
  });
  it("una actualización fallida tras el replay conserva la identidad y jamás vuelve a crear", async () => {
    const original = draft(); const changed = { ...draft(), type: "rediseno" as const };
    const created = { id: "entry", etag: '"v1"' } as EntryDto; const updated = { id: "entry", etag: '"v2"' } as EntryDto;
    const post = vi.spyOn(api, "post").mockRejectedValueOnce(new TypeError("Respuesta perdida")).mockResolvedValueOnce(created);
    const put = vi.spyOn(api, "put").mockRejectedValueOnce(new TypeError("PUT perdido")).mockResolvedValueOnce(updated);
    const save = createDraftSaveSession();
    await expect(save(original)).rejects.toThrow("Respuesta perdida");
    await expect(save(changed)).rejects.toThrow("PUT perdido");
    await expect(save(changed)).resolves.toBe(updated);
    expect(post).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
  it("mapea campos del formulario sin enviar identidad ni metadatos internos", () => {
    const value = draftFromForm({ tipo: "nuevo", sistema: "sag_web", rutas: [{ id: "r", niveles: [{ valor: "Barra lateral" }, { valor: "Ventas" }, { valor: "Pedidos" }] }], queCambio: null, acciones: [{ accionId: "reiniciar", nombre: "Reiniciar", texto: null }], cliente: "Empresa", asesorInicialId: "s", reglasNegocio: [], videos: [] });
    expect(value).toEqual({ type: "nuevo", system: "sag_web", routes: [{ via: "barra_lateral", submenus: ["Ventas"], option: "Pedidos" }], whatChanged: null, requiredActions: [{ actionCode: "reiniciar", detail: null }], clientName: "Empresa", initialTesterId: "s", attachments: [] });
    expect(JSON.stringify(value)).not.toMatch(/autor|developer|creada|nombre/);
  });
  it("jamás reutiliza URLs de imagen o adjuntos internos al mostrar documentos", () => {
    const doc = safeDisplayDoc({ type: "doc", content: [{ type: "image", attrs: { src: "https://private.test/x", fileId: "abc" } }, { type: "codeBlock", content: [{ type: "text", text: "secret" }] }, { type: "mencion", attrs: { id: "a", etiqueta: "Privado" } }, { type: "paragraph", content: [{ type: "text", text: "Seguro", marks: [{ type: "code" }] }] }] }, true);
    expect(JSON.stringify(doc)).not.toMatch(/private|secret|Privado|fileId|code/);
    expect(JSON.stringify(doc)).not.toContain("Seguro");
  });
  it("publicación envía If-Match e idempotencia, y filtros públicos al servidor", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({});
    const get = vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    await whatsNewApi.command("abc", "publish", '"version"');
    expect(post).toHaveBeenCalledWith("/whats-new/entries/abc/publish", {}, expect.objectContaining({ headers: expect.objectContaining({ "If-Match": '"version"', "Idempotency-Key": expect.any(String) }) }));
    await whatsNewApi.publicList({ periodo: "rango", desde: "2026-01-01", hasta: "2026-02-01", page: 2, categoria: "nuevas" });
    expect(get.mock.calls[0][0]).toContain("page=2");
    expect(get.mock.calls[0][0]).toContain("desde=2026-01-01");
    vi.restoreAllMocks();
  });
});
