import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const entrarMock = vi.fn();
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: null, entrar: entrarMock, mensaje: undefined }),
}));

import LoginPage from "../pages/LoginPage";

function renderPage() { return render(<MemoryRouter><LoginPage /></MemoryRouter>); }
function credentials() {
  fireEvent.change(screen.getByLabelText(/Correo electrónico/i), { target: { value: "user@x.com" } });
  fireEvent.change(screen.getByLabelText(/^Contraseña$/i), { target: { value: "Temporal muy segura 2026" } });
  fireEvent.click(screen.getByRole("button", { name: /^Entrar$/i }));
}

describe("LoginPage seguro", () => {
  beforeEach(() => entrarMock.mockReset());

  it("inicia con correo y contraseña y no muestra login Microsoft", async () => {
    entrarMock.mockResolvedValue({ authenticated: true });
    renderPage();
    expect(screen.getByAltText("SAG")).toHaveAttribute("src", "/brand/sag-white-icon.png");
    expect(screen.getByText("PORTAL")).toBeInTheDocument();
    expect(screen.getByText("SAG WEB")).toBeInTheDocument();
    credentials();
    await waitFor(() => expect(entrarMock).toHaveBeenCalledWith("user@x.com", "Temporal muy segura 2026", {}));
    expect(screen.queryByText(/Microsoft/i)).toBeNull();
    expect(screen.queryByText(/MFA|autenticador|código de recuperación/i)).toBeNull();
  });

  it("solicita cambio obligatorio y valida mínimo 14", async () => {
    entrarMock.mockResolvedValueOnce({ passwordChangeRequired: true });
    renderPage(); credentials();
    expect(await screen.findByText(/Debe cambiar la contraseña temporal/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Nueva contraseña$/i), { target: { value: "corta" } });
    fireEvent.change(screen.getByLabelText(/Confirmar nueva/i), { target: { value: "corta" } });
    fireEvent.click(screen.getByRole("button", { name: /Cambiar contraseña/i }));
    expect(await screen.findByText("La nueva contraseña debe tener al menos 14 caracteres.")).toBeInTheDocument();
  });

  it("envía la nueva contraseña y vuelve al login tras el cambio", async () => {
    entrarMock.mockResolvedValueOnce({ passwordChangeRequired: true }).mockResolvedValueOnce({ passwordChanged: true, message: "Contraseña actualizada." });
    renderPage(); credentials();
    const strong = "Una frase realmente segura 2026";
    fireEvent.change(await screen.findByLabelText(/^Nueva contraseña$/i), { target: { value: strong } });
    fireEvent.change(screen.getByLabelText(/Confirmar nueva/i), { target: { value: strong } });
    fireEvent.click(screen.getByRole("button", { name: /Cambiar contraseña/i }));
    await waitFor(() => expect(entrarMock).toHaveBeenLastCalledWith("user@x.com", "Temporal muy segura 2026", { newPassword: strong }));
    expect(await screen.findByText(/Contraseña actualizada/i)).toBeInTheDocument();
  });

});
