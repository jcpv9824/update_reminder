import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

import ClientesPage from "../pages/ClientesPage";

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClientesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.get.mockResolvedValue([]);
});

describe("ClientesPage", () => {
  it("muestra acciones rápidas para continuar el flujo de creación", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo cliente/i }));
    expect(screen.getByRole("button", { name: /^Guardar$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y agregar dominio/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y crear nuevo cliente/i })).toBeInTheDocument();
  });
});
