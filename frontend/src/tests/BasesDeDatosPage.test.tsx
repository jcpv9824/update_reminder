import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

import BasesDeDatosPage from "../pages/BasesDeDatosPage";

const clientes = [{ id: "client_1", name: "Cliente Uno", status: "active", createdAt: "", createdBy: "", updatedAt: "", updatedBy: "" }];
const dominios = [
  { id: "domain_1", clientId: "client_1", clientName: "Cliente Uno", domainName: "cliente.pya.com.co", environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "" },
  { id: "domain_2", clientId: "client_1", clientName: "Cliente Uno", domainName: "sinfrecuencia.pya.com.co", environment: "production", assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "" },
];
const frecuenciaDominio = {
  id: "schedule_domain",
  clientId: "client_1",
  clientName: "Cliente Uno",
  domainId: "domain_1",
  domainName: "cliente.pya.com.co",
  targetType: "domain",
  targetIds: ["domain_1"],
  frequencyType: "weekly",
  weekdays: ["FRIDAY"],
  startDate: "2026-05-01",
  timezone: "America/Bogota",
  assignedRole: "domain_updater",
  assignedUserIds: [],
  active: true,
  createdAt: "",
  updatedAt: "",
};

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BasesDeDatosPage />
    </QueryClientProvider>
  );
}

function mockGets(frecuencias = [frecuenciaDominio]) {
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve(clientes);
    if (path === "/domains") return Promise.resolve(dominios);
    if (path === "/databases") return Promise.resolve([]);
    if (path === "/schedules") return Promise.resolve(frecuencias);
    return Promise.resolve([]);
  });
}

function seleccionar(label: RegExp, optionText: RegExp) {
  const labelNode = screen.getAllByText(label).at(-1)!;
  const input = within(labelNode.parentElement!).getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.mouseDown(screen.getByText(optionText));
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.del.mockReset();
});

describe("BasesDeDatosPage", () => {
  it("Nueva base de datos muestra la frecuencia heredada del dominio seleccionado", async () => {
    mockGets();
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva base de datos/i }));
    seleccionar(/Cliente \*/i, /Cliente Uno/i);
    seleccionar(/Dominio \*/i, /cliente.pya.com.co/i);
    expect(await screen.findByText(/Esta base de datos usará la frecuencia configurada en el dominio seleccionado/i)).toBeInTheDocument();
    expect(screen.getByText(/Semanal: FRIDAY desde 2026-05-01/i)).toBeInTheDocument();
    expect(screen.queryByText(/Frecuencia individual avanzada/i)).toBeNull();
    expect(screen.queryByText(/Crear frecuencia automática específica/i)).toBeNull();
  });

  it("Nueva base de datos advierte si el dominio no tiene frecuencia", async () => {
    mockGets([]);
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva base de datos/i }));
    seleccionar(/Cliente \*/i, /Cliente Uno/i);
    seleccionar(/Dominio \*/i, /sinfrecuencia.pya.com.co/i);
    expect(await screen.findByText(/El dominio seleccionado no tiene frecuencia configurada/i)).toBeInTheDocument();
  });
});
