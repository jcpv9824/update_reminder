import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CargarDominiosCliente, CargarLicenciasCliente, CargadoresIndicadores } from "../components/CatalogoClienteIndicadores";
import CatalogoClientesPage, {
  type CatalogoClientesResponse,
  type CargarCatalogoClientes,
  type CargarDetalleCliente,
} from "../pages/CatalogoClientesPage";

const colombia = { sourceId: "co", label: "Colombia", revisionState: "verified", verifiedAt: "2026-11-17T14:30:00Z" } as const;
const estadosUnidos = { ...colombia, sourceId: "us", label: "Estados Unidos" };
const cliente = {
  id: "cliente-opaco",
  name: "Comercial Ejemplo",
  state: "active",
  web: "in_web",
  sources: [{ ...colombia, state: "active" }],
  stateVaries: false,
  requiresReconciliation: false,
} as const;

const initial: CatalogoClientesResponse = {
  items: [cliente],
  sources: [colombia, estadosUnidos],
  sag: { state: "verified", verifiedAt: null },
  partial: false,
  total: 1,
  page: 1,
  pageSize: 25,
};

function renderPage(load: CargarCatalogoClientes, loadDetail?: CargarDetalleCliente, indicadores?: CargadoresIndicadores) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CatalogoClientesPage scopeKey="alcance-de-prueba" load={load} loadDetail={loadDetail} indicadores={indicadores} />
    </QueryClientProvider>
  );
}

describe("catálogo de clientes multiempresa", () => {
  it("consulta por defecto todas las fuentes autorizadas, activos y en SAG Web, sin acciones de escritura", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    renderPage(load);

    await screen.findByText(cliente.name);
    const table = screen.getByRole("table", { name: "Clientes del catálogo" });
    expect(within(table).getByText("Colombia")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith({ state: "active", web: "in_web", page: 1, pageSize: 25 }, expect.any(AbortSignal));
    expect(screen.getByRole("checkbox", { name: "Todas las fuentes autorizadas" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /crear|nuevo|editar|eliminar|administrar fuentes/i })).toBeNull();
    expect(screen.queryByText(cliente.id)).toBeNull();
  });

  it("permite combinar fuentes y modificar estado, presencia y búsqueda de forma independiente", async () => {
    const panama = { ...colombia, sourceId: "pa", label: "Panamá" };
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue({ ...initial, sources: [colombia, estadosUnidos, panama] });
    renderPage(load);
    await screen.findByText(cliente.name);

    fireEvent.click(screen.getByRole("checkbox", { name: "Panamá" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceIds: ["co", "us"], state: "active", web: "in_web" }), expect.any(AbortSignal)));

    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "inactive" } });
    fireEvent.change(screen.getByLabelText("Presencia en SAG Web"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Buscar por nombre oficial"), { target: { value: " Comercial " } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      { sourceIds: ["co", "us"], state: "inactive", web: "all", search: "Comercial", page: 1, pageSize: 25 },
      expect.any(AbortSignal)));

    fireEvent.click(screen.getByRole("checkbox", { name: "Todas las fuentes autorizadas" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      { state: "inactive", web: "all", search: "Comercial", page: 1, pageSize: 25 }, expect.any(AbortSignal)));
  });

  it("distingue una lectura parcial de un estado negativo confirmado y conserva el aviso aun sin filas", async () => {
    const stale = { ...colombia, revisionState: "stale" } as const;
    const load = vi.fn<CargarCatalogoClientes>().mockImplementation(async query => ({
      ...initial, partial: true, sources: [stale], sag: { state: "unavailable", verifiedAt: null },
      ...(query.state === "all" && query.web === "all" ? {
        items: [{ ...cliente, state: "unverified", web: "unverified", sources: [{ ...stale, state: "unverified" }] }],
      } : { items: [], total: 0 }),
    }));
    renderPage(load);

    expect(await screen.findByText(/La información del catálogo está incompleta/)).toBeInTheDocument();
    expect(screen.getByText(/No hay resultados confirmados/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Presencia en SAG Web"), { target: { value: "all" } });
    await screen.findByText(cliente.name);
    const table = screen.getByRole("table", { name: "Clientes del catálogo" });
    expect(within(table).getAllByText("No verificado")).toHaveLength(2);
    expect(within(table).queryByText("Inactivo")).toBeNull();
    expect(within(table).queryByText("Fuera de SAG Web")).toBeNull();
  });

  it("muestra un fallo sin detalles técnicos y permite reintentar", async () => {
    const load = vi.fn<CargarCatalogoClientes>()
      .mockRejectedValueOnce(new Error("host, token y documento internos"))
      .mockResolvedValueOnce(initial);
    renderPage(load);

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo consultar el catálogo.");
    expect(screen.queryByText(/token y documento/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText(cliente.name)).toBeInTheDocument();
  });

  it("solicita el detalle por ID opaco y muestra todas las procedencias autorizadas que devuelve", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    const loadDetail = vi.fn<CargarDetalleCliente>().mockResolvedValue({
      ...cliente,
      sources: [...cliente.sources, { ...estadosUnidos, state: "inactive" }],
    });
    renderPage(load, loadDetail);
    await screen.findByText(cliente.name);

    fireEvent.click(screen.getByRole("button", { name: "Ver fuentes de Comercial Ejemplo" }));
    const detail = await screen.findByRole("region", { name: "Fuentes de Comercial Ejemplo" });
    expect(await within(detail).findByText("Estados Unidos")).toBeInTheDocument();
    expect(within(detail).getByText("Inactivo", { exact: false })).toBeInTheDocument();
    expect(loadDetail).toHaveBeenCalledWith(cliente.id, expect.any(AbortSignal));
  });

  it("no reutiliza filas ni nombres de fuente al cambiar el alcance de permisos", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    const siguiente = vi.fn<CargarCatalogoClientes>().mockImplementation(() => new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { rerender } = render(
      <QueryClientProvider client={client}><CatalogoClientesPage scopeKey="primer-alcance" load={load} /></QueryClientProvider>,
    );
    await screen.findByText(cliente.name);
    expect(screen.getByRole("checkbox", { name: "Colombia" })).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={client}>
        <CatalogoClientesPage scopeKey="nuevo-alcance" load={siguiente} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(cliente.name)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Colombia" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Cargando clientes");
  });

  it("consulta el indicador autorizado solo al abrirlo y muestra dominios sin enlaces ni destinos", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    const loadDetail = vi.fn<CargarDetalleCliente>().mockResolvedValue(cliente);
    const dominios = vi.fn<CargarDominiosCliente>().mockResolvedValue({
      state: "stale", verifiedAt: "2026-11-17T14:30:00Z", partial: true,
      items: [{ host: "ejemplo.invalid", observations: [
        { environment: "production", startedOn: "2026-11-17" }, { environment: "test", startedOn: null },
      ] }],
    });
    renderPage(load, loadDetail, { dominios });
    await screen.findByText(cliente.name);
    expect(dominios).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByRole("button", { name: "Ver fuentes de Comercial Ejemplo" }));
    const boton = await screen.findByRole("button", { name: "Ver dominios observados" });
    expect(screen.queryByRole("button", { name: "Ver licencias observadas" })).toBeNull();
    expect(dominios).toHaveBeenCalledTimes(0);
    fireEvent.click(boton);
    const panel = screen.getByRole("region", { name: "Dominios observados" });
    expect(await within(panel).findByText("ejemplo.invalid")).toBeInTheDocument();
    expect(within(panel).queryByRole("link")).toBeNull();
    expect(within(panel).getByText("Desactualizada", { exact: false })).toBeInTheDocument();
    expect(within(panel).getByText(/información parcial/i)).toBeInTheDocument();
    expect(within(panel).getByText(/Inicio no verificado/)).toBeInTheDocument();
    const diaObservado = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeZone: "UTC" })
      .format(new Date("2026-11-17T00:00:00Z"));
    expect(within(panel).getByText(diaObservado)).toHaveAttribute("datetime", "2026-11-17");
    expect(dominios).toHaveBeenCalledExactlyOnceWith(cliente.id, expect.any(AbortSignal));
  });

  it("distingue licencias no observadas de evidencia no disponible", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    const loadDetail = vi.fn<CargarDetalleCliente>().mockResolvedValue(cliente);
    const dominios = vi.fn<CargarDominiosCliente>().mockResolvedValue({
      state: "unavailable", verifiedAt: null, partial: true,
      items: [{ host: "no-visible.invalid", observations: [] }],
    });
    const licencias = vi.fn<CargarLicenciasCliente>().mockResolvedValue({
      state: "verified", verifiedAt: null, partial: false, items: [],
    });
    renderPage(load, loadDetail, { dominios, licencias });
    fireEvent.click(await screen.findByRole("button", { name: "Ver fuentes de Comercial Ejemplo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ver licencias observadas" }));
    expect(await screen.findByText(/No se observaron licencias en la información disponible/)).toBeInTheDocument();
    expect(dominios).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByRole("button", { name: "Ver dominios observados" }));
    expect(await screen.findByText(/No hay evidencia disponible sobre dominios/)).toBeInTheDocument();
    expect(screen.queryByText("no-visible.invalid")).toBeNull();
  });

  it("no expone los indicadores de un detalle que dejó de estar autorizado", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    const loadDetail = vi.fn<CargarDetalleCliente>().mockResolvedValue(null);
    const dominios = vi.fn<CargarDominiosCliente>();
    renderPage(load, loadDetail, { dominios });
    fireEvent.click(await screen.findByRole("button", { name: "Ver fuentes de Comercial Ejemplo" }));
    await screen.findByText(/El cliente ya no está disponible/);
    expect(screen.queryByRole("button", { name: "Ver dominios observados" })).toBeNull();
    expect(dominios).toHaveBeenCalledTimes(0);
  });
});
