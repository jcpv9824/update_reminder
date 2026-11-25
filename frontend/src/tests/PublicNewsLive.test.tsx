import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicNewsLive from "../pages/queHayDeNuevo/PublicNewsLive";

const { list, detail } = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock("../pages/queHayDeNuevo/contrato", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pages/queHayDeNuevo/contrato")>(),
  whatsNewApi: { publicList: list, publicDetail: detail },
}));

const item = { publicId: "public-1", category: "mejora", releaseMonth: "2026-10",
  title: "Traslados entre bodegas", summary: "Encuentra el resumen.", whereToFind: "Inventario › Traslados" };
function TestLocation() {
  const { search } = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="URL">{search}</output><button onClick={() => navigate(-1)}>Atrás (navegador)</button></>;
}
function mount(route = "/novedades") {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><MemoryRouter initialEntries={[route]}><PublicNewsLive /><TestLocation /></MemoryRouter></QueryClientProvider>);
  return query;
}

describe("Novedades pública en vivo", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    list.mockResolvedValue({ enabled: true, items: [item], total: 41, pageSize: 20 });
    detail.mockResolvedValue({ ...item, body: { type: "doc", content: [] }, advisor: "NO-MOSTRAR", findings: "NO-MOSTRAR" });
  });
  it("reabre filtros desde la URL y preserva página y filtros al volver de un detalle", async () => {
    mount("/novedades?categoria=mejoras&periodo=ultimo_ano&page=2");
    const results = await screen.findByRole("list", { name: "Novedades" });
    expect(list).toHaveBeenCalledWith({ categoria: "mejoras", periodo: "ultimo_ano", page: 2 });
    expect(screen.getByRole("button", { name: "Mejoras" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(within(results).getByRole("link", { name: "Ver detalle de Traslados entre bodegas" }));
    const dialog = await screen.findByRole("dialog", { name: item.title });
    expect(within(dialog).getByText(item.whereToFind)).toBeVisible();
    expect(within(dialog).queryByText("NO-MOSTRAR")).toBeNull();
    expect(screen.getByLabelText("URL")).toHaveTextContent("detalle=public-1");
    fireEvent.click(screen.getByRole("button", { name: "Atrás (navegador)" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("URL")).toHaveTextContent("categoria=mejoras&periodo=ultimo_ano&page=2");
  });
  it("no muestra un detalle guardado si la publicación está desactivada", async () => {
    list.mockResolvedValue({ enabled: false, items: [item], total: 1, pageSize: 20 });
    mount("/novedades?detalle=public-1");
    expect(await screen.findByText("Las novedades no están disponibles por ahora.")).toBeVisible();
    expect(detail).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(item.title)).toBeNull();
  });
  it("distingue lista vacía de fallo y no consulta un rango incompleto", async () => {
    list.mockResolvedValue({ enabled: true, items: [], total: 0, pageSize: 20 });
    mount("/novedades?periodo=rango");
    expect(screen.getByRole("alert")).toHaveTextContent("Selecciona un rango válido");
    expect(list).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Fecha de liberación"), { target: { value: "todo" } });
    expect(await screen.findByText("No hay novedades para estos filtros.")).toBeVisible();
    list.mockRejectedValue(new Error("internal"));
    fireEvent.click(screen.getByRole("button", { name: "Mejoras" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos cargar las novedades");
    expect(screen.queryByText("internal")).toBeNull();
  });
  it("quita los datos de un detalle abierto al confirmar que ya no está disponible", async () => {
    const query = mount("/novedades?detalle=public-1");
    const dialog = await screen.findByRole("dialog", { name: item.title });
    expect(within(dialog).getByText(item.whereToFind)).toBeVisible();
    list.mockResolvedValue({ enabled: true, items: [], total: 0, pageSize: 20 });
    detail.mockRejectedValue(new Error("not found"));
    await act(async () => {
      await query.invalidateQueries({ queryKey: ["whats-new", "public"] });
      await query.invalidateQueries({ queryKey: ["whats-new", "public-detail"] });
    });
    const withdrawn = await screen.findByRole("dialog", { name: "Detalle de la novedad" });
    expect(within(withdrawn).getByRole("alert")).toBeVisible();
    expect(within(withdrawn).queryByText(item.whereToFind)).toBeNull();
  });
});
