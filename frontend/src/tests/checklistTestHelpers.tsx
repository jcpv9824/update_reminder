import { vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactElement } from "react";
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), postForm: vi.fn(), getBlob: vi.fn() }));
const session = vi.hoisted(() => ({ roles: ["config_only"] as string[] }));
export { http, session };
vi.mock("../api/client", () => ({ api: http, apiUrl: (p: string) => `/api${p}` }));
vi.mock("../auth/AuthContext", () => ({ AuthProvider: ({ children }: { children: ReactElement }) => children, useAuth: () => ({ cargando: false, usuario: { id: "user", displayName: "Configuración", roles: session.roles }, cerrarSesion: vi.fn() }) }));
export const templateId = "11111111-1111-4111-8111-111111111111";
export const points = [{ id: "22222222-2222-4222-8222-222222222222", position: 1, title: "Primer punto", detail: null }, { id: "33333333-3333-4333-8333-333333333333", position: 2, title: "Segundo punto", detail: "Detalle" }];
export const version = { id: "44444444-4444-4444-8444-444444444444", templateId, templateName: "Migración", number: 2, status: "editing", requiresEnvironment: true, uses: 0, rowVersion: "AAAAAAAAAAE=", points };
export const template = { id: templateId, name: "Migración", currentVersion: 1, uses: 0, canDelete: false, createdAt: "2026-11-26T03:00:00Z", versions: [{ ...version, number: 1, status: "current" }, version] };
export function resetHttp() { Object.values(http).forEach(fn => fn.mockReset()); session.roles = ["config_only"]; }
export function renderChecklist(ui: ReactElement, path = "/configuracion/checklists", pattern = "/configuracion/checklists/*") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Routes><Route path={pattern} element={ui} /></Routes></MemoryRouter></QueryClientProvider>);
}
export function conflict(code: string, message: string) { return Object.assign(new Error(code), { status: 409, data: { error: code, message } }); }
