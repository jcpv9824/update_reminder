import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Tarea } from "../types";

const apiMock = vi.hoisted(() => ({
  get: vi.fn<[string?], Promise<any[]>>(async (_path?: string) => []),
  post: vi.fn<[string, any?], Promise<any>>(async () => ({})),
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
  apiMock.get.mockResolvedValue([]);
  apiMock.post.mockReset();
  apiMock.post.mockResolvedValue({});
});

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function tarea(overrides: Partial<Tarea>): Tarea {
  return {
    id: "task_1",
    taskDate: hoyIso(),
    taskBucket: `${hoyIso()}_domain`,
    clientId: "client_1",
    clientName: "Cliente Uno",
    domainId: "domain_1",
    domainName: "https://cliente1.example.com",
    targetType: "domain",
    targetId: "domain_1",
    targetName: "https://cliente1.example.com",
    scheduleId: "schedule_1",
    assignedRole: "domain_updater",
    assignedUserIds: ["u"],
    status: "pending",
    result: null,
    notes: "",
    createdAt: "",
    updatedAt: "",
    completedAt: null,
    completedBy: null,
    ...overrides,
  };
}

function mockTareas({ dominios = [], bases = [] }: { dominios?: Tarea[]; bases?: Tarea[] }) {
  apiMock.get.mockImplementation((path = "") => {
    if (path.includes("targetType=domain")) return Promise.resolve(dominios);
    if (path.includes("targetType=database")) return Promise.resolve(bases);
    return Promise.resolve([]);
  });
}

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

  it("consulta tareas dentro de la ventana predeterminada de siete días", async () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(/\/tasks\?targetType=domain&dateFrom=\d{4}-\d{2}-\d{2}&dateTo=\d{4}-\d{2}-\d{2}/)));
    expect(screen.getByText(/Mostrando grupos de trabajo desde/i)).toBeInTheDocument();
  });

  it("muestra el título 'Tareas' en el encabezado", () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    const heading = screen.getByRole("heading", { name: "Tareas" });
    expect(heading).toBeInTheDocument();
  });

  it("agrupa tareas por fecha, responsable y tipo sin saturar con registros individuales", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({
      dominios: [
        tarea({ id: "d1", domainName: "dominio-uno.example.com", targetName: "dominio-uno.example.com", status: "completed" }),
        tarea({ id: "d2", domainName: "dominio-dos.example.com", targetName: "dominio-dos.example.com" }),
      ],
      bases: [
        tarea({ id: "b1", targetType: "database", assignedRole: "database_updater", targetName: "BD_UNO", domainName: "dominio-uno.example.com", status: "completed" }),
        tarea({ id: "b2", targetType: "database", assignedRole: "database_updater", targetName: "BD_DOS", domainName: "dominio-dos.example.com" }),
      ],
    });
    renderPagina();
    expect(await screen.findByText(/Tú — Dominios por actualizar/i)).toBeInTheDocument();
    expect(await screen.findByText(/Total: 2 dominios/i)).toBeInTheDocument();
    expect((await screen.findAllByText(/Completadas: 1 \/ 2/i)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Tú — Bases de datos por actualizar/i)).toBeInTheDocument();
    expect(await screen.findByText(/Total: 2 bases de datos/i)).toBeInTheDocument();
    expect(screen.queryByText(/dominio-dos.example.com/i)).toBeNull();
    expect(screen.queryByText(/BD_DOS/i)).toBeNull();
  });

  it("al abrir detalle muestra tareas individuales y acciones de copiado", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d1" }), tarea({ id: "d2", domainName: "https://cliente2.example.com", targetName: "https://cliente2.example.com" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText("https://cliente1.example.com")).toBeInTheDocument();
    expect(screen.getByText("https://cliente2.example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copiar todos los dominios pendientes/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Copiar dominio/i }).length).toBeGreaterThan(0);
  });

  it("al completar una tarea llama inmediatamente el endpoint y actualiza contador del grupo", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    vi.spyOn(window, "prompt").mockReturnValue("");
    mockTareas({ dominios: [tarea({ id: "d1" }), tarea({ id: "d2" })] });
    renderPagina();
    expect(await screen.findByText(/Completadas: 0 \/ 2/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ver detalle/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /Completar/i }))[0]);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/tasks/d1/complete", { notes: "", result: "success" }));
    expect((await screen.findAllByText(/Guardado/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Completadas: 1 \/ 2/i)).length).toBeGreaterThan(0);
  });

  it("si el guardado falla muestra error y permite reintentar", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    vi.spyOn(window, "prompt").mockReturnValue("");
    apiMock.post.mockRejectedValueOnce(new Error("Fallo de red")).mockResolvedValueOnce({});
    mockTareas({ dominios: [tarea({ id: "d1" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /Completar/i }))[0]);
    expect(await screen.findByText(/Fallo de red/i)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Reintentar/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(2));
  });

  it("un usuario sin permiso no puede cambiar tareas de otro responsable", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["domain_updater"];
    mockTareas({ dominios: [tarea({ id: "d1", assignedUserIds: ["otro_usuario"] })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText(/Sin permiso/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Completar/i })).toBeNull();
  });
});
