import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const { get, post, auth } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  auth: { cargando: false, usuario: { id: "lector-inventario", roles: ["role-inventory"] } },
}));
vi.mock("../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/client")>(),
  api: { get, post },
}));
vi.mock("../auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => auth,
}));

const routes = [
  ["/dominios", "Dominios", "domains", "clients.domains.view", "/domains?"],
  ["/bases-de-datos", "Bases de Datos", "databases", "clients.databases.view", "/databases?"],
  ["/licenciamiento", "Licenciamiento", "licenses", "clients.licensing.view", "/license-modules?"],
] as const;
const nativeDialogMethods = (["showModal", "close"] as const).map(name => ({
  name, original: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
}));

const page = (state = "verified", items: unknown[] = [], current = 1, total = items.length) => ({
  items, state, page: current, pageSize: 25, total,
});

function mockRequests(permission: string, readInventory: (path: string) => unknown) {
  get.mockImplementation(async (path: string) => {
    if (path === "/roles") return [{ id: "role-inventory", active: true, permissions: [permission], name: "Lector" }];
    if (path.startsWith("/catalog/inventory/")) return readInventory(path);
    return path.includes("?") ? page() : [];
  });
}

function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>;
  const rendered = render(tree());
  return { ...rendered, refreshSession: () => rendered.rerender(tree()) };
}

describe("Vistas independientes del catálogo", () => {
  beforeEach(() => {
    // The rollout environment may enable observed inventory globally in CI.
    // Each observed scenario opts in explicitly; legacy tests start without it.
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "false");
    vi.stubEnv("VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "false");
  });

  afterEach(() => {
    for (const { name, original } of nativeDialogMethods) {
      if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    }
    vi.unstubAllEnvs();
    get.mockReset();
    post.mockReset();
    auth.usuario = { id: "lector-inventario", roles: ["role-inventory"] };
  });

  it.each(routes)("%s usa solo su inventario de solo lectura", async (path, label, view, permission) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    mockRequests(permission, () => page("verified", [{
      id: "registro-prueba", customerName: "Cliente de ejemplo", name: "Registro autorizado", environment: "test", detail: "Detalle seguro",
      user: "dato-excluido", password: "valor-excluido",
    }]));
    renderRoute(path);
    const table = await screen.findByRole("table", { name: `${label} del catálogo` });
    expect(table).toHaveTextContent("Cliente de ejemplo");
    expect(table).toHaveTextContent("Registro autorizado");
    expect(table).toHaveTextContent("Pruebas");
    expect(table).toHaveTextContent("Detalle seguro");
    expect(table).not.toHaveTextContent(/dato-excluido|valor-excluido/);
    expect(screen.queryByRole("button", { name: /Crear|Nuevo|Editar|Eliminar|Desactivar|Copiar|Conexión|Contraseña/i })).not.toBeInTheDocument();
    expect(get.mock.calls.filter(([request]) => request !== "/roles")).toEqual([
      [`/catalog/inventory/${view}?page=1&pageSize=25`, { signal: expect.any(AbortSignal) }],
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(routes)("%s conserva su fuente heredada con la opción desactivada", async (path, _label, _view, permission, legacy) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "false");
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "false");
    vi.stubEnv("VITE_PORTAL_CATALOG_CLIENTS_READ_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
    mockRequests(permission, () => { throw new Error("No debe consultar el catálogo"); });
    renderRoute(path);
    await waitFor(() => expect(get.mock.calls.some(([request]) => request.startsWith(legacy))).toBe(true));
    expect(get.mock.calls.some(([request]) => request.startsWith("/catalog/inventory/"))).toBe(false);
    expect(get.mock.calls.some(([request]) => request.startsWith("/catalog/refresh/status"))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  const observedRows = {
    domains: { name: "ejemplo.sagweb.co", heading: "Dominio" },
    databases: { name: "EMPRESA_WEB", heading: "Base de datos", detail: "ejemplo.sagweb.co", detailHeading: "Dominio" },
  };

  it("conserva el contrato anterior de observaciones si el directorio v2 no se activa", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "true");
    mockRequests("clients.licensing.view", () => page("verified", [{
      id: "registro", customerName: "Cliente ERP", name: "Código X", environment: "unknown",
    }]));
    renderRoute("/licenciamiento");
    expect(await screen.findByRole("table", { name: "Licenciamiento del catálogo" })).toHaveTextContent("Código X");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/catalog/inventory/licenses?page=1&pageSize=25", expect.anything());
  });

  it.each([routes[0], routes[1]])("%s consulta observaciones sin activar el inventario operativo ni encolar importaciones", async (path, label, view, permission, legacy) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "false");
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
    const record = observedRows[view];
    mockRequests(permission, () => page("partial", [{
      id: "observacion", customerId: "CLI-01", customerName: "Nombre oficial ERP", name: record.name, environment: "unknown",
      ...("detail" in record ? { detail: record.detail } : {}),
      user: "dato-excluido", password: "valor-excluido",
    }]));
    renderRoute(path);
    const table = await screen.findByRole("table", { name: `${label} del catálogo` });
    expect(screen.getByText(/SAG Admin.*ERP.*solo lectura/i)).toBeInTheDocument();
    expect(screen.getByText(/La información del catálogo está incompleta.*no se pueden confirmar/i)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Cliente (ERP)" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "ID del cliente" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: record.heading })).toBeInTheDocument();
    expect(table).toHaveTextContent("Nombre oficial ERP");
    expect(table).toHaveTextContent("CLI-01");
    expect(table).toHaveTextContent(record.name);
    expect(table).toHaveTextContent("Ambiente no verificado");
    if ("detail" in record) {
      expect(screen.getByRole("columnheader", { name: record.detailHeading })).toBeInTheDocument();
      expect(table).toHaveTextContent(record.detail);
    }
    expect(table).not.toHaveTextContent(/dato-excluido|valor-excluido/);
    expect(screen.queryByRole("button", { name: /Crear|Nuevo|Editar|Eliminar|Desactivar|Copiar|Conexión|Contraseña/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
    await waitFor(() => expect(get.mock.calls.filter(([request]) => request.startsWith("/catalog/inventory/"))).toHaveLength(2));
    expect(get.mock.calls.some(([request]) => request.startsWith(legacy) || request.startsWith("/catalog/refresh"))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([routes[0], routes[1]])("%s envía búsqueda y ambiente exactos al API y reinicia la paginación", async (path, label, view, permission) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "true");
    mockRequests(permission, request => {
      const query = new URL(request, "https://portal.example.invalid").searchParams;
      return page("verified", [{
        id: "registro", customerId: "CLI-01", customerName: "Cliente A", name: "Nombre", environment: query.get("environment") ?? "production",
      }], Number(query.get("page")), 26);
    });
    renderRoute(path);
    await screen.findByRole("table", { name: `${label} del catálogo` });
    const environment = screen.getByRole("combobox", { name: "Ambiente" });
    expect(within(environment).getAllByRole("option").map(option => (option as HTMLOptionElement).value))
      .toEqual(["", "production", "test", "demo", "unknown"]);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith(`/catalog/inventory/${view}?page=2&pageSize=25&v=2`, expect.anything()));
    const filtros = screen.getByRole("form", { name: "Filtros del inventario" });
    const search = within(filtros).getByRole("textbox");
    fireEvent.change(search, { target: { value: "  CLI-01 & A  " } });
    fireEvent.click(within(filtros).getByRole("button", { name: "Buscar" }));
    fireEvent.change(environment, { target: { value: "test" } });
    await waitFor(() => expect(get).toHaveBeenCalledWith(
      `/catalog/inventory/${view}?page=1&pageSize=25&v=2&search=CLI-01+%26+A&environment=test`, expect.anything()));
    expect(post).not.toHaveBeenCalled();
  });

  it("separa los módulos disponibles, los clientes y el detalle filtrable de un código", async () => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) {
        this.open = true;
        this.querySelector<HTMLElement>("button")?.focus();
      } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
    });
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
    const sourceA = "10000000-0000-4000-8000-000000000001";
    const sources = [{ id: sourceA, label: "ERP Colombia" }, { id: "10000000-0000-4000-8000-000000000002", label: "ERP Dos" }];
    mockRequests("clients.licensing.view", request => {
      const tab = new URL(request, "https://portal.example.invalid").searchParams.get("tab");
      if (tab === "customers") return page("verified", [
        { id: "row-c", customerId: "CLI-01", customerName: "Nombre oficial ERP", licenses: ["Inventario", "Auditor"] },
        { id: "row-empty", customerId: "CLI-02", customerName: "Cliente sin correspondencia", licenses: [] },
      ]);
      if (tab === "licenseCustomers") return page("verified", [{
        id: "row-c", customerId: "CLI-01", customerName: "Nombre oficial ERP", password: "excluir",
      }]);
      return { ...page("partial", [{ id: "license-D", code: "D", name: "Inventario" }]), sources };
    });
    renderRoute("/licenciamiento");
    expect(await screen.findByText("Inventario")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Licencias disponibles" })).toHaveAttribute("aria-selected", "true");
    const abrir = screen.getByRole("button", { name: "Ver clientes de Inventario" });
    fireEvent.click(abrir);
    const detalle = await screen.findByRole("dialog", { name: "Clientes con Inventario" });
    const table = await within(detalle).findByRole("table", { name: "Clientes con la licencia" });
    expect(within(table).getAllByRole("columnheader").map(th => th.textContent)).toEqual(["ID", "Nombre"]);
    expect(table).toHaveTextContent("CLI-01");
    expect(table).toHaveTextContent("Nombre oficial ERP");
    expect(table).not.toHaveTextContent("excluir");
    expect(get).toHaveBeenCalledWith("/catalog/inventory/licenses?page=1&pageSize=25&v=2&tab=licenseCustomers&code=D&state=active&web=in_web", expect.anything());
    fireEvent.change(within(detalle).getByRole("combobox", { name: "Estado del cliente" }), { target: { value: "inactive" } });
    fireEvent.change(within(detalle).getByRole("combobox", { name: "Presencia en SAG Web" }), { target: { value: "all" } });
    fireEvent.click(within(detalle).getByRole("button", { name: /Fuentes: Todas/ }));
    fireEvent.click(within(detalle).getByRole("checkbox", { name: "ERP Dos" }));
    const filtro = within(detalle).getByRole("textbox");
    fireEvent.change(filtro, { target: { value: "CLI-01" } });
    fireEvent.click(within(detalle).getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith(
      `/catalog/inventory/licenses?page=1&pageSize=25&v=2&tab=licenseCustomers&code=D&state=inactive&web=all&search=CLI-01&sourceId=${sourceA}`, expect.anything()));
    if (!within(detalle).queryByRole("checkbox", { name: "ERP Colombia" })) {
      fireEvent.click(within(detalle).getByRole("button", { name: /Fuentes: ERP Colombia/ }));
    }
    const numConsultas = get.mock.calls.length;
    fireEvent.click(within(detalle).getByRole("checkbox", { name: "ERP Colombia" }));
    expect(await within(detalle).findByText(/Selecciona al menos una fuente/)).toBeInTheDocument();
    expect(within(detalle).queryByRole("table")).not.toBeInTheDocument();
    expect(get.mock.calls).toHaveLength(numConsultas);
    fireEvent.click(within(detalle).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(abrir).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Licencias disponibles" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Licencias por cliente" })).toHaveFocus();
    const clientes = await screen.findByRole("table", { name: "Licencias por cliente" });
    expect(get).toHaveBeenCalledWith("/catalog/inventory/licenses?page=1&pageSize=25&v=2&tab=customers&state=all&web=all", expect.anything());
    expect(clientes).toHaveTextContent("CLI-01");
    expect(clientes).toHaveTextContent("Nombre oficial ERP");
    expect(clientes).toHaveTextContent("Inventario, Auditor");
    expect(within(clientes).getByRole("row", { name: "CLI-02 Cliente sin correspondencia Sin licencias identificadas" })).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it.each(routes)("%s rechaza el acceso directo sin el permiso de la vista", async (path) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "false");
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "true");
    mockRequests("clients.clients.view", () => { throw new Error("No debe consultar el catálogo"); });
    renderRoute(path);
    expect(await screen.findByRole("heading", { name: "No autorizado" })).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/roles"));
    expect(get.mock.calls.some(([request]) => request.startsWith("/catalog/inventory/"))).toBe(false);
  });

  it("muestra la misma base como relaciones separadas para clientes y dominios distintos", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
    const relations = [
      { id: "a-web-test", customerId: "CLI-01", customerName: "Cliente A", detail: "web.ejemplo.test", environment: "test", label: "Pruebas" },
      { id: "a-web-prod", customerId: "CLI-01", customerName: "Cliente A", detail: "web.ejemplo.test", environment: "production", label: "Producción" },
      { id: "b-web", customerId: "CLI-02", customerName: "Cliente B", detail: "web.ejemplo.test", environment: "production", label: "Producción" },
      { id: "a-otro", customerId: "CLI-01", customerName: "Cliente A", detail: "otro.ejemplo.test", environment: "production", label: "Producción" },
    ];
    mockRequests("clients.databases.view", () => page("verified", relations.map(row => ({
      ...row, name: "EMPRESA_WEB",
    }))));
    renderRoute("/bases-de-datos");
    await screen.findByRole("table", { name: "Bases de Datos del catálogo" });
    for (const row of relations) {
      expect(screen.getByRole("row", { name: `${row.customerId} ${row.customerName} ${row.detail} EMPRESA_WEB ${row.label}` })).toBeInTheDocument();
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("distingue vacío verificado, cobertura parcial, indisponibilidad y error de lectura", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    let state = "verified";
    mockRequests("clients.domains.view", () => {
      if (state === "error") throw new Error("error técnico que no debe mostrarse");
      if (state === "unavailable") return page(state, [{ id: "dato-vencido", name: "Registro no verificado" }]);
      return page(state);
    });
    renderRoute("/dominios");
    expect(await screen.findByText("No hay registros para mostrar.")).toBeInTheDocument();
    const reload = screen.getByRole("button", { name: "Actualizar lista" });
    state = "partial";
    fireEvent.click(reload);
    expect(await screen.findByText("La información del catálogo está incompleta.")).toBeInTheDocument();
    expect(screen.getByText("No hay registros confirmados en esta página.")).toBeInTheDocument();
    state = "unavailable";
    fireEvent.click(reload);
    expect(await screen.findByRole("alert")).toHaveTextContent("El catálogo no está disponible o todavía no se ha verificado.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Registro no verificado")).not.toBeInTheDocument();
    state = "error";
    fireEvent.click(reload);
    await screen.findByText("No se pudo consultar el catálogo.");
    expect(screen.queryByText(/error técnico/)).not.toBeInTheDocument();
    expect(screen.queryByText("No hay registros para mostrar.")).not.toBeInTheDocument();
  });

  it("pagina el inventario y no reutiliza filas cuando cambia la identidad", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    const record = (name: string) => ({ id: name, customerName: "Cliente de ejemplo", name, environment: "unknown" });
    mockRequests("clients.databases.view", (path) => {
      if (auth.usuario.id === "otra-identidad") return page("unavailable");
      return path.includes("page=2&")
        ? page("verified", [record("Registro segunda página")], 2, 26)
        : page("verified", [record("Registro primera página")], 1, 26);
    });
    const rendered = renderRoute("/bases-de-datos");
    expect(await screen.findByText("Registro primera página")).toBeInTheDocument();
    expect(screen.getByText("Ambiente no verificado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/i }));
    expect(await screen.findByText("Registro segunda página")).toBeInTheDocument();
    auth.usuario = { ...auth.usuario, id: "otra-identidad" };
    rendered.refreshSession();
    expect(screen.queryByText(/Registro (primera|segunda) página/)).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no está disponible/);
    const requests = get.mock.calls.filter(([path]) => path.startsWith("/catalog/inventory/"));
    expect(requests.map(([path]) => path)).toEqual([1, 2, 1].map(n => `/catalog/inventory/databases?page=${n}&pageSize=25`));
  });

  it.each(routes)("%s encola al abrir con solo permiso de lectura y aborta al salir", async (path, label, _view, permission) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "false");
    vi.stubEnv("VITE_PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
    mockRequests(permission, () => page());
    post.mockImplementation(() => new Promise(() => {}));
    const rendered = renderRoute(path);
    await screen.findByRole("table", { name: `${label} del catálogo` });
    expect(post).toHaveBeenCalledExactlyOnceWith("/catalog/refresh", {}, { signal: expect.any(AbortSignal) });
    rendered.unmount();
    expect(post.mock.calls[0][2].signal.aborted).toBe(true);
  });

  it("revalida una sola vez tras el estado terminal y conserva filas si falla una fuente", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
    post.mockResolvedValue({ accepted: 0, coalesced: 1 });
    get.mockImplementation(async (path: string) => {
      if (path === "/roles") return [{ id: "role-inventory", active: true, permissions: ["clients.domains.view"], name: "Lector" }];
      if (path === "/catalog/refresh/status") return {
        pending: false,
        items: [{ sourceId: "10000000-0000-4000-8000-000000000001", status: "failed", updatedAt: "2026-11-18T12:00:00Z" }],
      };
      return page("partial", [{ id: "registro-prueba", customerName: "Cliente de ejemplo", name: "Registro autorizado", environment: "test" }]);
    });
    renderRoute("/dominios");
    expect(await screen.findByText("Registro autorizado")).toBeInTheDocument();
    const requests = () => get.mock.calls.filter(([path]) => path.startsWith("/catalog/inventory/domains"));
    const warning = await screen.findByText(/No se pudieron actualizar todas las fuentes/i, {}, { timeout: 5_000 });
    expect(warning).toHaveAttribute("role", "status");
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(screen.getByText("Registro autorizado")).toBeInTheDocument();
    expect(screen.getByText("La información del catálogo está incompleta.")).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  });
});
