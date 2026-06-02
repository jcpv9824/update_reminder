import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

import BasesDeDatosPage from "../pages/BasesDeDatosPage";

const clientes = [{ id: "client_1", name: "Cliente Uno", status: "active", createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" }];
const dominios = [
  { id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "cliente.pya.com.co", environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "" },
  { id: "domain_2", clientId: "client_1", clientName: "Cliente Uno", domainName: "sinfrecuencia.pya.com.co", environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "" },
];
const frecuenciaDominio = {
  id: "schedule_domain",
  clientId: "client_1",
  clientName: "Cliente Uno",
  domainId: "domain_1",
  domainName: "cliente.pya.com.co",
  targetType: "domain",
  targetIds: ["domain_1"],
  frequencyType: "weekly",
  weekdays: ["FRIDAY"],
  startDate: "2026-05-01",
  timezone: "America/Bogota",
  assignedRole: "domain_updater",
  assignedUserIds: [],
  active: true,
  createdAt: "",
  updatedAt: "",
};

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BasesDeDatosPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function mockGets(frecuencias = [frecuenciaDominio]) {
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve(clientes);
    if (path === "/domains") return Promise.resolve(dominios);
    if (path === "/databases") return Promise.resolve([]);
    if (path === "/schedules") return Promise.resolve(frecuencias);
    return Promise.resolve([]);
  });
}

function seleccionar(label: RegExp, optionText: RegExp) {
  const labelNode = screen.getAllByText(label).at(-1)!;
  const input = within(labelNode.parentElement!).getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.mouseDown(screen.getByText(optionText));
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
});

describe("BasesDeDatosPage", () => {
  it("Nueva base de datos indica que se programa desde Actualizaciones programadas", async () => {
    mockGets();
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva base de datos/i }));
    seleccionar(/Cliente \*/i, /Cliente Uno/i);
    seleccionar(/Dominio \*/i, /cliente.pya.com.co/i);
    expect(await screen.findByText(/Las tareas de esta base de datos se generan desde/i)).toBeInTheDocument();
    expect(screen.getByText(/Actualizaciones programadas/i)).toBeInTheDocument();
    expect(screen.queryByText(/Frecuencia individual avanzada/i)).toBeNull();
    expect(screen.queryByText(/Crear frecuencia automática específica/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Guardar y crear nueva base de datos/i })).toBeInTheDocument();
  });

  it("Nueva base de datos no advierte por falta de frecuencia embebida", async () => {
    mockGets([]);
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva base de datos/i }));
    seleccionar(/Cliente \*/i, /Cliente Uno/i);
    seleccionar(/Dominio \*/i, /sinfrecuencia.pya.com.co/i);
    expect(await screen.findByText(/Las tareas de esta base de datos se generan desde/i)).toBeInTheDocument();
    expect(screen.queryByText(/El dominio seleccionado no tiene frecuencia configurada/i)).toBeNull();
  });

  it("envía búsqueda al listado paginado de bases de datos", async () => {
    mockGets();
    renderPagina();
    const label = await screen.findByText("Buscar empresa/base/servidor");
    fireEvent.change(within(label.parentElement!).getByRole("textbox"), { target: { value: "SAGWEB" } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/databases?page=1&pageSize=10&search=SAGWEB")));
  });

  it("Editar base abre el modal de edición", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve(clientes);
      if (path === "/domains") return Promise.resolve(dominios);
      if (path.startsWith("/databases?")) return Promise.resolve({ items: [{ id: "db_1", clientId: "client_1", clientName: "Cliente Uno", domainId: "domain_1", domainName: "cliente.pya.com.co", companyName: "Empresa Uno", environment: "production", status: "active", dbAccess: { serverHostPort: "sql:1433", initialCatalog: "SAGWEB", userId: "usr", passwordSecretName: "secret" }, assignedUpdaterIds: [], createdAt: "", updatedAt: "" }], page: 1, pageSize: 10, total: 1 });
      if (path === "/schedules") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(await screen.findByText(/Editar base de datos: Empresa Uno/i)).toBeInTheDocument();
  });

  it("muestra error claro cuando el backend rechaza cadena de conexión duplicada", async () => {
    apiMock.post.mockRejectedValue(new Error("Ya existe una base de datos con esta cadena de conexión."));
    mockGets();
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva base de datos/i }));
    seleccionar(/Cliente \*/i, /Cliente Uno/i);
    seleccionar(/Dominio \*/i, /cliente.pya.com.co/i);
    fireEvent.change(within(screen.getByText(/Nombre de la empresa/i).parentElement!).getByRole("textbox"), { target: { value: "Empresa Uno" } });
    fireEvent.change(within(screen.getByText(/Cadena de acceso a la base de datos/i).parentElement!).getByRole("textbox"), { target: { value: "sql:1433;Initial Catalog=SAGWEB;User ID=usr;Password=pwd;" } });
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));

    expect(await screen.findByText("Ya existe una base de datos con esta cadena de conexión.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Guardar$/i })).toBeInTheDocument();
  });
});
