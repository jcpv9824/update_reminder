import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
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
    mockRequests(permission, () => { throw new Error("No debe consultar el catálogo"); });
    renderRoute(path);
    await waitFor(() => expect(get.mock.calls.some(([request]) => request.startsWith(legacy))).toBe(true));
    expect(get.mock.calls.some(([request]) => request.startsWith("/catalog/inventory/"))).toBe(false);
  });

  it.each(routes)("%s rechaza el acceso directo sin el permiso de la vista", async (path) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    mockRequests("clients.clients.view", () => { throw new Error("No debe consultar el catálogo"); });
    renderRoute(path);
    expect(await screen.findByRole("heading", { name: "No autorizado" })).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/roles"));
    expect(get.mock.calls.some(([request]) => request.startsWith("/catalog/inventory/"))).toBe(false);
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
});
