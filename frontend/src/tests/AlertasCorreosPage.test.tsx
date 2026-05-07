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
    expect(screen.getByText(/Configuración básica/i)).toBeInTheDocument();
    expect(screen.getByText(/Recordatorios a actualizadores/i)).toBeInTheDocument();
    expect(screen.getByText(/Alertas a administradores/i)).toBeInTheDocument();
    expect(screen.getByText(/Reporte de clientes\/dominios\/empresas/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Correo de prueba/i).length).toBeGreaterThanOrEqual(1);
    const smtpSummary = screen.getByText(/Configuración avanzada SMTP/i);
    expect(smtpSummary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/Contraseña SMTP configurada:/i)).toBeInTheDocument();
  });

  it("el botón de configuración recomendada de P&A llena los valores correctos sin contraseña", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.click(screen.getByRole("button", { name: /Usar configuración recomendada de P&A/i }));
    expect(screen.getAllByDisplayValue("info@pya.com.co").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByDisplayValue("Programador de Actualizaciones")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://agreeable-wave-07469d50f.7.azurestaticapps.net")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Configuración avanzada SMTP/i));
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

  it("rechaza destinatarios inválidos antes de enviar reporte", async () => {
    apiMock.get.mockResolvedValueOnce(settings);
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.change(screen.getByPlaceholderText(/correo1@empresa.com; correo2@empresa.com/i), {
      target: { value: "uno@empresa.com; correo-malo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enviar reporte/i }));
    expect(await screen.findByText(/Correo inválido: correo-malo/i)).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
