import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConexionesCatalogoSources, {
  type CatalogSourceLoader,
  type CatalogSourceDraftBinder,
  type CatalogSourceItem,
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

function renderSection(args: { canEdit?: boolean; load?: CatalogSourceLoader; bindDraft?: CatalogSourceDraftBinder } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const load = args.load ?? vi.fn<CatalogSourceLoader>().mockResolvedValue({ items: sources });
  return render(
    <QueryClientProvider client={client}>
      <ConexionesCatalogoSources scopeKey="alcance-de-prueba" profiles={profiles} load={load}
        canEdit={args.canEdit ?? false} bindDraft={args.bindDraft} />
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
});
