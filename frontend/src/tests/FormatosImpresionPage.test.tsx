import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FormatosImpresionAdminPage from "../pages/FormatosImpresionAdminPage";
import FormatosImpresionPublicPage from "../pages/FormatosImpresionPublicPage";

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

const fuentes = [
  {
    id: "fuente_factura",
    nombre: "Factura de venta",
    descripcion: "Documentos de venta",
    activa: true,
    status: "active",
    formatosActivos: 2,
    createdAt: "",
    createdBy: "admin",
    updatedAt: "",
    updatedBy: "admin",
  },
  {
    id: "fuente_remision",
    nombre: "Remisión",
    descripcion: "Entregas",
    activa: true,
    status: "active",
    formatosActivos: 1,
    createdAt: "",
    createdBy: "admin",
    updatedAt: "",
    updatedBy: "admin",
  },
];

const formatos = [
  {
    id: "formato_estandar",
    nombre: "Factura de Venta - Estándar",
    fuenteId: "fuente_factura",
    fuenteNombre: "Factura de venta",
    descripcion: "Incluye impuestos y totales.",
    pdfNombreOriginal: "factura_estandar.pdf",
    pdfMimeType: "application/pdf",
    pdfUrl: "/api/public/formatos-impresion/formato_estandar/pdf",
    downloadUrl: "/api/public/formatos-impresion/formato_estandar/descargar",
    activo: true,
    status: "active",
    createdAt: "",
    createdBy: "admin",
    updatedAt: "",
    updatedBy: "admin",
  },
  {
    id: "formato_resumido",
    nombre: "Factura de Venta - Resumido",
    fuenteId: "fuente_factura",
    fuenteNombre: "Factura de venta",
    descripcion: "Sin detalle de ítems.",
    pdfNombreOriginal: "factura_resumido.pdf",
    pdfMimeType: "application/pdf",
    pdfUrl: "/api/public/formatos-impresion/formato_resumido/pdf",
    downloadUrl: "/api/public/formatos-impresion/formato_resumido/descargar",
    activo: true,
    status: "active",
    createdAt: "",
    createdBy: "admin",
    updatedAt: "",
    updatedBy: "admin",
  },
];

function mockGets() {
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/admin/fuentes-formatos") return Promise.resolve(fuentes);
    if (path === "/admin/formatos-impresion") return Promise.resolve(formatos);
    if (path === "/public/fuentes-formatos") return Promise.resolve(fuentes);
    if (path.startsWith("/public/formatos-impresion")) {
      if (path.includes("q=resumido")) return Promise.resolve([formatos[1]]);
      if (path.includes("fuente_id=fuente_remision")) return Promise.resolve([]);
      return Promise.resolve(formatos);
    }
    return Promise.resolve([]);
  });
}

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function field(label: string) {
  const matches = screen.getAllByText(label);
  const node = matches[matches.length - 1];
  return within(node.parentElement!).getByRole("textbox");
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  mockGets();
});

describe("FormatosImpresionPublicPage", () => {
  it("muestra fuentes, resultados y carga el PDF seleccionado", async () => {
    renderWithQuery(<FormatosImpresionPublicPage />);
    expect(await screen.findByRole("heading", { name: "Catálogo de Formatos de Impresión" })).toBeInTheDocument();
    expect((await screen.findAllByText("Factura de venta")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Factura de Venta - Estándar")).length).toBeGreaterThan(0);
    expect(screen.getByTitle("Vista previa Factura de Venta - Estándar")).toHaveAttribute(
      "src",
      "/api/public/formatos-impresion/formato_estandar/pdf"
    );
    expect(screen.getByRole("link", { name: "Descargar PDF" })).toHaveAttribute(
      "href",
      "/api/public/formatos-impresion/formato_estandar/descargar"
    );
    expect(screen.queryByText(/SAG/i)).toBeNull();
  });

  it("combina búsqueda con la consulta pública y actualiza la selección", async () => {
    renderWithQuery(<FormatosImpresionPublicPage />);
    await screen.findAllByText("Factura de Venta - Estándar");
    await userEvent.type(screen.getByLabelText("Buscar formato"), "resumido");
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("q=resumido")));
    expect((await screen.findAllByText("Factura de Venta - Resumido")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Factura de Venta - Estándar")).toHaveLength(0);
    expect(screen.getByTitle("Vista previa Factura de Venta - Resumido")).toHaveAttribute(
      "src",
      "/api/public/formatos-impresion/formato_resumido/pdf"
    );
  });
});

describe("FormatosImpresionAdminPage", () => {
  it("crea una Fuente desde la pestaña administrativa", async () => {
    apiMock.post.mockResolvedValue({ id: "fuente_nueva", nombre: "Cotización" });
    renderWithQuery(<FormatosImpresionAdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Nueva Fuente" }));
    await userEvent.type(field("Nombre de la Fuente *"), "Cotización");
    await userEvent.type(field("Descripción"), "Formatos para cotizaciones");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/admin/fuentes-formatos", expect.objectContaining({
      nombre: "Cotización",
      descripcion: "Formatos para cotizaciones",
      activa: true,
    })));
  });

  it("exige PDF al crear un formato", async () => {
    renderWithQuery(<FormatosImpresionAdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Formatos" }));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo formato" }));
    await userEvent.type(field("Nombre del formato *"), "Remisión con detalle");
    await userEvent.type(field("Descripción *"), "Formato para remisiones detalladas");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Debe cargar un PDF.")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
