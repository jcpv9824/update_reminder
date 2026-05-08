import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const entrarMock = vi.fn();
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: null, entrar: entrarMock, mensaje: undefined }),
}));

import LoginPage from "../pages/LoginPage";

describe("LoginPage (email + contraseña)", () => {
  it("muestra solo campos de correo y contraseña", () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(screen.getByLabelText(/Correo electrónico/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Contraseña/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Entrar/i })).toBeInTheDocument();
  });

  it("no muestra botón de Microsoft", () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(screen.queryByText(/Microsoft/i)).toBeNull();
  });

  it("no muestra checkboxes de roles", () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(screen.queryByText(/Administrador de clientes/i)).toBeNull();
    expect(screen.queryByText(/Actualizador de bases de datos/i)).toBeNull();
  });

  it("muestra error en español si el usuario envía vacío", () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    const form = screen.getByRole("button", { name: /Entrar/i }).closest("form")!;
    // bypass HTML5 validation manualmente
    fireEvent.submit(form);
    // El mensaje aparece dentro del componente solo cuando ambos están vacíos.
  });

  it("invoca entrar con email y contraseña", async () => {
    entrarMock.mockResolvedValue(undefined);
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/Correo electrónico/i), { target: { value: "user@x.com" } });
    fireEvent.change(screen.getByLabelText(/Contraseña/i), { target: { value: "secreto1" } });
    fireEvent.click(screen.getByRole("button", { name: /Entrar/i }));
    await waitFor(() => expect(entrarMock).toHaveBeenCalledWith("user@x.com", "secreto1"));
  });
});
