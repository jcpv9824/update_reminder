import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FrecuenciasPage from "../pages/FrecuenciasPage";
import type { Frecuencia } from "../types";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

const cliente = { id: "client_1", name: "Cliente Uno", status: "active", createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" };
const dominio = {
  id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "cliente.sagerp.co",
  environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "",
};
const dominio2 = { ...dominio, id: "domain_2", domainName: "cliente2.sagerp.co" };
const base1 = {
  id: "db_1", clientId: "client_1", clientName: "Cliente Uno", domainId: "domain_1", domainName: "cliente.sagerp.co",
  companyName: "Empresa Uno", environment: "production", dbAccess: { serverHostPort: "srv", initialCatalog: "EMPRESA_UNO", userId: "usr", passwordSecretName: "sec" },
  assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "",
};
const base2 = { ...base1, id: "db_2", companyName: "Empresa Dos", dbAccess: { ...base1.dbAccess, initialCatalog: "EMPRESA_DOS" } };
const modulo = { id: "module_mobile", name: "Mobile App", code: "MOBILE", status: "active" };
const moduloInactivo = { id: "module_old", name: "Licencia vieja", code: "OLD", status: "inactive" };

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FrecuenciasPage />
    </QueryClientProvider>
  );
}

function frecuencia(overrides: Partial<Frecuencia> = {}): Frecuencia {
  return {
    id: "schedule_special",
    clientId: "client_1",
    clientName: "Cliente Uno",
    targetType: "domain",
    targetIds: ["domain_1"],
    frequencyType: "weekly",
    everyNWeeks: 1,
    weekdays: ["FRIDAY"],
    startDate: "2026-05-08",
    endDate: null,
    timezone: "America/Bogota",
    assignedRole: "domain_updater",
    assignedUserIds: [],
    origin: "special",
    active: true,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function select(label: RegExp | string) {
  const node = screen.getByText(label);
  return within(node.parentElement!).getByRole("combobox");
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.post.mockResolvedValue({});
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve([cliente]);
    if (path === "/domains") return Promise.resolve([dominio, dominio2]);
    if (path === "/databases") return Promise.resolve([base1, base2]);
    if (path === "/license-modules") return Promise.resolve([modulo, moduloInactivo]);
    if (path.startsWith("/schedules?origin=special")) return Promise.resolve({ items: [], page: 1, pageSize: 10, total: 0 });
    return Promise.resolve([]);
  });
});

describe("FrecuenciasPage", () => {
  it("muestra titulo, explicacion y estado vacio de Programaciones especiales", async () => {
    renderPagina();
    expect(await screen.findByRole("heading", { name: "Programaciones especiales" })).toBeInTheDocument();
    expect(screen.getByText(/La frecuencia normal de actualización se configura desde cada dominio/i)).toBeInTheDocument();
    expect(await screen.findByText("No hay programaciones especiales configuradas.")).toBeInTheDocument();
    expect(screen.getByText(/ve a Dominios y edita la frecuencia del dominio/i)).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith("/schedules?origin=special&page=1&pageSize=10");
  });

  it("muestra programaciones especiales devueltas por el API", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/license-modules") return Promise.resolve([modulo]);
      if (path.startsWith("/schedules?origin=special")) return Promise.resolve({ items: [frecuencia()], page: 1, pageSize: 10, total: 1 });
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Cliente Uno")).toBeInTheDocument();
    expect(screen.getByText("Dominio")).toBeInTheDocument();
  });

  it("envía búsqueda al listado paginado de programaciones especiales", async () => {
    renderPagina();
    fireEvent.change(await screen.findByPlaceholderText("Buscar..."), { target: { value: "Mobile" } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/schedules?origin=special&page=1&pageSize=10&search=Mobile")));
  });

  it("no muestra frecuencias normales de dominio aunque lleguen en la respuesta", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/license-modules") return Promise.resolve([modulo]);
      if (path.startsWith("/schedules?origin=special")) return Promise.resolve({
        items: [
          frecuencia({ id: "schedule_normal", clientName: "Normal Oculta", origin: "domain_default" }),
          frecuencia({ id: "schedule_special", clientName: "Especial Visible", origin: "special" }),
        ],
        page: 1,
        pageSize: 10,
        total: 2,
      });
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Especial Visible")).toBeInTheDocument();
    expect(screen.queryByText("Normal Oculta")).toBeNull();
  });


  it("al crear envia origin special", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva programación especial/i }));
    fireEvent.focus(screen.getByPlaceholderText("Buscar cliente..."));
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.click(screen.getByLabelText(/Incluir todos los dominios activos/i));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      origin: "special",
      scopeGroups: expect.arrayContaining([expect.objectContaining({ clientId: "client_1", includeAllDomains: true })]),
    }));
  });

  it("permite agregar varios dominios y varias bases con modales de selección", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva programación especial/i }));
    fireEvent.focus(screen.getByPlaceholderText("Buscar cliente..."));
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));

    fireEvent.click(screen.getByRole("button", { name: /\+ Agregar dominios/i }));
    expect(await screen.findByRole("heading", { name: /Seleccionar dominios/i })).toBeInTheDocument();
    fireEvent.click(screen.getByText("cliente.sagerp.co"));
    fireEvent.click(screen.getByText("cliente2.sagerp.co"));
    fireEvent.click(screen.getByRole("button", { name: /Agregar seleccionados/i }));
    expect(await screen.findByText(/Dominio: cliente.sagerp.co/i)).toBeInTheDocument();
    expect(screen.getByText(/Dominio: cliente2.sagerp.co/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /\+ Agregar bases/i })[0]);
    expect(await screen.findByRole("heading", { name: /Seleccionar bases de datos/i })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Empresa Uno"));
    fireEvent.click(screen.getByText("Empresa Dos"));
    fireEvent.click(screen.getByRole("button", { name: /Agregar seleccionadas/i }));
    expect(await screen.findByText(/Empresa Uno — EMPRESA_UNO — production/i)).toBeInTheDocument();
    expect(screen.getByText(/Empresa Dos — EMPRESA_DOS — production/i)).toBeInTheDocument();
    expect(screen.getByText(/Resumen del alcance: 1 cliente\(s\), 2 dominio\(s\), 2 base\(s\) de datos/i)).toBeInTheDocument();
  });

  it("modo Por licenciamiento oculta selección manual y exige licencias", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva programación especial/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    expect(screen.getByText("Licencias a actualizar")).toBeInTheDocument();
    expect(screen.queryByText(/Todos los clientes activos/i)).toBeNull();
    expect(screen.queryByPlaceholderText("Buscar cliente...")).toBeNull();
    expect(screen.getByText("Sin licencias seleccionadas.")).toBeInTheDocument();
    expect(screen.queryByText("Licencia vieja")).toBeNull();
    expect(screen.getByLabelText(/Solo clientes, dominios y bases activos/i)).toBeChecked();
    expect(screen.getByLabelText(/Solo clientes, dominios y bases activos/i)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    expect(screen.getByText("Seleccione al menos una licencia.")).toBeInTheDocument();
  });

  it("muestra licencias seleccionadas y permite quitarlas con chip", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva programación especial/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    fireEvent.click(await screen.findByText("Mobile App"));
    expect(await screen.findByRole("button", { name: "Quitar Mobile App" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quitar Mobile App" }));
    expect(screen.getByText("Sin licencias seleccionadas.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Mobile App/i)).not.toBeChecked();
  });

  it("previsualiza y guarda programación por licenciamiento", async () => {
    apiMock.post.mockImplementation((path: string, body: any) => {
      if (path === "/special-schedules/preview-licensing-scope") {
        return Promise.resolve({
          clientsCount: 1,
          domainsCount: 1,
          databasesCount: 1,
          groups: [{
            client: { id: "client_1", name: "Cliente Uno", licenses: ["Mobile App"] },
            domains: [{ id: "domain_1", name: "cliente.sagerp.co", environment: "production", databases: [{ id: "db_1", companyName: "Empresa Uno", databaseName: "EMPRESA_UNO", environment: "production" }] }],
          }],
        });
      }
      return Promise.resolve({ id: "schedule_license", ...body });
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva programación especial/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    fireEvent.click(await screen.findByText("Mobile App"));
    fireEvent.change(select("Ambiente"), { target: { value: "production" } });
    fireEvent.change(select("Objetivo de actualización"), { target: { value: "domains_and_databases" } });
    fireEvent.click(screen.getByRole("button", { name: /Previsualizar alcance/i }));
    expect(await screen.findByText(/1 cliente\(s\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Cliente: Cliente Uno/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      selectionMode: "licensing",
      licensingScope: expect.objectContaining({ licenseModuleIds: ["module_mobile"], environment: "production", activeOnly: true }),
    })));
  });
});
