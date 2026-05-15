import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LicenciamientoPage from "../pages/LicenciamientoPage";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: apiMock }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "admin", email: "admin@empresa.com", displayName: "Admin", roles: ["admin"] },
    cerrarSesion: vi.fn(),
  }),
}));

const modules = [
  { id: "module_mobile", name: "Mobile App", code: "MOBILE", description: "App móvil", status: "active" },
];
const assignments = [
  {
    id: "assignment_1",
    moduleId: "module_mobile",
    moduleName: "Mobile App",
    targetType: "client",
    clientId: "client_1",
    clientName: "Cliente Uno",
    environment: "all",
    status: "active",
  },
];
const clients = [{ id: "client_1", name: "Cliente Uno", status: "active", createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" }];
const domains = [{ id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "cliente.pya.com.co", environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "" }];
const databases = [{
  id: "db_1",
  clientId: "client_1",
  clientName: "Cliente Uno",
  domainId: "domain_1",
  domainName: "cliente.pya.com.co",
  companyName: "Empresa Uno",
  environment: "production",
  dbAccess: { serverHostPort: "servidor:1433", initialCatalog: "EMPRESA_UNO", userId: "sql", passwordSecretName: "secret" },
  assignedUpdaterIds: [],
  status: "active",
  createdAt: "",
  updatedAt: "",
}];

function mockGets() {
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/license-modules") return Promise.resolve(modules);
    if (path === "/license-assignments") return Promise.resolve(assignments);
    if (path === "/clients") return Promise.resolve(clients);
    if (path === "/domains") return Promise.resolve(domains);
    if (path === "/databases") return Promise.resolve(databases);
    return Promise.resolve([]);
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LicenciamientoPage />
    </QueryClientProvider>
  );
}

function field(label: string) {
  const node = screen.getByText(label);
  return within(node.parentElement!).getByRole("combobox");
}

function textField(label: string) {
  const node = screen.getByText(label);
  return within(node.parentElement!).getByRole("textbox");
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  mockGets();
});

describe("LicenciamientoPage", () => {
  it("renderiza la página y la pestaña Módulos", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Licenciamiento" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Módulos" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Mobile App")).toBeInTheDocument();
  });

  it("renderiza la pestaña Asignaciones", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Asignaciones" }));
    expect(screen.getByRole("tab", { name: "Asignaciones" })).toHaveAttribute("aria-selected", "true");
    expect((await screen.findAllByText("Cliente completo")).length).toBeGreaterThan(0);
  });

  it("cambia los campos requeridos según el nivel de asignación", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Asignaciones" }));
    fireEvent.click(screen.getByRole("button", { name: "Nueva asignación" }));

    expect(screen.queryByText("Dominio *")).toBeNull();
    expect(screen.queryByText("Base de datos *")).toBeNull();

    fireEvent.change(field("Nivel de asignación *"), { target: { value: "domain" } });
    expect(screen.getByText("Dominio *")).toBeInTheDocument();
    expect(screen.queryByText("Base de datos *")).toBeNull();

    fireEvent.change(field("Nivel de asignación *"), { target: { value: "database" } });
    expect(screen.getByText("Dominio *")).toBeInTheDocument();
    expect(screen.getByText("Base de datos *")).toBeInTheDocument();
  });

  it("crear módulo llama la API", async () => {
    apiMock.post.mockResolvedValue({ id: "module_wms", name: "WMS", code: "WMS", status: "active" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo módulo" }));
    await userEvent.type(textField("Nombre *"), "WMS");
    await userEvent.type(textField("Código *"), "WMS");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/license-modules", expect.objectContaining({ name: "WMS", code: "WMS" })));
  });

  it("crear asignación llama la API", async () => {
    apiMock.post.mockResolvedValue({ id: "assignment_2" });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Asignaciones" }));
    fireEvent.click(screen.getByRole("button", { name: "Nueva asignación" }));

    fireEvent.change(field("Módulo *"), { target: { value: "module_mobile" } });
    fireEvent.change(field("Nivel de asignación *"), { target: { value: "database" } });
    fireEvent.change(field("Cliente *"), { target: { value: "client_1" } });
    fireEvent.change(field("Dominio *"), { target: { value: "domain_1" } });
    fireEvent.change(field("Base de datos *"), { target: { value: "db_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/license-assignments", expect.objectContaining({
      moduleId: "module_mobile",
      targetType: "database",
      clientId: "client_1",
      domainId: "domain_1",
      databaseId: "db_1",
    })));
  });
});
