import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

import AlertasCorreosPage from "../pages/AlertasCorreosPage";

const settings = {
  emailProvider: "smtp",
  emailFrom: "admin@empresa.com",
  emailFromName: "Admin",
  frontendBaseUrl: "https://actual.example.com",
  smtpHost: "smtp.example.com",
  smtpPort: 2525,
  smtpSecure: true,
  smtpUser: "admin@empresa.com",
  smtpPasswordConfigured: true,
  updatedAt: "2026-05-07T12:00:00.000Z",
  remindersEnabled: true,
  defaultReminderDaysBefore: [3, 1, 0],
  defaultReminderTime: "08:00",
  defaultTimezone: "America/Bogota",
  overdueAlertsEnabled: true,
  overdueAlertTime: "08:00",
  overdueAlertTimezone: "America/Bogota",
  overdueAlertRecipientsMode: "admins",
  customAdminAlertEmails: [],
  passwordNotificationEnabled: true,
  sendTemporaryPasswordByEmail: false,
};

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AlertasCorreosPage />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
});

describe("AlertasCorreosPage", () => {
  it("muestra las secciones principales y SMTP avanzado colapsado", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    expect(await screen.findByRole("heading", { name: /Alertas y correos/i })).toBeInTheDocument();
    expect(screen.getByText(/Estado del envío de correos/i)).toBeInTheDocument();
    expect(screen.getByText(/Configuración recomendada rápida/i)).toBeInTheDocument();
    expect(screen.getByText(/Configuración básica/i)).toBeInTheDocument();
    expect(screen.getByText(/Recordatorios a actualizadores/i)).toBeInTheDocument();
    expect(screen.getByText(/Alertas de tareas vencidas/i)).toBeInTheDocument();
    expect(screen.getByText(/Reporte maestro de clientes\/dominios\/empresas/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Enviar correo de prueba/i })).toHaveLength(1);
    const smtpSummary = screen.getByText(/Configuración SMTP avanzada/i);
    expect(smtpSummary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/Contraseña SMTP configurada:/i)).toBeInTheDocument();
  });

  it("muestra ayuda de recordatorios globales y sección de bloqueos no resueltos", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    expect(screen.getByText(/valor por defecto para los recordatorios de dominios/i)).toBeInTheDocument();
    expect(screen.getByText(/Cuando una tarea se bloquee, se enviará una alerta inmediata/i)).toBeInTheDocument();
    expect(screen.getByText(/Recordatorios si el bloqueo sigue sin resolverse/i)).toBeInTheDocument();
    expect(screen.queryByText(/Enviar inmediatamente al bloquear/i)).toBeNull();
  });

  it("recordatorios administrativos usan último día hábil por defecto y día fijo muestra input", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    const reglas = screen.getAllByLabelText(/Regla de envío/i) as HTMLSelectElement[];
    expect(reglas[0].value).toBe("last_business_day");
    expect(screen.queryByLabelText(/^Día del mes$/i)).toBeNull();
    fireEvent.change(reglas[0], { target: { value: "fixed_day" } });
    expect(screen.getByLabelText(/^Día del mes$/i)).toBeInTheDocument();
  });

  it("el botón de configuración recomendada de P&A llena los valores correctos sin contraseña", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByRole("button", { name: /Usar configuración recomendada de P&A/i }));
    expect(screen.getAllByDisplayValue("info@pya.com.co").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByDisplayValue("Programador de Actualizaciones")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://agreeable-wave-07469d50f.7.azurestaticapps.net")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Configuración SMTP avanzada/i));
    expect(screen.getByDisplayValue("smtp.office365.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("587")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/valor-prueba-no-real/i)).toBeNull();
  });

  it("permite enviar correo de prueba", async () => {
    apiMock.get.mockResolvedValueOnce({ ...settings, emailProvider: "mock", smtpPasswordConfigured: false });
    apiMock.post.mockResolvedValueOnce({ ok: true, message: "Correo de prueba enviado correctamente." });
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.change(screen.getByPlaceholderText(/prueba@empresa.com/i), { target: { value: "destino@x.com" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Enviar correo de prueba/i }).at(-1)!);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/settings/email-alerts/test-email", { to: "destino@x.com" }));
    expect(await screen.findByText(/Correo de prueba enviado correctamente/i)).toBeInTheDocument();
  });

  it("acepta destinatarios separados por punto y coma y llama endpoint de reporte", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    apiMock.post.mockResolvedValueOnce({ ok: true, message: "Reporte enviado correctamente." });
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.change(screen.getByPlaceholderText(/correo1@empresa.com; correo2@empresa.com/i), {
      target: { value: "uno@empresa.com; dos@empresa.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enviar reporte/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/reports/masters/send-email", { recipients: "uno@empresa.com; dos@empresa.com" }));
    expect(await screen.findByText(/Reporte enviado correctamente/i)).toBeInTheDocument();
  });

  it("la sección SMTP muestra el botón 'Guardar configuración SMTP'", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByText(/Configuración SMTP avanzada/i));
    expect(screen.getByRole("button", { name: /Guardar configuración SMTP/i })).toBeInTheDocument();
  });

  it("guardar SMTP llama PUT /settings/email-alerts y muestra el mensaje de éxito", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    apiMock.put.mockResolvedValueOnce({ ...settings, smtpPasswordConfigured: true });
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByText(/Configuración SMTP avanzada/i));
    fireEvent.click(screen.getByRole("button", { name: /Guardar configuración SMTP/i }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Configuración SMTP guardada correctamente/i)).toBeInTheDocument();
  });

  it("guardar SMTP sin contraseña NO envía smtpPassword al backend (preserva la actual)", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    apiMock.put.mockResolvedValueOnce({ ...settings, smtpPasswordConfigured: true });
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByText(/Configuración SMTP avanzada/i));
    fireEvent.click(screen.getByRole("button", { name: /Guardar configuración SMTP/i }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    const [ruta, body] = apiMock.put.mock.calls[0];
    expect(ruta).toBe("/settings/email-alerts");
    expect(body).not.toHaveProperty("smtpPassword");
    expect(body).not.toHaveProperty("smtpPasswordConfigured");
  });

  it("guardar SMTP con contraseña nueva la envía y luego limpia el campo", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    apiMock.put.mockResolvedValueOnce({ ...settings, smtpPasswordConfigured: true });
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByText(/Configuración SMTP avanzada/i));
    fireEvent.click(screen.getByRole("button", { name: /Cambiar contraseña SMTP/i }));
    const inputPwd = screen.getByLabelText(/Contraseña SMTP/i) as HTMLInputElement;
    fireEvent.change(inputPwd, { target: { value: "AppPwd-1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar configuración SMTP/i }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.put.mock.calls[0];
    expect(body.smtpPassword).toBe("AppPwd-1234");
    // Tras el éxito el campo de contraseña queda limpio en el DOM:
    await waitFor(() => {
      expect(screen.queryByDisplayValue("AppPwd-1234")).toBeNull();
    });
    // Y el indicador "Sí" sigue visible.
    expect(screen.getByText(/Contraseña SMTP configurada:/i).parentElement?.textContent).toMatch(/Sí/);
  });

  it("Cancelar en SMTP descarta cambios locales y recarga la configuración guardada", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByText(/Configuración SMTP avanzada/i));
    const inputHost = screen.getByDisplayValue("smtp.example.com") as HTMLInputElement;
    fireEvent.change(inputHost, { target: { value: "smtp.cambiado.com" } });
    expect(inputHost.value).toBe("smtp.cambiado.com");
    fireEvent.click(screen.getByRole("button", { name: /^Cancelar$/i }));
    // Vuelve al valor original:
    expect((screen.getByDisplayValue("smtp.example.com") as HTMLInputElement).value).toBe("smtp.example.com");
  });

  it("muestra error si guardar SMTP falla y NO limpia el formulario", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    apiMock.put.mockRejectedValueOnce(new Error("Error en Key Vault"));
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByText(/Configuración SMTP avanzada/i));
    fireEvent.click(screen.getByRole("button", { name: /Cambiar contraseña SMTP/i }));
    fireEvent.change(screen.getByLabelText(/Contraseña SMTP/i), { target: { value: "Secreto-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar configuración SMTP/i }));
    expect(await screen.findByText(/Error en Key Vault/i)).toBeInTheDocument();
    // El input de contraseña no se borra cuando hay error
    expect((screen.getByLabelText(/Contraseña SMTP/i) as HTMLInputElement).value).toBe("Secreto-1");
  });

  it("rechaza destinatarios inválidos antes de enviar reporte", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.change(screen.getByPlaceholderText(/correo1@empresa.com; correo2@empresa.com/i), {
      target: { value: "uno@empresa.com; correo-malo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enviar reporte/i }));
    expect(await screen.findByText("El correo ‘correo-malo’ no tiene un formato válido.")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
