import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AppLayout from "../components/AppLayout";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "admin", email: "admin@empresa.com", displayName: "Admin", roles: ["admin"] },
    cerrarSesion: vi.fn(),
  }),
}));

describe("AppLayout", () => {
  it("muestra Programaciones especiales en el menu lateral", () => {
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "Programaciones especiales" })).toBeInTheDocument();
    expect(screen.queryByText("Frecuencias especiales")).toBeNull();
  });
});
