import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DescargasPublicasAdminPage from "../pages/DescargasPublicasAdminPage";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: apiMock,
  apiUrl: (path: string) => `/api${path}`,
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><DescargasPublicasAdminPage /></QueryClientProvider>);
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.get.mockResolvedValue([]);
});

describe("DescargasPublicasAdminPage", () => {
  it("administra únicamente archivos descargables sin secciones", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: "Nuevo archivo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Secciones" })).toBeNull();
    expect(screen.queryByText(/Las secciones organizan/i)).toBeNull();
    expect(screen.getByText(/Todos los endpoints de esta opción fuerzan la descarga/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nuevo documento" })).toBeNull();
  });

  it("permite seleccionar videos compatibles al crear un archivo público", async () => {
    apiMock.post.mockResolvedValue({ id: "asset_video" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo archivo" }));

    const titleLabel = screen.getByText("Título *");
    await userEvent.type(within(titleLabel.parentElement!).getByRole("textbox"), "Video de instalación");
    const input = screen.getByLabelText("Archivo *");
    expect(input).toHaveAttribute("accept", expect.stringContaining("video/mp4"));
    expect(input).toHaveAttribute("accept", expect.stringContaining(".webm"));

    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
    await userEvent.upload(input, new File([bytes], "instalacion.mp4", { type: "video/mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(
      "/public-downloads/admin/files",
      expect.objectContaining({
        titulo: "Video de instalación",
        archivoNombreOriginal: "instalacion.mp4",
        archivoMimeType: "video/mp4",
      })
    ));
    expect(apiMock.post.mock.calls[0][1]).not.toHaveProperty("sectionId");
  });
});
