import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { api } from "../api/client";
import { LiveWhatsNewPage, LivePublicPage, LiveReportPage, LiveConfigPage, ReportDialog } from "../pages/queHayDeNuevo/LivePages";
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), getText: vi.fn() } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ cargando: false, usuario: { id: "s", roles: ["custom"], displayName: "Asesora" } }) }));
const get = vi.mocked(api.get);
function mount(ui: React.ReactElement, path = "/", pattern = "*") { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Routes><Route path={pattern} element={ui} /></Routes></MemoryRouter></QueryClientProvider>); }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const author = { user: { id: "s", displayName: "Desarrollo", email: "s@test.co" }, areas: ["desarrollo"], permissions: ["updates.whats_new.view", "updates.whats_new.author"], views: ["desarrollador"], defaultView: "desarrollador", clientCatalogAvailable: true };
const newEntryPath = "/actualizaciones/que-hay-de-nuevo/nueva";
const draftPath = "/actualizaciones/que-hay-de-nuevo/slow-draft/editar";
const draftDetail = {
  id: "slow-draft", number: "QN-100", type: "mejora", system: "sag_web", status: "borrador",
  developer: { id: "s", displayName: "Desarrollo" }, clientName: null, whatChanged: null,
  routes: [{ via: "barra_lateral", submenus: ["Pedidos"], option: "Consultar" }],
  requiredActions: [], attachments: [], etag: '"v1"',
};
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
describe("Qué hay de nuevo · API real", () => {
  it("mantiene editor, foco y controles durante seis segundos de autoguardado y luego guarda los cambios con el ETag nuevo", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/entries/slow-draft" ? draftDetail : []);
    const put = vi.mocked(api.put);
    put.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ ...draftDetail, etag: '"v2"' }), 6_000)));
    put.mockResolvedValue({ ...draftDetail, etag: '"v3"' });
    mount(<LiveWhatsNewPage />, draftPath, "/actualizaciones/que-hay-de-nuevo/*");
    const option = await screen.findByRole("textbox", { name: "Opción" });
    const editor = screen.getByRole("textbox", { name: /Qué cambió/ }) as HTMLElement & { editor: Editor };
    vi.useFakeTimers();
    act(() => option.focus());
    fireEvent.change(option, { target: { value: "Consultar p" } });
    await tick(1_000);
    fireEvent.change(option, { target: { value: "Consultar pedidos" } });
    await tick(2_999);
    expect(put).not.toHaveBeenCalled();
    await tick(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(option).toBeEnabled();
    expect(option).toHaveFocus();
    expect(screen.getByRole("textbox", { name: /Qué cambió/ })).toBe(editor);
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("button", { name: "Negrita" })).toBeEnabled();
    act(() => editor.focus());
    act(() => { editor.editor.commands.insertContent("Este texto se escribió durante el guardado."); });
    fireEvent.change(option, { target: { value: "Consultar y exportar pedidos" } });
    expect(editor).toHaveFocus();
    await tick(5_999);
    expect(put).toHaveBeenCalledTimes(1);
    expect(editor).toHaveAttribute("contenteditable", "true");
    await tick(1);
    expect(screen.getByRole("textbox", { name: /Qué cambió/ })).toBe(editor);
    expect(editor).toHaveFocus();
    await tick(3_000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenNthCalledWith(1, "/whats-new/entries/slow-draft/draft", expect.objectContaining({
      routes: [expect.objectContaining({ option: "Consultar pedidos" })],
    }), { headers: { "If-Match": '"v1"' } });
    expect(put).toHaveBeenNthCalledWith(2, "/whats-new/entries/slow-draft/draft", expect.objectContaining({
      routes: [expect.objectContaining({ option: "Consultar y exportar pedidos" })],
      whatChanged: expect.objectContaining({ content: [expect.objectContaining({
        content: [expect.objectContaining({ text: "Este texto se escribió durante el guardado." })],
      })] }),
    }), { headers: { "If-Match": '"v2"' } });
    for (const path of ["/whats-new/me", "/whats-new/entries/slow-draft", "/whats-new/lookups/required-actions", "/whats-new/lookups/support-users"]) {
      expect(get.mock.calls.filter(([requested]) => requested.split("?")[0] === path), path).toHaveLength(1);
    }
  });

  it("no guarda al perder foco y un conflicto detiene el autoguardado sin borrar las ediciones locales", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/entries/slow-draft" ? draftDetail : []);
    const put = vi.mocked(api.put).mockRejectedValue(Object.assign(new Error("Version conflict"), { status: 409, data: { code: "version_desactualizada" } }));
    mount(<LiveWhatsNewPage />, draftPath, "/actualizaciones/que-hay-de-nuevo/*");
    const option = await screen.findByRole("textbox", { name: "Opción" });
    vi.useFakeTimers();
    fireEvent.change(option, { target: { value: "Edición local" } });
    fireEvent.blur(option, { relatedTarget: screen.getByRole("link", { name: /Volver a mis entradas/ }) });
    await tick(1_000);
    expect(put).not.toHaveBeenCalled();
    await tick(2_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/otra persona modificó/i);
    expect(option).toHaveValue("Edición local");
    expect(option).toBeEnabled();
    fireEvent.change(option, { target: { value: "Edición local sin perder" } });
    await tick(60_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(option).toHaveValue("Edición local sin perder");
  });
  it("busca solo en ERP y guarda el identificador seleccionado, nunca el texto de búsqueda ni el nombre", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/lookups/clients?q=alp" ? [{ id: "erp-id-1", label: "Alpina ERP" }] : []);
    vi.mocked(api.post).mockResolvedValue({ id: "entry-id-1", clientName: "Alpina ERP", etag: '"v1"' });
    mount(<LiveWhatsNewPage />, newEntryPath, "/actualizaciones/que-hay-de-nuevo/*");
    fireEvent.click(await screen.findByRole("radio", { name: "Nuevo" }));
    const client = screen.getByRole("combobox", { name: "Cliente *" });
    expect(screen.getByText(/Escribe al menos 3 caracteres/)).toBeVisible();
    fireEvent.change(client, { target: { value: " al  " } });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(get.mock.calls.some(([path]) => path.includes("/lookups/clients"))).toBe(false);
    fireEvent.change(client, { target: { value: " alp  " } });
    expect(await screen.findByRole("option", { name: "Alpina ERP" })).toBeInTheDocument();
    fireEvent.change(client, { target: { value: "alp " } });
    expect(screen.getByRole("option", { name: "Alpina ERP" })).toBeInTheDocument();
    expect(get.mock.calls.filter(([path]) => path === "/whats-new/lookups/clients?q=alp")).toHaveLength(1);
    fireEvent.keyDown(client, { key: "ArrowDown" });
    expect(client).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Alpina ERP" }).id);
    fireEvent.keyDown(client, { key: "Enter" });
    expect(client).toHaveValue("Alpina ERP");
    expect(client).toHaveAttribute("aria-expanded", "false");
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
    const search = screen.getByRole("combobox", { name: "Cliente *" });
    fireEvent.change(search, { target: { value: "alp" } });
    expect(await screen.findByRole("option", { name: "Alpina ERP" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "otro" } });
    expect(screen.queryByRole("option", { name: "Alpina ERP" })).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo consultar el catálogo del ERP.");
    expect(within(screen.getByRole("listbox", { name: "Clientes del ERP", hidden: true })).queryAllByRole("option")).toHaveLength(0);
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/whats-new/lookups/clients?q=otro")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Publicar a Soporte" })).toBeDisabled();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveAttribute("aria-expanded", "false");
    expect(search).toHaveValue("");
  });
  it("conserva el nombre histórico sin tratarlo como opción del ERP y permite borrarlo explícitamente", async () => {
    const saved = { id: "entry-id-1", type: "nuevo", status: "borrador", developer: { id: "s", displayName: "Desarrollo" }, clientName: "Cliente histórico", routes: [], requiredActions: [], attachments: [], etag: '"v1"' };
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/entries/entry-id-1" ? saved : []);
    vi.mocked(api.put).mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, clientName: null });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo/entry-id-1/editar", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByRole("combobox", { name: "Cliente *" })).toHaveValue("Cliente histórico");
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
  it("presenta título y acción de creación juntos, conteos del servidor y enlaces por estado", async () => {
    const draft = { id: "draft", number: "QN-1", status: "borrador", type: null, system: null, primaryRoute: null, summary: null, developer: { id: "s", displayName: "Desarrollo" }, createdAt: "2026-11-17T10:00:00Z" };
    const published = { ...draft, id: "sent", number: "QN-2", status: "sin_probar", type: "mejora", system: "sag_web", primaryRoute: "Ventas › Pedidos", summary: "Corrección" };
    get.mockImplementation(async path => {
      if (path === "/whats-new/me") return { ...author, permissions: [...author.permissions, "updates.whats_new.view_all"] };
      const tab = new URL(path, "https://portal.test").searchParams.get("tab");
      return { items: tab === "publicadas" ? [published] : [draft, published], total: tab === "publicadas" ? 29 : 36, page: 1, pageSize: 20, tabCounts: { todas: 36, borradores: 7, publicadas: 29 } };
    });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByRole("heading", { name: "Qué hay de nuevo · Mis entradas" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Nueva entrada" })).toHaveAttribute("href", newEntryPath);
    expect(screen.queryByText("Desarrollo")).toBeNull();
    expect(await screen.findByRole("tab", { name: "Todas 36" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: "Continuar QN-1" })).toHaveAttribute("href", "/actualizaciones/que-hay-de-nuevo/draft/editar");
    expect(screen.getByRole("link", { name: "Ver detalle de QN-2" })).toHaveAttribute("href", "/actualizaciones/que-hay-de-nuevo/sent");
    fireEvent.click(screen.getByRole("tab", { name: "Publicadas 29" }));
    expect(await screen.findByRole("tab", { name: "Publicadas 29" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("QN-1")).toBeNull();
    fireEvent.change(screen.getByLabelText("Ver"), { target: { value: "all" } });
    expect(await screen.findByRole("columnheader", { name: "Desarrollador" })).toBeVisible();
    expect(get.mock.calls.some(([path]) => path.includes("tab=publicadas") && path.includes("scope=all"))).toBe(true);
  });
  it("ofrece + separado para reglas y video y no añade referencias hasta confirmar un enlace", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : []);
    mount(<LiveWhatsNewPage />, newEntryPath, "/actualizaciones/que-hay-de-nuevo/*");
    fireEvent.click(await screen.findByRole("radio", { name: "Nuevo" }));
    const rules = within(screen.getByRole("region", { name: "8. Reglas de negocio" }));
    const videos = within(screen.getByRole("region", { name: "9. Video de entrega" }));
    fireEvent.click(rules.getByRole("button", { name: "Agregar referencia a Reglas de negocio" }));
    expect(rules.getByText("Sin referencias añadidas.")).toBeVisible();
    expect(rules.getByRole("button", { name: "Adjuntar archivo" })).toBeVisible();
    expect(videos.queryByRole("button", { name: "Añadir enlace" })).toBeNull();
    fireEvent.click(rules.getByRole("button", { name: "Añadir enlace" }));
    fireEvent.change(rules.getByLabelText("URL HTTPS"), { target: { value: "https://example.test/reglas" } });
    fireEvent.click(rules.getByRole("button", { name: "Agregar enlace" }));
    expect(rules.getByText("https://example.test/reglas")).toBeVisible();
    expect(videos.getByText("Sin referencias añadidas.")).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("en detalle publicado conserva hallazgos e historial y ofrece corrección sin controles de prueba", async () => {
    const detail = { id: "sent", number: "QN-2", status: "fallida", type: "mejora", system: "sag_web", developer: { id: "s", displayName: "Desarrollo" }, clientName: null, createdAt: "2026-11-17T10:00:00Z", whatChanged: null, routes: [], requiredActions: [], attachments: [], rounds: [], findings: [{ id: "f1", number: 1, roundNo: 1, body: null }], participants: [], log: [], etag: '"v1"' };
    get.mockImplementation(async path => path === "/whats-new/me" ? author : detail);
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo/sent", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByRole("heading", { name: "Detalle de la entrada" })).toBeVisible();
    expect(screen.getByText("Solo lectura.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Hallazgos 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Historial y rondas de prueba" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Corregir y volver a publicar" })).toHaveAttribute("href", "/actualizaciones/que-hay-de-nuevo/sent/corregir");
    expect(screen.queryByRole("button", { name: "Marcar probado" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Mostrar esta novedad a los clientes" })).toBeNull();
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
