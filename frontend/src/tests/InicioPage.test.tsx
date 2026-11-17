import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import InicioPage from "../pages/InicioPage";
import { opcionesPermitidas, rutaInicial } from "../menu";
import type { RoleDefinition } from "../permissionModel";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
const authState = vi.hoisted(() => ({ roles: ["implementador"] as string[] }));

vi.mock("../api/client", () => ({ api: apiMock }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "u1", email: "u@example.com", displayName: "U", roles: authState.roles },
  }),
}));

function role(id: string, permissions: string[]): RoleDefinition {
  return { id, label: id, description: "", permissions, system: false } as unknown as RoleDefinition;
}

function renderAt() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<InicioPage />} />
          <Route path="/tareas" element={<p>Pantalla de tareas</p>} />
          <Route path="/implementacion/logo-compania" element={<p>Pantalla del logo</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("start page by permissions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens Tasks when the person has access to it", async () => {
    authState.roles = ["r"];
    apiMock.get.mockResolvedValue([role("r", ["updates.tasks.view", "clients.clients.view"])]);
    renderAt();
    expect(await screen.findByText("Pantalla de tareas")).toBeInTheDocument();
  });

  it("opens the only assigned option directly", async () => {
    authState.roles = ["implementador"];
    apiMock.get.mockResolvedValue([role("implementador", ["implementation.company_logo.view", "implementation.company_logo.upload"])]);
    renderAt();
    expect(await screen.findByText("Pantalla del logo")).toBeInTheDocument();
  });

  it("shows the welcome with the portal brand when there are several options and no Tasks", async () => {
    authState.roles = ["r"];
    apiMock.get.mockResolvedValue([role("r", ["implementation.company_logo.view", "clients.clients.view"])]);
    renderAt();
    expect(await screen.findByRole("heading", { name: "Bienvenido al Portal SAG Web" })).toBeInTheDocument();
    expect(screen.getByAltText("SAG")).toBeInTheDocument();
    expect(screen.getByLabelText("PORTAL SAG WEB")).toBeInTheDocument();
  });

  it("computes the allowed options in menu order", () => {
    const definitions = [role("r", ["clients.domains.view", "implementation.company_logo.view"])];
    expect(opcionesPermitidas(["r"], definitions).map((opcion) => opcion.ruta)).toEqual(["/dominios", "/implementacion/logo-compania"]);
    expect(rutaInicial([])).toBeNull();
  });
});
