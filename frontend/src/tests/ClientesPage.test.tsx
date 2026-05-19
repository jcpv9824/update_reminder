import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

import ClientesPage from "../pages/ClientesPage";

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClientesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.get.mockResolvedValue([]);
});

describe("ClientesPage", () => {
  const moduloMobile = { id: "module_mobile", name: "Mobile App", code: "MOBILE", status: "active" };

  it("muestra acciones rápidas para continuar el flujo de creación", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo cliente/i }));
    expect(screen.getByRole("button", { name: /^Guardar$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y agregar dominio/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y crear nuevo cliente/i })).toBeInTheDocument();
  });

  it("modal Nuevo cliente muestra y guarda licencias seleccionadas", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/license-modules") return Promise.resolve([moduloMobile]);
      return Promise.resolve([]);
    });
    apiMock.post.mockResolvedValue({ id: "client_1", name: "Cliente Uno" });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo cliente/i }));
    expect(await screen.findByText("Licencias del cliente")).toBeInTheDocument();
    fireEvent.change(within(screen.getByText(/^ID del cliente$/i).parentElement!).getByRole("textbox"), { target: { value: "PYA-001" } });
    fireEvent.change(within(screen.getByText(/Nombre del cliente/i).parentElement!).getByRole("textbox"), { target: { value: "Cliente Uno" } });
    fireEvent.click(screen.getByText("Mobile App"));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/clients", expect.objectContaining({
      name: "Cliente Uno",
      externalId: "PYA-001",
      licenseModuleIds: ["module_mobile"],
    })));
  });

  it("el ID del cliente es opcional y muestra ayuda de unicidad", async () => {
    apiMock.post.mockResolvedValue({ id: "client_1", name: "Cliente Uno" });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo cliente/i }));
    expect(screen.getByText(/Opcional por ahora/i)).toBeInTheDocument();
    fireEvent.change(within(screen.getByText(/Nombre del cliente/i).parentElement!).getByRole("textbox"), { target: { value: "Cliente Uno" } });
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/clients", expect.objectContaining({
      name: "Cliente Uno",
      externalId: undefined,
    })));
  });

  it("muestra chips de licencias seleccionadas y permite quitarlas", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/license-modules") return Promise.resolve([moduloMobile]);
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo cliente/i }));
    expect(await screen.findByText("Sin licencias seleccionadas.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Mobile App"));
    expect(await screen.findByText("Licencias seleccionadas")).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: /Mobile App/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Quitar Mobile App/i }));
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Sin licencias seleccionadas.")).toBeInTheDocument();
  });

  it("muestra error claro cuando el backend rechaza cliente duplicado", async () => {
    apiMock.post.mockRejectedValue(new Error("Ya existe un cliente con este nombre."));
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo cliente/i }));
    fireEvent.change(within(screen.getByText(/Nombre del cliente/i).parentElement!).getByRole("textbox"), { target: { value: "Cliente Uno" } });
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));

    expect(await screen.findByText("Ya existe un cliente con este nombre.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Guardar$/i })).toBeInTheDocument();
  });

  it("envía búsqueda al listado paginado de clientes", async () => {
    renderPagina();
    fireEvent.change(await screen.findByPlaceholderText("Nombre del cliente"), { target: { value: "PYA" } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/clients?page=1&pageSize=10&search=PYA")));
  });

  it("modal Editar cliente carga licencias actuales", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path.startsWith("/clients?")) return Promise.resolve({ items: [{ id: "client_1", name: "Cliente Uno", status: "active", licenseModuleIds: ["module_mobile"], createdAt: "2026-05-01T00:00:00Z", createdBy: "", updatedAt: "", updatedBy: "" }], page: 1, pageSize: 10, total: 1 });
      if (path === "/license-modules") return Promise.resolve([moduloMobile]);
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const checkbox = await screen.findByRole("checkbox", { name: /Mobile App/i });
    expect(checkbox).toBeChecked();
    expect(screen.getByText("Licencias seleccionadas")).toBeInTheDocument();
  });

  it("Ver dominios y bases muestra licencias del cliente", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path.startsWith("/clients?")) return Promise.resolve({ items: [{ id: "client_1", name: "Cliente Uno", status: "active", licenseModuleNames: ["Mobile App"], createdAt: "2026-05-01T00:00:00Z", createdBy: "", updatedAt: "", updatedBy: "" }], page: 1, pageSize: 10, total: 1 });
      if (path === "/license-modules") return Promise.resolve([moduloMobile]);
      if (path === "/clients/client_1/tree") return Promise.resolve({ client: { id: "client_1", name: "Cliente Uno", status: "active", licenseModuleNames: ["Mobile App"] }, domains: [] });
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: "Ver dominios y bases" }));
    expect(await screen.findByText(/Licencias:/i)).toBeInTheDocument();
    expect(screen.getByText(/Mobile App/i)).toBeInTheDocument();
  });

  it("Clientes muestra acción Agregar dominio y el árbol muestra acciones por dominio/base", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path.startsWith("/clients?")) return Promise.resolve({ items: [{ id: "client_1", name: "Cliente Uno", status: "active", createdAt: "2026-05-01T00:00:00Z", createdBy: "", updatedAt: "", updatedBy: "" }], page: 1, pageSize: 10, total: 1 });
      if (path === "/license-modules") return Promise.resolve([moduloMobile]);
      if (path === "/clients/client_1/tree") return Promise.resolve({
        client: { id: "client_1", name: "Cliente Uno", status: "active", licenseModuleNames: [] },
        domains: [{
          domain: { id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "https://demo.sagerp.cloud", environment: "production", status: "active", assignedUpdaterIds: [], createdAt: "", updatedAt: "" },
          databases: [{ id: "db_1", clientId: "client_1", clientName: "Cliente Uno", domainId: "domain_1", domainName: "https://demo.sagerp.cloud", companyName: "Empresa Uno", environment: "production", status: "active", dbAccess: { initialCatalog: "SAGWEB", serverHostPort: "sql:1433", userId: "usr", passwordSecretName: "secret" }, assignedUpdaterIds: [], createdAt: "", updatedAt: "" }],
        }],
      });
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByRole("button", { name: "Agregar dominio" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver dominios y bases" }));
    expect(await screen.findByRole("button", { name: "Editar dominio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agregar base" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar base" })).toBeInTheDocument();
  });
});
