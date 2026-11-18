import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    databaseName: "PortalSAGWeb-TEST",
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
    // El título aparece antes de que llegue la consulta: esperar a que el formulario se llene.
    expect(await screen.findByDisplayValue("https://s3.example.com")).toBeInTheDocument();
    expect(await screen.findByText(/Credenciales: configuradas/)).toBeInTheDocument();
    expect(screen.queryByText(/secret-name/i)).toBeNull();
    expect(screen.queryByDisplayValue(/secret/i)).toBeNull();
    expect(screen.getAllByDisplayValue("").length).toBeGreaterThanOrEqual(2);
  });

  it("explains that saving does not activate SeaweedFS", async () => {
    renderPage();

    expect(await screen.findByText(/Guardar no cambia el proveedor activo/)).toBeInTheDocument();
  });

  it("keeps edited advanced settings separate from the last saved connection test", async () => {
    renderPage();
    const test = await screen.findByRole("button", { name: "Probar conexión" });
    const endpoint = await screen.findByDisplayValue("https://s3.example.com");
    expect(endpoint.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("PortalSAGWeb-TEST/Archivos/")).toBeInTheDocument();
    expect(test).toBeEnabled();
    fireEvent.change(endpoint, { target: { value: "https://s3-other.example.com" } });
    expect(test).toBeDisabled();
    fireEvent.click(test);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("saves cleared advanced values on a disabled profile and does not restore them after reopening", async () => {
    const cleared = { ...connectionData.objectStorage, displayName: "", endpoint: "", region: "", forcePathStyle: false };
    apiMock.put.mockResolvedValue(cleared);
    const view = renderPage();
    fireEvent.change(await screen.findByDisplayValue("https://s3.example.com"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Región de firma"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Nombre del perfil"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Usar path-style"));
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith(
      "/settings/integrations/object-storage/seaweedfs",
      expect.objectContaining({ displayName: "", endpoint: "", region: "", forcePathStyle: false, active: false, databaseName: "PortalSAGWeb-TEST" }),
    ));
    view.unmount();
    apiMock.get.mockImplementation(async (path: string) => path === "/roles" ? [] : { ...connectionData, objectStorage: cleared });
    renderPage();
    await screen.findByDisplayValue("PortalSAGWeb-TEST");
    expect(screen.getByLabelText("Endpoint HTTPS")).toHaveValue("");
    expect(screen.getByLabelText("Región de firma")).toHaveValue("");
    expect(screen.getByLabelText("Nombre del perfil")).toHaveValue("");
    expect(screen.getByLabelText("Usar path-style")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Probar conexión" })).toBeDisabled();
  });

  it("locks the target fields while a connection test is pending", async () => {
    let finishTest!: (response: unknown) => void;
    apiMock.post.mockReturnValueOnce(new Promise((resolve) => { finishTest = resolve; }));
    renderPage();
    const bucket = await screen.findByDisplayValue("portal-files");
    fireEvent.click(screen.getByRole("button", { name: "Probar conexión" }));
    await waitFor(() => expect(bucket).toBeDisabled());
    expect(apiMock.post).toHaveBeenCalledWith(
      "/settings/integrations/object-storage/seaweedfs/test-saved",
      undefined,
      { headers: { "If-Match": '"0102030405060708"' } },
    );
    finishTest({ result: { succeeded: true, testedAt: "2026-11-17T20:00:00Z", message: "Prueba completada" } });
    await waitFor(() => expect(bucket).toBeEnabled());
  });

  it("opens an external SQL profile with mandatory TLS", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Nueva conexión" }));

    expect(screen.getByRole("heading", { name: "Nueva conexión SQL Server" })).toBeInTheDocument();
    expect(screen.getByText("Cifrado TLS obligatorio")).toBeInTheDocument();
    expect(screen.getByLabelText(/Contraseña/)).toHaveAttribute("type", "password");
  });
});
