import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({
  get: vi.fn<(path?: string) => Promise<any>>(async () => ({ items: [], page: 1, pageSize: 10, total: 0 })),
  post: vi.fn<(path: string, body?: any) => Promise<any>>(async () => ({})),
  put: vi.fn<(path: string, body?: any) => Promise<any>>(async () => ({})),
}));

vi.mock("../api/client", () => ({ api: apiMock }));

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
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.get.mockResolvedValue({
    items: [{
      id: "user_1",
      displayName: "Laura Pérez",
      email: "laura@empresa.com",
      roles: ["database_updater"],
      active: true,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    }],
    page: 1,
    pageSize: 10,
    total: 1,
  });
  apiMock.post.mockResolvedValue({});
});

describe("UsuariosPage", () => {
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
});
