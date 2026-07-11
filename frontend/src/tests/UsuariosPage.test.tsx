import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({
  get: vi.fn<(path?: string) => Promise<any>>(async () => ({ items: [], page: 1, pageSize: 10, total: 0 })),
  post: vi.fn<(path: string, body?: any) => Promise<any>>(async () => ({})),
  put: vi.fn<(path: string, body?: any) => Promise<any>>(async () => ({})),
  del: vi.fn<(path: string) => Promise<any>>(async () => ({})),
}));
const authState = vi.hoisted(() => ({
  roles: ["super_admin"] as string[],
}));

vi.mock("../api/client", () => ({ api: apiMock }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "admin", email: "admin@empresa.com", displayName: "Admin", roles: authState.roles },
  }),
}));

import UsuariosPage from "../pages/UsuariosPage";

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsuariosPage />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  authState.roles = ["super_admin"];
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.get.mockImplementation(async (path = "") => {
    if (path.startsWith("/roles")) {
      return [
        {
          id: "super_admin",
          name: "Super Administrador",
          permissions: ["updates.tasks.view", "configuration.roles.manage_permissions"],
          taskVisibility: { domain: "all", database: "all" },
          system: true,
          protected: true,
          active: true,
        },
        {
          id: "domain_updater",
          name: "Actualizador de Dominios",
          permissions: ["updates.tasks.view"],
          taskVisibility: { domain: "assigned", database: "none" },
          system: true,
          active: true,
        },
        {
          id: "roles_admin",
          name: "Administrador de Roles",
          permissions: [
            "configuration.roles.view",
            "configuration.roles.create",
            "configuration.roles.edit",
            "configuration.roles.manage_permissions",
            "configuration.roles.manage_task_visibility",
          ],
          taskVisibility: { domain: "none", database: "none" },
          system: false,
          active: true,
        },
      ];
    }
    return {
      items: [{
        id: "user_1",
        displayName: "Laura Pérez",
        email: "laura@empresa.com",
        roles: ["database_updater"],
        active: true,
        mfaEnabled: true,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      }],
      page: 1,
      pageSize: 10,
      total: 1,
    };
  });
  apiMock.post.mockResolvedValue({});
});

describe("UsuariosPage", () => {
  it("no muestra estado ni controles de segundo factor", async () => {
    renderPagina();
    expect(await screen.findByText("Laura Pérez")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "MFA" })).toBeNull();
    expect(screen.queryByText("Activa", { selector: "td" })).toBeNull();
  });

  it("permite reenviar credenciales generando una nueva contraseña temporal", async () => {
    renderPagina();
    expect(await screen.findByText("Laura Pérez")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reenviar contraseña/i }));
    expect(await screen.findByRole("heading", { name: /Reenviar contraseña a Laura Pérez/i })).toBeInTheDocument();
    expect(screen.getByText(/nueva contraseña temporal/i)).toBeInTheDocument();
    expect(screen.getByText(/no se pueden recuperar/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Generar y enviar/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/users/user_1/resend-credentials"));
    expect(await screen.findByText(/Se generó una nueva contraseña temporal/i)).toBeInTheDocument();
  });

  it("muestra roles con visibilidad de tareas separada de los permisos", async () => {
    renderPagina();
    fireEvent.click(screen.getByRole("tab", { name: "Roles" }));

    expect(await screen.findByText("Super Administrador")).toBeInTheDocument();
    expect(screen.getByText("Actualizador de Dominios")).toBeInTheDocument();
    expect(screen.getByText("Dominios: Solo asignadas · Bases de Datos: Sin acceso")).toBeInTheDocument();
  });

  it("permite crear un rol seleccionando permisos por módulo", async () => {
    renderPagina();
    fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo rol" }));

    fireEvent.change(screen.getByLabelText("Nombre *"), { target: { value: "Supervisor de Actualizaciones" } });
    fireEvent.click(screen.getByLabelText("Actualizaciones"));
    fireEvent.click(screen.getByRole("button", { name: "Guardar rol" }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/roles", expect.objectContaining({
      name: "Supervisor de Actualizaciones",
      taskVisibility: { domain: "none", database: "none" },
    })));
    const body = apiMock.post.mock.calls.find(([path]) => path === "/roles")?.[1];
    expect(body.permissions).toContain("updates.tasks.view");
    expect(body.permissions).toContain("updates.schedules.generate_tasks");
  });

  it("permite quitar una acción individual después de seleccionar un módulo", async () => {
    renderPagina();
    fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo rol" }));
    fireEvent.change(screen.getByLabelText("Nombre *"), { target: { value: "Operador limitado" } });
    fireEvent.click(screen.getByLabelText("Actualizaciones"));
    fireEvent.click(screen.getByLabelText("Completar"));
    fireEvent.click(screen.getByRole("button", { name: "Guardar rol" }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/roles", expect.objectContaining({ name: "Operador limitado" })));
    const body = apiMock.post.mock.calls.find(([path]) => path === "/roles")?.[1];
    expect(body.permissions).toContain("updates.tasks.view");
    expect(body.permissions).not.toContain("updates.tasks.complete");
  });

  it("permite eliminar un rol personalizado después de confirmarlo", async () => {
    renderPagina();
    fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar rol Administrador de Roles" }));
    expect(screen.getByText(/solo se puede eliminar cuando no está asignado/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar rol" }));

    await waitFor(() => expect(apiMock.del).toHaveBeenCalledWith("/roles/roles_admin"));
  });

  it("abre solo la pestaña de roles cuando el usuario no puede ver usuarios", async () => {
    authState.roles = ["roles_admin"];
    renderPagina();

    expect(await screen.findByRole("tab", { name: "Roles" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Usuarios" })).toBeNull();
    expect(screen.queryByText("Laura Pérez")).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/users/));
  });
});
