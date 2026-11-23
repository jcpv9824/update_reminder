import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FrecuenciasPage from "../pages/FrecuenciasPage";
import type { Frecuencia } from "../types";
import type { RoleDefinition } from "../permissionModel";
import { hoyEnBogotaIso, sumarDiasIso } from "../utils/fechas";

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
const dominio2 = { ...dominio, id: "domain_2", domainName: "cliente2.sagerp.co" };
const base1 = {
  id: "db_1", clientId: "client_1", clientName: "Cliente Uno", domainId: "domain_1", domainName: "cliente.sagerp.co",
  companyName: "Empresa Uno", environment: "production", dbAccess: { serverHostPort: "srv", initialCatalog: "EMPRESA_UNO", userId: "usr", passwordSecretName: "sec" },
  assignedUpdaterIds: [], status: "active", createdAt: "", updatedAt: "",
};
const base2 = { ...base1, id: "db_2", companyName: "Empresa Dos", dbAccess: { ...base1.dbAccess, initialCatalog: "EMPRESA_DOS" } };
const modulo = { id: "module_mobile", name: "Mobile App", code: "MOBILE", status: "active" };
const moduloInactivo = { id: "module_old", name: "Licencia vieja", code: "OLD", status: "inactive" };
const rolesProgramables: RoleDefinition[] = [
  { id: "domain_updater", name: "Actualizador de Dominios", permissions: ["updates.tasks.view"], taskVisibility: { domain: "assigned", database: "none" }, system: true, active: true },
  { id: "database_updater", name: "Actualizador de Bases de Datos", permissions: ["updates.tasks.view"], taskVisibility: { domain: "none", database: "assigned" }, system: true, active: true },
  { id: "domain_specialist", name: "Especialista de Dominios", permissions: ["updates.tasks.view"], taskVisibility: { domain: "all", database: "none" }, system: false, active: true },
  { id: "tasks_without_visibility", name: "Sin visibilidad", permissions: ["updates.tasks.view"], taskVisibility: { domain: "none", database: "none" }, system: false, active: true },
];

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

function select(label: RegExp | string) {
  const node = screen.getByText(label);
  return within(node.parentElement!).getByRole("combobox");
}

beforeEach(() => {
  vi.stubEnv("VITE_PORTAL_CATALOG_SCHEDULE_UI_ENABLED", "false");
  vi.stubEnv("VITE_PORTAL_CATALOG_DRAFT_PREVIEW_ENABLED", "false");
  vi.stubEnv("VITE_PORTAL_CATALOG_DRAFT_PROPOSALS_ENABLED", "false");
  vi.stubEnv("VITE_PORTAL_CATALOG_DRAFT_MATERIALIZATION_ENABLED", "false");
  vi.stubEnv("VITE_PORTAL_CATALOG_COPY_PROPOSALS_ENABLED", "false");
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.del.mockReset();
  apiMock.post.mockResolvedValue({});
  apiMock.get.mockImplementation((path: string) => {
    if (path === "/clients") return Promise.resolve([cliente]);
    if (path === "/domains") return Promise.resolve([dominio, dominio2]);
    if (path === "/databases") return Promise.resolve([base1, base2]);
    if (path === "/license-modules") return Promise.resolve([modulo, moduloInactivo]);
    if (path === "/roles") return Promise.resolve(rolesProgramables);
    if (path === "/settings/email-alerts") return Promise.resolve({ remindersEnabled: true, defaultReminderDaysBefore: [3, 1, 0], defaultReminderTime: "08:00", defaultTimezone: "America/Bogota" });
    if (path.startsWith("/schedules?origin=special")) return Promise.resolve({ items: [], page: 1, pageSize: 10, total: 0 });
    return Promise.resolve([]);
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("FrecuenciasPage", () => {
  it("consulta clientes, dominios y bases por su relación exacta en el formulario del catálogo", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_SCHEDULE_UI_ENABLED", "true");
    const customerId = "d832a70e-b525-42fa-ab14-a4d54ea5158c";
    const customer = { id: customerId, customerId, customerName: "Cliente del catálogo", eligibility: "observed_only" };
    const domain = { ...customer, id: "a".repeat(64), domain: "pruebas.example.test", environment: "test" };
    const first = apiMock.get.getMockImplementation()!;
    const page = (items: object[]) => ({ state: "verified", page: 1, pageSize: 25, total: items.length, items });
    apiMock.get.mockImplementation((path: string) => {
      if (!path.startsWith("/schedules/catalog-choices?")) return first(path);
      const params = new URLSearchParams(path.split("?")[1]);
      if (params.get("kind") === "customer") return Promise.resolve(page([customer]));
      if (params.get("customerId") !== customerId || params.get("environment") !== "test") return Promise.resolve(page([]));
      return Promise.resolve(page(params.get("kind") === "domain" ? [domain] : params.get("domain") === domain.domain
        ? [{ ...domain, id: "b".repeat(64), database: "Base asociada" }] : []));
    });
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: "Nueva actualización programada" }));
    const dialog = await screen.findByRole("region", { name: "Alcance del catálogo de SAG Web" });
    const scope = within(dialog);
    fireEvent.change(scope.getByLabelText("Ambiente"), { target: { value: "test" } });
    await scope.findByRole("option", { name: customer.customerName });
    fireEvent.change(scope.getByLabelText("Cliente del catálogo"), { target: { value: customerId } });
    await scope.findByRole("option", { name: /pruebas\.example\.test/ });
    fireEvent.change(scope.getByLabelText("Dominio del catálogo"), { target: { value: domain.id } });
    expect(await scope.findByText("Base asociada")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(scope.queryByRole("button", { name: /guardar|crear/i })).not.toBeInTheDocument();
  });

  it("usa el nombre de la licencia del catálogo y consulta ambos tipos sin interpretar identificadores observados como operativos", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_SCHEDULE_UI_ENABLED", "true");
    const first = apiMock.get.getMockImplementation()!;
    apiMock.get.mockImplementation((path: string) => {
      if (!path.startsWith("/schedules/catalog-choices?")) return first(path);
      const params = new URLSearchParams(path.split("?")[1]);
      return Promise.resolve({ state: "partial", page: 1, pageSize: 25, total: params.get("kind") === "license" ? 1 : 0,
        items: [], ...(params.get("kind") === "license" ? { licenseOptions: [{ code: "I", name: "Inventario" }] } : {}) });
    });
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: "Nueva actualización programada" }));
    const scope = within(await screen.findByRole("region", { name: "Alcance del catálogo de SAG Web" }));
    fireEvent.change(scope.getByLabelText("Tipo de alcance"), { target: { value: "licensing" } });
    await scope.findByRole("option", { name: "Inventario (I)" });
    fireEvent.change(scope.getByLabelText("Licencia del catálogo"), { target: { value: "I" } });
    fireEvent.change(scope.getByLabelText("Ambiente"), { target: { value: "demo" } });
    await waitFor(() => {
      for (const kind of ["domain", "database"]) expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`kind=${kind}.*environment=demo.*moduleCode=I`)));
    });
    expect(scope.getAllByText(/datos parciales/i).length).toBeGreaterThan(0);
    expect(apiMock.post).not.toHaveBeenCalled();
  });
  it("previsualiza licenciamiento, muestra reservas y descarta la vista al cambiar el ambiente", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_SCHEDULE_UI_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DRAFT_PREVIEW_ENABLED", "true");
    const first = apiMock.get.getMockImplementation()!;
    apiMock.get.mockImplementation((path: string) => !path.startsWith("/schedules/catalog-choices?") ? first(path) :
      Promise.resolve({ state: "verified", page: 1, pageSize: 25, total: 1, items: [], licenseOptions: [{ code: "I", name: "Inventario" }] }));
    apiMock.post.mockResolvedValue({ coverage: "verified", groups: [{ id: "group", kind: "database", state: "reserved", label: "Base verificada",
      links: [{ id: "link", customerName: "Cliente A", environment: "test" }] }] });
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: "Nueva actualización programada" }));
    const scope = within(await screen.findByRole("region", { name: "Alcance del catálogo de SAG Web" }));
    fireEvent.change(scope.getByLabelText("Tipo de alcance"), { target: { value: "licensing" } });
    await scope.findByRole("option", { name: "Inventario (I)" });
    fireEvent.change(scope.getByLabelText("Licencia del catálogo"), { target: { value: "I" } });
    fireEvent.change(scope.getByLabelText("Ambiente"), { target: { value: "test" } });
    fireEvent.change(scope.getByLabelText("Objetivo de la actualización"), { target: { value: "database" } });
    fireEvent.click(scope.getByRole("button", { name: "Previsualizar alcance operativo" }));
    expect(await scope.findByText(/hay una reserva existente/i)).toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledExactlyOnceWith("/schedules/catalog-draft-preview",
      { mode: "licensing", moduleCode: "I", date: hoyEnBogotaIso(), target: "database", environment: "test" });
    fireEvent.change(scope.getByLabelText("Ambiente"), { target: { value: "demo" } });
    expect(scope.queryByRole("region", { name: "Vista previa operativa" })).not.toBeInTheDocument();
  });
  it("guarda solo los destinos marcados como solicitud pendiente y no activa tareas", async () => {
    vi.stubEnv("VITE_PORTAL_CATALOG_SCHEDULE_UI_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DRAFT_PREVIEW_ENABLED", "true");
    vi.stubEnv("VITE_PORTAL_CATALOG_DRAFT_PROPOSALS_ENABLED", "true");
    const first = apiMock.get.getMockImplementation()!;
    apiMock.get.mockImplementation((path: string) => !path.startsWith("/schedules/catalog-choices?") ? first(path) :
      Promise.resolve({ state: "verified", page: 1, pageSize: 25, total: 1, items: [], licenseOptions: [{ code: "I", name: "Inventario" }] }));
    const ready = (id: string, label: string) => ({ id, kind: "database", state: "ready", label,
      links: [{ id: id.repeat(64), customerName: "Cliente de prueba", environment: "test" }] });
    apiMock.post.mockResolvedValueOnce({ previewId: "preview-firmada", coverage: "verified", groups: [ready("a", "Base A"), ready("b", "Base B")] })
      .mockResolvedValueOnce({ id: "05d95fc4-21c3-4adc-8c8d-d23716fe679c", status: "pending_approval" });
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: "Nueva actualización programada" }));
    const scope = within(await screen.findByRole("region", { name: "Alcance del catálogo de SAG Web" }));
    fireEvent.change(scope.getByLabelText("Tipo de alcance"), { target: { value: "licensing" } });
    await scope.findByRole("option", { name: "Inventario (I)" });
    fireEvent.change(scope.getByLabelText("Licencia del catálogo"), { target: { value: "I" } });
    fireEvent.click(scope.getByRole("button", { name: "Previsualizar alcance operativo" }));
    const checkbox = await scope.findByRole("checkbox", { name: "Seleccionar Base B" });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.change(scope.getByLabelText("Nombre de la programación"), { target: { value: "Solicitud de prueba" } });
    fireEvent.change(scope.getByLabelText("Frecuencia de la programación"), { target: { value: "weekly" } });
    expect(scope.getByRole("button", { name: "Guardar solicitud de programación" })).toBeDisabled();
    fireEvent.click(scope.getByRole("checkbox", { name: "Lunes" }));
    fireEvent.click(scope.getByRole("button", { name: "Guardar solicitud de programación" }));
    expect(await scope.findByText(/pendiente de aprobación.*no se crearon tareas/i)).toBeInTheDocument();
    expect(apiMock.post).toHaveBeenLastCalledWith("/schedules/catalog-draft-proposals", {
      name: "Solicitud de prueba", previewId: "preview-firmada", linkIds: ["a".repeat(64)],
      calendar: { frequencyType: "weekly", everyNWeeks: 1, weekdays: ["MONDAY"] },
      assignment: { mode: "role", domainRole: "domain_updater", databaseRole: "database_updater" },
      scope: { mode: "licensing", moduleCode: "I", date: hoyEnBogotaIso(), target: "both", environment: "all" },
    });
  });
  it("muestra titulo, explicacion y estado vacio de Programar Actualizaciones", async () => {
    renderPagina();
    expect(await screen.findByRole("heading", { name: "Programar Actualizaciones" })).toBeInTheDocument();
    expect(screen.getByText(/Defina actualizaciones recurrentes o únicas/i)).toBeInTheDocument();
    expect(await screen.findByText("No hay actualizaciones programadas configuradas.")).toBeInTheDocument();
    expect(screen.getByText(/programar dominios, bases o ambos con alcance explícito/i)).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith("/schedules?origin=special&page=1&pageSize=10");
  });

  it("recupera una solicitud nueva y confirma solo con el recibo sin mezclarla con una copia", async () => {
    for (const flag of ["SCHEDULE_UI", "DRAFT_PREVIEW", "DRAFT_PROPOSALS", "DRAFT_MATERIALIZATION"])
      vi.stubEnv(`VITE_PORTAL_CATALOG_${flag}_ENABLED`, "true");
    const id = "7a9b6b25-aaf9-4dd3-ac93-43c4dd899a95", receipt = "05d95fc4-21c3-4adc-8c8d-d23716fe679c";
    const initial = apiMock.get.getMockImplementation()!;
    let confirmed = false;
    let canRead = true;
    apiMock.get.mockImplementation((path: string) => path === "/schedules/catalog-draft-proposals"
      ? canRead ? Promise.resolve({ items: [{ id, name: "Solicitud recuperada", date: hoyEnBogotaIso(), status: confirmed ? "active" : "pending_approval" }] })
        : Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 }))
      : initial(path));
    apiMock.post.mockImplementation(async () => { confirmed = true; return { id: `catalog-draft-${id}`, status: "created" }; });
    renderPagina();
    fireEvent.click(screen.getByRole("button", { name: "Mis solicitudes" }));
    const request = within(await screen.findByRole("article", { name: "Solicitud recuperada" }));
    const input = request.getByLabelText("Recibo de revisión");
    fireEvent.change(input, { target: { value: "inválido" } });
    fireEvent.click(request.getByRole("button", { name: "Confirmar programación revisada" }));
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(request.getByRole("alert")).toHaveTextContent("identificador completo");
    fireEvent.change(input, { target: { value: receipt } });
    fireEvent.click(request.getByRole("button", { name: "Confirmar programación revisada" }));
    expect(input).toHaveValue("");
    expect(await request.findByText(/· Activada$/)).toBeInTheDocument();
    expect(request.queryByLabelText("Recibo de revisión")).not.toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledExactlyOnceWith(`/schedules/catalog-draft-proposals/${id}/activate`, { reviewId: receipt },
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
    canRead = false;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar solicitudes" }));
    expect(await screen.findByText("No se pudieron consultar sus solicitudes.")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Solicitud recuperada" })).not.toBeInTheDocument();
  });

  it("muestra actualizaciones programadas devueltas por el API", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/license-modules") return Promise.resolve([modulo]);
      if (path.startsWith("/schedules?origin=special")) return Promise.resolve({ items: [frecuencia()], page: 1, pageSize: 10, total: 1 });
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Cliente Uno")).toBeInTheDocument();
    expect(screen.getByText("Dominio")).toBeInTheDocument();
  });

  it("envía búsqueda al listado paginado de actualizaciones programadas", async () => {
    renderPagina();
    fireEvent.change(await screen.findByPlaceholderText("Buscar..."), { target: { value: "Mobile" } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/schedules?origin=special&page=1&pageSize=10&search=Mobile")));
  });

  it("no muestra frecuencias normales de dominio aunque lleguen en la respuesta", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/license-modules") return Promise.resolve([modulo]);
      if (path.startsWith("/schedules?origin=special")) return Promise.resolve({
        items: [
          frecuencia({ id: "schedule_normal", clientName: "Normal Oculta", origin: "domain_default" }),
          frecuencia({ id: "schedule_special", clientName: "Especial Visible", origin: "special" }),
        ],
        page: 1,
        pageSize: 10,
        total: 2,
      });
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Especial Visible")).toBeInTheDocument();
    expect(screen.queryByText("Normal Oculta")).toBeNull();
  });


  it("al crear envia origin special", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
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

  it("permite asignar roles personalizados aptos para las tareas y excluye roles sin visibilidad", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));

    const rolDominios = select("Rol para tareas de dominios");
    const rolBases = select("Rol para tareas de bases de datos");
    expect(within(rolDominios).getByRole("option", { name: "Especialista de Dominios" })).toBeInTheDocument();
    expect(within(rolDominios).queryByRole("option", { name: "Sin visibilidad" })).toBeNull();
    fireEvent.change(rolDominios, { target: { value: "domain_specialist" } });

    expect(within(rolBases).getByRole("option", { name: "Actualizador de Bases de Datos" })).toBeInTheDocument();
    expect(within(rolBases).queryByRole("option", { name: "Especialista de Dominios" })).toBeNull();

    fireEvent.focus(screen.getByPlaceholderText("Buscar cliente..."));
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.click(screen.getByLabelText(/Incluir todos los dominios activos/i));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      assignmentMode: "role",
      domainAssignedRole: "domain_specialist",
      databaseAssignedRole: "database_updater",
    })));
  });

  it("permite objetivo manual solo bases y guarda bases sin crear selección obligatoria de dominio", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    expect(select("Objetivo de la actualización")).toHaveValue("domains_and_databases");
    fireEvent.change(select("Objetivo de la actualización"), { target: { value: "databases_only" } });

    fireEvent.focus(screen.getByPlaceholderText("Buscar cliente..."));
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.click(screen.getByRole("button", { name: /\+ Agregar bases de datos/i }));
    fireEvent.click(await screen.findByLabelText(/Empresa Uno/i));
    fireEvent.click(screen.getByRole("button", { name: /Agregar seleccionadas/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      selectionMode: "manual",
      manualTargetTypes: "databases_only",
      scopeGroups: expect.arrayContaining([
        expect.objectContaining({
          clientId: "client_1",
          domains: expect.arrayContaining([
            expect.objectContaining({ domainId: "domain_1", databaseIds: ["db_1"] }),
          ]),
        }),
      ]),
    })));
  });

  it("usa frecuencia Única por defecto y solo muestra fecha de actualización", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    expect(select("Tipo de frecuencia *")).toHaveValue("once");
    expect(screen.getByText("Fecha de actualización *")).toBeInTheDocument();
    expect(screen.queryByText("Cada cuántas semanas")).toBeNull();
    expect(screen.queryByText("Tiene fecha de fin")).toBeNull();
    expect(screen.getByText(/Esta programación se ejecutará una sola vez/i)).toBeInTheDocument();
    expect(screen.getByText("Programación activa")).toBeInTheDocument();

    fireEvent.change(select("Tipo de frecuencia *"), { target: { value: "weekly" } });
    expect(screen.getByText("Cada cuántas semanas")).toBeInTheDocument();
    expect(screen.getByText("Días de la semana")).toBeInTheDocument();
  });

  it("usa recordatorios globales por defecto y permite override con días por coma y hora", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    expect(screen.getByLabelText(/Usar configuración global de recordatorios/i)).toBeChecked();
    expect(screen.getByDisplayValue("3, 1, 0")).toBeInTheDocument();
    expect(screen.getByDisplayValue("08:00")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Usar configuración global de recordatorios/i));
    expect(screen.getByText("Activar recordatorios automáticos")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("1, 0"), { target: { value: "2,1,0" } });
    fireEvent.change(screen.getByPlaceholderText("08:00"), { target: { value: "07:30" } });

    fireEvent.focus(screen.getByPlaceholderText("Buscar cliente..."));
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));
    fireEvent.click(screen.getByLabelText(/Incluir todos los dominios activos/i));
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      reminders: expect.objectContaining({
        remindersEnabled: true,
        reminderDaysBefore: [2, 1, 0],
        reminderTime: "07:30",
      }),
    })));
  });

  it("permite agregar varios dominios y varias bases con modales de selección", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    fireEvent.focus(screen.getByPlaceholderText("Buscar cliente..."));
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Cliente Uno" }));

    fireEvent.click(screen.getByRole("button", { name: /\+ Agregar dominios/i }));
    const domainModal = screen.getByText("Seleccionar dominios", { selector: "h3" }).closest<HTMLElement>(".modal")!;
    const domains = within(domainModal);
    fireEvent.click(domains.getByText("cliente.sagerp.co"));
    fireEvent.click(domains.getByText("cliente2.sagerp.co"));
    fireEvent.click(domains.getByRole("button", { name: /Agregar seleccionados/i }));
    expect(screen.getByText(/Dominio: cliente.sagerp.co/i)).toBeInTheDocument();
    expect(screen.getByText(/Dominio: cliente2.sagerp.co/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /\+ Agregar bases/i })[0]);
    const databaseModal = screen.getByText("Seleccionar bases de datos", { selector: "h3" }).closest<HTMLElement>(".modal")!;
    const databases = within(databaseModal);
    fireEvent.click(databases.getByText("Empresa Uno"));
    fireEvent.click(databases.getByText("Empresa Dos"));
    fireEvent.click(databases.getByRole("button", { name: /Agregar seleccionadas/i }));
    expect(screen.getByText(/Empresa Uno — EMPRESA_UNO — production/i)).toBeInTheDocument();
    expect(screen.getByText(/Empresa Dos — EMPRESA_DOS — production/i)).toBeInTheDocument();
    expect(screen.getByText(/Resumen del alcance: 1 cliente\(s\), 2 dominio\(s\), 2 base\(s\) de datos/i)).toBeInTheDocument();
  });

  it("modo Por licenciamiento oculta selección manual y exige licencias", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    expect(screen.getByText("Licencias a actualizar")).toBeInTheDocument();
    expect(screen.queryByText(/Todos los clientes activos/i)).toBeNull();
    expect(screen.queryByPlaceholderText("Buscar cliente...")).toBeNull();
    expect(screen.getByText("Sin licencias seleccionadas.")).toBeInTheDocument();
    expect(screen.queryByText("Licencia vieja")).toBeNull();
    expect(screen.getByLabelText(/Solo clientes, dominios y bases activos/i)).toBeChecked();
    expect(screen.getByLabelText(/Solo clientes, dominios y bases activos/i)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    expect(screen.getByText("Seleccione al menos una licencia.")).toBeInTheDocument();
  });

  it("muestra licencias seleccionadas y permite quitarlas con chip", async () => {
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    fireEvent.click(await screen.findByText("Mobile App"));
    expect(await screen.findByRole("button", { name: "Quitar Mobile App" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quitar Mobile App" }));
    expect(screen.getByText("Sin licencias seleccionadas.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Mobile App/i)).not.toBeChecked();
  });

  it("previsualiza y guarda programación por licenciamiento", async () => {
    apiMock.post.mockImplementation((path: string, body: any) => {
      if (path === "/special-schedules/preview-licensing-scope") {
        return Promise.resolve({
          clientsCount: 1,
          domainsCount: 1,
          databasesCount: 1,
          groups: [{
            client: { id: "client_1", name: "Cliente Uno", licenses: ["Mobile App"] },
            domains: [{ id: "domain_1", name: "cliente.sagerp.co", environment: "production", databases: [{ id: "db_1", companyName: "Empresa Uno", databaseName: "EMPRESA_UNO", environment: "production" }] }],
          }],
        });
      }
      return Promise.resolve({ id: "schedule_license", ...body });
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    fireEvent.click(await screen.findByText("Mobile App"));
    fireEvent.change(select("Ambiente"), { target: { value: "production" } });
    fireEvent.change(select("Objetivo de actualización"), { target: { value: "domains_and_databases" } });
    fireEvent.click(screen.getByRole("button", { name: /Previsualizar alcance/i }));
    expect(await screen.findByText(/1 cliente\(s\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Cliente: Cliente Uno/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      selectionMode: "licensing",
      licensingScope: expect.objectContaining({ licenseModuleIds: ["module_mobile"], environment: "production", activeOnly: true }),
    })));
  });

  it("permite excluir dominios y bases desde el preview por licenciamiento", async () => {
    apiMock.post.mockImplementation((path: string, body: any) => {
      if (path === "/special-schedules/preview-licensing-scope") {
        return Promise.resolve({
          clientsCount: 1,
          domainsCount: 1,
          databasesCount: 1,
          excludedDomainsCount: 0,
          excludedDatabasesCount: 0,
          groups: [{
            client: { id: "client_1", name: "Cliente Uno", licenses: ["Mobile App"] },
            domains: [{ id: "domain_1", name: "cliente.sagerp.co", environment: "production", databases: [{ id: "db_1", companyName: "Empresa Uno", databaseName: "EMPRESA_UNO", environment: "production" }] }],
          }],
        });
      }
      return Promise.resolve({ id: "schedule_license", ...body });
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    fireEvent.click(await screen.findByText("Mobile App"));
    fireEvent.click(screen.getByRole("button", { name: /Previsualizar alcance/i }));

    const excluirDominio = await screen.findByLabelText(/Excluir este dominio de esta programación/i);
    const excluirBase = screen.getByLabelText(/Excluir esta base de esta programación/i);
    fireEvent.click(excluirDominio);
    fireEvent.click(excluirBase);
    expect(screen.getByText(/0 dominio\(s\) incluido\(s\)/i)).toBeInTheDocument();
    expect(screen.getByText(/1 dominio\(s\) excluido\(s\)/i)).toBeInTheDocument();
    expect(screen.getByText(/0 base\(s\) incluida\(s\)/i)).toBeInTheDocument();
    expect(screen.getByText(/1 base\(s\) excluida\(s\)/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/schedules", expect.objectContaining({
      licensingScope: expect.objectContaining({
        excludedDomainIds: ["domain_1"],
        excludedDatabaseIds: ["db_1"],
      }),
    })));
  });

  it("actualiza automáticamente el preview al cambiar filtros y permite guardar", async () => {
    apiMock.post.mockImplementation((path: string) => {
      if (path === "/special-schedules/preview-licensing-scope") {
        return Promise.resolve({
          clientsCount: 1,
          domainsCount: 1,
          databasesCount: 1,
          groups: [{
            client: { id: "client_1", name: "Cliente Uno", licenses: ["Mobile App"] },
            domains: [{ id: "domain_1", name: "cliente.sagerp.co", environment: "production", databases: [] }],
          }],
        });
      }
      return Promise.resolve({});
    });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Nueva actualización programada/i }));
    fireEvent.change(select("Tipo de alcance"), { target: { value: "licensing" } });
    fireEvent.click(await screen.findByText("Mobile App"));
    fireEvent.click(screen.getByRole("button", { name: /Previsualizar alcance/i }));
    expect(await screen.findByText(/Alcance final/i)).toBeInTheDocument();

    fireEvent.change(select("Ambiente"), { target: { value: "test" } });
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/special-schedules/preview-licensing-scope", expect.objectContaining({ environment: "test" })));
    expect(screen.getByRole("button", { name: /^Guardar$/i })).not.toBeDisabled();
  });

  it("agrupa las actualizaciones programadas por estado (Requiere atención / Al día / Inactivas)", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/license-modules") return Promise.resolve([modulo]);
      if (path.startsWith("/schedules?origin=special")) return Promise.resolve({
        items: [
          frecuencia({ id: "s_atencion", name: "Con vencidas", summary: { proximas: 0, vencidas: 2, conError: 0, completadas: 0, requiereAtencion: true } }),
          frecuencia({ id: "s_aldia", name: "Sana", summary: { proximas: 1, vencidas: 0, conError: 0, completadas: 0, requiereAtencion: false } }),
          frecuencia({ id: "s_inactiva", name: "Apagada", active: false }),
        ],
        page: 1, pageSize: 10, total: 3,
      });
      return Promise.resolve([]);
    });
    renderPagina();
    expect(await screen.findByText("Requiere atención", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Al día", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Inactivas", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Con vencidas")).toBeInTheDocument();
    expect(screen.getByText("Sana")).toBeInTheDocument();
    expect(screen.getByText("Apagada")).toBeInTheDocument();
  });

  describe("copia de catálogo", () => {
    const sourceId = "prog:actual+2026";
    const prefix = `/schedules/${encodeURIComponent(sourceId)}/catalog-copy-preview?date=`;
    const preview = {
      previewId: "preview_local_test",
      coverage: "partial",
      groups: [
        { kind: "domain", label: "Dominio ocupado", physicalTargetId: "host_busy",
          conflict: { id: "conflict_1", reason: "Hay otra operación." },
          links: [{ id: "domain_busy", label: "No copiar dominio ocupado", verified: true }] },
        { kind: "domain", label: "Dominio libre", physicalTargetId: "host_safe",
          links: [{ id: "domain_safe", label: "Dominio verificado", verified: true }] },
        { kind: "database", label: "Base Elegible", physicalTargetId: "database_safe",
          links: [{ id: "db_safe", label: "Base asociada verificada", verified: true },
            { id: "db_unverified", label: "Base aún no verificada", verified: false }] },
      ],
    };

    function setup(read: (path: string) => unknown) {
      vi.stubEnv("VITE_PORTAL_CATALOG_SCHEDULE_UI_ENABLED", "true");
      const first = apiMock.get.getMockImplementation()!;
      apiMock.get.mockImplementation((path: string) => {
        if (path.startsWith("/schedules?origin=special")) return Promise.resolve({
          items: [frecuencia({ name: "Programación base", id: sourceId, notes: "nota privada no copiada",
            reminders: { remindersEnabled: true, reminderDaysBefore: [1], reminderTime: "08:00",
              reminderRecipientsMode: "customEmails", customReminderEmails: ["privado@example.test"] } })],
          page: 1, pageSize: 10, total: 1,
        });
        if (path.startsWith(prefix)) return read(path);
        if (path === `/schedules/${encodeURIComponent(sourceId)}/catalog-copy-proposals`) return Promise.resolve({ items: [] });
        return first(path);
      });
      renderPagina();
    }

    it("abre un borrador independiente y preselecciona solo destinos verificados sin conflicto, aunque la cobertura sea parcial", async () => {
      setup(() => Promise.resolve(preview));
      fireEvent.click(await screen.findByRole("button", { name: "Duplicar" }));
      const copy = within(await screen.findByRole("region", { name: "Borrador de copia" }));
      expect(copy.getByLabelText("Fecha de la copia")).toHaveValue(hoyEnBogotaIso());
      expect(copy.getByLabelText("Nombre de la copia")).toHaveValue("Programación base (copia)");
      expect(await copy.findByText(/cobertura parcial/i)).toBeInTheDocument();
      expect(apiMock.get).toHaveBeenCalledWith(prefix + hoyEnBogotaIso(), { signal: expect.any(AbortSignal) });
      expect(copy.getByRole("button", { name: "Permitir doble" })).toBeDisabled();
      expect(copy.queryByRole("checkbox")).not.toBeInTheDocument();
      fireEvent.click(copy.getByRole("button", { name: "Trabajar con las restantes" }));
      const chosen = copy.getByRole("checkbox", { name: "Base asociada verificada" });
      expect(chosen).toBeChecked();
      expect(copy.getByRole("checkbox", { name: "Dominio verificado" })).toBeChecked();
      expect(copy.getByRole("heading", { name: "Destinos restantes del borrador" })).toHaveFocus();
      expect(copy.getByText("2 de 2 destinos seleccionados")).toBeInTheDocument();
      expect(copy.queryByRole("checkbox", { name: "No copiar dominio ocupado" })).not.toBeInTheDocument();
      expect(copy.queryByRole("checkbox", { name: "Base aún no verificada" })).not.toBeInTheDocument();
      fireEvent.click(chosen);
      expect(chosen).not.toBeChecked();
      expect(copy.getByText("1 de 2 destinos seleccionados")).toBeInTheDocument();
      fireEvent.change(copy.getByLabelText("Nombre de la copia"), { target: { value: "Mi nueva copia" } });
      fireEvent.click(copy.getByRole("button", { name: "Trabajar con las restantes" }));
      expect(chosen).toBeChecked();
      expect(copy.getByText("2 de 2 destinos seleccionados")).toBeInTheDocument();
      expect(copy.getByLabelText("Nombre de la copia")).toHaveValue("Mi nueva copia");
      expect(screen.getByText("Programación base")).toBeInTheDocument();
      expect(copy.queryByRole("button", { name: /guardar|crear|confirmar/i })).not.toBeInTheDocument();
      expect(copy.queryByText(/nota privada|privado@example\.test/)).not.toBeInTheDocument();
      expect(apiMock.post).not.toHaveBeenCalled();
      expect(apiMock.put).not.toHaveBeenCalled();
      expect(apiMock.del).not.toHaveBeenCalled();
      fireEvent.change(copy.getByLabelText("Fecha de la copia"), { target: { value: sumarDiasIso(hoyEnBogotaIso(), 3) } });
      expect(copy.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(copy.queryByText("Hay otra operación.")).not.toBeInTheDocument();
    });

    it("descarta la vista anterior al cambiar fecha, incluso si la respuesta previa llega tarde", async () => {
      let finish: (value: unknown) => void = () => {};
      const otherDate = sumarDiasIso(hoyEnBogotaIso(), 3);
      setup(path => path.endsWith(otherDate)
        ? Promise.resolve({ previewId: "complete_new_date", coverage: "verified", groups: [] })
        : new Promise(resolve => { finish = resolve; }));
      fireEvent.click(await screen.findByRole("button", { name: "Duplicar" }));
      const copy = within(await screen.findByRole("region", { name: "Borrador de copia" }));
      await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(prefix + hoyEnBogotaIso(), expect.objectContaining({ signal: expect.anything() })));
      fireEvent.change(copy.getByLabelText("Fecha de la copia"), { target: { value: otherDate } });
      expect(copy.queryByRole("button", { name: "Trabajar con las restantes" })).not.toBeInTheDocument();
      fireEvent.click(copy.getByRole("button", { name: "Verificar destinos" }));
      expect(await copy.findByText("No quedan destinos verificados sin conflicto.")).toBeInTheDocument();
      await act(async () => finish(preview));
      expect(copy.getByRole("button", { name: "Trabajar con las restantes" })).toBeDisabled();
      expect(copy.queryByText("Hay otra operación.")).not.toBeInTheDocument();
      expect(apiMock.post).not.toHaveBeenCalled();
    });

    it("envía solo el subconjunto marcado y presenta la copia como pendiente, no activa", async () => {
      vi.stubEnv("VITE_PORTAL_CATALOG_COPY_PROPOSALS_ENABLED", "true");
      apiMock.post.mockResolvedValue({ status: "pending_approval", proposalId: "d44005d7-15c4-4089-8397-6e0ce6f3bd7a" });
      setup(() => Promise.resolve(preview));
      fireEvent.click(await screen.findByRole("button", { name: "Duplicar" }));
      const copy = within(await screen.findByRole("region", { name: "Borrador de copia" }));
      fireEvent.click(await copy.findByRole("button", { name: "Trabajar con las restantes" }));
      fireEvent.click(copy.getByRole("checkbox", { name: "Dominio verificado" }));
      fireEvent.click(copy.getByRole("button", { name: "Solicitar copia" }));
      expect(await copy.findByText(/solicitud guardada, pendiente de aprobación/i)).toBeInTheDocument();
      expect(apiMock.post).toHaveBeenCalledExactlyOnceWith(`/schedules/${encodeURIComponent(sourceId)}/catalog-copy-proposals`, {
        name: "Programación base (copia)", date: hoyEnBogotaIso(), previewId: preview.previewId, linkIds: ["db_safe"],
      });
      expect(apiMock.put).not.toHaveBeenCalled();
      expect(apiMock.del).not.toHaveBeenCalled();
    });

    it("retoma una solicitud guardada y confirma solo con su recibo sin conservarlo en el formulario", async () => {
      vi.stubEnv("VITE_PORTAL_CATALOG_COPY_PROPOSALS_ENABLED", "true");
      const proposalId = "d44005d7-15c4-4089-8397-6e0ce6f3bd7a";
      const reviewId = "05d95fc4-21c3-4adc-8c8d-d23716fe679c";
      const name = "Copia guardada previamente";
      let status = "pending_approval";
      setup(() => Promise.resolve(preview));
      const read = apiMock.get.getMockImplementation()!;
      apiMock.get.mockImplementation((path: string) => path.endsWith("/catalog-copy-proposals")
        ? Promise.resolve({ items: [{ id: proposalId, date: hoyEnBogotaIso(), name, status }] }) : read(path));
      apiMock.post.mockImplementation(() => {
        status = "active";
        return Promise.resolve({ id: `catalog-copy-${proposalId}`, status: "created" });
      });
      fireEvent.click(await screen.findByRole("button", { name: "Duplicar" }));
      const saved = within(await screen.findByRole("article", { name }));
      const receipt = saved.getByLabelText("Recibo de revisión");
      fireEvent.change(receipt, { target: { value: "inválido" } });
      fireEvent.click(saved.getByRole("button", { name: "Confirmar copia revisada" }));
      expect(await saved.findByRole("alert")).toHaveTextContent(/identificador completo/i);
      expect(apiMock.post).not.toHaveBeenCalled();
      fireEvent.change(receipt, { target: { value: reviewId } });
      fireEvent.click(saved.getByRole("button", { name: "Confirmar copia revisada" }));
      expect(receipt).toHaveValue("");
      expect(await saved.findByText(/copia confirmada/i)).toBeInTheDocument();
      expect(await saved.findByText(/fecha: .* activada/i)).toBeInTheDocument();
      expect(apiMock.post).toHaveBeenCalledExactlyOnceWith(
        `/schedules/catalog-copy-proposals/${proposalId}/activate`, { reviewId }, { signal: expect.any(AbortSignal) });
      expect(saved.queryByLabelText("Recibo de revisión")).not.toBeInTheDocument();
    });

    it("no solicita una fecha fuera de la ventana de previsualización del API", async () => {
      setup(() => Promise.resolve(preview));
      fireEvent.click(await screen.findByRole("button", { name: "Duplicar" }));
      const copy = within(await screen.findByRole("region", { name: "Borrador de copia" }));
      await copy.findByText(/cobertura parcial/i);
      const date = copy.getByLabelText("Fecha de la copia");
      expect(date).toHaveAttribute("min", hoyEnBogotaIso());
      expect(date).toHaveAttribute("max", sumarDiasIso(hoyEnBogotaIso(), 7));
      fireEvent.change(date, { target: { value: sumarDiasIso(hoyEnBogotaIso(), 8) } });
      expect(copy.getByRole("button", { name: "Verificar destinos" })).toBeDisabled();
      expect(copy.queryByRole("button", { name: "Trabajar con las restantes" })).not.toBeInTheDocument();
      expect(apiMock.get.mock.calls.filter(([path]) => path.startsWith(prefix))).toHaveLength(1);
    });

    it.each([409, 503])("presenta el HTTP %s como no verificado sin mutaciones ni detalles internos", async status => {
      setup(() => Promise.reject(Object.assign(new Error("detalle privado del servidor"), { status })));
      fireEvent.click(await screen.findByRole("button", { name: "Duplicar" }));
      const copy = within(await screen.findByRole("region", { name: "Borrador de copia" }));
      expect(await copy.findByRole("alert")).toHaveTextContent(/no se pudo verificar/i);
      expect(copy.queryByText("detalle privado del servidor")).not.toBeInTheDocument();
      expect(copy.queryByRole("button", { name: /trabajar con las restantes|guardar/i })).not.toBeInTheDocument();
      expect(apiMock.post).not.toHaveBeenCalled();
      expect(apiMock.put).not.toHaveBeenCalled();
    });
  });

  it("Duplicar abre el formulario precargado y crea una copia al guardar", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/clients") return Promise.resolve([cliente]);
      if (path === "/domains") return Promise.resolve([dominio]);
      if (path === "/databases") return Promise.resolve([]);
      if (path === "/license-modules") return Promise.resolve([modulo]);
      if (path.startsWith("/schedules?origin=special")) return Promise.resolve({
        items: [frecuencia({ id: "s_orig", name: "Programación base", scopeGroups: [{ clientId: "client_1", includeAllDomains: false, domains: [{ domainId: "domain_1", includeAllDatabases: false, databaseIds: [] }] }], selectionMode: "manual", manualTargetTypes: "domains_only" })],
        page: 1, pageSize: 10, total: 1,
      });
      return Promise.resolve([]);
    });
    apiMock.post.mockResolvedValue({ id: "s_copy" });
    renderPagina();
    fireEvent.click(await screen.findByRole("button", { name: /Duplicar/i }));
    // El modal de duplicación precarga el nombre con sufijo "(copia)".
    expect(await screen.findByDisplayValue("Programación base (copia)")).toBeInTheDocument();
    const ambiente = screen.getByRole("combobox", { name: "Ambiente" });
    expect(within(ambiente).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Todos", "Producción", "Pruebas", "Demo",
    ]);
    fireEvent.change(ambiente, { target: { value: "production" } });
    fireEvent.click(screen.getByRole("button", { name: /^Guardar$/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/schedules",
      expect.objectContaining({ name: "Programación base (copia)", manualEnvironment: "production" })));
  });
});
