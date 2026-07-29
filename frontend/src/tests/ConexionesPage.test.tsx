import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ConexionesPage from "../pages/ConexionesPage";

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
    usuario: {
      id: "admin",
      email: "admin@example.com",
      displayName: "Admin",
      roles: ["super_admin"],
    },
  }),
}));

const connectionData = {
  objectStorage: {
    id: "seaweedfs-primary",
    etag: "0102030405060708",
    provider: "seaweedfs",
    displayName: "SeaweedFS principal",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "portal-files",
    forcePathStyle: true,
    credentialsConfigured: true,
    active: false,
    lastTest: null,
    createdAt: "2026-07-29T10:00:00.000Z",
    createdBy: "admin",
    updatedAt: "2026-07-29T10:00:00.000Z",
    updatedBy: "admin",
  },
  externalDatabases: [],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConexionesPage />
    </QueryClientProvider>,
  );
}

describe("ConexionesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockImplementation(async (path: string) => (
      path === "/roles" ? [] : connectionData
    ));
  });

  it("shows safe metadata but never renders stored secret names or values", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Conexiones" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://s3.example.com")).toBeInTheDocument();
    expect(screen.getByText(/Credenciales: configuradas/)).toBeInTheDocument();
    expect(screen.queryByText(/secret-name/i)).toBeNull();
    expect(screen.queryByDisplayValue(/secret/i)).toBeNull();
    expect(screen.getAllByDisplayValue("").length).toBeGreaterThanOrEqual(2);
  });

  it("explains that saving does not activate SeaweedFS", async () => {
    renderPage();

    expect(await screen.findByText(/Blob Storage seguirá en producción/)).toBeInTheDocument();
    expect(screen.getByText(/Guardar no cambia el proveedor activo/)).toBeInTheDocument();
  });

  it("opens an external SQL profile with mandatory TLS", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Nueva conexión" }));

    expect(screen.getByRole("heading", { name: "Nueva conexión SQL Server" })).toBeInTheDocument();
    expect(screen.getByText("Cifrado TLS obligatorio")).toBeInTheDocument();
    expect(screen.getByLabelText(/Contraseña/)).toHaveAttribute("type", "password");
  });
});
