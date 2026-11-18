import { useLayoutEffect, useRef, useState } from "react";
import { api, type ApiError } from "../api/client";

type Selection = readonly string[] | undefined;
type CatalogRefreshStatus = {
  pending: boolean;
  items: readonly {
    sourceId: string;
    status: "queued" | "processing" | "retry" | "succeeded" | "failed";
    updatedAt: string;
  }[];
};

export type CatalogRefreshService = {
  enqueue: (sourceIds: Selection, signal: AbortSignal) => Promise<{ accepted: number; coalesced: number }>;
  status: (sourceIds: Selection, signal: AbortSignal) => Promise<CatalogRefreshStatus>;
};

const refreshService: CatalogRefreshService = {
  enqueue: (sourceIds, signal) => api.post("/catalog/refresh", sourceIds === undefined ? {} : { sourceIds }, { signal }),
  status: (sourceIds, signal) => api.get(sourceIds === undefined
    ? "/catalog/refresh/status"
    : `/catalog/refresh/status?${new URLSearchParams({ sourceIds: sourceIds.join(",") })}`, { signal }),
};

export function catalogRefreshServiceIfEnabled(): CatalogRefreshService | undefined {
  if (import.meta.env.VITE_PORTAL_CATALOG_READ_ENABLED === "true"
    && import.meta.env.VITE_PORTAL_CATALOG_AUTOMATION_ENABLED === "true") return refreshService;
}

export const catalogRefreshMessages = {
  idle: null,
  pending: "Actualizando las fuentes del catálogo…",
  waiting: "La actualización puede seguir en curso. Usa «Actualizar lista» para volver a consultar.",
  failed: "No se pudieron actualizar todas las fuentes. Se muestra la información disponible.",
  unavailable: "No se pudo solicitar o comprobar la actualización del catálogo. Puedes reintentar con «Actualizar lista».",
  denied: "No se pudo confirmar tu acceso al catálogo. Verifica tu sesión o tus permisos.",
} as const;

type State = keyof typeof catalogRefreshMessages;
type Run = { controller: AbortController; deadline: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setTimeout> };

const POLL_MS = 2_000;
const DEADLINE_MS = 60_000;

function accessDenied(error: unknown): boolean {
  const status = (error as ApiError | null | undefined)?.status;
  return status === 401 || status === 403;
}

export function useCatalogRefresh({
  service, scopeKey, sourceIds, criteria, onSettled, onAccessDenied,
}: {
  service?: CatalogRefreshService;
  scopeKey: string;
  sourceIds?: readonly string[];
  criteria?: string;
  onSettled: () => void;
  onAccessDenied: () => void;
}) {
  // null (all authorized) and [] (none) deliberately have different identities.
  const selection = JSON.stringify(sourceIds === undefined ? null : [...new Set(sourceIds.map(id => id.toLowerCase()))].sort());
  const selectionScope = JSON.stringify([scopeKey, selection]);
  const targetKey = JSON.stringify([selectionScope, criteria]);
  const [notice, setNotice] = useState<{ targetKey: string; state: State }>();
  const [deniedScope, setDeniedScope] = useState<string>();
  const denied = deniedScope === selectionScope;
  const owner = useRef<{ targetKey: string; start: () => Promise<void>; deny: () => void }>();
  const callbacks = useRef({ onSettled, onAccessDenied });

  useLayoutEffect(() => {
    callbacks.current = { onSettled, onAccessDenied };
  }, [onSettled, onAccessDenied]);

  useLayoutEffect(() => {
    if (!denied && deniedScope !== undefined) setDeniedScope(undefined);
  }, [denied, deniedScope]);

  useLayoutEffect(() => {
    if (!service || denied || selection === "[]") return;
    const ids = (JSON.parse(selection) as string[] | null) ?? undefined;
    const transport = service;
    let active = true;
    let run: Run | undefined;

    function stop() {
      if (!run) return;
      const previous = run;
      run = undefined;
      clearTimeout(previous.deadline);
      clearTimeout(previous.poll);
      // This aborts only HTTP. A job already accepted by the server is durable.
      previous.controller.abort();
    }

    function show(state: State) {
      setNotice({ targetKey, state });
    }

    function deny() {
      if (!active) return;
      active = false;
      stop();
      setDeniedScope(selectionScope);
      callbacks.current.onAccessDenied();
    }

    function onError(current: Run, error: unknown) {
      if (run !== current) return;
      if (accessDenied(error)) deny();
      else {
        stop();
        show("unavailable");
      }
    }

    function poll(current: Run) {
      current.poll = setTimeout(async () => {
        let status: CatalogRefreshStatus;
        try {
          status = await transport.status(ids, current.controller.signal);
          if (run !== current) return;
          if (status.pending) {
            poll(current);
            return;
          }
          // Completion is not a claim of coverage; only the catalog read supplies it.
          show(status.items.some(item => item.status === "failed") ? "failed" : "idle");
        } catch (error) {
          onError(current, error);
          return;
        }
        stop();
        callbacks.current.onSettled();
      }, POLL_MS);
    }

    async function start() {
      if (!active || run) return;
      const current: Run = {
        controller: new AbortController(),
        // Bound the whole cycle even if an HTTP request never resolves.
        deadline: setTimeout(() => {
          stop();
          show("waiting");
        }, DEADLINE_MS),
      };
      run = current;
      show("pending");
      try {
        await transport.enqueue(ids, current.controller.signal);
        if (run === current) poll(current);
      } catch (error) {
        onError(current, error);
      }
    }

    owner.current = { targetKey, start, deny };
    // Start after commit so an immediately replayed mount effect queues nothing early.
    queueMicrotask(() => { void start(); });
    return () => {
      active = false;
      owner.current = undefined;
      stop();
    };
  }, [service, denied, selection, selectionScope, targetKey]);

  const state = !service ? "idle" : denied ? "denied" : notice?.targetKey === targetKey ? notice.state : "idle";
  return {
    state,
    request() { if (owner.current?.targetKey === targetKey) void owner.current.start(); },
    async read<T>(signal: AbortSignal, load: () => Promise<T>): Promise<T> {
      try {
        return await load();
      } catch (error) {
        if (!signal.aborted && accessDenied(error) && owner.current?.targetKey === targetKey) owner.current.deny();
        throw error;
      }
    },
  };
}
