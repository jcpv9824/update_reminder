import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UserBusinessAreasPanel from "../components/UserBusinessAreasPanel";

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get, put } }));

function mount(canEdit = true) {
  const saved = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>
    <UserBusinessAreasPanel actorScope="admin" userId="persona-1" canEdit={canEdit} onSaved={saved} />
  </QueryClientProvider>);
  return { saved, client, ...view };
}

beforeEach(() => {
  get.mockReset().mockResolvedValue({ areas: ["soporte"], etag: '"v1"' });
  put.mockReset().mockResolvedValue({ areas: ["desarrollo", "soporte"], etag: '"v2"' });
});

describe("áreas de negocio del usuario", () => {
  it("carga la clasificación y guarda una instantánea con la versión, sin cambiar roles", async () => {
    const { saved } = mount();
    const development = await screen.findByRole("checkbox", { name: "Desarrollo" });
    expect(screen.getByRole("checkbox", { name: "Soporte" })).toBeChecked();
    fireEvent.click(development);
    fireEvent.click(screen.getByRole("button", { name: "Guardar áreas" }));
    await waitFor(() => expect(put).toHaveBeenCalledExactlyOnceWith(
      "/whats-new/users/persona-1/business-areas", { areas: ["soporte", "desarrollo"] },
      { headers: { "If-Match": '"v1"' } },
    ));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });

  it("permite consultar sin permiso de edición y no ofrece guardar", async () => {
    mount(false);
    expect(await screen.findByRole("checkbox", { name: "Soporte" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar áreas" })).not.toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it("no muestra un formulario utilizable mientras carga", () => {
    get.mockImplementation(() => new Promise(() => {}));
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Consultando áreas");
    expect(screen.queryByRole("button", { name: "Guardar áreas" })).not.toBeInTheDocument();
  });

  it("no filtra errores internos ni deja guardar cuando falla la lectura", async () => {
    get.mockRejectedValue(new Error("SENTINELA_DATOS_INTERNOS"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron consultar las áreas");
    expect(screen.queryByText(/SENTINELA/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar áreas" })).not.toBeInTheDocument();
  });

  it("conserva la selección pero exige volver a consultar tras un conflicto", async () => {
    put.mockRejectedValue(Object.assign(new Error("SENTINELA_CONFLICTO"), { status: 409 }));
    const { saved } = mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Desarrollo" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar áreas" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Vuelve a consultar");
    expect(screen.getByRole("checkbox", { name: "Desarrollo" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Guardar áreas" })).toBeDisabled();
    expect(screen.queryByText(/SENTINELA/)).not.toBeInTheDocument();
    expect(saved).not.toHaveBeenCalled();
  });

  it("admite quitar todas las áreas sin modificar el estado del usuario", async () => {
    mount();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Soporte" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar áreas" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      "/whats-new/users/persona-1/business-areas", { areas: [] }, expect.any(Object),
    ));
  });

  it("no cierra otro diálogo al terminar un guardado después de desmontar", async () => {
    let finish!: (value: unknown) => void;
    put.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { saved, unmount } = mount();
    await screen.findByRole("checkbox", { name: "Soporte" });
    fireEvent.click(screen.getByRole("button", { name: "Guardar áreas" }));
    await waitFor(() => expect(put).toHaveBeenCalledOnce());
    unmount();
    await act(async () => { finish({ areas: ["soporte"], etag: '"v2"' }); });
    expect(saved).not.toHaveBeenCalled();
  });
});
