import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AppLayout from "../components/AppLayout";

const authState = vi.hoisted(() => ({ roles: ["admin"] as string[] }));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "user", email: "user@empresa.com", displayName: "Usuario", roles: authState.roles },
    cerrarSesion: vi.fn(),
  }),
}));

function renderLayout() {
  return render(
    <MemoryRouter>
      <AppLayout />
    </MemoryRouter>
  );
}

describe("AppLayout", () => {
  beforeEach(() => {
    authState.roles = ["admin"];
  });

  it("muestra Programaciones especiales en el menu lateral", () => {
    renderLayout();
    expect(screen.getByRole("link", { name: "Programaciones especiales" })).toBeInTheDocument();
    expect(screen.queryByText("Frecuencias especiales")).toBeNull();
  });

  it("muestra Licenciamiento para Administrador", () => {
    authState.roles = ["admin"];
    renderLayout();
    expect(screen.getByRole("link", { name: "Licenciamiento" })).toBeInTheDocument();
  });

  it("muestra Licenciamiento para Administrador de clientes", () => {
    authState.roles = ["client_manager"];
    renderLayout();
    expect(screen.getByRole("link", { name: "Licenciamiento" })).toBeInTheDocument();
  });

  it("oculta Licenciamiento para actualizadores y visualizadores", () => {
    authState.roles = ["domain_updater"];
    const { rerender } = render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>
    );
    expect(screen.queryByRole("link", { name: "Licenciamiento" })).toBeNull();

    authState.roles = ["viewer"];
    rerender(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>
    );
    expect(screen.queryByRole("link", { name: "Licenciamiento" })).toBeNull();
  });
});
