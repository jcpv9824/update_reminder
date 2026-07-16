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
    fuenteIds: ["fuente_factura", "fuente_remision"],
    fuenteNombres: ["Factura de venta", "Remisión"],
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
    fuenteIds: ["fuente_factura"],
    fuenteNombres: ["Factura de venta"],
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

const modulosLicencia = [
  {
    id: "modulo_contabilidad",
    name: "Contabilidad",
    code: "CONTABILIDAD",
    status: "active",
    active: true,
  },
];

function mockGets() {
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/catalogo-formatos/admin/fuentes-formatos") return Promise.resolve(fuentes);
    if (path === "/catalogo-formatos/admin/formatos-impresion") return Promise.resolve(formatos);
    if (path === "/license-modules") return Promise.resolve(modulosLicencia);
    if (path === "/public/fuentes-formatos") return Promise.resolve(fuentes);
    if (path.startsWith("/public/formatos-impresion")) {
      if (path.includes("q=resumido")) return Promise.resolve([formatos[1]]);
      if (path.includes("fuente_id=fuente_remision")) return Promise.resolve([formatos[0]]);
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

function selectField(label: string) {
  const matches = screen.getAllByText(label);
  const node = matches[matches.length - 1];
  return within(node.parentElement!).getByRole("combobox");
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  mockGets();
});

describe("FormatosImpresionPublicPage", () => {
  it("muestra tipos de fuente, marca SAG Web y carga el PDF seleccionado", async () => {
    renderWithQuery(<FormatosImpresionPublicPage />);
    expect(await screen.findByRole("heading", { name: "Catálogo de Formatos de Impresión" })).toBeInTheDocument();
    expect(screen.getByText("Catálogo de formatos de impresión disponibles en SAG Web.")).toBeInTheDocument();
    expect(screen.getByAltText("SAG Web")).toHaveAttribute("src", "https://pya.com.co/wp-content/uploads/2025/12/H_LOGO.png");
    expect(screen.getByRole("heading", { name: "Filtrar por tipo de fuente" })).toBeInTheDocument();
    expect((await screen.findAllByText("Factura de venta")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Factura de Venta - Estándar")).length).toBeGreaterThan(0);
    expect(screen.getByText("Factura de venta · Remisión")).toBeInTheDocument();
    expect(screen.getByTitle("Vista previa Factura de Venta - Estándar")).toHaveAttribute(
      "src",
      "/api/public/formatos-impresion/formato_estandar/pdf"
    );
    expect(screen.queryByRole("link", { name: "Descargar PDF" })).toBeNull();
  });

  it("incluye un formato compartido al filtrar por cualquiera de sus fuentes", async () => {
    renderWithQuery(<FormatosImpresionPublicPage />);
    await screen.findAllByText("Factura de Venta - Estándar");

    await userEvent.click(screen.getByRole("button", { name: "Filtrar por Remisión" }));

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("fuente_id=fuente_remision")));
    expect((await screen.findAllByText("Factura de Venta - Estándar")).length).toBeGreaterThan(0);
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

  it("permite limpiar rápidamente la búsqueda pública", async () => {
    renderWithQuery(<FormatosImpresionPublicPage />);
    const buscador = await screen.findByLabelText("Buscar formato");
    await userEvent.type(buscador, "resumido");
    expect(await screen.findByRole("button", { name: "Limpiar busqueda" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Limpiar busqueda" }));

    await waitFor(() => expect(buscador).toHaveValue(""));
    expect((await screen.findAllByText("Factura de Venta - Estándar")).length).toBeGreaterThan(0);
  });
});

describe("FormatosImpresionAdminPage", () => {
  it("crea un tipo de fuente desde la pestaña administrativa", async () => {
    apiMock.post.mockResolvedValue({ id: "fuente_nueva", nombre: "Cotización" });
    renderWithQuery(<FormatosImpresionAdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo tipo de fuente" }));
    await userEvent.type(field("Nombre del tipo de fuente *"), "Cotización");
    await userEvent.type(field("Descripción"), "Formatos para cotizaciones");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/catalogo-formatos/admin/fuentes-formatos", expect.objectContaining({
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

  it("permite asociar más de un tipo de fuente al crear un formato", async () => {
    apiMock.post.mockResolvedValue({ id: "formato_compartido" });
    renderWithQuery(<FormatosImpresionAdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Formatos" }));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo formato" }));
    await userEvent.type(field("Nombre del formato *"), "Formato compartido");
    await userEvent.click(screen.getByLabelText("Remisión"));
    await userEvent.type(field("Descripción *"), "Disponible para factura y remisión");
    const pdf = new File(["%PDF-1.4\n"], "compartido.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("PDF *"), pdf);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(
      "/catalogo-formatos/admin/formatos-impresion",
      expect.objectContaining({ fuenteIds: ["fuente_factura", "fuente_remision"] })
    ));
  });

  it("muestra metadatos opcionales de tamaño y licencia en el formato", async () => {
    renderWithQuery(<FormatosImpresionAdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Formatos" }));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo formato" }));

    expect(screen.queryByText("PDF (opcional para reemplazar)")).toBeNull();
    await userEvent.selectOptions(selectField("Tamaño del formato"), "personalizado");
    expect(field("Tamaño personalizado")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Restringir por tipo de licencia"));
    expect(selectField("Tipo de licencia")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Contabilidad" })).toBeInTheDocument();
  });

  it("permite limpiar rápidamente la búsqueda administrativa", async () => {
    renderWithQuery(<FormatosImpresionAdminPage />);
    await screen.findByText("Factura de venta");
    const buscador = screen.getByPlaceholderText("Buscar por nombre o descripción...");

    await userEvent.type(buscador, "remision");
    expect(screen.queryByText("Factura de venta")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Limpiar busqueda" }));

    await waitFor(() => expect(buscador).toHaveValue(""));
    expect(screen.getByText("Factura de venta")).toBeInTheDocument();
  });
});
