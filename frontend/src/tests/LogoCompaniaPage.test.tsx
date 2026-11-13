import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LogoCompaniaPage, { validateLogoForm } from "../pages/LogoCompaniaPage";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));

vi.mock("../api/client", () => ({ api: apiMock }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "admin", email: "admin@example.com", displayName: "Admin", roles: ["super_admin"] },
  }),
}));

const RESULT = {
  url: "https://storcube.sagweb.co:8333/demo.sagerp.cloud.buk/SAGWebDemo/Archivos/Imagenes/LogoEmpresa/x.png",
  fileName: "x.png",
  bytes: 10,
  replacedCount: 1,
  sql: "UPDATE parametros_web SET LogoEmpresa = N'https://...';",
  sqlFileName: "logo_SAGWebDemo.sql",
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><LogoCompaniaPage /></QueryClientProvider>);
}

async function fillAll() {
  fireEvent.change(screen.getByLabelText(/^Bucket/), { target: { value: " demo.sagerp.cloud.buk " } });
  fireEvent.change(screen.getByLabelText(/^Nombre de la base de datos de la compañía/), { target: { value: "SAGWebDemo" } });
  fireEvent.change(screen.getByLabelText(/^Llave de acceso/), { target: { value: "ACCESS123" } });
  fireEvent.change(screen.getByLabelText(/^Llave secreta/), { target: { value: "SECRET-1234567890" } });
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText(/^Imagen del logo/), { target: { files: [file] } });
  await screen.findByAltText("Vista previa del logo seleccionado");
}

describe("LogoCompaniaPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue([]);
    URL.createObjectURL = vi.fn(() => "blob:sql");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows the keys as readable text fields, in Spanish", () => {
    renderPage();
    expect(screen.getByLabelText(/^Llave de acceso/).getAttribute("type")).not.toBe("password");
    expect(screen.getByLabelText(/^Llave secreta/).getAttribute("type")).not.toBe("password");
  });

  it("links the storage sheet in a new tab", () => {
    renderPage();
    const link = screen.getByRole("link", { name: /hoja de almacenamiento/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.getAttribute("href")).toContain("docs.google.com/spreadsheets/d/1lZQ2gpeKZ");
  });

  it("enables the upload button only when the five data are filled", async () => {
    renderPage();
    const button = screen.getByRole("button", { name: "Subir logo y generar SQL" });
    expect(button).toBeDisabled();
    await fillAll();
    expect(button).toBeEnabled();
  });

  it("asks before replacing an existing logo, downloads the SQL and offers to download it again", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    apiMock.post.mockImplementation(async (path: string) => (
      path.endsWith("/check")
        ? { folder: "SAGWebDemo/Archivos/Imagenes/LogoEmpresa/", existing: [{ name: "old.png", bytes: 100, lastModified: null }] }
        : RESULT
    ));
    renderPage();
    await fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Subir logo y generar SQL" }));
    expect(await screen.findByText("Esta compañía ya tiene logo")).toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledWith("/implementation/company-logo/check", {
      bucket: "demo.sagerp.cloud.buk", accessKey: "ACCESS123", secretKey: "SECRET-1234567890", databaseName: "SAGWebDemo",
    });
    fireEvent.click(screen.getByRole("button", { name: "Sí, reemplazar" }));
    await screen.findByText("SQL listo");
    const uploadCall = apiMock.post.mock.calls.find(([path]) => String(path).endsWith("/upload"))!;
    expect(uploadCall[1]).toMatchObject({ replaceConfirmed: true, imageName: "logo.png" });
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/^Llave secreta/)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Descargar el SQL de nuevo" }));
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it("validates fields with actionable Spanish messages", () => {
    const base = { bucket: "demo.sagerp.cloud.buk", accessKey: "A1", secretKey: "S-12345678", databaseName: "Base_1" };
    expect(validateLogoForm(base)).toBeNull();
    expect(validateLogoForm({ ...base, bucket: "Demo_Bucket" })).toMatch(/minúsculas/);
    expect(validateLogoForm({ ...base, databaseName: "Mi base" })).toMatch(/sin espacios/);
    expect(validateLogoForm({ ...base, secretKey: "abc" })).toMatch(/incompleta/);
    expect(validateLogoForm({ ...base, accessKey: "A 1" })).toMatch(/espacios/);
  });
});
