import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FrecuenciasPage from "../pages/FrecuenciasPage";
import type { Frecuencia } from "../types";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

const cliente = { id: "client_1", name: "Cliente Uno", status: "active", createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" };
const dominio = {
  id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "cliente.sagerp.co",
  environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "",
};

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FrecuenciasPage />
    </QueryClientProvider>
  );
}

function frecuencia(overrides: Partial<Frecuencia> = {}): Frecuencia {
  return {
    id: "schedule_special",
    clientId: "client_1",
    clientName: "Cliente Uno",
    targetType: "domain",
    targetIds: ["domain_1"],
    frequencyType: "weekly",
    everyNWeeks: 1,
    weekdays: ["FRIDAY"],
    startDate: "2026-05-08",
    endDate: null,
    timezone: "America/Bogota",
    assignedRole: "domain_updater",
    assignedUserIds: [],
    origin: "special",
    active: true,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.post.mockResolvedValue({});
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve([cliente]);
    if (path === "/domains") return Promise.resolve([dominio]);
    if (path === "/databases") return Promise.resolve([]);
    if (path === "/schedules?origin=special") return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe("FrecuenciasPage", () => {
  it("muestra titulo, explicacion y estado vacio de Programaciones especiales", async () => {
    renderPagina();
    expect(await screen.findByRole("heading", { name: "Programaciones especiales" })).toBeInTheDocument();
    expect(screen.getByText(/La frecuencia normal de actualización se configura desde cada dominio/i)).toBeInTheDocument();
    expect(await screen.findByText("No hay programaciones especiales configuradas.")).toBeInTheDocument();
    expect(screen.getByText(/ve a Dominios y edita la frecuencia del dominio/i)).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith("/schedules?origin=special");
  });

  it("muestra programaciones especiales devueltas por el API", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/schedules?origin=special") return Promise.resolve([frecuencia()]);
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Cliente Uno")).toBeInTheDocument();
    expect(screen.getByText("Dominio")).toBeInTheDocument();
  });

  it("no muestra frecuencias normales de dominio aunque lleguen en la respuesta", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/schedules?origin=special") return Promise.resolve([
        frecuencia({ id: "schedule_normal", clientName: "Normal Oculta", origin: "domain_default" }),
        frecuencia({ id: "schedule_special", clientName: "Especial Visible", origin: "special" }),
      ]);
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Especial Visible")).toBeInTheDocument();
    expect(screen.queryByText("Normal Oculta")).toBeNull();
  });


  it("al crear envia origin special", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva programación especial/i }));
    fireEvent.focus(screen.getByPlaceholderText("Buscar cliente..."));
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.click(screen.getByLabelText(/Incluir todos los dominios activos/i));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      origin: "special",
      scopeGroups: expect.arrayContaining([expect.objectContaining({ clientId: "client_1", includeAllDomains: true })]),
    }));
  });
});
