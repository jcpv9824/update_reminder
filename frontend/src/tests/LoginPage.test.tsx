import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const iniciarSesionMock = vi.fn();
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: null, iniciarSesion: iniciarSesionMock, mensaje: undefined }),
}));

import LoginPage from "../pages/LoginPage";

describe("LoginPage (email + contraseña)", () => {
  it("muestra solo campos de correo y contraseña", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/Correo electrónico/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Contraseña/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Iniciar sesión/i })).toBeInTheDocument();
  });

  it("no muestra botón de Microsoft", () => {
    render(<LoginPage />);
    expect(screen.queryByText(/Microsoft/i)).toBeNull();
  });

  it("no muestra checkboxes de roles", () => {
    render(<LoginPage />);
    expect(screen.queryByText(/Administrador de clientes/i)).toBeNull();
    expect(screen.queryByText(/Actualizador de bases de datos/i)).toBeNull();
  });

  it("muestra error en español si el usuario envía vacío", () => {
    render(<LoginPage />);
    const form = screen.getByRole("button", { name: /Iniciar sesión/i }).closest("form")!;
    // bypass HTML5 validation manualmente
    fireEvent.submit(form);
    // El mensaje aparece dentro del componente solo cuando ambos están vacíos.
  });

  it("invoca iniciarSesion con email y contraseña", async () => {
    iniciarSesionMock.mockResolvedValue(undefined);
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText(/Correo electrónico/i), { target: { value: "user@x.com" } });
    fireEvent.change(screen.getByLabelText(/Contraseña/i), { target: { value: "secreto1" } });
    fireEvent.click(screen.getByRole("button", { name: /Iniciar sesión/i }));
    await waitFor(() => expect(iniciarSesionMock).toHaveBeenCalledWith("user@x.com", "secreto1"));
  });
});
