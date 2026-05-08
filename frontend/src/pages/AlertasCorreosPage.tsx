import { useEffect, useState } from "react";
import type React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Alerta } from "../components/Comunes";

type Settings = {
  emailProvider: "mock" | "smtp" | "sendgrid" | "acs";
  emailFrom: string;
  emailFromName: string;
  frontendBaseUrl?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPasswordConfigured?: boolean;
  updatedAt?: string;
  remindersEnabled: boolean;
  defaultReminderDaysBefore: number[];
  defaultReminderTime: string;
  defaultTimezone: string;
  overdueAlertsEnabled: boolean;
  overdueAlertTime: string;
  overdueAlertTimezone: string;
  overdueAlertRecipientsMode: "admins" | "adminsAndClientManagers" | "customEmails";
  customAdminAlertEmails?: string[];
  passwordNotificationEnabled: boolean;
  sendTemporaryPasswordByEmail: boolean;
};

const RUTA = "/settings/email-alerts";
const PYA_DEFAULTS = {
  emailProvider: "smtp" as const,
  emailFrom: "info@pya.com.co",
  emailFromName: "Programador de Actualizaciones",
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "info@pya.com.co",
  frontendBaseUrl: "https://agreeable-wave-07469d50f.7.azurestaticapps.net",
};

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function parseCorreos(valor: string): string[] {
  return valor.split(";").map((x) => x.trim()).filter(Boolean);
}

function validarCorreosSeparadosPorPuntoYComa(valor: string): string | null {
  const correos = parseCorreos(valor);
  if (correos.length === 0) return "Ingrese al menos un correo.";
  const invalido = correos.find((correo) => !isEmail(correo));
  return invalido ? `Correo inválido: ${invalido}` : null;
}

function Acordeon({ titulo, children, abiertoInicial = true }: { titulo: string; children: React.ReactNode; abiertoInicial?: boolean }) {
  return (
    <details className="acordeon" open={abiertoInicial}>
      <summary>{titulo}</summary>
      <div className="acordeon-contenido">{children}</div>
    </details>
  );
}

export default function AlertasCorreosPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["settings-email-alerts"],
    queryFn: () => api.get<Settings>(RUTA),
  });

  const [form, setForm] = useState<Settings | null>(null);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [cambiarPwd, setCambiarPwd] = useState(false);
  const [destinatarioPrueba, setDestinatarioPrueba] = useState("");
  const [destinatariosReporte, setDestinatariosReporte] = useState("");
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultadoPrueba, setResultadoPrueba] = useState<{ ok: boolean; message: string; details?: string } | null>(null);
  const [resultadoReporte, setResultadoReporte] = useState<{ ok: boolean; message: string; details?: string } | null>(null);

  useEffect(() => { if (data) setForm({ ...PYA_DEFAULTS, ...data }); }, [data]);

  const guardar = useMutation({
    mutationFn: (body: any) => api.put<Settings>(RUTA, body),
    onSuccess: (s) => {
      qc.setQueryData(["settings-email-alerts"], s);
      setExito("Configuración guardada.");
      setError(null);
      setSmtpPassword("");
      setCambiarPwd(false);
    },
    onError: (e: any) => setError(e?.message ?? "Error al guardar."),
  });

  const enviarPrueba = useMutation({
    mutationFn: (to: string) => api.post<{ ok: boolean; message: string; details?: string }>(`${RUTA}/test-email`, { to }),
    onSuccess: (r) => setResultadoPrueba(r),
    onError: (e: any) => setResultadoPrueba({ ok: false, message: e?.message ?? "Error desconocido." }),
  });

  const enviarReporte = useMutation({
    mutationFn: (recipients: string) => api.post<{ ok: boolean; sent?: boolean; recipientsCount?: number; message: string; details?: string }>("/reports/masters/send-email", { recipients }),
    onSuccess: (r) => setResultadoReporte(r),
    onError: (e: any) => setResultadoReporte({ ok: false, message: e?.message ?? "Error al enviar el reporte." }),
  });

  if (isLoading || !form) return <div className="cargando">Cargando configuración...</div>;

  function actualizar<K extends keyof Settings>(k: K, v: Settings[K]) {
    setForm((f) => (f ? { ...f, [k]: v } : f));
  }

  function usarConfiguracionPya() {
    setForm((f) => (f ? { ...f, ...PYA_DEFAULTS } : f));
    setSmtpPassword("");
    setCambiarPwd(false);
    setExito("Configuración recomendada de P&A cargada. Escriba la contraseña SMTP solo si desea cambiarla.");
    setError(null);
  }

  function validarYGuardar() {
    setError(null);
    setExito(null);
    if (!form) return;
    if (!isEmail(form.emailFrom)) return setError("El correo remitente no es válido.");
    if (form.emailProvider === "smtp") {
      if (!form.smtpHost) return setError("El servidor SMTP es obligatorio.");
      if (!form.smtpPort || form.smtpPort < 1 || form.smtpPort > 65535) return setError("El puerto SMTP debe estar entre 1 y 65535.");
      if (!form.smtpUser || !isEmail(form.smtpUser)) return setError("El usuario SMTP debe ser un correo válido.");
    }
    if (form.remindersEnabled) {
      if (!form.defaultReminderTime) return setError("La hora de recordatorios es obligatoria.");
      if (!form.defaultReminderDaysBefore.every((n) => Number.isFinite(n) && n >= 0)) return setError("Los días previos deben ser números mayores o iguales a 0.");
    }
    if (form.overdueAlertsEnabled) {
      if (!form.overdueAlertTime) return setError("La hora de alertas de vencidos es obligatoria.");
      if (form.overdueAlertRecipientsMode === "customEmails") {
        const lista = form.customAdminAlertEmails ?? [];
        if (lista.length === 0 || !lista.every(isEmail)) return setError("Ingrese correos válidos separados por punto y coma para las alertas personalizadas.");
      }
    }
    const body: any = { ...form };
    if (cambiarPwd && smtpPassword) body.smtpPassword = smtpPassword;
    delete body.smtpPasswordConfigured;
    delete body.updatedAt;
    guardar.mutate(body);
  }

  function probar() {
    setResultadoPrueba(null);
    if (!isEmail(destinatarioPrueba)) {
      setResultadoPrueba({ ok: false, message: "El correo destinatario no es válido." });
      return;
    }
    enviarPrueba.mutate(destinatarioPrueba);
  }

  function enviarReporteManual() {
    setResultadoReporte(null);
    const errorCorreos = validarCorreosSeparadosPorPuntoYComa(destinatariosReporte);
    if (errorCorreos) {
      setResultadoReporte({ ok: false, message: errorCorreos });
      return;
    }
    enviarReporte.mutate(destinatariosReporte);
  }

  const proveedor = form.emailProvider === "mock" ? "Mock" : form.emailProvider.toUpperCase();

  return (
    <>
      <div className="encabezado-pagina"><h2>Alertas y correos</h2></div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      <div className="tarjeta estado-correo">
        <div>
          <h3>Estado del envío de correos</h3>
          <p><strong>Proveedor actual:</strong> {proveedor}</p>
          <p className="texto-ayuda">Indica si los correos se están simulando o enviando realmente.</p>
          <p><strong>Correo remitente actual:</strong> {form.emailFrom}</p>
          <p><strong>Contraseña SMTP configurada:</strong> {form.smtpPasswordConfigured ? "Sí" : "No"}</p>
          <p className="texto-ayuda">Por seguridad no se muestra la contraseña. Solo se indica si ya fue guardada.</p>
          <p><strong>Última actualización:</strong> {form.updatedAt ? new Date(form.updatedAt).toLocaleString("es-CO") : "Sin cambios registrados"}</p>
          {form.emailProvider === "mock"
            ? <Alerta tipo="info">El envío está en modo simulado. No se enviarán correos reales.</Alerta>
            : <Alerta tipo="exito">El envío real de correos está activo.</Alerta>}
        </div>
      </div>

      <Acordeon titulo="Configuración recomendada rápida">
        <p className="texto-ayuda">Llena los valores sugeridos para Office 365. No llena la contraseña.</p>
        <button type="button" onClick={usarConfiguracionPya}>Usar configuración recomendada de P&A</button>
      </Acordeon>

      <Acordeon titulo="Configuración básica del remitente">
        <div className="fila-formulario" style={{ marginTop: 12 }}><label>Correo remitente</label>
          <p className="texto-ayuda">Correo desde el cual saldrán las notificaciones.</p>
          <input type="email" value={form.emailFrom} onChange={(e) => actualizar("emailFrom", e.target.value)} /></div>
        <div className="fila-formulario"><label>Nombre del remitente</label>
          <p className="texto-ayuda">Nombre visible que verá el destinatario del correo.</p>
          <input value={form.emailFromName} onChange={(e) => actualizar("emailFromName", e.target.value)} /></div>
        <div className="fila-formulario"><label>URL de la aplicación</label>
          <p className="texto-ayuda">Enlace usado en los botones de los correos.</p>
          <input value={form.frontendBaseUrl ?? ""} onChange={(e) => actualizar("frontendBaseUrl", e.target.value)} /></div>
      </Acordeon>

      <Acordeon titulo="Configuración SMTP avanzada" abiertoInicial={false}>
        <p className="texto-ayuda">Estos valores normalmente no necesitan cambiarse. Modifíquelos solo si cambia la cuenta de correo o el proveedor.</p>
        <div className="fila-formulario"><label>Proveedor</label>
          <select value={form.emailProvider} onChange={(e) => actualizar("emailProvider", e.target.value as any)}>
            <option value="mock">Simulado (mock)</option>
            <option value="smtp">SMTP</option>
            <option value="sendgrid">SendGrid</option>
            <option value="acs">Azure Communication Services</option>
          </select></div>
        <div className="fila-formulario"><label>Servidor SMTP</label>
          <input value={form.smtpHost ?? ""} onChange={(e) => actualizar("smtpHost", e.target.value)} placeholder="smtp.office365.com" /></div>
        <div className="fila-formulario"><label>Puerto</label>
          <input type="number" min={1} max={65535} value={form.smtpPort ?? 587} onChange={(e) => actualizar("smtpPort", Number(e.target.value))} /></div>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={!!form.smtpSecure} onChange={(e) => actualizar("smtpSecure", e.target.checked)} />
          SSL/TLS
        </label></div>
        <div className="fila-formulario"><label>Usuario SMTP</label>
          <input type="email" value={form.smtpUser ?? ""} onChange={(e) => actualizar("smtpUser", e.target.value)} /></div>
        <div className="fila-formulario">
          <label>Contraseña de aplicación SMTP</label>
          <p className="texto-ayuda">La contraseña actual no se muestra por seguridad. Escriba una nueva solo si desea cambiarla.</p>
          <p className="texto-ayuda">Contraseña configurada: <strong>{form.smtpPasswordConfigured ? "Sí" : "No"}</strong></p>
          {!cambiarPwd ? (
            <button onClick={() => setCambiarPwd(true)}>{form.smtpPasswordConfigured ? "Cambiar contraseña SMTP" : "Configurar contraseña SMTP"}</button>
          ) : (
            <>
              <input type="password" autoComplete="new-password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} />
              <button style={{ marginTop: 6 }} onClick={() => { setCambiarPwd(false); setSmtpPassword(""); }}>Cancelar</button>
            </>
          )}
        </div>
      </Acordeon>

      <Acordeon titulo="Recordatorios a actualizadores">
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.remindersEnabled} onChange={(e) => actualizar("remindersEnabled", e.target.checked)} />
          Activar recordatorios automáticos
        </label></div>
        {form.remindersEnabled && (
          <>
            <div className="fila-formulario"><label>Días previos separados por coma</label>
              <input value={form.defaultReminderDaysBefore.join(", ")}
                onChange={(e) => {
                  const arr = e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
                  actualizar("defaultReminderDaysBefore", arr);
                }} />
              <p className="texto-ayuda">Ejemplo: 3,1,0 enviará recordatorios 3 días antes, 1 día antes y el mismo día.</p>
            </div>
            <div className="fila-formulario"><label>Hora de envío</label>
              <p className="texto-ayuda">Hora local en la que se intentará enviar el recordatorio.</p>
              <input value={form.defaultReminderTime} onChange={(e) => actualizar("defaultReminderTime", e.target.value)} /></div>
            <div className="fila-formulario"><label>Zona horaria</label>
              <p className="texto-ayuda">Zona usada para calcular fechas y horas de envío.</p>
              <input value={form.defaultTimezone} onChange={(e) => actualizar("defaultTimezone", e.target.value)} /></div>
            <details>
              <summary>Opciones avanzadas de destinatarios</summary>
              <p className="texto-ayuda">Por defecto los recordatorios se envían a los usuarios asignados en las tareas.</p>
            </details>
          </>
        )}
      </Acordeon>

      <Acordeon titulo="Alertas de tareas vencidas">
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.overdueAlertsEnabled} onChange={(e) => actualizar("overdueAlertsEnabled", e.target.checked)} />
          Activar alertas de vencidos
        </label></div>
        {form.overdueAlertsEnabled && (
          <>
            <div className="fila-formulario"><label>Hora de envío</label>
              <p className="texto-ayuda">Hora local en la que se intentará enviar la alerta.</p>
              <input value={form.overdueAlertTime} onChange={(e) => actualizar("overdueAlertTime", e.target.value)} /></div>
            <div className="fila-formulario"><label>Zona horaria</label>
              <p className="texto-ayuda">Zona usada para calcular las alertas de vencidos.</p>
              <input value={form.overdueAlertTimezone} onChange={(e) => actualizar("overdueAlertTimezone", e.target.value)} /></div>
            <div className="fila-formulario"><label>Destinatarios</label>
              <p className="texto-ayuda">Puedes usar administradores activos o correos específicos separados por punto y coma.</p>
              <select value={form.overdueAlertRecipientsMode} onChange={(e) => actualizar("overdueAlertRecipientsMode", e.target.value as any)}>
                <option value="admins">Administradores activos</option>
                <option value="adminsAndClientManagers">Administradores + administradores de clientes</option>
                <option value="customEmails">Correos personalizados</option>
              </select></div>
            {form.overdueAlertRecipientsMode === "customEmails" && (
              <div className="fila-formulario"><label>Correos personalizados</label>
                <input placeholder="correo1@empresa.com; correo2@empresa.com; correo3@empresa.com" value={(form.customAdminAlertEmails ?? []).join("; ")}
                  onChange={(e) => actualizar("customAdminAlertEmails", parseCorreos(e.target.value))} /></div>
            )}
          </>
        )}
      </Acordeon>

      <Acordeon titulo="Reporte maestro de clientes/dominios/empresas">
        <p className="texto-ayuda">Envía un resumen de clientes, dominios y bases sin datos sensibles.</p>
        <div className="fila-formulario"><label>Destinatarios</label>
          <input value={destinatariosReporte} onChange={(e) => setDestinatariosReporte(e.target.value)} placeholder="correo1@empresa.com; correo2@empresa.com" /></div>
        <button className="primario" onClick={enviarReporteManual} disabled={enviarReporte.isPending}>{enviarReporte.isPending ? "Enviando..." : "Enviar reporte"}</button>
        {resultadoReporte && (
          <div style={{ marginTop: 12 }}>
            <Alerta tipo={resultadoReporte.ok ? "exito" : "error"}>
              {resultadoReporte.message}
              {resultadoReporte.details && <div style={{ fontSize: 12, marginTop: 4 }}>Detalles: {resultadoReporte.details}</div>}
            </Alerta>
          </div>
        )}
      </Acordeon>

      <Acordeon titulo="Correo de prueba">
        <p className="texto-ayuda">Envía un correo de prueba para validar la configuración actual.</p>
        <div className="fila-formulario"><label>Destinatario</label>
          <input type="email" value={destinatarioPrueba} onChange={(e) => setDestinatarioPrueba(e.target.value)} placeholder="prueba@empresa.com" /></div>
        <button onClick={probar} disabled={enviarPrueba.isPending}>{enviarPrueba.isPending ? "Enviando..." : "Enviar correo de prueba"}</button>
        {resultadoPrueba && (
          <div style={{ marginTop: 12 }}>
            <Alerta tipo={resultadoPrueba.ok ? "exito" : "error"}>
              {resultadoPrueba.message}
              {resultadoPrueba.details && <div style={{ fontSize: 12, marginTop: 4 }}>Detalles: {resultadoPrueba.details}</div>}
            </Alerta>
          </div>
        )}
      </Acordeon>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginBottom: 24 }}>
        <button className="primario" onClick={validarYGuardar} disabled={guardar.isPending}>
          {guardar.isPending ? "Guardando..." : "Guardar configuración"}
        </button>
      </div>
    </>
  );
}
