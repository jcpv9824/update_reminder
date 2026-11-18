import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConexionesPage />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("ConexionesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockImplementation(async (path: string) => (
      path === "/roles" ? [] : connectionData
    ));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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

  it("does not request catalog sources when the admin feature is disabled", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_ADMIN_ENABLED", "false");
    renderPage();
    await screen.findByDisplayValue("https://s3.example.com");
    expect(apiMock.get.mock.calls.some(([path]) => path === "/settings/integrations/catalog-sources")).toBe(false);
    expect(screen.queryByText("Base de datos de SAG Admin")).toBeNull();
  });

  it("sends only the source ID and an empty body when verifying or confirming activation", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_ADMIN_ENABLED", "true");
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === "/roles") return [];
      if (path === "/settings/integrations/catalog-sources") return { items: [{
        id: "source with space", profileId: "profile-id", label: "Administración central",
        role: "sag-admin", state: "draft", canReadCurrentProfile: false,
      }] };
      return connectionData;
    });
    apiMock.post.mockImplementation(async (path: string) => path.endsWith("/verify")
      ? { status: "verified" } : { status: "activated" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Verificar" }));
    await screen.findByText("Verificación completada. La fuente sigue en borrador.");
    expect(apiMock.post).toHaveBeenCalledExactlyOnceWith(
      "/settings/integrations/catalog-sources/source%20with%20space/verify", {},
    );
    const activate = screen.getByRole("button", { name: "Activar" });
    await waitFor(() => expect(activate).toBeEnabled());
    fireEvent.click(activate);
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar activación" }));
    await screen.findByText("Fuente activada.");
    expect(apiMock.post).toHaveBeenNthCalledWith(
      2, "/settings/integrations/catalog-sources/source%20with%20space/activate", {},
    );
  });

  describe("click-time connection snapshots", () => {
    beforeEach(() => {
      const setOptions = MutationObserver.prototype.setOptions;
      // Model delayed passive-effect synchronization, not a browser timing
      // assertion: keep the initial mutation function while allowing the page
      // and observer callbacks to render the current form normally.
      vi.spyOn(MutationObserver.prototype, "setOptions").mockImplementation(function (
        this: MutationObserver, options: Parameters<typeof setOptions>[0],
      ) {
        setOptions.call(this, this.options
          ? { ...options, mutationFn: this.options.mutationFn }
          : options);
      });
      apiMock.post.mockResolvedValue({ result: { succeeded: true, testedAt: "2026-11-18T18:00:00Z", message: "Prueba completada" } });
      apiMock.put.mockResolvedValue(connectionData.objectStorage);
    });

    it("tests the loaded saved target even when the observer retains its initial function", async () => {
      renderPage();
      await screen.findByDisplayValue("portal-files");
      const test = screen.getByRole("button", { name: "Probar conexión" });
      expect(test).toBeEnabled();
      fireEvent.click(test);
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledExactlyOnceWith(
        "/settings/integrations/object-storage/seaweedfs/test-saved", undefined,
        { headers: { "If-Match": '"0102030405060708"' } },
      ));
    });

    it("saves the current edited form and version rather than the initial empty form", async () => {
      renderPage();
      fireEvent.change(await screen.findByDisplayValue("portal-files"), { target: { value: "edited-fixture" } });
      fireEvent.change(screen.getByLabelText("Nombre del perfil"), { target: { value: "Perfil revisado" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
      await waitFor(() => expect(apiMock.put).toHaveBeenCalledExactlyOnceWith(
        "/settings/integrations/object-storage/seaweedfs",
        expect.objectContaining({ bucket: "edited-fixture", displayName: "Perfil revisado", databaseName: "PortalSAGWeb-TEST", etag: "0102030405060708" }),
      ));
    });

    it("never tests an edited target with saved credentials and submits only the new fake-key snapshot", async () => {
      const { queryClient } = renderPage();
      fireEvent.change(await screen.findByDisplayValue("portal-files"), { target: { value: "edited-fixture" } });
      const test = screen.getByRole("button", { name: "Probar conexión" });
      expect(test).toBeDisabled();
      fireEvent.click(test);
      expect(apiMock.post).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "fake-access-fixture" } });
      fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "fake-secret-fixture" } });
      expect(test).toBeEnabled();
      fireEvent.click(test);
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledExactlyOnceWith(
        "/settings/integrations/object-storage/seaweedfs/test",
        { endpoint: "https://s3.example.com", region: "us-east-1", bucket: "edited-fixture", databaseName: "PortalSAGWeb-TEST", forcePathStyle: true, accessKey: "fake-access-fixture", secretKey: "fake-secret-fixture" },
      ));
      await screen.findAllByText("Prueba completada");
      await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
      expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain("fake-secret-fixture");
    });

    it("removes a failed save snapshot from the mutation cache without caching its new keys", async () => {
      apiMock.put.mockRejectedValueOnce(new Error("No se pudo guardar el perfil."));
      const { queryClient } = renderPage();
      await screen.findByDisplayValue("portal-files");
      fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "fake-save-access" } });
      fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "fake-save-secret" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar y validar" }));
      await screen.findByText("No se pudo guardar el perfil.");
      expect(apiMock.put).toHaveBeenCalledExactlyOnceWith(
        "/settings/integrations/object-storage/seaweedfs",
        expect.objectContaining({ bucket: "portal-files", etag: "0102030405060708", accessKey: "fake-save-access", secretKey: "fake-save-secret" }),
      );
      await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
      expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain("fake-save-secret");
    });
  });
});
