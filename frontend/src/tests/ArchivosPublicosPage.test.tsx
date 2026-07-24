import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ArchivosPublicosAdminPage from "../pages/ArchivosPublicosAdminPage";

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
  return render(<QueryClientProvider client={client}><ArchivosPublicosAdminPage /></QueryClientProvider>);
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.get.mockResolvedValue([]);
});

describe("ArchivosPublicosAdminPage", () => {
  it("explica que los endpoints se visualizan en el navegador", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Archivos públicos" })).toBeInTheDocument();
    expect(screen.getByText(/se abren en el navegador y no fuerzan una descarga/i)).toBeInTheDocument();
  });

  it("crea una imagen pública usando el contrato inline separado", async () => {
    apiMock.post.mockResolvedValue({ id: "public_file_image" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo archivo" }));

    const titleLabel = screen.getByText("Título *");
    await userEvent.type(within(titleLabel.parentElement!).getByRole("textbox"), "Captura de instalación");
    const input = screen.getByLabelText("Archivo *");
    expect(input).toHaveAttribute("accept", expect.stringContaining("image/png"));
    expect(input).not.toHaveAttribute("accept", expect.stringContaining("text/html"));

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await userEvent.upload(input, new File([png], "captura.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(
      "/public-files/admin",
      expect.objectContaining({
        titulo: "Captura de instalación",
        archivoNombreOriginal: "captura.png",
        archivoMimeType: "image/png",
      }),
    ));
  });
});
