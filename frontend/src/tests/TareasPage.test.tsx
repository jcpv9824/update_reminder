import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BaseDeDatos, Tarea } from "../types";
import type { RoleDefinition } from "../permissionModel";
import { hoyEnBogotaIso, sumarDiasIso } from "../utils/fechas";

const apiMock = vi.hoisted(() => ({
  get: vi.fn<(path?: string) => Promise<any>>(async (_path?: string) => []),
  post: vi.fn<(path: string, body?: any) => Promise<any>>(async () => ({})),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

const usuarioMock = { id: "u", email: "u@x", displayName: "U", roles: ["admin"] as string[] };
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ cargando: false, usuario: usuarioMock, iniciarSesionDev: vi.fn(), cerrarSesion: vi.fn() }),
}));

import TareasPage from "../pages/TareasPage";

type BaseDetallePrueba = Omit<BaseDeDatos, "dbAccess"> & {
  dbAccess: {
    initialCatalog: string;
    serverHostPort: string;
    userId: string;
    passwordSecretName?: string;
  };
};

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
  return hoyEnBogotaIso();
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

function bd(id: string, overrides: Partial<BaseDetallePrueba> = {}): BaseDetallePrueba {
  return {
    id,
    clientId: "client_1",
    clientName: "Cliente Uno",
    domainId: "domain_1",
    domainName: "https://cliente1.example.com",
    companyName: "Empresa",
    environment: "production",
    dbAccess: {
      serverHostPort: "data-ims.imsampedro.cloud,54101",
      initialCatalog: "SAMPEDRO",
      userId: "IMSAMPEDRO-IMS01-API",
      passwordSecretName: "secret-no-visible",
    },
    assignedUpdaterIds: ["u"],
    status: "active",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function mockTareas({
  dominios = [],
  bases = [],
  basesDetalle = [],
  usuarios = [],
  roles = [],
}: {
  dominios?: Tarea[];
  bases?: Tarea[];
  basesDetalle?: BaseDetallePrueba[];
  usuarios?: any[];
  roles?: RoleDefinition[];
}) {
  apiMock.get.mockImplementation((path = "") => {
    if (path === "/roles") return Promise.resolve(roles);
    if (path === "/users") return Promise.resolve(usuarios);
    if (path === "/schedules") return Promise.resolve([{ id: "schedule_1", name: "Actualización mensual" }]);
    if (path.includes("targetType=domain")) return Promise.resolve(dominios);
    if (path.includes("targetType=database")) return Promise.resolve(bases);
    if (path.includes("/access-info")) {
      const id = path.split("/databases/")[1]?.split("/")[0] ?? "db_1";
      const item = basesDetalle.find((b) => b.id === id) ?? bd(id);
      return Promise.resolve({
        server: item.dbAccess.serverHostPort,
        databaseName: item.dbAccess.initialCatalog,
        user: item.dbAccess.userId,
        hasPassword: true,
      });
    }
    if (path.startsWith("/databases/")) {
      const id = path.split("/").at(-1);
      return Promise.resolve(basesDetalle.find((b) => b.id === id) ?? bd(id ?? "db_1"));
    }
    return Promise.resolve([]);
  });
}

describe("TareasPage (vista unificada)", () => {
  it("admin ve ambas columnas sin botón Refrescar", () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    expect(screen.getByText(/Tareas de dominios/i)).toBeInTheDocument();
    expect(screen.getByText(/Tareas de bases de datos/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refrescar/i })).toBeNull();
  });

  it("actualizador de dominios no ve el botón de generación manual", () => {
    usuarioMock.roles = ["domain_updater"];
    renderPagina();
    expect(screen.queryByRole("button", { name: /Refrescar/i })).toBeNull();
    expect(screen.getByText(/Tareas de dominios/i)).toBeInTheDocument();
    expect(screen.queryByText(/Tareas de bases de datos/i)).toBeNull();
  });

  it("actualizador de bases de datos no ve el botón de generación manual", () => {
    usuarioMock.roles = ["database_updater"];
    renderPagina();
    expect(screen.queryByRole("button", { name: /Refrescar/i })).toBeNull();
    expect(screen.queryByText(/Tareas de dominios/i)).toBeNull();
    expect(screen.getByText(/Tareas de bases de datos/i)).toBeInTheDocument();
  });

  it("usa permisos y visibilidad de tareas de roles personalizados para mostrar columnas", async () => {
    usuarioMock.roles = ["custom_database_worker"];
    mockTareas({
      roles: [{
        id: "custom_database_worker",
        name: "Operador de Bases",
        permissions: ["updates.tasks.view", "updates.tasks.complete"],
        taskVisibility: { domain: "none", database: "assigned" },
        system: false,
        active: true,
      }],
    });
    renderPagina();
    expect(screen.queryByText(/Tareas de dominios/i)).toBeNull();
    expect(await screen.findByText(/Tareas de bases de datos/i)).toBeInTheDocument();
  });

  it("respeta permisos granulares de acción en tareas para roles personalizados", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["custom_database_worker"];
    mockTareas({
      roles: [{
        id: "custom_database_worker",
        name: "Operador de Bases",
        permissions: ["updates.tasks.view", "updates.tasks.complete", "updates.tasks.reveal_database_password"],
        taskVisibility: { domain: "none", database: "assigned" },
        system: false,
        active: true,
      }],
      bases: [tarea({
        id: "b_custom",
        targetType: "database",
        targetId: "db_custom",
        targetName: "BD_CUSTOM",
        assignedRole: "custom_database_worker",
        assignedUserIds: [],
      })],
      basesDetalle: [bd("db_custom")],
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    const accionesFila = within(screen.getByTestId("acciones-tarea-b_custom"));
    expect(accionesFila.getByRole("button", { name: /^Completar$/i })).toBeInTheDocument();
    expect(accionesFila.queryByRole("button", { name: /^Bloquear$/i })).toBeNull();
    expect(await screen.findByRole("button", { name: /^Ver$/i })).toBeInTheDocument();
  });

  it("oculta columnas cuando el rol puede abrir tareas pero no tiene visibilidad de registros", () => {
    usuarioMock.roles = ["task_page_only"];
    mockTareas({
      roles: [{
        id: "task_page_only",
        name: "Solo Página de Tareas",
        permissions: ["updates.tasks.view"],
        taskVisibility: { domain: "none", database: "none" },
        system: false,
        active: true,
      }],
    });
    renderPagina();
    expect(screen.queryByText(/Tareas de dominios/i)).toBeNull();
    expect(screen.queryByText(/Tareas de bases de datos/i)).toBeNull();
    expect(screen.getByText(/No tienes tareas asignadas/i)).toBeInTheDocument();
  });

  it("muestra tareas futuras ya generadas en Próximas", async () => {
    usuarioMock.roles = ["admin"];
    const mananaIso = sumarDiasIso(hoyIso(), 1);
    apiMock.get.mockImplementation((path = "") => {
      if (path === "/users") return Promise.resolve([]);
      if (path === "/schedules") return Promise.resolve([{ id: "schedule_1", name: "Actualización puntual" }]);
      if (path.includes("targetType=domain")) return Promise.resolve([tarea({ id: "d_futura", taskDate: mananaIso, taskBucket: `${mananaIso}_domain` })]);
      if (path.includes("targetType=database")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPagina();
    await waitFor(() => {
      const proximasHeaders = screen.getAllByText(/^Próximas/i);
      expect(proximasHeaders.some((h) => /\(1\)/.test(h.parentElement?.textContent ?? ""))).toBe(true);
    });
    expect(screen.getByText(/Actualización: Actualización puntual/i)).toBeInTheDocument();
  });

  it("consulta tareas hasta próximas 4 días y muestra texto de vista operativa", async () => {
    usuarioMock.roles = ["admin"];
    renderPagina();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(/\/tasks\?targetType=domain&dateTo=\d{4}-\d{2}-\d{2}/)));
    expect(apiMock.get).not.toHaveBeenCalledWith(expect.stringContaining("dateFrom="));
    expect(screen.getByText(/Vista operativa: vencidas abiertas, hoy, próximas 4 días y completadas recientes/i)).toBeInTheDocument();
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
    expect(await screen.findByText(/U — Dominios por actualizar/i)).toBeInTheDocument();
    expect(await screen.findByText(/Total: 2 dominios/i)).toBeInTheDocument();
    expect((await screen.findAllByText(/Completadas: 1 \/ 2/i)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/U — Bases de datos por actualizar/i)).toBeInTheDocument();
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
    expect(screen.getAllByRole("button", { name: /Copiar dominio para publicar/i }).length).toBeGreaterThan(0);
  });

  it("al completar una tarea abre modal de confirmación y llama endpoint con withProblems=false", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d1" }), tarea({ id: "d2" })] });
    renderPagina();
    expect(await screen.findByText(/Completadas: 0 \/ 2/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ver detalle/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^Completar$/i }))[0]);
    // Aparece el modal de confirmación.
    expect(await screen.findByRole("heading", { name: /Confirmar actualización/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar actualización/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/tasks/d1/complete", expect.objectContaining({ withProblems: false })));
    expect((await screen.findAllByText(/Completadas: 1 \/ 2/i)).length).toBeGreaterThan(0);
  });

  it("completar marcando 'tuve problemas' envía withProblems=true con problemNote", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d1" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^Completar$/i }))[0]);
    // Marcar el checkbox de problema.
    const checkbox = await screen.findByLabelText(/¿Tuviste algún problema/i);
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText(/Describe el problema/i), { target: { value: "DNS no resolvía" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmar actualización/i }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/tasks/d1/complete", expect.objectContaining({ withProblems: true, problemNote: "DNS no resolvía" }))
    );
  });

  it("muestra el botón Bloquear en el detalle del grupo", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d1" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(screen.queryByRole("button", { name: /^Iniciar$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^Completar$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Bloquear$/i })).toBeInTheDocument();
  });

  it("tarea en progreso no muestra Iniciar y conserva Completar/Bloquear", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d_en_progreso", status: "in_progress" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(screen.queryByRole("button", { name: /^Iniciar$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^Completar$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Bloquear$/i })).toBeInTheDocument();
  });

  it("tarea completada muestra Reabrir y usa modal sin prompt del navegador", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => "no usar");
    const hoy = hoyIso();
    mockTareas({ dominios: [tarea({ id: "d_done", status: "completed", taskDate: hoy, taskBucket: `${hoy}_domain`, completedAt: `${hoy}T10:00:00Z`, completedBy: "u" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(screen.queryByRole("button", { name: /^Iniciar$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Completar$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Bloquear$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Reabrir$/i }));
    expect(await screen.findByRole("heading", { name: /Reabrir tarea completada/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Motivo de reapertura/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reabrir tarea/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/tasks/d_done/reopen", { reopenReason: undefined }));
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("tarea bloqueada muestra Resolver bloqueo, no Reabrir, y permite comentario vacío", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d_blocked", status: "blocked", blockReason: "Error" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(screen.getByRole("button", { name: /^Completar$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resolver bloqueo/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Iniciar$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reabrir$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Resolver bloqueo/i }));
    expect(await screen.findByRole("heading", { name: /Resolver bloqueo/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Nuevo estado/i), { target: { value: "in_progress" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar resolución/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/tasks/d_blocked/resolve-block", { resolutionComment: undefined, newStatus: "in_progress" }));
  });

  it("tarea bloqueada puede completarse con modal de cierre", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d_blocked_done", status: "blocked", blockReason: "Error corregido" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Completar$/i }));
    expect(await screen.findByRole("heading", { name: /Completar tarea bloqueada/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Comentario de cierre/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/¿Tuviste algún problema/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Comentario de cierre/i), { target: { value: "Se corrigió y se actualizó correctamente." } });
    fireEvent.click(screen.getByRole("button", { name: /Marcar como completada/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/tasks/d_blocked_done/complete", expect.objectContaining({
      withProblems: false,
      completionNote: "Se corrigió y se actualizó correctamente.",
      notes: "Se corrigió y se actualizó correctamente.",
      result: "success",
    })));
  });

  it("si el guardado falla muestra error y permite reintentar", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    apiMock.post.mockRejectedValueOnce(new Error("Fallo de red")).mockResolvedValueOnce({});
    mockTareas({ dominios: [tarea({ id: "d1" })] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^Completar$/i }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: /Confirmar actualización/i }));
    expect(await screen.findByText(/Fallo de red/i)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Reintentar/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(2));
  });

  it("una tarea de mañana aparece en PRÓXIMAS, no en HOY", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const { hoyEnBogotaIso, sumarDiasIso } = await import("../utils/fechas");
    const manana = sumarDiasIso(hoyEnBogotaIso(), 1);
    mockTareas({ dominios: [tarea({ id: "d_manana", taskDate: manana, taskBucket: `${manana}_domain` })] });
    renderPagina();
    // Buscamos los headers de sección "Próximas" y "Hoy" dentro de la columna de dominios.
    await waitFor(() => {
      const proximasHeaders = screen.getAllByText(/^Próximas/i);
      // Al menos una sección "Próximas" debe contener (1).
      expect(proximasHeaders.some((h) => /\(1\)/.test(h.parentElement?.textContent ?? ""))).toBe(true);
    });
    // Y ninguna "Hoy" debe contener (1).
    const hoyHeaders = screen.getAllByText(/^Hoy/i);
    expect(hoyHeaders.every((h) => !/\(1\)/.test(h.parentElement?.textContent ?? ""))).toBe(true);
  });

  it("aplica ventana operativa: vencidas abiertas, hoy, próximas 4 días y completadas recientes", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const { hoyEnBogotaIso, sumarDiasIso } = await import("../utils/fechas");
    const hoy = hoyEnBogotaIso();
    const vieja = sumarDiasIso(hoy, -20);
    const manana = sumarDiasIso(hoy, 1);
    const enCuatro = sumarDiasIso(hoy, 4);
    const enCinco = sumarDiasIso(hoy, 5);
    const haceCuatro = sumarDiasIso(hoy, -4);
    const haceCinco = sumarDiasIso(hoy, -5);
    mockTareas({
      dominios: [
        tarea({ id: "vencida_pendiente", taskDate: vieja, taskBucket: `${vieja}_domain`, status: "pending" }),
        tarea({ id: "vencida_bloqueada", taskDate: vieja, taskBucket: `${vieja}_domain`, status: "blocked" }),
        tarea({ id: "vencida_completada", taskDate: vieja, taskBucket: `${vieja}_domain`, status: "completed", completedAt: `${vieja}T10:00:00.000Z`, assignedUserIds: ["cerrador"] }),
        tarea({ id: "hoy", taskDate: hoy, taskBucket: `${hoy}_domain`, status: "pending" }),
        tarea({ id: "manana", taskDate: manana, taskBucket: `${manana}_domain`, status: "pending" }),
        tarea({ id: "en_cuatro", taskDate: enCuatro, taskBucket: `${enCuatro}_domain`, status: "pending" }),
        tarea({ id: "en_cinco", taskDate: enCinco, taskBucket: `${enCinco}_domain`, status: "pending" }),
        tarea({ id: "completada_hoy", taskDate: hoy, taskBucket: `${hoy}_domain`, status: "completed", completedAt: `${hoy}T10:00:00.000Z`, assignedUserIds: ["cerrador"] }),
        tarea({ id: "completada_hace_cuatro", taskDate: haceCuatro, taskBucket: `${haceCuatro}_domain`, status: "completed", completedAt: `${haceCuatro}T10:00:00.000Z`, assignedUserIds: ["cerrador"] }),
        tarea({ id: "completada_hace_cinco", taskDate: haceCinco, taskBucket: `${haceCinco}_domain`, status: "completed", completedAt: `${haceCinco}T10:00:00.000Z`, assignedUserIds: ["cerrador"] }),
      ],
    });
    renderPagina();
    expect(await screen.findByText((_content, node) => node?.textContent === "Vencidas (1)")).toBeInTheDocument();
    expect(screen.getByText((_content, node) => node?.textContent === "Hoy (1)")).toBeInTheDocument();
    expect(screen.getByText((_content, node) => node?.textContent === "Próximas (2)")).toBeInTheDocument();
    expect(screen.getByText((_content, node) => node?.textContent === "Completadas (2)")).toBeInTheDocument();
  });

  it("la ventana operativa también mantiene bases vencidas antiguas abiertas", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const { hoyEnBogotaIso, sumarDiasIso } = await import("../utils/fechas");
    const vieja = sumarDiasIso(hoyEnBogotaIso(), -30);
    mockTareas({
      bases: [
        tarea({ id: "base_vencida", taskDate: vieja, taskBucket: `${vieja}_database`, targetType: "database", targetId: "db_old", targetName: "BD_OLD", assignedRole: "database_updater", status: "in_progress" }),
      ],
      basesDetalle: [bd("db_old", { dbAccess: { ...bd("db_old").dbAccess, initialCatalog: "BD_OLD" } })],
    });
    renderPagina();
    expect(await screen.findByText(/U — Bases de datos por actualizar/i)).toBeInTheDocument();
    expect(screen.getAllByText((_content, node) => node?.textContent === "Vencidas (1)").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText("BD_OLD")).toBeInTheDocument();
  });

  it("resalta el grupo asignado al usuario actual con el badge 'Asignado a ti'", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({ dominios: [tarea({ id: "d1", assignedUserIds: ["u"] })] });
    renderPagina();
    expect(await screen.findByText(/Asignado a ti/i)).toBeInTheDocument();
  });

  it("detalle de dominio usa modal grande y solo muestra copiar dominio para publicar y completar", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockTareas({
      dominios: [tarea({
        id: "d_publicable",
        domainName: "https://argatex.sagerp.cloud:54678/",
        targetName: "https://argatex.sagerp.cloud:54678/",
        assignedUserIds: ["u"],
      })],
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(screen.getByRole("heading", { name: /U — dominios por actualizar/i }).closest(".modal")).toHaveClass("modal-detalle-tareas");
    expect(screen.getAllByText(/Dominio para publicar/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Copiar URLs completas/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copiar URL completa$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Iniciar$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^Bloquear$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reportar problema/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Copiar todos los dominios pendientes \(formato publicable\)/i })).toBeInTheDocument();
    const accionesFila = within(screen.getByTestId("acciones-tarea-d_publicable"));
    expect(accionesFila.getByRole("button", { name: /^Copiar dominio para publicar$/i })).toBeInTheDocument();
    expect(accionesFila.getByRole("button", { name: /^Completar$/i })).toBeInTheDocument();
    expect(accionesFila.queryByRole("button", { name: /^Copiar URL completa$/i })).toBeNull();
    expect(accionesFila.queryByRole("button", { name: /^Iniciar$/i })).toBeNull();
    expect(accionesFila.getByRole("button", { name: /^Bloquear$/i })).toBeInTheDocument();
    expect(accionesFila.queryByRole("button", { name: /Reportar problema/i })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /^Copiar dominio para publicar$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("argatex.sagerp.cloud"));
  });

  it("'Copiar todos los dominios pendientes' usa formato publicable, uno por línea", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockTareas({
      dominios: [
        tarea({ id: "a", domainName: "https://argatex.sagerp.cloud:54678/", targetName: "https://argatex.sagerp.cloud:54678/" }),
        tarea({ id: "b", domainName: "https://machineparts.sagerp.cloud:54678/path?x=1", targetName: "https://machineparts.sagerp.cloud:54678/" }),
      ],
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    fireEvent.click(screen.getByRole("button", { name: /Copiar todos los dominios pendientes/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("argatex.sagerp.cloud\nmachineparts.sagerp.cloud"));
  });

  it("permite buscar en el detalle de dominios por cliente o dominio", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({
      dominios: [
        tarea({
          id: "dom_pya",
          clientName: "P&A",
          domainName: "https://pya.sagerp.cloud:54678/",
          targetName: "https://pya.sagerp.cloud:54678/",
        }),
        tarea({
          id: "dom_asia",
          clientName: "ASIA SUPPLY AND LOGISTICS",
          domainName: "https://asiasuplog.sagerp.cloud:54678/",
          targetName: "https://asiasuplog.sagerp.cloud:54678/",
        }),
      ],
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText("P&A")).toBeInTheDocument();
    expect(screen.getByText("ASIA SUPPLY AND LOGISTICS")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Buscar en este detalle/i), { target: { value: "asia" } });

    expect(screen.queryByText("P&A")).toBeNull();
    expect(screen.getByText("ASIA SUPPLY AND LOGISTICS")).toBeInTheDocument();
    expect(screen.getByText(/Mostrando 1 de 2 dominios/i)).toBeInTheDocument();
  });

  it("muestra 'Tu rol puede atender esta tarea' cuando no hay asignado y el rol coincide", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["domain_updater"];
    mockTareas({ dominios: [tarea({ id: "d1", assignedUserIds: [] })] });
    renderPagina();
    expect(await screen.findByText(/Tu rol puede atender/i)).toBeInTheDocument();
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

  it("detalle de base muestra conexión apilada, contraseña oculta y solo completar como acción de fila", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const baseTask = tarea({
      id: "b1",
      targetType: "database",
      targetId: "db_1",
      targetName: "SAMPEDRO",
      assignedRole: "database_updater",
    });
    mockTareas({ bases: [baseTask], basesDetalle: [bd("db_1")] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText(/Servidor:/i)).toBeInTheDocument();
    expect(screen.getByText(/Base:/i)).toBeInTheDocument();
    expect(screen.getByText(/Usuario:/i)).toBeInTheDocument();
    expect(screen.getByText(/Contraseña:/i)).toBeInTheDocument();
    expect(screen.getByText("••••••••••••")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Copiar$/i }).length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole("button", { name: /^Ver$/i })).toBeInTheDocument();
    const accionesFila = within(screen.getByTestId("acciones-tarea-b1"));
    expect(accionesFila.getByRole("button", { name: /^Completar$/i })).toBeInTheDocument();
    expect(accionesFila.queryByRole("button", { name: /^Copiar$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Iniciar$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^Bloquear$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reportar problema/i })).toBeNull();
  });

  it("permite buscar bases y filtrarlas por servidor en el detalle", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({
      bases: [
        tarea({
          id: "base_pya",
          targetType: "database",
          targetId: "db_pya",
          targetName: "PYACOL",
          clientName: "P&A",
          domainName: "https://pya.sagerp.cloud:54678/",
          assignedRole: "database_updater",
        }),
        tarea({
          id: "base_asia",
          targetType: "database",
          targetId: "db_asia",
          targetName: "ASIASUPLOG-DB",
          clientName: "ASIA SUPPLY AND LOGISTICS",
          domainName: "https://asiasuplog.sagerp.cloud:54678/",
          assignedRole: "database_updater",
        }),
      ],
      basesDetalle: [
        bd("db_pya", {
          clientName: "P&A",
          domainName: "https://pya.sagerp.cloud:54678/",
          dbAccess: { ...bd("db_pya").dbAccess, serverHostPort: "data11.sagerp.co,54106", initialCatalog: "PYACOL" },
        }),
        bd("db_asia", {
          clientName: "ASIA SUPPLY AND LOGISTICS",
          domainName: "https://asiasuplog.sagerp.cloud:54678/",
          dbAccess: { ...bd("db_asia").dbAccess, serverHostPort: "data15.sagerp.co,53504", initialCatalog: "ASIASUPLOG-DB" },
        }),
      ],
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText("PYACOL")).toBeInTheDocument();
    expect(await screen.findByText("ASIASUPLOG-DB")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Buscar en este detalle/i), { target: { value: "asiasuplog" } });
    expect(screen.queryByText("PYACOL")).toBeNull();
    expect(screen.getByText("ASIASUPLOG-DB")).toBeInTheDocument();
    expect(screen.getByText(/Mostrando 1 de 2 bases/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Buscar en este detalle/i), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/Filtrar por servidor/i), { target: { value: "data11.sagerp.co,54106" } });

    await waitFor(() => expect(screen.getByText("PYACOL")).toBeInTheDocument());
    expect(screen.queryByText("ASIASUPLOG-DB")).toBeNull();
    expect(screen.getByText(/Mostrando 1 de 2 bases/i)).toBeInTheDocument();
  });

  it("grupo de bases por rol carga conexión por taskId aunque assignedUserIds esté vacío", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["database_updater"];
    const baseTask = tarea({
      id: "b_role",
      targetType: "database",
      targetId: "db_role",
      targetName: "SAMPEDRO",
      assignedRole: "database_updater",
      assignedUserIds: [],
    });
    mockTareas({ bases: [baseTask], basesDetalle: [bd("db_role")] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText(/Servidor:/i)).toBeInTheDocument();
    expect(screen.getAllByText("data-ims.imsampedro.cloud,54101").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cargando conexión/i)).toBeNull();
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/databases/db_role/access-info?taskId=b_role")
    );
  });

  it("grupo de bases asignado manualmente sigue cargando conexión", async () => {
    usuarioMock.id = "rodrigo";
    usuarioMock.roles = ["database_updater"];
    usuarioMock.displayName = "Rodrigo Kammerer";
    const baseTask = tarea({
      id: "b_rodrigo",
      targetType: "database",
      targetId: "db_rodrigo",
      targetName: "SAMPEDRO",
      assignedRole: "database_updater",
      assignedUserIds: ["rodrigo"],
    });
    mockTareas({ bases: [baseTask], basesDetalle: [bd("db_rodrigo")] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText(/Servidor:/i)).toBeInTheDocument();
    expect(screen.getByText("IMSAMPEDRO-IMS01-API")).toBeInTheDocument();
  });

  it("si access-info falla, la fila muestra error y reintento sin dejar todo cargando", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const okTask = tarea({ id: "b_ok", targetType: "database", targetId: "db_ok", targetName: "OK", assignedRole: "database_updater" });
    const failTask = tarea({ id: "b_fail", targetType: "database", targetId: "db_fail", targetName: "FAIL", assignedRole: "database_updater" });
    apiMock.get.mockImplementation((path = "") => {
      if (path.includes("targetType=domain")) return Promise.resolve([]);
      if (path.includes("targetType=database")) return Promise.resolve([okTask, failTask]);
      if (path.includes("/databases/db_ok/access-info")) {
        return Promise.resolve({ server: "srv-ok", databaseName: "OK", user: "usr-ok", hasPassword: true });
      }
      if (path.includes("/databases/db_fail/access-info")) return Promise.reject(new Error("Error 500"));
      if (path === "/users") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText("srv-ok")).toBeInTheDocument();
    expect(await screen.findByText(/No se pudo cargar la conexión/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reintentar/i })).toBeInTheDocument();
    expect(screen.queryByText(/Cargando conexión/i)).toBeNull();
  });

  it("si access-info devuelve 403, muestra mensaje de permisos", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["database_updater"];
    const error = Object.assign(new Error("No tienes permiso para ver esta conexión."), { status: 403 });
    apiMock.get.mockImplementation((path = "") => {
      if (path.includes("targetType=domain")) return Promise.resolve([]);
      if (path.includes("targetType=database")) {
        return Promise.resolve([tarea({ id: "b_forbidden", targetType: "database", targetId: "db_forbidden", assignedRole: "database_updater", assignedUserIds: ["otro"] })]);
      }
      if (path.includes("/access-info")) return Promise.reject(error);
      return Promise.resolve([]);
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText(/No tienes permiso para ver esta conexión/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reintentar/i })).toBeNull();
  });

  it("ver y copiar contraseña llaman endpoint seguro sin precargar password", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    apiMock.post.mockResolvedValue({ password: "pwd-secreta" });
    mockTareas({ bases: [tarea({ id: "b1", targetType: "database", targetId: "db_1", targetName: "SAMPEDRO", assignedRole: "database_updater" })], basesDetalle: [bd("db_1")] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(screen.queryByText("pwd-secreta")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /^Ver$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/databases/db_1/reveal-password", { taskId: "b1", reason: "task_detail" }));
    expect(await screen.findByText("pwd-secreta")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Ocultar$/i }));
    expect(screen.queryByText("pwd-secreta")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /^Copiar$/i }).at(-1)!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pwd-secreta"));
  });

  it("no renderiza contraseña ni botones de reveal para usuario sin permiso", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["database_updater"];
    mockTareas({ bases: [tarea({ id: "b1", targetType: "database", targetId: "db_1", assignedRole: "database_updater", assignedUserIds: ["otro"] })], basesDetalle: [bd("db_1")] });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect(await screen.findByText("••••••••••••")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ver$/i })).toBeNull();
    expect(screen.queryByText("pwd-secreta")).toBeNull();
  });

  it("las tarjetas muestran nombres de responsables cuando hay usuarios cargados", async () => {
    usuarioMock.id = "admin";
    usuarioMock.roles = ["admin"];
    usuarioMock.displayName = "Admin";
    mockTareas({
      dominios: [tarea({ id: "d1", assignedUserIds: ["mateo"] })],
      usuarios: [{ id: "mateo", displayName: "Mateo Palacio", email: "mateo@empresa.com" }],
    });
    renderPagina();
    expect(await screen.findByText(/Mateo Palacio — Dominios por actualizar/i)).toBeInTheDocument();
    expect(screen.getByText(/Responsable: Mateo Palacio/i)).toBeInTheDocument();
  });

  it("la tarjeta vuelve a mostrar el rol y no el responsable viejo cuando assignedUserIds está vacío", async () => {
    usuarioMock.id = "admin";
    usuarioMock.roles = ["admin"];
    mockTareas({
      dominios: [tarea({ id: "d1", assignedUserIds: [], assignedRole: "domain_updater" })],
      usuarios: [{ id: "rodrigo", displayName: "Rodrigo Kammerer", email: "rodrigo@empresa.com" }],
    });
    renderPagina();
    expect(await screen.findByText(/Actualizador de dominios — Dominios por actualizar/i)).toBeInTheDocument();
    expect(screen.queryByText(/Rodrigo Kammerer — Dominios por actualizar/i)).toBeNull();
  });

  it("no muestra tareas obsoletas canceladas en el tablero ni en el detalle", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    mockTareas({
      dominios: [
        tarea({ id: "activa", domainName: "activo.sagerp.cloud", targetName: "activo.sagerp.cloud" }),
        tarea({ id: "obsoleta", domainName: "sampedro.sagerp.cloud", targetName: "sampedro.sagerp.cloud", status: "cancelled" }),
      ],
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect((await screen.findAllByText("activo.sagerp.cloud")).length).toBeGreaterThan(0);
    expect(screen.queryByText("sampedro.sagerp.cloud")).toBeNull();
  });

  it("las tareas completadas siguen apareciendo en la sección completadas dentro de la ventana", async () => {
    usuarioMock.id = "u";
    usuarioMock.roles = ["admin"];
    const hoy = hoyIso();
    mockTareas({ dominios: [tarea({ id: "completada", status: "completed", taskDate: hoy, taskBucket: `${hoy}_domain`, completedAt: `${hoy}T10:00:00Z`, domainName: "historico.sagerp.cloud", targetName: "historico.sagerp.cloud" })] });
    renderPagina();
    expect(await screen.findByText(/Completadas: 1 \/ 1/i)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Ver detalle/i }));
    expect((await screen.findAllByText("historico.sagerp.cloud")).length).toBeGreaterThan(0);
  });
});
