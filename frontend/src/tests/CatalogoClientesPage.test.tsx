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
  displayDocument: "00012345-6",
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
const selectorFuentes = () => screen.getByRole("button", { name: /^Fuentes:/ });
const verSinSAG = "Ver clientes sin filtrar por presencia en SAG Web";

describe("catálogo de clientes multiempresa", () => {
  it("incluye por defecto los activos del ERP y los no verificados solo en SAG Admin, sin acciones de escritura", async () => {
    const soloErp = { ...cliente, web: "not_in_web" } as const;
    const soloSag = { ...cliente, id: "sag-id-opaco", displayDocument: "ID EXT-001", name: "Solo en SAG",
      state: "unverified", sources: [], sagOnly: true } as const;
    const sinDocumento = { ...cliente, id: "sin-documento-opaco", displayDocument: null, name: "Sin documento" } as const;
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue({
      ...initial, items: [soloErp, soloSag, sinDocumento], total: 3,
    });
    renderPage(load);

    await screen.findByText(cliente.name);
    const table = screen.getByRole("table", { name: "Clientes del catálogo" });
    const filaErp = within(table).getByRole("row", { name: /Comercial Ejemplo/ });
    expect(within(filaErp).getByText("Colombia")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith({ state: "active_or_unverified", web: "all", page: 1, pageSize: 25 }, expect.any(AbortSignal));
    expect(selectorFuentes()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("checkbox", { name: "Todas las fuentes autorizadas" })).toBeNull();
    fireEvent.click(selectorFuentes());
    expect(screen.getByRole("checkbox", { name: "Todas las fuentes autorizadas" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /crear|nuevo|editar|eliminar|administrar fuentes/i })).toBeNull();
    expect(within(table).getByText(soloErp.displayDocument)).toBeInTheDocument();
    expect(within(table).getByText("Fuera de SAG Web")).toBeInTheDocument();
    const filaSag = within(table).getByRole("row", { name: /Solo en SAG/ });
    expect(within(filaSag).getByText(soloSag.displayDocument)).toBeInTheDocument();
    expect(within(filaSag).getByText("Solo SAG Admin")).toBeInTheDocument();
    expect(within(filaSag).getByText("No verificado")).toBeInTheDocument();
    expect(within(table).getByText("No disponible")).toBeInTheDocument();
    for (const item of [soloErp, soloSag, sinDocumento]) {
      expect(within(table).queryByText(item.id)).not.toBeInTheDocument();
    }
    expect(within(table).getAllByRole("columnheader").map(header => header.textContent))
      .toEqual(["ID", "Nombre", "Estado", "SAG Web", "Origen"]);
    expect(within(table).getByRole("columnheader", { name: "Origen" })).toHaveClass("catalogo-clientes-origen");
    expect(within(filaErp).getByText("Colombia").closest("td")).toHaveClass("catalogo-clientes-origen");
  });

  it("permite consultar clientes sin estado verificado sin asumir que están activos o inactivos", async () => {
    const soloSag = { ...cliente, id: "sag-id-opaco", name: "Nombre desde SAG Admin",
      state: "unverified", sources: [], sagOnly: true } as const;
    const load = vi.fn<CargarCatalogoClientes>().mockImplementation(async query => ({
      ...initial, items: query.state === "unverified" ? [soloSag] : [cliente],
    }));
    renderPage(load);
    await screen.findByText(cliente.name);
    expect(screen.getByLabelText("Estado del cliente")).toHaveValue("active_or_unverified");
    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "unverified" } });
    await screen.findByText(soloSag.name);
    const row = screen.getByRole("row", { name: /Nombre desde SAG Admin/ });
    expect(within(row).getByText("No verificado")).toBeInTheDocument();
    expect(within(row).getByText("Solo SAG Admin")).toBeInTheDocument();
    expect(within(row).queryByText("Activo")).toBeNull();
    expect(within(row).queryByText("Inactivo")).toBeNull();
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ state: "unverified", web: "all" }), expect.any(AbortSignal));
  });

  it("aplica la búsqueda por documento solo al enviarla y conserva ceros y guion en pantalla", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    renderPage(load);
    await screen.findByText(cliente.name);
    fireEvent.change(screen.getByLabelText("Buscar por ID o nombre"), { target: { value: ` ${cliente.displayDocument} ` } });
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: cliente.displayDocument, state: "active_or_unverified", web: "all", page: 1 }), expect.any(AbortSignal)));
    expect(await screen.findByText(cliente.displayDocument)).toBeInTheDocument();
    expect(screen.queryByText(cliente.id)).not.toBeInTheDocument();
  });

  it("permite combinar fuentes y modificar estado, presencia y búsqueda de forma independiente", async () => {
    const panama = { ...colombia, sourceId: "pa", label: "Panamá" };
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue({ ...initial, sources: [colombia, estadosUnidos, panama] });
    renderPage(load);
    await screen.findByText(cliente.name);

    fireEvent.click(selectorFuentes());
    fireEvent.click(screen.getByRole("checkbox", { name: "Panamá" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceIds: ["co", "us"], state: "active_or_unverified", web: "all" }), expect.any(AbortSignal)));

    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "inactive" } });
    fireEvent.change(screen.getByLabelText("Presencia en SAG Web"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Buscar por ID o nombre"), { target: { value: " Comercial " } });
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
    fireEvent.click(selectorFuentes());
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

  it("cierra el selector con Escape, devuelve el foco y no consulta al dejar todas las fuentes desmarcadas", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue(initial);
    renderPage(load);
    await screen.findByText(cliente.name);
    const trigger = selectorFuentes();
    fireEvent.click(trigger);
    const todas = screen.getByRole("checkbox", { name: "Todas las fuentes autorizadas" });
    todas.focus();
    fireEvent.keyDown(todas, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("checkbox", { name: "Todas las fuentes autorizadas" }));
    expect(await screen.findByText(/Selecciona al menos una fuente/)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "Colombia" })).not.toBeChecked();
  });

  it("desambigua nombres de BD repetidos sin cambiar los IDs de filtros", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue({
      ...initial, sources: [{ ...colombia, label: "ERP_Main" }, { ...estadosUnidos, label: "ERP_Main" }],
    });
    renderPage(load);
    await screen.findByText(cliente.name);
    fireEvent.click(selectorFuentes());
    expect(screen.getByRole("checkbox", { name: "ERP_Main (1)" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "ERP_Main (2)" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ sourceIds: ["co"] }), expect.any(AbortSignal)));
    expect(selectorFuentes()).toHaveAccessibleName("Fuentes: ERP_Main (1)");
  });

  it("solo amplía el filtro SAG Web con la acción explícita y conserva búsqueda, estado y fuentes", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockImplementation(async query => ({
      ...initial, sag: { state: "unavailable", verifiedAt: null }, partial: true,
      items: query.web === "all" ? [{ ...cliente, web: "unverified" }] : [], total: query.web === "all" ? 1 : 0,
    }));
    renderPage(load);
    await screen.findByText(cliente.name);
    expect(screen.queryByRole("button", { name: verSinSAG })).toBeNull();
    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("Presencia en SAG Web"), { target: { value: "in_web" } });
    expect(await screen.findByRole("button", { name: verSinSAG })).toBeInTheDocument();
    fireEvent.click(selectorFuentes());
    fireEvent.click(screen.getByRole("checkbox", { name: "Estados Unidos" }));
    fireEvent.change(screen.getByLabelText("Buscar por ID o nombre"), { target: { value: "Comercial" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    fireEvent.click(await screen.findByRole("button", { name: verSinSAG }));
    await screen.findByText(cliente.name);
    expect(load).toHaveBeenLastCalledWith(
      { sourceIds: ["co"], state: "active", search: "Comercial", web: "all", page: 1, pageSize: 25 }, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: verSinSAG })).toBeNull();
    expect(within(screen.getByRole("table")).getByText("No verificado")).toBeInTheDocument();
  });

  it.each([
    { sag: initial.sag, sources: initial.sources, total: 0 },
    { sag: { state: "stale", verifiedAt: null } as const, sources: [], total: 0 },
    { sag: { state: "stale", verifiedAt: null } as const, sources: initial.sources, total: 0 },
    { sag: { state: "unavailable", verifiedAt: null } as const, sources: initial.sources, total: 2 },
    { sag: { state: "unavailable", verifiedAt: null } as const, sources: initial.sources, total: 0, page: 2 },
  ])("no ofrece ampliar sin evidencia de estado incompleto, fuentes visibles y cero resultados (%#)", async caso => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue({ ...initial, ...caso, partial: true, items: [] });
    renderPage(load);
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("Presencia en SAG Web"), { target: { value: "in_web" } });
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: verSinSAG })).toBeNull();
  });

  it("no sugiere ampliar la presencia SAG Web para clientes inactivos", async () => {
    const load = vi.fn<CargarCatalogoClientes>().mockResolvedValue({
      ...initial, partial: true, sag: { state: "unavailable", verifiedAt: null }, items: [], total: 0,
    });
    renderPage(load);
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("Presencia en SAG Web"), { target: { value: "in_web" } });
    expect(await screen.findByRole("button", { name: verSinSAG })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Estado del cliente"), { target: { value: "inactive" } });
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: verSinSAG })).toBeNull();
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
