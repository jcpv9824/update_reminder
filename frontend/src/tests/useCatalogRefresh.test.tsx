import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogRefresh, type CatalogRefreshService } from "../hooks/useCatalogRefresh";

const a = "10000000-0000-4000-8000-00000000000a";
const b = "10000000-0000-4000-8000-00000000000b";
const item = { sourceId: a, status: "succeeded", updatedAt: "2026-11-18T12:00:00Z" } as const;

const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function fixture() {
  const enqueue = vi.fn<CatalogRefreshService["enqueue"]>().mockResolvedValue({ accepted: 0, coalesced: 1 });
  const status = vi.fn<CatalogRefreshService["status"]>().mockResolvedValue({ pending: false, items: [item] });
  const onSettled = vi.fn();
  const onAccessDenied = vi.fn();
  return { enqueue, status, onSettled, onAccessDenied, service: { enqueue, status } };
}

describe("ciclo de actualización del catálogo", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("respeta pending agregado aunque todas las fuentes visibles ya terminaron", async () => {
    const f = fixture();
    f.status.mockResolvedValueOnce({ pending: true, items: [item] });
    const { result, rerender } = renderHook(() => useCatalogRefresh({ ...f, scopeKey: "lector" }));
    await flush();
    await advance(1_999);
    expect(f.status).not.toHaveBeenCalled();
    await advance(1);
    expect(result.current.state).toBe("pending");
    expect(f.onSettled).not.toHaveBeenCalled();
    await advance(2_000);
    expect(result.current.state).toBe("idle");
    expect(f.onSettled).toHaveBeenCalledTimes(1);
    rerender();
    await advance(90_000);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.status).toHaveBeenCalledTimes(2);
    expect(f.onSettled).toHaveBeenCalledTimes(1);
  });

  it("limita la espera a 60s aunque una solicitud de seguimiento no responda y permite volver a consultar", async () => {
    const f = fixture();
    let complete!: (result: Awaited<ReturnType<CatalogRefreshService["status"]>>) => void;
    f.status.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { result } = renderHook(() => useCatalogRefresh({ ...f, scopeKey: "lector" }));
    await flush();
    await advance(59_999);
    expect(result.current.state).toBe("pending");
    const firstSignal = f.status.mock.calls[0][1];
    await advance(1);
    expect(result.current.state).toBe("waiting");
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { complete({ pending: false, items: [item] }); });
    expect(f.onSettled).not.toHaveBeenCalled();
    await act(async () => { result.current.request(); result.current.request(); });
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    await advance(2_000);
    expect(result.current.state).toBe("idle");
    expect(f.onSettled).toHaveBeenCalledTimes(1);
  });

  it("limita a 30 consultas aun si todas responden de inmediato con pending", async () => {
    const f = fixture();
    f.status.mockResolvedValue({ pending: true, items: [item] });
    const { result } = renderHook(() => useCatalogRefresh({ ...f, scopeKey: "lector" }));
    await flush();
    await advance(120_000);
    expect(result.current.state).toBe("waiting");
    expect(f.status.mock.calls.length).toBeGreaterThan(0);
    expect(f.status.mock.calls.length).toBeLessThanOrEqual(30);
    expect(f.onSettled).not.toHaveBeenCalled();
  });

  it("canonicaliza las fuentes, respeta ninguna y descarta respuestas de otro alcance o de un desmontaje", async () => {
    const f = fixture();
    let complete!: (result: Awaited<ReturnType<CatalogRefreshService["status"]>>) => void;
    f.status.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { result, rerender, unmount } = renderHook<ReturnType<typeof useCatalogRefresh>, { scopeKey: string; sourceIds?: string[] }>((props) =>
      useCatalogRefresh({ ...f, ...props }), { initialProps: { scopeKey: "lector", sourceIds: [b, a.toUpperCase(), a] } });
    await flush();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith([a, b], expect.any(AbortSignal));
    rerender({ scopeKey: "lector", sourceIds: [a, b] });
    await flush();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(f.status).toHaveBeenCalledExactlyOnceWith([a, b], expect.any(AbortSignal));
    rerender({ scopeKey: "lector", sourceIds: [] });
    expect(f.status.mock.calls[0][1].aborted).toBe(true);
    await act(async () => { complete({ pending: false, items: [item] }); });
    expect(result.current.state).toBe("idle");
    await act(async () => { result.current.request(); });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    rerender({ scopeKey: "otro-lector" });
    await flush();
    expect(f.enqueue).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
    unmount();
    expect(f.enqueue.mock.calls[1][1].aborted).toBe(true);
    await advance(90_000);
    expect(f.status).toHaveBeenCalledTimes(1);
    expect(f.onSettled).not.toHaveBeenCalled();
  });

  it.each([401, 403])("detiene el ciclo al recibir %s y no reintenta con el mismo alcance", async status => {
    const f = fixture();
    f.enqueue.mockRejectedValueOnce(Object.assign(new Error("detalle interno"), { status }));
    const { result } = renderHook(() => useCatalogRefresh({ ...f, scopeKey: "lector" }));
    await flush();
    expect(result.current.state).toBe("denied");
    expect(f.onAccessDenied).toHaveBeenCalledTimes(1);
    await act(async () => { result.current.request(); });
    await advance(90_000);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.status).not.toHaveBeenCalled();
    expect(f.onSettled).not.toHaveBeenCalled();
  });

  it("detiene solicitudes no disponibles sin reintentos automáticos", async () => {
    const f = fixture();
    f.enqueue.mockRejectedValueOnce(Object.assign(new Error("dato interno"), { status: 503 }));
    const { result } = renderHook(() => useCatalogRefresh({ ...f, scopeKey: "lector" }));
    await flush();
    await advance(90_000);
    expect(result.current.state).toBe("unavailable");
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.status).not.toHaveBeenCalled();
    expect(f.onAccessDenied).not.toHaveBeenCalled();
    expect(f.onSettled).not.toHaveBeenCalled();
  });
});
