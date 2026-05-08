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

import DominiosPage from "../pages/DominiosPage";

const clientes = [{ id: "client_1", name: "Cliente Uno", status: "active", createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" }];

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DominiosPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve(clientes);
    if (path === "/domains") return Promise.resolve([]);
    if (path === "/schedules") return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe("DominiosPage", () => {
  it("configura frecuencia del dominio sin pedir rol responsable y muestra acciones rápidas", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nuevo dominio/i }));
    expect(screen.getByText(/Frecuencia de actualización del dominio/i)).toBeInTheDocument();
    expect(screen.queryByText(/Rol responsable/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^Guardar$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y agregar base de datos/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guardar y crear nuevo dominio/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Tiene fecha de fin/i)).toBeInTheDocument();
  });
});
