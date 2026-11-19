import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../api/client";
import { LiveWhatsNewPage, LivePublicPage, LiveReportPage, LiveConfigPage, ReportDialog } from "../pages/queHayDeNuevo/LivePages";
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), getText: vi.fn() } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ cargando: false, usuario: { id: "s", roles: ["custom"], displayName: "Asesora" } }) }));
const get = vi.mocked(api.get);
function mount(ui: React.ReactElement, path = "/", pattern = "*") { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Routes><Route path={pattern} element={ui} /></Routes></MemoryRouter></QueryClientProvider>); }
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("Qué hay de nuevo · API real", () => {
  it("configuración usa capacidades vigentes sin exigir permiso de ver Actualizaciones", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? { user: { id: "s", displayName: "Configuración", email: "s@test.co" }, areas: [], permissions: ["configuration.whats_new.view", "configuration.whats_new.manage"], views: [], defaultView: null } : { settings: { publicEnabled: false, etag: '"v1"' }, actions: [], publicUrl: "/novedades" });
    mount(<LiveConfigPage />);
    expect(await screen.findByRole("heading", { name: "Configuración de Qué hay de nuevo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nueva acción")).toBeEnabled();
    expect(screen.getByLabelText("Nueva acción")).toHaveAttribute("maxlength", "120");
    expect(screen.getByLabelText("Publicación activa")).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("carga actor vigente sin selector simulado y muestra tres pestañas de pruebas", async () => {
    get.mockImplementation(async (path) => path === "/whats-new/me" ? { user: { id: "s", displayName: "Asesora SQL", email: "s@test.co" }, areas: ["soporte"], permissions: ["updates.whats_new.view", "updates.whats_new.test"], views: ["asesor"], defaultView: "asesor", storageAvailable: false } : { items: [], total: 0, page: 1, pageSize: 20 });
    mount(<LiveWhatsNewPage />);
    expect(await screen.findByRole("tab", { name: "Sin probar" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "En pruebas" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Probadas" }));
    expect(await screen.findByLabelText("Resultado")).toBeInTheDocument();
    expect(screen.queryByLabelText("Usuario simulado")).toBeNull();
    expect(screen.getByLabelText("Buscar")).toHaveAttribute("maxlength", "100");
    await waitFor(() => expect(get.mock.calls.some(([p]) => p.includes("/queue?") && p.includes("tab=probadas"))).toBe(true));
  });
  it("página pública consulta DTO público paginado, sin /me ni entradas privadas", async () => {
    get.mockResolvedValue({ enabled: true, items: [{ publicId: "p", category: "nuevo", releaseMonth: "2026-11", title: "Nueva opción", summary: "Resumen seguro", whereToFind: "Ventas › Pedidos" }], total: 22, page: 1, pageSize: 20 });
    mount(<LivePublicPage />);
    expect(await screen.findByText("Nueva opción")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Fecha de liberación"), { target: { value: "ultimos_3_meses" } });
    await waitFor(() => expect(get.mock.calls.some(([p]) => p.includes("periodo=ultimos_3_meses"))).toBe(true));
    expect(get.mock.calls.every(([p]) => p.startsWith("/public/novedades?"))).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Navegación principal" })).toBeNull();
  });
  it("el reporte se abre sin consultar área ni permisos de la opción", async () => {
    vi.mocked(api.getText).mockResolvedValue("<!doctype html><html><body>Reporte congelado</body></html>");
    mount(<LiveReportPage />, "/reportes/r", "/reportes/:id");
    expect(await screen.findByTitle("Reporte completo")).toHaveAttribute("sandbox", "");
    expect(api.getText).toHaveBeenCalledWith("/whats-new/reports/r", { credentials: "include" });
    expect(get).not.toHaveBeenCalled();
  });
  it("reportes usa destinatarios activos del portal y muestra 503 sin fingir un envío", async () => {
    get.mockResolvedValue([{ id: "sales", displayName: "Persona de Ventas", email: "ventas@test.co", active: true }, { id: "inactive", displayName: "Inactivo", active: false }]);
    vi.mocked(api.post).mockRejectedValue(Object.assign(new Error("El almacenamiento de archivos todavía no está conectado."), { status: 503 }));
    mount(<ReportDialog filters={{}} onClose={() => {}} />);
    expect(screen.getByLabelText("Buscar destinatarios")).toHaveAttribute("maxlength", "100");
    fireEvent.click(await screen.findByRole("checkbox", { name: /Persona de Ventas/ }));
    expect(screen.queryByRole("checkbox", { name: "Inactivo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enviar a 1 personas" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El almacenamiento de archivos todavía no está conectado.");
    expect(api.post).toHaveBeenCalledWith("/whats-new/reports", { include: "todas", filters: {}, recipientIds: ["sales"] }, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) }));
    expect(screen.queryByText(/Reporte enviado/)).toBeNull();
  });
});
