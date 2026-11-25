import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { api } from "../api/client";
import { LiveWhatsNewPage, LiveReportPage, LiveConfigPage, ReportDialog } from "../pages/queHayDeNuevo/LivePages";
import LivePublicPage from "../pages/queHayDeNuevo/PublicNewsLive";
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), getText: vi.fn() } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ cargando: false, usuario: { id: "s", roles: ["custom"], displayName: "Asesora" } }) }));
const get = vi.mocked(api.get);
function mount(ui: React.ReactElement, path = "/", pattern = "*") { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Routes><Route path={pattern} element={ui} /></Routes></MemoryRouter></QueryClientProvider>); }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const author = { user: { id: "s", displayName: "Desarrollo", email: "s@test.co" }, areas: ["desarrollo"], permissions: ["updates.whats_new.view", "updates.whats_new.author"], views: ["desarrollador"], defaultView: "desarrollador", clientCatalogAvailable: true };
const advisor = { ...author, areas: ["soporte"], permissions: ["updates.whats_new.view", "updates.whats_new.test"], views: ["asesor"], defaultView: "asesor" };
const newEntryPath = "/actualizaciones/que-hay-de-nuevo/nueva";
const draftPath = "/actualizaciones/que-hay-de-nuevo/slow-draft/editar";
const draftDetail = {
  id: "slow-draft", number: "QN-100", type: "mejora", system: "sag_web", status: "borrador",
  developer: { id: "s", displayName: "Desarrollo" }, clientName: null, whatChanged: null,
  routes: [{ via: "barra_lateral", submenus: ["Pedidos"], option: "Consultar" }],
  requiredActions: [], attachments: [], etag: '"v1"',
};
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const testRound = { id: "round-test", roundNo: 1, revisionNo: 1, holderId: "s", holderName: "Asesora QA", status: "tomada", etag: '"round1"', checklist: [{ itemNo: 2, label: "Prueba funcional", checked: false }], notes: [], noteDraft: null };
const advisorEntry = { ...draftDetail, id: "test-entry", number: "QHN-TEST", status: "en_pruebas", developer: { id: "dev", displayName: "Autora" },
  initialAssigneeName: "Asesora inicial", lastTesterName: "Asesora histórica", rounds: [testRound], findings: [], participants: [], log: [], revisions: [], createdAt: "2026-10-24T15:00:00Z", clientText: null };
describe("Qué hay de nuevo · API real", () => {
  it("solo guarda al pulsar Guardar borrador y conserva foco y cambios escritos durante una respuesta lenta", async () => {
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
    await tick(20_000);
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
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
    await tick(20_000);
    expect(put).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
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

  it("no guarda al perder foco y conserva el borrador si hay conflicto o se cancela la salida", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/entries/slow-draft" ? draftDetail : []);
    const put = vi.mocked(api.put).mockRejectedValue(Object.assign(new Error("Version conflict"), { status: 409, data: { code: "version_desactualizada" } }));
    mount(<LiveWhatsNewPage />, draftPath, "/actualizaciones/que-hay-de-nuevo/*");
    const option = await screen.findByRole("textbox", { name: "Opción" });
    vi.useFakeTimers();
    fireEvent.change(option, { target: { value: "Edición local" } });
    fireEvent.blur(option, { relatedTarget: screen.getByRole("link", { name: /Volver a mis entradas/ }) });
    await tick(1_000);
    expect(put).not.toHaveBeenCalled();
    await tick(20_000);
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await tick(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/otra persona modificó/i);
    expect(option).toHaveValue("Edición local");
    expect(option).toBeEnabled();
    fireEvent.change(option, { target: { value: "Edición local sin perder" } });
    await tick(60_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(option).toHaveValue("Edición local sin perder");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("link", { name: /Volver a mis entradas/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(option).toHaveValue("Edición local sin perder");
    confirm.mockRestore();
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
  it("guarda el valor elegido del interruptor en ambos sentidos y relee la versión antes del siguiente cambio", async () => {
    const manager = { ...author, permissions: ["configuration.whats_new.view", "configuration.whats_new.manage"] };
    let settings = { publicEnabled: false, etag: '"v1"' };
    const config = () => ({ settings, actions: [], publicUrl: "/novedades" });
    get.mockImplementation(async path => path === "/whats-new/me" ? manager : config());
    const put = vi.mocked(api.put);
    put.mockImplementation(async (_path, body) => {
      settings = { publicEnabled: (body as { publicEnabled: boolean }).publicEnabled, etag: settings.etag === '"v1"' ? '"v2"' : '"v3"' };
      return config();
    });
    mount(<LiveConfigPage />);
    const publication = await screen.findByRole("switch", { name: "Publicación activa" });
    expect(publication).not.toBeChecked();
    fireEvent.click(publication);
    await waitFor(() => expect(put).toHaveBeenNthCalledWith(1, "/whats-new/config/settings", { publicEnabled: true }, { headers: { "If-Match": '"v1"' } }));
    await waitFor(() => {
      expect(publication).toBeChecked();
      expect(publication).toBeEnabled();
    });
    fireEvent.click(publication);
    await waitFor(() => expect(put).toHaveBeenNthCalledWith(2, "/whats-new/config/settings", { publicEnabled: false }, { headers: { "If-Match": '"v2"' } }));
    await waitFor(() => {
      expect(publication).not.toBeChecked();
      expect(publication).toBeEnabled();
    });
    expect(put).toHaveBeenCalledTimes(2);
  });
  it("separa Aprobadas y Fallidas y recupera filtros y página de la URL", async () => {
    get.mockImplementation(async (path) => path === "/whats-new/me" ? { user: { id: "s", displayName: "Asesora SQL", email: "s@test.co" }, areas: ["soporte"], permissions: ["updates.whats_new.view", "updates.whats_new.test"], views: ["asesor"], defaultView: "asesor", storageAvailable: false } : { items: [], total: 0, page: 1, pageSize: 20 });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo?tab=fallidas&createdMonth=2026-10&page=2&q=pedidos", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByRole("tab", { name: "Fallidas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "En pruebas" })).toBeInTheDocument();
    expect(screen.getByLabelText("Mes de creación")).toHaveValue("2026-10");
    expect(screen.getByLabelText("Buscar")).toHaveValue("pedidos");
    await waitFor(() => expect(get.mock.calls.some(([p]) => p.includes("result=fallidas") && p.includes("createdMonth=2026-10") && p.includes("page=2"))).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Aprobadas" }));
    expect(screen.queryByLabelText("Resultado")).toBeNull();
    expect(screen.queryByLabelText("Usuario simulado")).toBeNull();
    expect(screen.getByLabelText("Buscar")).toHaveAttribute("maxlength", "100");
    await waitFor(() => expect(get.mock.calls.some(([p]) => p.includes("/queue?") && p.includes("tab=probadas") && p.includes("result=sin_errores") && p.includes("page=1"))).toBe(true));
  });
  it("pide el mes anterior por creación y distingue la asignación inicial de la prueba activa sin perder la lista al abrir el detalle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T04:59:59.999Z"));
    get.mockImplementation(async path => path === "/whats-new/me" ? advisor : path === "/whats-new/entries/test-entry" ? advisorEntry
      : { items: [{ ...advisorEntry, holder: { id: "s", displayName: "Asesora QA" } }], total: 1, page: 1, pageSize: 20 });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByLabelText("Mes de creación")).toHaveValue("2025-11");
    fireEvent.click(screen.getByLabelText("Asignadas a mí inicialmente"));
    fireEvent.click(screen.getByRole("tab", { name: "En pruebas" }));
    fireEvent.click(screen.getByLabelText("Probando yo"));
    const selected = await screen.findByRole("link", { name: "Ver detalle de QHN-TEST" });
    await waitFor(() => expect(get.mock.calls.some(([p]) => p.includes("createdMonth=2025-11") && p.includes("testingByMe=true"))).toBe(true));
    expect(get.mock.calls.some(([p]) => p.includes("assignedToMe=true"))).toBe(true);
    fireEvent.click(selected);
    expect(await screen.findByRole("heading", { name: "QHN-TEST" })).toBeVisible();
    expect(screen.getByLabelText("Mes de creación")).toHaveValue("2025-11");
    expect(screen.getByLabelText("Probando yo")).toBeChecked();
    expect(screen.getAllByText("Asesora inicial").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "Prueba funcional" }));
    const cancel = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("tab", { name: "Aprobadas" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "En pruebas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("checkbox", { name: "Prueba funcional" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar bandeja" }));
    await waitFor(() => expect(get.mock.calls.filter(([p]) => p.includes("testingByMe=true"))).toHaveLength(2));
    expect(screen.getByRole("checkbox", { name: "Prueba funcional" })).toBeChecked();
    cancel.mockRestore();
  });
  it("mantiene checklist y avance locales y solo guarda juntos con el ETag de ronda", async () => {
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Avance local" }] }] };
    let entry: unknown = advisorEntry;
    get.mockImplementation(async path => path === "/whats-new/me" ? advisor : entry);
    const patch = vi.mocked(api.patch).mockImplementation(async () => {
      entry = { ...advisorEntry, rounds: [{ ...testRound, etag: '"round2"', checklist: [{ ...testRound.checklist[0], checked: true }], noteDraft: body }] };
      return entry;
    });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo/test-entry", "/actualizaciones/que-hay-de-nuevo/*");
    const check = await screen.findByRole("checkbox", { name: "Prueba funcional" });
    const editor = screen.getByRole("textbox", { name: "Borrador de avance" }) as HTMLElement & { editor: Editor };
    fireEvent.click(check);
    act(() => { editor.focus(); editor.editor.commands.insertContent("Avance local"); });
    vi.useFakeTimers();
    await tick(20_000);
    expect(patch).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(check).toBeChecked();
    expect(screen.getByRole("button", { name: "Aprobar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar avance" }));
    await tick(1);
    expect(patch).toHaveBeenCalledExactlyOnceWith("/whats-new/rounds/round-test/round-progress", { items: [{ itemNo: 2, checked: true }], body }, { headers: { "If-Match": '"round1"' } });
    expect(screen.getByRole("textbox", { name: "Borrador de avance" })).toBe(editor);
    expect(editor).toHaveFocus();
    expect(screen.getByText("Avance guardado.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Aprobar" })).toBeEnabled();
  });
  it("no preselecciona publicar y permite aprobar en privado sin permiso de publicación", async () => {
    let entry = { ...advisorEntry, rounds: [{ ...testRound, checklist: [{ ...testRound.checklist[0], checked: true }] }] };
    get.mockImplementation(async path => path === "/whats-new/me" ? advisor : entry);
    vi.mocked(api.post).mockImplementation(async () => { entry = { ...entry, status: "probado" }; return entry; });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo/test-entry", "/actualizaciones/que-hay-de-nuevo/*");
    fireEvent.click(await screen.findByRole("button", { name: "Aprobar" }));
    let dialog = within(screen.getByRole("dialog", { name: "Aprobar entrada" }));
    expect(dialog.getByRole("radio", { name: "Sí, mostrar a clientes" })).toBeDisabled();
    expect(dialog.getByRole("radio", { name: "No, mantener privada" })).not.toBeChecked();
    expect(dialog.getByRole("button", { name: "Confirmar aprobación" })).toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Título para clientes")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    dialog = within(screen.getByRole("dialog", { name: "Aprobar entrada" }));
    fireEvent.click(dialog.getByRole("radio", { name: "No, mantener privada" }));
    fireEvent.click(dialog.getByRole("button", { name: "Confirmar aprobación" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith("/whats-new/entries/test-entry/mark-tested", { publishToClients: false }, { headers: { "If-Match": '"v1"', "Idempotency-Key": expect.any(String) } }));
  });
  it("un asesor autorizado puede aprobar con texto público guardado y luego ocultar mediante la versión de entrada", async () => {
    const privileged = { ...advisor, publicEnabled: false, permissions: [...advisor.permissions, "updates.whats_new.publish_client"] };
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Explicación publicada" }] }] };
    let entry = { ...advisorEntry, rounds: [{ ...testRound, checklist: [{ ...testRound.checklist[0], checked: true }] }],
      clientText: { title: "Título público", body, etag: '"text-version"', showToClients: false } };
    get.mockImplementation(async path => path === "/whats-new/me" ? privileged : entry);
    const post = vi.mocked(api.post).mockImplementation(async path => {
      if (path.endsWith("mark-tested")) entry = { ...entry, status: "probado", etag: '"v2"', rounds: [], clientText: { ...entry.clientText, showToClients: true } };
      if (path.endsWith("set-client-visibility")) entry = { ...entry, etag: '"v3"', clientText: { ...entry.clientText, showToClients: false } };
      return entry;
    });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo/test-entry", "/actualizaciones/que-hay-de-nuevo/*");
    fireEvent.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialog = within(screen.getByRole("dialog", { name: "Aprobar entrada" }));
    fireEvent.click(dialog.getByRole("radio", { name: "Sí, mostrar a clientes" }));
    expect(dialog.getByText(/publicación general está desactivada/i)).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "Confirmar aprobación" }));
    expect(await screen.findByText("Preparada · publicación general desactivada")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Ocultar a clientes" }));
    await waitFor(() => expect(post).toHaveBeenNthCalledWith(2, "/whats-new/entries/test-entry/set-client-visibility", { showToClients: false }, { headers: { "If-Match": '"v2"', "Idempotency-Key": expect.any(String) } }));
    expect(post.mock.calls[0][1]).toEqual({ publishToClients: true });
    expect(await screen.findByText("Privada")).toBeVisible();
    expect(api.put).not.toHaveBeenCalled();
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
  it("abre el reporte en un iframe aislado y delega su autorización al endpoint", async () => {
    vi.mocked(api.getText).mockResolvedValue("<!doctype html><html><body>Reporte congelado</body></html>");
    mount(<LiveReportPage />, "/reportes/r", "/reportes/:id");
    expect(await screen.findByTitle("Reporte completo")).toHaveAttribute("sandbox", "");
    expect(api.getText).toHaveBeenCalledWith("/whats-new/reports/r", { credentials: "include" });
    expect(get).not.toHaveBeenCalled();
  });
  it("guarda un reporte privado con confirmación real sin pedir destinatarios ni llamar al envío", async () => {
    const onSaved = vi.fn();
    const post = vi.mocked(api.post);
    const hash = "a".repeat(64);
    post.mockResolvedValueOnce({ html: "<p>Vista previa</p>", entryCount: 1, approvedCount: 1, failedCount: 0, snapshotSha256: hash });
    post.mockResolvedValueOnce({ id: "saved-r" });
    mount(<ReportDialog filters={{}} onClose={() => {}} onSaved={onSaved} />);
    expect(screen.queryByLabelText("Buscar destinatarios")).toBeNull();
    expect(screen.getByRole("button", { name: "Guardar reporte privado" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Ver vista previa" }));
    expect(await screen.findByTitle("Vista previa del reporte")).toHaveAttribute("sandbox", "");
    fireEvent.click(screen.getByRole("button", { name: "Guardar reporte privado" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("saved-r"));
    expect(post).toHaveBeenCalledWith("/whats-new/reports/saved", { include: "todas", filters: {}, previewSha256: hash }, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) }));
    expect(post.mock.calls.some(([path]) => path === "/whats-new/reports")).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
  it("cuando cambia el reporte, mantiene filtros y exige generar otra vista previa", async () => {
    const post = vi.mocked(api.post);
    post.mockResolvedValueOnce({ html: "<p>Vista previa anterior</p>", entryCount: 2, approvedCount: 0, failedCount: 2, snapshotSha256: "b".repeat(64) });
    post.mockRejectedValueOnce(Object.assign(new Error("Conflict"), { status: 409, data: { code: "report_preview_stale" } }));
    mount(<ReportDialog filters={{ createdMonth: "2026-10", q: "pedidos" }} result="fallidas" onClose={() => {}} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver vista previa" }));
    await screen.findByTitle("Vista previa del reporte");
    fireEvent.click(screen.getByRole("button", { name: "Guardar reporte privado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/genera una nueva vista previa/i);
    expect(screen.queryByTitle("Vista previa del reporte")).toBeNull();
    expect(screen.getByRole("button", { name: "Guardar reporte privado" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Solo fallidas" })).toBeChecked();
    expect(post.mock.calls[1][1]).toEqual({ include: "fallidas", filters: { createdMonth: "2026-10", q: "pedidos" }, previewSha256: "b".repeat(64) });
  });
  it("permite eliminar una entrada desde un borrador guardado solo tras confirmación y conserva su ETag", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/entries/slow-draft" ? { ...draftDetail, canDelete: true } : path.startsWith("/whats-new/entries?") ? { items: [], total: 0, page: 1, pageSize: 20 } : []);
    vi.mocked(api.del).mockResolvedValue(undefined);
    mount(<LiveWhatsNewPage />, draftPath, "/actualizaciones/que-hay-de-nuevo/*");
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar entrada" }));
    const dialog = screen.getByRole("dialog", { name: "Eliminar entrada" });
    expect(dialog).toHaveTextContent(/se conserva el historial/i);
    expect(api.del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar eliminación" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/whats-new/entries/slow-draft", { headers: { "If-Match": '"v1"' } }));
    expect(await screen.findByRole("heading", { name: /Mis entradas/ })).toBeInTheDocument();
  });
  it("no ofrece eliminar un borrador si el servidor no lo autoriza", async () => {
    get.mockImplementation(async path => path === "/whats-new/me" ? author : path === "/whats-new/entries/slow-draft" ? { ...draftDetail, canDelete: false } : []);
    mount(<LiveWhatsNewPage />, draftPath, "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByRole("heading", { name: /Editar borrador/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Eliminar entrada" })).toBeNull();
  });
  it("permite a super_admin sin área localizar y retirar un borrador ajeno desde el detalle, sin editarlo", async () => {
    const admin = { ...author, areas: [], views: ["lectura"], superAdmin: true, canUseSavedReports: true };
    const otherDraft = {
      ...draftDetail, id: "other-draft", developer: { id: "other", displayName: "Otra persona" }, canDelete: true,
      createdAt: "2026-11-24T15:00:00Z", rounds: [], findings: [], log: [], participants: [], revisions: [],
    };
    get.mockImplementation(async path => path === "/whats-new/me" ? admin : path === "/whats-new/entries/other-draft" ? otherDraft : { items: [otherDraft], total: 1, page: 1, pageSize: 20 });
    vi.mocked(api.del).mockResolvedValue(undefined);
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByRole("heading", { name: /Entradas del equipo/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Nueva entrada" })).toBeNull();
    expect(screen.getByRole("link", { name: "Reportes guardados" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: "Ver detalle de QN-100" }));
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar entrada" }));
    expect(screen.queryByRole("link", { name: "Continuar edición" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar eliminación" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/whats-new/entries/other-draft", { headers: { "If-Match": '"v1"' } }));
  });
  it("ofrece reportes guardados también en Soporte solo por capacidad del servidor", async () => {
    const support = { ...author, areas: ["soporte"], permissions: ["updates.whats_new.view", "updates.whats_new.test", "updates.whats_new.report"], views: ["asesor"], canUseSavedReports: true };
    get.mockImplementation(async path => path === "/whats-new/me" ? support : { items: [], total: 0, page: 1, pageSize: 20 });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo", "/actualizaciones/que-hay-de-nuevo/*");
    expect(await screen.findByRole("link", { name: "Reportes guardados" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Aprobadas" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar reporte privado" }));
    expect(screen.getByRole("button", { name: "Guardar reporte privado" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enviar/ })).toBeNull();
  });
  it("elimina un reporte guardado solo si el servidor lo permite, y nunca cuando se cancela", async () => {
    const owner = { ...author, canUseSavedReports: true };
    let deleted = false;
    const reports = [
      { id: "saved-r", generatedAt: "2026-11-24T15:00:00Z", generatedBy: owner.user, entryCount: 1, approvedCount: 1, failedCount: 0, canDelete: true },
      { id: "blocked-r", generatedAt: "2026-11-24T14:00:00Z", generatedBy: { id: "other", displayName: "Otra persona" }, entryCount: 1, approvedCount: 1, failedCount: 0, canDelete: false },
    ];
    get.mockImplementation(async path => path === "/whats-new/me" ? owner : { items: deleted ? reports.slice(1) : reports, total: deleted ? 1 : 2, page: 1, pageSize: 20 });
    vi.mocked(api.del).mockImplementation(async () => { deleted = true; });
    mount(<LiveWhatsNewPage />, "/actualizaciones/que-hay-de-nuevo/reportes", "/actualizaciones/que-hay-de-nuevo/*");
    const deleteButton = await screen.findByRole("button", { name: "Eliminar reporte" });
    expect(screen.getAllByRole("button", { name: "Eliminar reporte" })).toHaveLength(1);
    fireEvent.click(deleteButton);
    expect(screen.getByRole("dialog", { name: "Eliminar reporte" })).toHaveTextContent(/se conserva el historial/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(api.del).not.toHaveBeenCalled();
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar eliminación" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/whats-new/reports/saved-r"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Eliminar reporte" })).toBeNull());
  });
});
