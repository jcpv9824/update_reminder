import { beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cliente API con sesión segura", () => {
  it("PATCH conserva sesión, CSRF y If-Match para el checklist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");
    client.setToken("access-vigente");
    await client.api.patch("/whats-new/rounds/r/checklist", { items: [{ itemNo: 1, checked: true }] }, { headers: { "If-Match": '"etag"' } });
    expect(fetchMock).toHaveBeenCalledWith("/api/whats-new/rounds/r/checklist", expect.objectContaining({ method: "PATCH", credentials: "include", headers: expect.objectContaining({ Authorization: "Bearer access-vigente", "X-Requested-With": "XMLHttpRequest", "If-Match": '"etag"' }) }));
  });
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("elimina el JWT legado y conserva el access token solo en memoria", async () => {
    localStorage.setItem("erp_update_token", "jwt-legado");
    const client = await import("../api/client");

    expect(localStorage.getItem("erp_update_token")).toBeNull();
    client.setToken("jwt-en-memoria");
    expect(client.getToken()).toBe("jwt-en-memoria");
    expect(localStorage.getItem("erp_update_token")).toBeNull();
  });

  it("restaura sesión mediante cookie, credenciales y encabezado anti-CSRF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { token: "access-renovado" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");

    expect(await client.restoreSession()).toBe(true);
    expect(client.getToken()).toBe("access-renovado");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.objectContaining({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({ "X-Requested-With": "XMLHttpRequest" }),
    }));
  });

  it("ante 401 rota una sola vez y reintenta con el nuevo access token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: "No autenticado." }))
      .mockResolvedValueOnce(jsonResponse(200, { token: "access-nuevo" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");
    client.setToken("access-vencido");

    await expect(client.api.get<{ ok: boolean }>("/me")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/refresh");
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer access-nuevo" }),
    }));
  });

  it("mantiene GET sin encabezados que fuercen preflight al seguir un redirect a Blob", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("borrador", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");
    client.setToken("access-vigente");

    await expect(client.api.getText("/guide-sessions/guide_1/drafts/current")).resolves.toBe("borrador");
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-vigente");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["X-Requested-With"]).toBeUndefined();
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("omit");
  });

  it("no intenta refresh recursivo si el propio refresh devuelve 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Sesión expirada." }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");

    expect(await client.restoreSession()).toBe(false);
    expect(client.getToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no reenvía una lectura cancelada mientras se renovaba la sesión compartida", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: "No autenticado." }))
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(jsonResponse(200, { token: "access-nuevo" }));
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");

    await expect(client.api.get("/catalog/customers", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(fetchMock.mock.calls[1][1]?.signal).toBeUndefined();
    expect(client.getToken()).toBe("access-nuevo");
  });

  it("envía encabezados tipados de idempotencia y concurrencia", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");

    await client.api.post("/guide-sessions/guide_1/finalize", { draftVersion: 3 }, {
      headers: {
        "Idempotency-Key": "guide-finalize-1",
        "If-Match": "\"AQIDBAUGBwg=\"",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/guide-sessions/guide_1/finalize", expect.objectContaining({
      headers: expect.objectContaining({
        "Idempotency-Key": "guide-finalize-1",
        "If-Match": "\"AQIDBAUGBwg=\"",
      }),
    }));
  });

  it("negocia y lee solo text/plain o el JSON legado declarado para contraseñas de tareas", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(" contraseña-sintética ", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }))
      .mockResolvedValueOnce(jsonResponse(200, { password: "sintética-reveal" }))
      .mockResolvedValueOnce(jsonResponse(200, { part: "password", value: "sintética-copy" }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, setToken } = await import("../api/client");
    setToken("token-sintético");
    const controller = new AbortController();
    const path = "/databases/db_1/reveal-password";
    const copiar = "/databases/db_1/copy-access-part";
    await expect(api.postTaskPassword(path, { taskId: "task_1" }, "reveal", { signal: controller.signal }))
      .resolves.toBe(" contraseña-sintética ");
    await expect(api.postTaskPassword(path, { taskId: "task_1" }, "reveal")).resolves.toBe("sintética-reveal");
    await expect(api.postTaskPassword(copiar, { taskId: "task_1", part: "password" }, "copy")).resolves.toBe("sintética-copy");
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api${path}`, expect.objectContaining({
      method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: expect.objectContaining({ Accept: "text/plain, application/json;q=0.9", Authorization: "Bearer token-sintético" }),
    }));
  });

  it("rechaza otros tipos y no expone errores de parseo ni datos de un error del endpoint sensible", async () => {
    const leaked = "fragmento-sintético-no-mostrar";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(leaked, { headers: { "Content-Type": "text/html" } }))
      .mockResolvedValueOnce(new Response(leaked, { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(jsonResponse(200, { part: "userId", value: leaked }))
      .mockResolvedValueOnce(jsonResponse(403, { error: leaked, password: leaked }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../api/client");
    for (const action of ["reveal", "reveal", "copy"] as const) {
      await expect(api.postTaskPassword("/sensitive", {}, action)).rejects.toThrow("Respuesta de contraseña no válida.");
    }
    await expect(api.postTaskPassword("/sensitive", {}, "copy")).rejects.toMatchObject({
      message: "Error 403", status: 403,
    });
  });

  it("carga a una URL firmada y reporta progreso sin enviar credenciales del portal", async () => {
    const progress = vi.fn();
    const state: {
      method?: string;
      url?: string;
      headers: Record<string, string>;
      body?: File;
    } = { headers: {} };
    class FakeXhr {
      status = 201;
      upload: { onprogress?: (event: ProgressEvent) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      open(method: string, url: string) { state.method = method; state.url = url; }
      setRequestHeader(name: string, value: string) { state.headers[name] = value; }
      send(body: File) {
        state.body = body;
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        this.onload?.();
      }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const client = await import("../api/client");
    const file = new File(["video"], "video.mp4", { type: "video/mp4" });

    await client.uploadToSignedUrl({
      url: "https://storage.example/write",
      method: "PUT",
      headers: { "x-storage-token": "opaque" },
      file,
      onProgress: progress,
    });

    expect(state).toEqual(expect.objectContaining({
      method: "PUT",
      url: "https://storage.example/write",
      headers: { "x-storage-token": "opaque" },
      body: file,
    }));
    expect(progress).toHaveBeenCalledWith(50);
  });
});
