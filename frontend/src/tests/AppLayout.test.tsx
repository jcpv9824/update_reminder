import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AppLayout from "../components/AppLayout";

const authState = vi.hoisted(() => ({ roles: ["admin"] as string[] }));
const apiMock = vi.hoisted(() => ({
  get: vi.fn(async () => []),
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "user", email: "user@empresa.com", displayName: "Usuario", roles: authState.roles },
    cerrarSesion: vi.fn(),
  }),
}));

vi.mock("../api/client", () => ({ api: apiMock }));

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function expandModule(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Expandir ${name}` }));
}

describe("AppLayout", () => {
  beforeEach(() => {
    authState.roles = ["admin"];
    apiMock.get.mockReset();
    apiMock.get.mockResolvedValue([]);
  });

  it("muestra Programar Actualizaciones en el menu lateral", () => {
    renderLayout();
    expect(screen.getByText("Actualizaciones")).toBeInTheDocument();
    expandModule("Actualizaciones");
    expect(screen.getByRole("link", { name: "Programar Actualizaciones" })).toBeInTheDocument();
    expect(screen.queryByText("Frecuencias especiales")).toBeNull();
  });

  it("usa el icono blanco de SAG y no repite el logo en el pie de usuario", () => {
    renderLayout();
    expect(screen.getByAltText("SAG")).toHaveAttribute("src", "/brand/sag-white-icon.png");
    expect(screen.getByTestId("usuario-sidebar-icon")).toBeInTheDocument();
    expect(document.querySelector(".usuario-sidebar img")).toBeNull();
  });

  it("permite contraer y expandir modulos del menu lateral", () => {
    renderLayout();
    expect(screen.queryByRole("link", { name: "Licenciamiento" })).toBeNull();

    expandModule("Clientes");
    expect(screen.getByRole("link", { name: "Licenciamiento" })).toBeInTheDocument();
    const panel = document.getElementById("menu-modulo-clientes");
    expect(panel).toHaveClass("abierto");

    fireEvent.click(screen.getByRole("button", { name: "Contraer Clientes" }));
    expect(panel).toHaveClass("cerrado");
    expect(screen.queryByRole("link", { name: "Licenciamiento" })).toBeNull();
  });

  it("mantiene Tablero con su nombre actual", () => {
    renderLayout();
    expandModule("Auditoría y Visibilidad");
    expect(screen.getByRole("link", { name: "Tablero" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  it("ubica Descargas Públicas y Archivos Públicos como opciones separadas de Implementación", () => {
    renderLayout();
    expect(screen.getByText("Implementación")).toBeInTheDocument();
    expandModule("Implementación");
    expect(screen.getByRole("link", { name: "Descargas Públicas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Archivos Públicos" })).toBeInTheDocument();
    expect(screen.getByText("Configuración")).toBeInTheDocument();
    expandModule("Configuración");
    expect(screen.getByRole("link", { name: "Formatos de Impresión" })).toBeInTheDocument();
  });

  it("filtra opciones del menu lateral con el buscador", () => {
    renderLayout();
    fireEvent.change(screen.getByPlaceholderText("Buscar Opción"), { target: { value: "tablero" } });

    expect(screen.getByRole("link", { name: "Tablero" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Clientes" })).toBeNull();
  });

  it("muestra Licenciamiento para Administrador", () => {
    authState.roles = ["admin"];
    renderLayout();
    expandModule("Clientes");
    expect(screen.getByRole("link", { name: "Licenciamiento" })).toBeInTheDocument();
  });

  it("muestra opciones administrativas para Super Administrador", () => {
    authState.roles = ["super_admin"];
    renderLayout();
    expandModule("Clientes");
    expect(screen.getByRole("link", { name: "Licenciamiento" })).toBeInTheDocument();
    expandModule("Configuración");
    expect(screen.getByRole("link", { name: "Usuarios y Roles" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Formatos de Impresión" })).toBeInTheDocument();
  });

  it("oculta Licenciamiento para actualizadores", () => {
    authState.roles = ["domain_updater"];
    renderLayout();
    expect(screen.queryByRole("link", { name: "Licenciamiento" })).toBeNull();
    expandModule("Actualizaciones");
    expect(screen.getByRole("link", { name: "Tareas" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dominios" })).toBeNull();
  });
});
