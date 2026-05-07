import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: apiMock }));

import AlertasCorreosPage from "../pages/AlertasCorreosPage";

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AlertasCorreosPage />
    </QueryClientProvider>
  );
}

describe("AlertasCorreosPage", () => {
  it("muestra las secciones principales y nunca renderiza la contraseña SMTP", async () => {
    apiMock.get.mockResolvedValueOnce({
      emailProvider: "smtp", emailFrom: "info@pya.com.co", emailFromName: "X",
      smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecure: false, smtpUser: "info@pya.com.co",
      smtpPasswordConfigured: true,
      remindersEnabled: true, defaultReminderDaysBefore: [3, 1, 0], defaultReminderTime: "08:00", defaultTimezone: "America/Bogota",
      overdueAlertsEnabled: true, overdueAlertTime: "08:00", overdueAlertTimezone: "America/Bogota", overdueAlertRecipientsMode: "admins",
      passwordNotificationEnabled: true, sendTemporaryPasswordByEmail: false,
    });
    render_();
    expect(await screen.findByRole("heading", { name: /Alertas y correos/i })).toBeInTheDocument();
    expect(screen.getByText(/Proveedor de correo/i)).toBeInTheDocument();
    expect(screen.getByText(/Configuración SMTP/i)).toBeInTheDocument();
    expect(screen.getByText(/Recordatorios a actualizadores/i)).toBeInTheDocument();
    expect(screen.getByText(/Alertas a administradores/i)).toBeInTheDocument();
    expect(screen.getByText(/Notificaciones de contraseña/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Enviar correo de prueba/i })).toBeInTheDocument();
    // Estado mostrado.
    expect(screen.getByText(/Contraseña configurada/i)).toBeInTheDocument();
    expect(screen.getByText(/Sí/i)).toBeInTheDocument();
  });

  it("permite enviar correo de prueba", async () => {
    apiMock.get.mockResolvedValueOnce({
      emailProvider: "mock", emailFrom: "a@b.com", emailFromName: "X",
      remindersEnabled: false, defaultReminderDaysBefore: [], defaultReminderTime: "08:00", defaultTimezone: "America/Bogota",
      overdueAlertsEnabled: false, overdueAlertTime: "08:00", overdueAlertTimezone: "America/Bogota", overdueAlertRecipientsMode: "admins",
      passwordNotificationEnabled: false, sendTemporaryPasswordByEmail: false,
      smtpPasswordConfigured: false,
    });
    apiMock.post.mockResolvedValueOnce({ ok: true, message: "Correo de prueba enviado correctamente." });
    render_();
    await screen.findByRole("heading", { name: /Alertas y correos/i });
    fireEvent.change(screen.getByPlaceholderText(/prueba@empresa.com/i), { target: { value: "destino@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar correo de prueba/i }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/settings/email-alerts/test-email", { to: "destino@x.com" }));
    expect(await screen.findByText(/Correo de prueba enviado correctamente/i)).toBeInTheDocument();
  });
});
