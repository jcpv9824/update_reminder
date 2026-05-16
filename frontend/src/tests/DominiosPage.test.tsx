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

import DominiosPage from "../pages/DominiosPage";

const clientes = [{ id: "client_1", name: "Cliente Uno", status: "active", createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" }];

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DominiosPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve(clientes);
    if (path === "/domains") return Promise.resolve([]);
    if (path === "/schedules") return Promise.resolve([]);
    if (path === "/users") return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe("DominiosPage", () => {
  it("configura frecuencia del dominio sin pedir rol responsable y muestra acciones rápidas", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo dominio/i }));
    expect(screen.getByText(/Frecuencia de actualización del dominio/i)).toBeInTheDocument();
    expect(screen.queryByText(/Rol responsable/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^Guardar$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y agregar base de datos/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y crear nuevo dominio/i })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Activar frecuencia automática/i));
    expect(screen.getByLabelText(/Tiene fecha de fin/i)).toBeInTheDocument();
  });

  it("al guardar frecuencia normal del dominio envia origin domain_default", async () => {
    apiMock.post.mockResolvedValue({ id: "domain_1", clientId: "client_1" });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo dominio/i }));
    fireEvent.focus(screen.getAllByPlaceholderText("Buscar cliente...").at(-1)!);
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.change(screen.getAllByPlaceholderText("https://ejemplo.sagerp.co").at(-1)!, { target: { value: "https://cliente.sagerp.co" } });
    fireEvent.click(screen.getByLabelText(/Activar frecuencia automática/i));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect(apiMock.post).toHaveBeenCalledWith("/domains", expect.objectContaining({
      frequency: expect.objectContaining({ origin: "domain_default" }),
    }));
  });

  it("muestra error claro cuando el backend rechaza dominio duplicado", async () => {
    apiMock.post.mockRejectedValue(new Error("Ya existe un dominio con esta URL."));
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo dominio/i }));
    fireEvent.focus(screen.getAllByPlaceholderText("Buscar cliente...").at(-1)!);
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.change(screen.getAllByPlaceholderText("https://ejemplo.sagerp.co").at(-1)!, { target: { value: "https://cliente.sagerp.co" } });
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));

    expect(await screen.findByText("Ya existe un dominio con esta URL.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Guardar$/i })).toBeInTheDocument();
  });

  it("tabla muestra Agregar base, Recurrente y Próxima actualización sin columna Versión", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve(clientes);
      if (path.startsWith("/domains?")) return Promise.resolve({ items: [{ id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "https://cliente.sagerp.co", environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "" }], page: 1, pageSize: 10, total: 1 });
      if (path === "/schedules") return Promise.resolve([{ id: "schedule_1", origin: "domain_default", active: true, targetType: "domain", domainId: "domain_1", targetIds: ["domain_1"], frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", timezone: "America/Bogota", assignedRole: "domain_updater", assignedUserIds: [] }]);
      if (path === "/users") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Recurrente")).toBeInTheDocument();
    expect(screen.getByText("Próxima actualización")).toBeInTheDocument();
    expect(screen.queryByText("Versión web")).toBeNull();
    expect(screen.getByText("Sí")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agregar base de datos" })).toBeInTheDocument();
  });

  it("modal de bases asociadas permite copiar contraseña y editar base", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve(clientes);
      if (path.startsWith("/domains?")) return Promise.resolve({ items: [{ id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "https://cliente.sagerp.co", environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "" }], page: 1, pageSize: 10, total: 1 });
      if (path === "/domains/domain_1/databases") return Promise.resolve([{ id: "db_1", clientId: "client_1", clientName: "Cliente Uno", domainId: "domain_1", domainName: "https://cliente.sagerp.co", companyName: "Empresa Uno", environment: "production", status: "active", dbAccess: { serverHostPort: "sql:1433", initialCatalog: "SAGWEB", userId: "usr", passwordSecretName: "secret" }, assignedUpdaterIds: [], createdAt: "", updatedAt: "" }]);
      if (path === "/schedules") return Promise.resolve([]);
      if (path === "/users") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    apiMock.post.mockResolvedValue({ value: "secreto" });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: "Ver bases asociadas" }));
    expect(await screen.findByRole("button", { name: "Copiar contraseña" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar base" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copiar contraseña" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/databases/db_1/copy-access-part", { part: "password" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("secreto"));
  });

  it("envía filtro de programación recurrente y nuevo dominio inicia sin frecuencia automática", async () => {
    renderPagina();
    const filtro = within((await screen.findByText("Programación recurrente")).parentElement!).getByRole("combobox");
    fireEvent.change(filtro, { target: { value: "with" } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("recurring=with")));
    fireEvent.click(screen.getByRole("button", { name: /Nuevo dominio/i }));
    expect(screen.getByLabelText(/Activar frecuencia automática/i)).not.toBeChecked();
  });

  it("envía búsqueda al listado paginado de dominios", async () => {
    renderPagina();
    fireEvent.change(await screen.findByPlaceholderText("ejemplo.sagerp.co"), { target: { value: "demo" } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/domains?page=1&pageSize=10&search=demo")));
  });

  it("muestra error si el dominio no inicia con https", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo dominio/i }));
    fireEvent.focus(screen.getAllByPlaceholderText("Buscar cliente...").at(-1)!);
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.change(screen.getAllByPlaceholderText("https://ejemplo.sagerp.co").at(-1)!, { target: { value: "cliente.sagerp.co" } });
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    expect(await screen.findByText("El dominio debe iniciar con https://")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
