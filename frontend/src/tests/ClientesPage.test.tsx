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
    fireEvent.change(within(screen.getByText(/Nombre del cliente/i).parentElement!).getByRole("textbox"), { target: { value: "Cliente Uno" } });
    fireEvent.click(screen.getByText("Mobile App"));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/clients", expect.objectContaining({
      name: "Cliente Uno",
      licenseModuleIds: ["module_mobile"],
    })));
  });

  it("modal Editar cliente carga licencias actuales", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([{ id: "client_1", name: "Cliente Uno", status: "active", licenseModuleIds: ["module_mobile"], createdAt: "2026-05-01T00:00:00Z", createdBy: "", updatedAt: "", updatedBy: "" }]);
      if (path === "/license-modules") return Promise.resolve([moduloMobile]);
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const checkbox = await screen.findByRole("checkbox", { name: /Mobile App/i });
    expect(checkbox).toBeChecked();
  });

  it("Ver dominios y bases muestra licencias del cliente", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([{ id: "client_1", name: "Cliente Uno", status: "active", licenseModuleNames: ["Mobile App"], createdAt: "2026-05-01T00:00:00Z", createdBy: "", updatedAt: "", updatedBy: "" }]);
      if (path === "/license-modules") return Promise.resolve([moduloMobile]);
      if (path === "/clients/client_1/tree") return Promise.resolve({ client: { id: "client_1", name: "Cliente Uno", status: "active", licenseModuleNames: ["Mobile App"] }, domains: [] });
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: "Ver dominios y bases" }));
    expect(await screen.findByText(/Licencias:/i)).toBeInTheDocument();
    expect(screen.getByText(/Mobile App/i)).toBeInTheDocument();
  });
});
