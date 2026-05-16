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
const paginatedModules = Array.from({ length: 10 }, (_, index) => ({
  id: `module_${index + 1}`,
  name: `Módulo ${index + 1}`,
  code: `MOD_${index + 1}`,
  description: `Descripción ${index + 1}`,
  status: "active",
}));
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
    if (path.startsWith("/license-modules?")) return Promise.resolve({ items: modules, page: 1, pageSize: 10, total: modules.length });
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
  it("renderiza la página como maestro de Módulos y oculta Asignaciones", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Licenciamiento" })).toBeInTheDocument();
    expect(screen.getByText(/Gestione los módulos licenciados que pueden ser asignados a los clientes/i)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Asignaciones" })).toBeNull();
    expect(await screen.findByText("Mobile App")).toBeInTheDocument();
  });

  it("crear módulo permite omitir código y llama la API", async () => {
    apiMock.post.mockResolvedValue({ id: "module_wms", name: "WMS", code: "WMS", status: "active" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo módulo" }));
    await userEvent.type(textField("Nombre *"), "WMS");
    expect(screen.queryByText("Código *")).toBeNull();
    expect(screen.getByText(/Opcional. Si lo deja vacío/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/license-modules", expect.objectContaining({ name: "WMS", code: "" })));
  });

  it("busca módulos sin romper paginación", async () => {
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText("Buscar módulo..."), { target: { value: "WMS" } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/license-modules?page=1&pageSize=10&search=WMS")));
  });

  it("pagina módulos de licenciamiento", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path.startsWith("/license-modules?")) return Promise.resolve({ items: paginatedModules, page: path.includes("page=2") ? 2 : 1, pageSize: 10, total: 25 });
      if (path === "/license-assignments") return Promise.resolve(assignments);
      if (path === "/clients") return Promise.resolve(clients);
      if (path === "/domains") return Promise.resolve(domains);
      if (path === "/databases") return Promise.resolve(databases);
      return Promise.resolve([]);
    });
    renderPage();
    expect(await screen.findByText("Mostrando 1-10 de 25")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/license-modules?page=2&pageSize=10")));
  });

  it("muestra error cuando el backend rechaza nombre duplicado", async () => {
    apiMock.post.mockRejectedValue(new Error("Ya existe un módulo con este nombre."));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo módulo" }));
    await userEvent.type(textField("Nombre *"), "Mobile App");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Ya existe un módulo con este nombre.")).toBeInTheDocument();
  });
});
