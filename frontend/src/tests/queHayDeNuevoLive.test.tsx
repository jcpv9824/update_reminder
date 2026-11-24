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
const author = { user: { id: "s", displayName: "Desarrollo", email: "s@test.co" }, areas: ["desarrollo"], permissions: ["updates.whats_new.view", "updates.whats_new.author"], views: ["desarrollador"], defaultView: "desarrollador", clientCatalogAvailable: true };
const newEntryPath = "/actualizaciones/que-hay-de-nuevo/nueva";
describe("Qué hay de nuevo · API real", () => {
  it("busca solo en ERP y guarda el identificador seleccionado, nunca el texto de búsqueda ni el nombre", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/lookups/clients?q=alp" ? [{ id: "erp-id-1", label: "Alpina ERP" }] : []);
    vi.mocked(api.post).mockResolvedValue({ id: "entry-id-1", clientName: "Alpina ERP", etag: '"v1"' });
    mount(<LiveWhatsNewPage />, newEntryPath, "/actualizaciones/que-hay-de-nuevo/*");
    fireEvent.click(await screen.findByRole("radio", { name: "Nuevo" }));
    expect(screen.getByRole("combobox", { name: "Cliente *" })).toBeDisabled();
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar cliente en el ERP" }), { target: { value: "alp" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar en el ERP" }));
    expect(await screen.findByRole("option", { name: "Alpina ERP" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Cliente *" }), { target: { value: "erp-id-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/whats-new/entries", expect.objectContaining({ clientId: "erp-id-1" }), expect.anything()));
    expect(vi.mocked(api.post).mock.calls[0][1]).not.toHaveProperty("clientName");
  });
  it("deshabilita resultados de otra búsqueda y no ofrece clientes si el ERP falla", async () => {
    get.mockImplementation(async path => {
      if (path === "/whats-new/me") return author;
      if (path === "/whats-new/lookups/clients?q=alp") return [{ id: "erp-id-1", label: "Alpina ERP" }];
      if (path === "/whats-new/lookups/clients?q=otro") throw new Error("El catálogo ERP no está disponible.");
      return [];
    });
    mount(<LiveWhatsNewPage />, newEntryPath, "/actualizaciones/que-hay-de-nuevo/*");
    fireEvent.click(await screen.findByRole("radio", { name: "Nuevo" }));
    const search = screen.getByRole("searchbox", { name: "Buscar cliente en el ERP" });
    fireEvent.change(search, { target: { value: "alp" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar en el ERP" }));
    expect(await screen.findByRole("option", { name: "Alpina ERP" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "otro" } });
    expect(screen.queryByRole("option", { name: "Alpina ERP" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Buscar en el ERP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El catálogo ERP no está disponible.");
    expect(screen.getByRole("combobox", { name: "Cliente *" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publicar a Soporte" })).toBeDisabled();
  });
  it("conserva el nombre histórico sin tratarlo como opción del ERP y permite borrarlo explícitamente", async () => {
    const saved = { id: "entry-id-1", type: "nuevo", status: "borrador", developer: { id: "s", displayName: "Desarrollo" }, clientName: "Cliente histórico", routes: [], requiredActions: [], attachments: [], etag: '"v1"' };
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/entries/entry-id-1" ? saved : []);
    vi.mocked(api.put).mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, clientName: null });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo/entry-id-1/editar", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByText("Cliente histórico")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Cliente histórico" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.put).mock.calls[0][1]).not.toHaveProperty("clientId");
    expect(vi.mocked(api.put).mock.calls[0][1]).not.toHaveProperty("clientName");
    await waitFor(() => expect(screen.getByRole("button", { name: "Quitar cliente" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Quitar cliente" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.put).mock.calls[1][1]).toHaveProperty("clientId", null);
    expect(get.mock.calls.every(([path]) => !path.includes("/lookups/clients"))).toBe(true);
  });
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
