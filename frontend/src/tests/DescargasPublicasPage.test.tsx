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

const sections = [{
  id: "section_manuals",
  nombre: "Manuales",
  slug: "manuales",
  activa: true,
  status: "active",
  createdAt: "",
  createdBy: "admin",
  updatedAt: "",
  updatedBy: "admin",
}];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><DescargasPublicasAdminPage /></QueryClientProvider>);
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.get.mockImplementation((path: string) => Promise.resolve(path.endsWith("/sections") ? sections : []));
});

describe("DescargasPublicasAdminPage", () => {
  it("distingue las secciones de los archivos y usa Archivos como concepto general", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: "Archivos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Secciones" })).toBeInTheDocument();
    expect(screen.getByText(/Las secciones organizan los archivos públicos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nuevo archivo" })).toBeInTheDocument();
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
      "/public-downloads/admin/documents",
      expect.objectContaining({ titulo: "Video de instalación", archivoNombreOriginal: "instalacion.mp4", archivoMimeType: "video/mp4" })
    ));
  });
});
