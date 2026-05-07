import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../api/client", () => ({
  api: { get: vi.fn(async () => []), post: vi.fn(async () => ({})) },
}));

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

describe("TareasPage (vista unificada)", () => {
  it("admin ve ambas columnas: dominios y bases de datos", () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    expect(screen.getByText(/Tareas de dominios/i)).toBeInTheDocument();
    expect(screen.getByText(/Tareas de bases de datos/i)).toBeInTheDocument();
  });

  it("actualizador de dominios solo ve la columna de dominios", () => {
    usuarioMock.roles = ["domain_updater"];
    renderPagina();
    expect(screen.getByText(/Tareas de dominios/i)).toBeInTheDocument();
    expect(screen.queryByText(/Tareas de bases de datos/i)).toBeNull();
  });

  it("actualizador de bases de datos solo ve la columna de bases de datos", () => {
    usuarioMock.roles = ["database_updater"];
    renderPagina();
    expect(screen.queryByText(/Tareas de dominios/i)).toBeNull();
    expect(screen.getByText(/Tareas de bases de datos/i)).toBeInTheDocument();
  });

  it("muestra el título 'Tareas' en el encabezado", () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    const heading = screen.getByRole("heading", { name: "Tareas" });
    expect(heading).toBeInTheDocument();
  });
});
