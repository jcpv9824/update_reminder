import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogoClientesRoute from "../pages/CatalogoClientesRoute";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get, post } }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: { id: "sesion-prueba", roles: ["catalog-reader"] } }),
}));

const cliente = { id: "2f2e2f2e-0000-4000-8000-2f2e2f2e2f2e", name: "Comercial Ejemplo", state: "active", web: "in_web", sources: [],
  stateVaries: false, requiresReconciliation: false };
const detallePath = `/catalog/customers/${cliente.id}`;
const dominiosPath = `${detallePath}/domains`;
const licenciasPath = `${detallePath}/licenses`;

describe("indicadores de Clientes en la ruta", () => {
  afterEach(() => { vi.unstubAllEnvs(); get.mockReset(); post.mockReset(); });
  it.each([
    ["clients.domains.view", "Ver dominios observados", dominiosPath, "Ver licencias observadas", licenciasPath],
    ["clients.licensing.view", "Ver licencias observadas", licenciasPath, "Ver dominios observados", dominiosPath],
  ])("autoriza solo el indicador de %s y envía su solicitud con ID opaco", async (permission, boton, endpoint, oculto, noEndpoint) => {
    vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
    const called = (path: string) => get.mock.calls.some(([calledPath]) => calledPath === path);
    get.mockImplementation(async (path: string) => {
      if (path === "/roles") return [{ id: "catalog-reader", active: true, permissions: ["clients.clients.view", permission] }];
      if (path === detallePath) return cliente;
      if (path === dominiosPath) return { state: "verified", verifiedAt: null, partial: false, items: [] };
      if (path === licenciasPath) return { state: "verified", verifiedAt: null, partial: false,
        items: [
          { code: "F", environments: ["production", "unknown"] },
          { code: "C", environments: ["test"], moduleName: "Contabilidad", moduleDescription: "Gestión contable" },
          { code: "N", environments: ["demo"], moduleName: "Nómina" },
        ] };
      return { items: [cliente], sources: [], sag: { state: "verified", verifiedAt: null }, partial: false,
        total: 1, page: 1, pageSize: 25 };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<QueryClientProvider client={queryClient}><CatalogoClientesRoute /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Ver fuentes de Comercial Ejemplo" }));
    const control = await screen.findByRole("button", { name: boton });
    expect(screen.queryByRole("button", { name: oculto })).toBeNull();
    expect(called(endpoint)).toBe(false);
    fireEvent.click(control);
    await screen.findByText(/Evidencia: Verificada/);
    expect(get).toHaveBeenCalledWith(endpoint, { signal: expect.any(AbortSignal) });
    expect(called(noEndpoint)).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(called("/catalog/refresh/status")).toBe(false);
    if (endpoint === licenciasPath) {
      const legado = screen.getByText("F").closest("li");
      expect(legado).toHaveTextContent("Correspondencia no verificada");
      expect(legado).toHaveTextContent("Producción, Ambiente no verificado");
      const certificado = screen.getByText("C").closest("li");
      expect(certificado).toHaveTextContent("Contabilidad");
      expect(certificado).toHaveTextContent("Gestión contable");
      expect(certificado).toHaveTextContent("Pruebas");
      expect(certificado).not.toHaveTextContent("Correspondencia no verificada");
      const sinDescripcion = screen.getByText("N").closest("li");
      expect(sinDescripcion).toHaveTextContent("Nómina");
      expect(sinDescripcion).toHaveTextContent("Demostración");
      expect(sinDescripcion).not.toHaveTextContent("Correspondencia no verificada");
    }
  });
});

const fuenteA = { sourceId: "10000000-0000-4000-8000-000000000001", label: "Empresa A", revisionState: "verified", verifiedAt: null };
const fuenteB = { ...fuenteA, sourceId: "10000000-0000-4000-8000-000000000002", label: "Empresa B" };

function setupRefresh(status?: () => unknown) {
  vi.stubEnv("VITE_PORTAL_CATALOG_READ_ENABLED", "true");
  vi.stubEnv("VITE_PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
  get.mockImplementation(async (path: string) => {
    if (path === "/roles") return [{ id: "catalog-reader", active: true, permissions: ["clients.clients.view", "clients.domains.view"] }];
    if (path.startsWith("/catalog/refresh/status")) return status?.();
    if (path === detallePath) return { ...cliente, sources: [{ ...fuenteA, state: "active" }] };
    if (path === dominiosPath) return { state: "verified", verifiedAt: null, partial: false,
      items: [{ host: "sensible.example", observations: [] }] };
    return { items: [cliente], sources: [fuenteA, fuenteB], sag: { state: "verified", verifiedAt: null }, partial: false,
      total: 50, page: path.includes("page=2") ? 2 : 1, pageSize: 25 };
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<StrictMode><QueryClientProvider client={queryClient}><CatalogoClientesRoute /></QueryClientProvider></StrictMode>);
  return queryClient;
}

describe("actualización automática de Clientes", () => {
  afterEach(() => { vi.unstubAllEnvs(); get.mockReset(); post.mockReset(); });

  it("encola al abrir, buscar o cambiar fuentes; no al escribir, paginar o filtrar estado", async () => {
    post.mockImplementation(() => new Promise(() => {}));
    setupRefresh();
    await screen.findByText(cliente.name);
    expect(post).toHaveBeenCalledExactlyOnceWith("/catalog/refresh", {}, { signal: expect.any(AbortSignal) });

    fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/i }));
    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Presencia en SAG Web"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Buscar por nombre oficial"), { target: { value: "Comercial" } });
    expect(post).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith("/catalog/refresh", {}, { signal: expect.any(AbortSignal) });
    expect(post.mock.calls[0][2].signal.aborted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Fuentes:/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Empresa B" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post).toHaveBeenLastCalledWith("/catalog/refresh", { sourceIds: [fuenteA.sourceId] }, { signal: expect.any(AbortSignal) });

    const solicitudes = get.mock.calls.length;
    fireEvent.click(screen.getByRole("checkbox", { name: "Empresa A" }));
    expect(await screen.findByText(/Selecciona al menos una fuente/)).toBeInTheDocument();
    expect(screen.queryByText(cliente.name)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Empresa A" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][2].signal.aborted).toBe(true);
    expect(get).toHaveBeenCalledTimes(solicitudes);
  });

  it("vuelve a actualizar y leer al repetir una búsqueda terminada, pero no duplica la que está pendiente", async () => {
    post.mockImplementationOnce(() => new Promise(() => {}));
    post.mockResolvedValue({ accepted: 1, coalesced: 0 });
    setupRefresh(() => ({ pending: false, items: [] }));
    await screen.findByText(cliente.name);
    const buscar = screen.getByRole("button", { name: "Buscar" });
    const actualizar = screen.getByRole("button", { name: "Actualizar lista" });
    const lecturas = () => get.mock.calls.filter(([path]) =>
      path.startsWith("/catalog/customers?") && path.includes("search=Comercial"));
    fireEvent.change(screen.getByLabelText("Buscar por nombre oficial"), { target: { value: "Comercial" } });
    fireEvent.click(buscar);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(actualizar).toBeDisabled();
    fireEvent.click(buscar);
    expect(post).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(lecturas()).toHaveLength(2), { timeout: 3_500 });
    expect(actualizar).toBeEnabled();

    fireEvent.click(buscar);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post).toHaveBeenLastCalledWith("/catalog/refresh", {}, { signal: expect.any(AbortSignal) });
    await waitFor(() => expect(lecturas()).toHaveLength(3), { timeout: 3_500 });
    expect(post).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("borra filas, detalle e indicadores de esta sesión si el seguimiento recibe 403", async () => {
    post.mockResolvedValue({ accepted: 1, coalesced: 0 });
    const queryClient = setupRefresh(() => { throw Object.assign(new Error("detalle interno"), { status: 403 }); });
    queryClient.setQueryData(["catalogo-clientes", "otra-sesion", "lista"], { available: true });
    fireEvent.click(await screen.findByRole("button", { name: `Ver fuentes de ${cliente.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Ver dominios observados" }));
    expect(await screen.findByText("sensible.example")).toBeInTheDocument();

    expect(await screen.findByRole("alert", {}, { timeout: 5_000 })).toHaveTextContent(/acceso al catálogo/i);
    expect(screen.queryByText(cliente.name)).not.toBeInTheDocument();
    expect(screen.queryByText("sensible.example")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Fuentes:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Empresa A" })).not.toBeInTheDocument();
    expect(screen.queryByText(/detalle interno/)).not.toBeInTheDocument();
    expect(queryClient.getQueriesData({ queryKey: ["catalogo-clientes"] }).filter(([, data]) => data !== undefined))
      .toEqual([[ ["catalogo-clientes", "otra-sesion", "lista"], { available: true } ]]);
  });
});
