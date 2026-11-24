import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/* La bandera de Novedades no altera las rutas existentes y el prototipo tiene un control separado. */

const session = vi.hoisted(() => ({ user: null as null | { id: string; displayName: string; roles: string[] } }));
vi.mock("../auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({ cargando: false, usuario: session.user, entrar: vi.fn(), cerrarSesion: vi.fn(), recargar: vi.fn() }),
}));
vi.mock("../api/client", () => ({ api: { get: vi.fn(async () => []), post: vi.fn(), getText: vi.fn(async () => "<h1>Reporte histórico</h1>") }, apiUrl: (p: string) => `/api${p}` }));

async function cargar(encendida: boolean) {
  vi.stubEnv("VITE_WHATS_NEW_ENABLED", String(encendida));
  vi.resetModules();
  vi.doMock("../featureFlags", () => ({ GUIDE_BUILDER_UI_ENABLED: true, WHATS_NEW_ENABLED: encendida, WHATS_NEW_PROTOTYPE_ENABLED: false }));
  const { MODULOS } = await import("../menu");
  const { default: App } = await import("../App");
  return { MODULOS, App };
}

function renderApp(App: () => JSX.Element, ruta: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rutasDeMenu = (modulos: { elementos: { ruta: string }[] }[]) => modulos.flatMap((m) => m.elementos.map((e) => e.ruta));

describe("Qué hay de nuevo · bandera del módulo", () => {
  afterEach(() => {
    cleanup();
    session.user = null;
    vi.doUnmock("../featureFlags");
    vi.unstubAllEnvs();
  });

  it("apagada: no hay opciones de menú ni página /novedades", { timeout: 30000 }, async () => {
    const { MODULOS, App } = await cargar(false);
    expect(rutasDeMenu(MODULOS)).not.toContain("/actualizaciones/que-hay-de-nuevo");
    expect(rutasDeMenu(MODULOS)).not.toContain("/configuracion/que-hay-de-nuevo");
    expect(rutasDeMenu(MODULOS)).toEqual(expect.arrayContaining([
      "/clientes", "/dominios", "/bases-de-datos", "/licenciamiento", "/admin/formatos-impresion", "/ayudas/constructor-guias",
    ]));
    renderApp(App, "/novedades");
    expect(screen.queryByRole("heading", { name: "Novedades de SAG Web" })).toBeNull();
  });

  it("encendida: aparecen las opciones en Actualizaciones y Configuración, y /novedades abre sin sesión", { timeout: 30000 }, async () => {
    const { MODULOS, App } = await cargar(true);
    const actualizaciones = MODULOS.find((m) => m.etiqueta === "Actualizaciones")!;
    expect(actualizaciones.elementos.find((e) => e.ruta === "/actualizaciones/que-hay-de-nuevo")).toMatchObject({ etiqueta: "Qué hay de nuevo", permiso: "updates.whats_new.view" });
    expect(rutasDeMenu(MODULOS)).toContain("/configuracion/que-hay-de-nuevo");
    expect(rutasDeMenu(MODULOS)).not.toContain("/novedades");
    renderApp(App, "/novedades");
    expect(await screen.findByRole("heading", { name: "Novedades de SAG Web" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Navegación principal" })).toBeNull();
  });
  it("un usuario activo de Ventas sin permiso de la opción abre directamente un reporte", { timeout: 30000 }, async () => {
    session.user = { id: "ventas", displayName: "Ventas", roles: ["sales"] };
    const { App } = await cargar(true);
    renderApp(App, "/actualizaciones/que-hay-de-nuevo/reportes/abc");
    expect(await screen.findByTitle("Reporte completo", {}, { timeout: 10000 })).toHaveAttribute("sandbox", "");
    expect(screen.queryByText("No tienes un área habilitada para esta opción")).toBeNull();
  });
  it("prototipo apagado aunque producción esté encendida: no ofrece bypass de sesión", { timeout: 30000 }, async () => {
    const { App } = await cargar(true);
    renderApp(App, "/__dev/que-hay-de-nuevo");
    expect(screen.queryByLabelText("Usuario simulado")).toBeNull();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });
});
