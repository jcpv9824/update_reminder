import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { checklistMessage } from "./api";
import type { VersionSummary } from "./types";
export const basePath = "/configuracion/checklists";
export const QueryScope = createContext<string[]>(["checklist-templates"]);
export function useTemplateKeys() { return useContext(QueryScope); }
export function useRefreshTemplates() { const qc = useQueryClient(); const key = useTemplateKeys(); return () => qc.invalidateQueries({ queryKey: key }); }
export function ErrorNotice({ error }: { error: unknown }) { return error ? <div className="alerta alerta-error" role="alert">{checklistMessage(error)}</div> : null; }
export function Loading() { return <p role="status">Cargando...</p>; }
export function Breadcrumb({ children }: { children?: ReactNode }) { return <nav className="checklists-migas" aria-label="Migas de pan"><span>Configuración</span> › <Link to={basePath}>Checklists</Link>{children && <> › {children}</>}</nav>; }
export function Status({ status }: { status: VersionSummary["status"] }) { return <span className={`checklists-estado checklists-estado-${status}`}>{status === "editing" ? "En edición" : status === "current" ? "Vigente" : "🔒 Congelada"}</span>; }
export function ChecklistDialog({ title, children, close, busy = false }: { title: string; children: ReactNode; close: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const id = useId(); const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], textarea:not([disabled])') ?? []);
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0])?.focus();
    function handle(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) { e.preventDefault(); closeRef.current(); }
      if (e.key !== "Tab") return;
      const list = focusable(); const first = list[0]; const last = list.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    const node = ref.current; node?.addEventListener("keydown", handle);
    return () => { node?.removeEventListener("keydown", handle); previous?.focus(); };
  }, [busy]);
  return <div className="modal-fondo"><div className="modal checklists-modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}><div className="checklists-heading"><h2 id={id}>{title}</h2><button type="button" onClick={close} disabled={busy}>Cerrar</button></div>{children}</div></div>;
}
/** RN-39: never implicitly save or discard local work. BrowserRouter has no data-router blocker. */
export function useTemplateUnsaved(dirty: boolean) {
  const location = useLocation();
  useEffect(() => {
    if (!dirty) return;
    const prompt = () => window.confirm("Tiene cambios sin guardar. ¿Salir sin guardar?");
    const index: unknown = window.history.state?.idx; let restoring = false;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.download || (anchor.target && anchor.target !== "_self")) return;
      const dest = new URL(anchor.href, window.location.href);
      if (dest.origin === window.location.origin && (dest.pathname !== location.pathname || dest.search !== location.search) && !prompt()) { event.preventDefault(); event.stopPropagation(); }
    };
    const pop = (event: PopStateEvent) => {
      if (restoring) { restoring = false; return; }
      const next: unknown = event.state?.idx;
      if (typeof index === "number" && typeof next === "number" && next !== index && !prompt()) { restoring = true; event.stopImmediatePropagation(); window.history.go(index - next); }
    };
    document.addEventListener("click", click, true); window.addEventListener("beforeunload", unload); window.addEventListener("popstate", pop, true);
    return () => { document.removeEventListener("click", click, true); window.removeEventListener("beforeunload", unload); window.removeEventListener("popstate", pop, true); };
  }, [dirty, location.pathname, location.search]);
}
