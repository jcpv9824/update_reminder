import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(async () => []),
  post: vi.fn(async () => ({})),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

const usuarioMock = { id: "u", email: "u@x", displayName: "U", roles: ["admin"] as string[] };
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: usuarioMock, iniciarSesionDev: vi.fn(), cerrarSesion: vi.fn() }),
}));

import TareasPage from "../pages/TareasPage";

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TareasPage />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.get.mockClear();
  apiMock.post.mockReset();
  apiMock.post.mockResolvedValue({});
});

describe("TareasPage (vista unificada)", () => {
  it("admin ve ambas columnas y el botón Generar tareas ahora", () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    expect(screen.getByText(/Tareas de dominios/i)).toBeInTheDocument();
    expect(screen.getByText(/Tareas de bases de datos/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generar tareas ahora/i })).toBeInTheDocument();
  });

  it("client_manager ve el botón Generar tareas ahora", () => {
    usuarioMock.roles = ["client_manager"];
    renderPagina();
    expect(screen.getByRole("button", { name: /Generar tareas ahora/i })).toBeInTheDocument();
  });

  it("actualizador de dominios no ve el botón de generación manual", () => {
    usuarioMock.roles = ["domain_updater"];
    renderPagina();
    expect(screen.queryByRole("button", { name: /Generar tareas ahora/i })).toBeNull();
    expect(screen.getByText(/Tareas de dominios/i)).toBeInTheDocument();
    expect(screen.queryByText(/Tareas de bases de datos/i)).toBeNull();
  });

  it("actualizador de bases de datos no ve el botón de generación manual", () => {
    usuarioMock.roles = ["database_updater"];
    renderPagina();
    expect(screen.queryByRole("button", { name: /Generar tareas ahora/i })).toBeNull();
    expect(screen.queryByText(/Tareas de dominios/i)).toBeNull();
    expect(screen.getByText(/Tareas de bases de datos/i)).toBeInTheDocument();
  });

  it("visualizador no ve el botón de generación manual", () => {
    usuarioMock.roles = ["viewer"];
    renderPagina();
    expect(screen.queryByRole("button", { name: /Generar tareas ahora/i })).toBeNull();
  });

  it("el botón Generar tareas ahora llama /tasks/generate y muestra mensaje", async () => {
    usuarioMock.roles = ["admin"];
    apiMock.post.mockResolvedValueOnce({ created: 2, skipped: 1, message: "Tareas generadas correctamente." });
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: /Generar tareas ahora/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/tasks/generate", {}));
    expect(await screen.findByText(/Tareas generadas correctamente/i)).toBeInTheDocument();
  });

  it("muestra el título 'Tareas' en el encabezado", () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    const heading = screen.getByRole("heading", { name: "Tareas" });
    expect(heading).toBeInTheDocument();
  });
});
