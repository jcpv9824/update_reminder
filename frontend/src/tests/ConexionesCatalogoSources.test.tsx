import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConexionesCatalogoSources, {
  type CatalogSourceLoader,
  type CatalogSourceDraftBinder,
  type CatalogSourceItem,
  type CatalogSourceVerifier,
  type CatalogSourceActivator,
} from "../components/ConexionesCatalogoSources";

const sources: readonly CatalogSourceItem[] = [
  { id: "b-co", profileId: "co", label: "Empresa Colombia", role: "erp-customers", state: "active",
    issuerScope: "CO:NIT", canReadCurrentProfile: true },
  { id: "b-pa", profileId: "pa", label: "Empresa Panamá", role: "erp-customers", state: "draft",
    issuerScope: "PA:RUC", canReadCurrentProfile: false },
  { id: "b-sag", profileId: "sag", label: "Administración central", role: "sag-admin", state: "active",
    canReadCurrentProfile: true },
];
const profiles = [
  { id: "co", displayName: "Empresa Colombia" },
  { id: "pa", displayName: "Empresa Panamá" },
  { id: "sag", displayName: "Administración central" },
  { id: "nueva", displayName: "Conexión nueva" },
];

function renderSection(args: {
  canEdit?: boolean;
  canTest?: boolean;
  load?: CatalogSourceLoader;
  bindDraft?: CatalogSourceDraftBinder;
  verifyDraft?: CatalogSourceVerifier;
  activateDraft?: CatalogSourceActivator;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const load = args.load ?? vi.fn<CatalogSourceLoader>().mockResolvedValue({ items: sources });
  return render(
    <QueryClientProvider client={client}>
      <ConexionesCatalogoSources scopeKey="alcance-de-prueba" profiles={profiles} load={load}
        canEdit={args.canEdit ?? false} canTest={args.canTest ?? false} bindDraft={args.bindDraft}
        verifyDraft={args.verifyDraft} activateDraft={args.activateDraft} />
    </QueryClientProvider>,
  );
}

describe("fuentes de catálogo en Conexiones", () => {
  it("muestra las empresas ERP separadas de SAG Admin y mantiene visibles estados y validación", async () => {
    renderSection();
    await screen.findByText("Empresa Colombia");
    const erp = screen.getByRole("region", { name: "Bases de datos externas que suministran clientes" });
    const sag = screen.getByRole("region", { name: "Base de datos de SAG Admin" });
    expect(within(erp).getByText("Empresa Panamá")).toBeInTheDocument();
    expect(within(erp).getByText("Borrador")).toBeInTheDocument();
    expect(within(erp).getByText("Lectura no confirmada para el perfil actual")).toBeInTheDocument();
    expect(within(erp).queryByText("Administración central")).toBeNull();
    expect(within(sag).getByText("Administración central")).toBeInTheDocument();
    expect(within(sag).getByText("Activo")).toBeInTheDocument();
  });

  it("no muestra el formulario a quien sólo puede consultar", async () => {
    const bindDraft = vi.fn<CatalogSourceDraftBinder>();
    renderSection({ bindDraft });
    await screen.findByText("Empresa Colombia");
    expect(screen.queryByRole("button", { name: /vincular|activar/i })).toBeNull();
    expect(bindDraft).toHaveBeenCalledTimes(0);
  });

  it("vincula un perfil ERP existente sólo como borrador y refresca la lista", async () => {
    const load = vi.fn<CatalogSourceLoader>().mockResolvedValue({ items: sources });
    const bindDraft = vi.fn<CatalogSourceDraftBinder>().mockResolvedValue(undefined);
    renderSection({ canEdit: true, bindDraft, load });
    const selector = await screen.findByLabelText("Perfil SQL existente");
    expect(within(selector).queryByRole("option", { name: "Empresa Colombia" })).toBeNull();
    fireEvent.change(selector, { target: { value: "nueva" } });
    fireEvent.change(screen.getByLabelText("Ámbito emisor (país:tipo)"), { target: { value: " co:nit " } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular como borrador" }));

    await waitFor(() => expect(bindDraft).toHaveBeenCalledWith("nueva", { role: "erp-customers", issuerScope: "CO:NIT" }));
    expect(await screen.findByText("Perfil vinculado como borrador. No se activó el catálogo.")).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("no envía un ámbito de ERP al cambiar a SAG Admin, ni ofrece un botón para activar", async () => {
    const bindDraft = vi.fn<CatalogSourceDraftBinder>().mockResolvedValue(undefined);
    renderSection({ canEdit: true, bindDraft });
    fireEvent.change(await screen.findByLabelText("Perfil SQL existente"), { target: { value: "nueva" } });
    fireEvent.change(screen.getByLabelText("Ámbito emisor (país:tipo)"), { target: { value: "CO:NIT" } });
    fireEvent.change(screen.getByLabelText("Uso del perfil"), { target: { value: "sag-admin" } });
    expect(screen.queryByLabelText("Ámbito emisor (país:tipo)")).toBeNull();
    expect(screen.queryByRole("button", { name: /^activar$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Vincular como borrador" }));
    await waitFor(() => expect(bindDraft).toHaveBeenCalledWith("nueva", { role: "sag-admin" }));
  });

  it("bloquea el ámbito inválido y nunca muestra detalles técnicos de un fallo", async () => {
    const bindDraft = vi.fn<CatalogSourceDraftBinder>().mockRejectedValue(new Error("host o token interno"));
    renderSection({ canEdit: true, bindDraft });
    fireEvent.change(await screen.findByLabelText("Perfil SQL existente"), { target: { value: "nueva" } });
    fireEvent.change(screen.getByLabelText("Ámbito emisor (país:tipo)"), { target: { value: "Colombia" } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular como borrador" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Usa un ámbito con formato país:tipo");
    expect(bindDraft).toHaveBeenCalledTimes(0);
    fireEvent.change(screen.getByLabelText("Ámbito emisor (país:tipo)"), { target: { value: "CO:NIT" } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular como borrador" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No se pudo vincular el perfil."));
    expect(screen.queryByText(/token interno/)).toBeNull();
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "separa los permisos de verificación y activación con editar=%s y probar=%s",
    async (canEdit, canTest) => {
      renderSection({ canEdit, canTest, verifyDraft: vi.fn<CatalogSourceVerifier>(),
        activateDraft: vi.fn<CatalogSourceActivator>() });
      const draftRow = await screen.findByRole("row", { name: /Empresa Panamá/ });
      expect(!!within(draftRow).queryByRole("button", { name: "Verificar" })).toBe(canTest);
      expect(!!within(draftRow).queryByRole("button", { name: "Activar" })).toBe(canEdit && canTest);
      const activeRow = screen.getByRole("row", { name: /Empresa Colombia/ });
      expect(!!within(activeRow).queryByRole("button", { name: "Verificar" })).toBe(canTest);
      expect(within(activeRow).queryByRole("button", { name: "Activar" })).toBeNull();
      expect(within(activeRow).queryByRole("button", { name: "Revalidar fuente" })).toBeNull();
    },
  );

  it("verifica sin activar y vuelve a consultar las fuentes", async () => {
    const load = vi.fn<CatalogSourceLoader>().mockResolvedValue({ items: sources });
    const verifyDraft = vi.fn<CatalogSourceVerifier>().mockResolvedValue({ status: "verified" });
    const activateDraft = vi.fn<CatalogSourceActivator>();
    renderSection({ canTest: true, canEdit: true, load, verifyDraft, activateDraft });
    fireEvent.click(within(await screen.findByRole("row", { name: /Empresa Panamá/ })).getByRole("button", { name: "Verificar" }));
    expect(await screen.findByText("Verificación completada. La fuente sigue en borrador.")).toBeInTheDocument();
    expect(verifyDraft).toHaveBeenCalledExactlyOnceWith("b-pa");
    expect(activateDraft).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Borrador")).toBeInTheDocument();
  });

  it("permite cancelar o confirmar explícitamente antes de activar y refresca el estado", async () => {
    const load = vi.fn<CatalogSourceLoader>().mockResolvedValueOnce({ items: sources }).mockResolvedValue({
      items: sources.map(item => item.id === "b-pa" ? { ...item, state: "active" } : item),
    });
    const verifyDraft = vi.fn<CatalogSourceVerifier>();
    const activateDraft = vi.fn<CatalogSourceActivator>().mockResolvedValue({ status: "activated" });
    renderSection({ canTest: true, canEdit: true, load, verifyDraft, activateDraft });
    fireEvent.click(await screen.findByRole("button", { name: "Activar" }));
    const confirmation = screen.getByRole("group", { name: "Confirmar activación de Empresa Panamá" });
    expect(activateDraft).toHaveBeenCalledTimes(0);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancelar" }));
    expect(activateDraft).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByRole("button", { name: "Activar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar activación" }));
    expect(await screen.findByText("Fuente activada.")).toBeInTheDocument();
    expect(activateDraft).toHaveBeenCalledExactlyOnceWith("b-pa");
    expect(verifyDraft).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Activar" })).toBeNull());
    expect(within(screen.getByRole("row", { name: /Empresa Panamá/ })).getByText("Activo")).toBeInTheDocument();
  });

  it("muestra un error controlado cuando falla una verificación y no inicia activación", async () => {
    const verifyDraft = vi.fn<CatalogSourceVerifier>().mockRejectedValue(new Error("detalle interno"));
    const activateDraft = vi.fn<CatalogSourceActivator>();
    renderSection({ canTest: true, canEdit: true, verifyDraft, activateDraft });
    fireEvent.click(within(await screen.findByRole("row", { name: /Empresa Panamá/ })).getByRole("button", { name: "Verificar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo verificar la fuente.");
    expect(screen.queryByText(/detalle interno/)).toBeNull();
    expect(activateDraft).toHaveBeenCalledTimes(0);
  });

  it("permite revalidar de forma explícita una fuente activa con perfil cambiado, pero no una retirada", async () => {
    const changed = { ...sources[0], canReadCurrentProfile: false };
    const retired = { ...sources[1], state: "retired" as const };
    const load = vi.fn<CatalogSourceLoader>().mockResolvedValueOnce({ items: [changed, retired] }).mockResolvedValue({
      items: [sources[0], retired],
    });
    const verifyDraft = vi.fn<CatalogSourceVerifier>();
    const activateDraft = vi.fn<CatalogSourceActivator>().mockResolvedValue({ status: "activated" });
    renderSection({ canTest: true, canEdit: true, load, verifyDraft, activateDraft });
    const changedRow = await screen.findByRole("row", { name: /Empresa Colombia/ });
    expect(within(changedRow).getByRole("button", { name: "Verificar" })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Empresa Panamá/ })).queryAllByRole("button")).toHaveLength(0);
    fireEvent.click(within(changedRow).getByRole("button", { name: "Revalidar fuente" }));
    expect(activateDraft).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar revalidación" }));
    expect(await screen.findByText("Fuente revalidada.")).toBeInTheDocument();
    expect(activateDraft).toHaveBeenCalledExactlyOnceWith("b-co");
    await waitFor(() => expect(within(changedRow).queryByRole("button", { name: "Revalidar fuente" })).toBeNull());
    expect(within(changedRow).getByRole("button", { name: "Verificar" })).toBeInTheDocument();
  });
});
