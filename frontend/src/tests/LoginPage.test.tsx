import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "../pages/LoginPage";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: null, iniciarSesionDev: vi.fn(), mensaje: undefined }),
}));

describe("LoginPage", () => {
  it("muestra el botón de Microsoft y el título minimalista", () => {
    render(<LoginPage />);
    expect(screen.getByText(/Programador de Actualizaciones/i)).toBeInTheDocument();
    expect(screen.getByText(/Iniciar sesión con Microsoft/i)).toBeInTheDocument();
  });

  it("no muestra checkboxes de roles en modo producción (VITE_DEV_MODE!='true')", () => {
    render(<LoginPage />);
    // Ningún rol debe aparecer como checkbox seleccionable
    expect(screen.queryByText(/Administrador de clientes/i)).toBeNull();
    expect(screen.queryByText(/Actualizador de bases de datos/i)).toBeNull();
  });

  it("muestra el subtítulo en español", () => {
    render(<LoginPage />);
    expect(screen.getByText(/cuenta corporativa de Microsoft/i)).toBeInTheDocument();
  });
});
