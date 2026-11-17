import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LogoCompaniaPage, { DEFAULT_OPTIONS, validateDatabase, validateOptions, validateStorage } from "../pages/LogoCompaniaPage";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));

vi.mock("../api/client", () => ({ api: apiMock }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "admin", email: "admin@example.com", displayName: "Admin", roles: ["super_admin"] },
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><LogoCompaniaPage /></QueryClientProvider>);
}

function change(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillStorageAndDatabase() {
  change(/^Bucket/, " demo.sagerp.cloud.buk ");
  change(/^Access key/, " ACCESS123 ");
  change(/^Secret key/, "SECRET-1234567890");
  change(/^Servidor y puerto/, " data14.sagerp.co,54103 ");
  change(/^Nombre de la base de datos/, "SAGWebDemo");
  change(/^Usuario de SQL/, "usuario_sql");
  change(/^Contraseña/, " clave con espacios ");
}

async function attachLogo() {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText(/^Imagen del logo/), { target: { files: [file] } });
  await screen.findByAltText("Vista previa del logo seleccionado");
}

const EXPECTED_STORAGE = {
  bucket: "demo.sagerp.cloud.buk",
  accessKey: "ACCESS123",
  secretKey: "SECRET-1234567890",
  options: { endpoint: "storcube.sagweb.co", port: 8333, useSsl: true, basePath: "Archivos/", region: "us-east-1" },
};
const EXPECTED_DATABASE = { server: "data14.sagerp.co,54103", databaseName: "SAGWebDemo", username: "usuario_sql", password: "clave con espacios" };

describe("LogoCompaniaPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue([]);
  });

  it("shows the three sections with the requested field names, keys readable and the sheet link in a new tab", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "1. Almacenamiento de objetos" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2. Acceso a la base de datos de la compañía" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3. Logo (opcional)" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Access key/).getAttribute("type")).not.toBe("password");
    expect(screen.getByLabelText(/^Secret key/).getAttribute("type")).not.toBe("password");
    expect(screen.getByLabelText(/^Contraseña/)).toHaveAttribute("type", "password");
    const link = screen.getByRole("link", { name: /hoja de almacenamiento/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.getAttribute("href")).toContain("docs.google.com/spreadsheets/d/1lZQ2gpeKZ");
  });

  it("keeps the additional parameters folded with the defaults filled in", () => {
    renderPage();
    const summary = screen.getByText("Configurar parámetros adicionales (opcional)");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByLabelText(/^Servidor del almacenamiento/)).toHaveValue("storcube.sagweb.co");
    expect(screen.getByLabelText(/^Puerto/)).toHaveValue("8333");
    expect(screen.getByLabelText(/^Ruta base/)).toHaveValue("Archivos/");
  });

  it("enables each final button only when its data are complete", async () => {
    renderPage();
    const onlyStorage = screen.getByRole("button", { name: "Configurar almacenamiento de archivos" });
    const withLogo = screen.getByRole("button", { name: "Configurar almacenamiento de archivos y subir nuevo logo" });
    expect(onlyStorage).toBeDisabled();
    expect(withLogo).toBeDisabled();
    fillStorageAndDatabase();
    expect(onlyStorage).toBeEnabled();
    expect(withLogo).toBeDisabled();
    await attachLogo();
    expect(withLogo).toBeEnabled();
  });

  it("sends trimmed values and shows the result in the anchored notice", async () => {
    apiMock.post.mockResolvedValue({ databaseName: "SAGWebDemo", logoUpdated: false, logoUrl: null, previousLogoCount: 0 });
    renderPage();
    fillStorageAndDatabase();
    fireEvent.click(screen.getByRole("button", { name: "Configurar almacenamiento de archivos" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveClass("aviso-flotante");
    expect(notice).toHaveTextContent("Almacenamiento de archivos configurado en SAGWebDemo.");
    expect(apiMock.post).toHaveBeenCalledWith("/implementation/company-logo/apply", {
      storage: EXPECTED_STORAGE, database: EXPECTED_DATABASE, confirmed: false,
    });
    expect(screen.getByLabelText(/^Secret key/)).toHaveValue("");
    expect(screen.getByLabelText(/^Contraseña/)).toHaveValue("");
  });

  it("asks before replacing, lists what changes and resends with confirmation and the logo", async () => {
    const conflict = Object.assign(new Error("Esta compañía ya tiene una configuración o un logo."), {
      status: 409,
      data: {
        requiresConfirmation: true,
        changes: [{ field: "MinioBucketName", label: "Bucket", before: "otro", after: "demo.sagerp.cloud.buk" }],
        keysChanged: true, currentLogoUrl: "https://x/old.png", existingLogoCount: 2, replacesLogo: true,
      },
    });
    apiMock.post
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ databaseName: "SAGWebDemo", logoUpdated: true, logoUrl: "https://x/new.png", previousLogoCount: 2 });
    renderPage();
    fillStorageAndDatabase();
    await attachLogo();
    fireEvent.click(screen.getByRole("button", { name: "Configurar almacenamiento de archivos y subir nuevo logo" }));
    expect(await screen.findByText("Esta compañía ya tiene una configuración")).toBeInTheDocument();
    expect(screen.getByText("otro")).toBeInTheDocument();
    expect(screen.getByText(/se reemplazan por las nuevas/)).toBeInTheDocument();
    expect(screen.getByText(/hay 2 imágenes de logo; no se borran/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sí, reemplazar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("logo actualizado en SAGWebDemo");
    const second = apiMock.post.mock.calls[1][1];
    expect(second).toMatchObject({ confirmed: true, logo: { imageName: "logo.png" } });
  });

  it("shows an error in the anchored notice and keeps it until it is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.post.mockRejectedValue(new Error("El servidor rechazó el usuario o la contraseña de SQL."));
    renderPage();
    fillStorageAndDatabase();
    // El segundo «Probar conexión» es el de la base de datos.
    fireEvent.click(screen.getAllByRole("button", { name: "Probar conexión" })[1]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("rechazó el usuario o la contraseña");
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });

  it("validates with actionable Spanish messages and no spaces where they do not apply", () => {
    const storage = { bucket: "demo.sagerp.cloud.buk", accessKey: "A1", secretKey: "S-12345678" };
    expect(validateStorage(storage)).toBeNull();
    expect(validateStorage({ ...storage, bucket: "Demo_Bucket" })).toMatch(/minúsculas/);
    expect(validateStorage({ ...storage, accessKey: "A 1" })).toMatch(/espacios/);
    expect(validateStorage({ ...storage, secretKey: "abc" })).toMatch(/incompleto/);
    const database = { server: "srv.ejemplo.co,1433", databaseName: "Base_1", username: "u", password: "con espacio" };
    expect(validateDatabase(database)).toBeNull();
    expect(validateDatabase({ ...database, server: "srv, 1433" })).toMatch(/espacios/);
    expect(validateDatabase({ ...database, databaseName: "Mi base" })).toMatch(/espacios/);
    expect(validateDatabase({ ...database, username: "mi usuario" })).toMatch(/espacios/);
    expect(validateDatabase({ ...database, password: "  " })).toMatch(/contraseña/);
    expect(validateOptions(DEFAULT_OPTIONS)).toBeNull();
    expect(validateOptions({ ...DEFAULT_OPTIONS, endpoint: "https://x.co" })).toMatch(/sin https/);
    expect(validateOptions({ ...DEFAULT_OPTIONS, basePath: "Archivos" })).toMatch(/terminar en \//);
  });
});
