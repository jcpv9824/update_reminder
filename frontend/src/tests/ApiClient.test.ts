import { beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cliente API con sesión segura", () => {
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

  it("no intenta refresh recursivo si el propio refresh devuelve 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Sesión expirada." }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../api/client");

    expect(await client.restoreSession()).toBe(false);
    expect(client.getToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
