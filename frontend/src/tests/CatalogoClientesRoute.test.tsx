import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogoClientesRoute from "../pages/CatalogoClientesRoute";

const get = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({ api: { get } }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: { id: "sesion-prueba", roles: ["catalog-reader"] } }),
}));

const cliente = { id: "2f2e2f2e-0000-4000-8000-2f2e2f2e2f2e", name: "Comercial Ejemplo", state: "active", web: "in_web", sources: [],
  stateVaries: false, requiresReconciliation: false };
const detallePath = `/catalog/customers/${cliente.id}`;
const dominiosPath = `${detallePath}/domains`;
const licenciasPath = `${detallePath}/licenses`;

describe("indicadores de Clientes en la ruta", () => {
  afterEach(() => { vi.unstubAllEnvs(); get.mockReset(); });
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
