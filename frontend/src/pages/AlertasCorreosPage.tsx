import { useEffect, useState } from "react";
import type React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Alerta } from "../components/Comunes";
import { ETIQUETAS_ROLES, DIAS_SEMANA } from "../types";

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
  overdueAlertRecipientRoleIds?: string[];
  overdueAlertCustomEmails?: string[];
  overdueAlertFrequency?: "daily" | "weekly";
  overdueAlertWeekdays?: string[];
  blockedAlertsEnabled?: boolean;
  blockedAlertRecipientRoleIds?: string[];
  blockedAlertCustomEmails?: string[];
  blockedAlertSendImmediately?: boolean;
  blockedAlertIncludeInOverdueSummary?: boolean;
  blockedReminderEnabled?: boolean;
  blockedReminderDaysAfter?: number[];
  blockedReminderTime?: string;
  blockedReminderTimezone?: string;
  administrativeReminders?: {
    sagWebVersionReminder: AdminReminder;
    whatsNewReminder: AdminReminder;
  };
  passwordNotificationEnabled: boolean;
  sendTemporaryPasswordByEmail: boolean;
};

type AdminReminder = {
  enabled: boolean;
  recipients: string[];
  sendRule?: "first_day" | "last_day" | "last_business_day" | "fixed_day";
  dayOfMonth: number;
  time: string;
  timezone: string;
  subject: string;
};

const RUTA = "/settings/email-alerts";
const PYA_DEFAULTS = {
  emailProvider: "smtp" as const,
  emailFrom: "info@pya.com.co",
  emailFromName: "Portal SAG Web",
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "info@pya.com.co",
  frontendBaseUrl: "https://agreeable-wave-07469d50f.7.azurestaticapps.net",
};
const ADMIN_REMINDER_DEFAULTS: Settings["administrativeReminders"] = {
  sagWebVersionReminder: {
    enabled: false,
    recipients: [],
    sendRule: "last_business_day",
    dayOfMonth: 1,
    time: "08:00",
    timezone: "America/Bogota",
    subject: "Recordatorio: guardar la última versión mensual de SAG Web",
  },
  whatsNewReminder: {
    enabled: false,
    recipients: [],
    sendRule: "last_business_day",
    dayOfMonth: 1,
    time: "08:00",
    timezone: "America/Bogota",
    subject: "Recordatorio: crear documento \"¿Qué hay de nuevo en SAG Web?\"",
  },
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
  return invalido ? `El correo ‘${invalido}’ no tiene un formato válido.` : null;
}

function Acordeon({ titulo, resumen, children, abiertoInicial = true }: { titulo: string; resumen?: string; children: React.ReactNode; abiertoInicial?: boolean }) {
  return (
    <details className="acordeon" open={abiertoInicial}>
      <summary><span>{titulo}</span>{resumen && <small>{resumen}</small>}</summary>
      <div className="acordeon-contenido">{children}</div>
    </details>
  );
}

function Tooltip({ texto }: { texto: string }) {
  return <span className="tooltip" title={texto}>ⓘ</span>;
}

function alternar(lista: string[] = [], valor: string): string[] {
  return lista.includes(valor) ? lista.filter((x) => x !== valor) : [...lista, valor];
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
  const [resultadoAdmin, setResultadoAdmin] = useState<{ ok: boolean; message: string; details?: string } | null>(null);

  useEffect(() => {
    if (data) {
      setForm({
        ...PYA_DEFAULTS,
        ...data,
        overdueAlertRecipientRoleIds: data.overdueAlertRecipientRoleIds ?? ["admin"],
        overdueAlertCustomEmails: data.overdueAlertCustomEmails ?? data.customAdminAlertEmails ?? [],
        overdueAlertFrequency: data.overdueAlertFrequency ?? "daily",
        overdueAlertWeekdays: data.overdueAlertWeekdays ?? ["MONDAY"],
        blockedAlertsEnabled: data.blockedAlertsEnabled ?? true,
        blockedAlertRecipientRoleIds: data.blockedAlertRecipientRoleIds ?? ["admin"],
        blockedAlertCustomEmails: data.blockedAlertCustomEmails ?? [],
        blockedAlertSendImmediately: data.blockedAlertSendImmediately ?? true,
        blockedReminderEnabled: data.blockedReminderEnabled ?? false,
        blockedReminderDaysAfter: data.blockedReminderDaysAfter ?? [1, 3, 5],
        blockedReminderTime: data.blockedReminderTime ?? "08:00",
        blockedReminderTimezone: data.blockedReminderTimezone ?? "America/Bogota",
        administrativeReminders: {
          sagWebVersionReminder: { ...ADMIN_REMINDER_DEFAULTS!.sagWebVersionReminder, ...data.administrativeReminders?.sagWebVersionReminder },
          whatsNewReminder: { ...ADMIN_REMINDER_DEFAULTS!.whatsNewReminder, ...data.administrativeReminders?.whatsNewReminder },
        },
      });
    }
  }, [data]);

  // `mensajeExito` permite a quien dispara el guardado personalizar el mensaje
  // (por ejemplo "Configuración SMTP guardada correctamente.").
  const guardar = useMutation({
    mutationFn: ({ body }: { body: any; mensajeExito?: string }) => api.put<Settings>(RUTA, body),
    onSuccess: (s, variables) => {
      qc.setQueryData(["settings-email-alerts"], s);
      setExito(variables?.mensajeExito ?? "Configuración guardada.");
      setError(null);
      // Por seguridad: limpiar siempre el campo local de contraseña SMTP.
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

  const enviarPruebaAdmin = useMutation({
    mutationFn: ({ key, recipients }: { key: "sag-web-version" | "whats-new"; recipients: string }) =>
      api.post<{ ok: boolean; message: string; details?: string }>(`${RUTA}/administrative-reminders/${key}/test`, { recipients }),
    onSuccess: (r) => setResultadoAdmin(r),
    onError: (e: any) => setResultadoAdmin({ ok: false, message: e?.message ?? "Error al enviar la prueba." }),
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
      if ((form.overdueAlertCustomEmails ?? []).some((e) => !isEmail(e))) return setError("Ingrese correos válidos separados por punto y coma para las alertas de vencidos.");
      if (form.overdueAlertFrequency === "weekly" && (form.overdueAlertWeekdays ?? []).length === 0) return setError("Seleccione al menos un día para la frecuencia semanal.");
    }
    if ((form.blockedAlertCustomEmails ?? []).some((e) => !isEmail(e))) return setError("Ingrese correos válidos separados por punto y coma para las alertas de bloqueos.");
    if (form.blockedReminderEnabled && !(form.blockedReminderDaysAfter ?? []).every((n) => Number.isFinite(n) && n > 0)) return setError("Los días después del bloqueo deben ser números mayores a 0.");
    for (const r of Object.values(form.administrativeReminders ?? {})) {
      if ((r.sendRule ?? "last_business_day") === "fixed_day" && (r.dayOfMonth < 1 || r.dayOfMonth > 28)) return setError("El día fijo de los recordatorios administrativos debe estar entre 1 y 28.");
      if (r.recipients.some((e) => !isEmail(e))) return setError("Hay destinatarios inválidos en recordatorios administrativos.");
    }
    const body: any = { ...form };
    if (cambiarPwd && smtpPassword) body.smtpPassword = smtpPassword;
    delete body.smtpPasswordConfigured;
    delete body.updatedAt;
    guardar.mutate({ body });
  }

  // Guarda únicamente la sección SMTP. Si el campo de contraseña está vacío
  // NO envía smtpPassword, por lo que el backend conserva la contraseña actual.
  function guardarSmtp() {
    setError(null);
    setExito(null);
    if (!form) return;
    if (form.emailProvider === "smtp") {
      if (!form.smtpHost) return setError("El servidor SMTP es obligatorio.");
      if (!form.smtpPort || form.smtpPort < 1 || form.smtpPort > 65535) return setError("El puerto SMTP debe estar entre 1 y 65535.");
      if (!form.smtpUser || !isEmail(form.smtpUser)) return setError("El usuario SMTP debe ser un correo válido.");
    }
    if (!isEmail(form.emailFrom)) return setError("El correo remitente no es válido.");
    const body: any = {
      emailProvider: form.emailProvider,
      emailFrom: form.emailFrom,
      emailFromName: form.emailFromName,
      frontendBaseUrl: form.frontendBaseUrl,
      smtpHost: form.smtpHost,
      smtpPort: form.smtpPort,
      smtpSecure: !!form.smtpSecure,
      smtpUser: form.smtpUser,
    };
    // Solo se envía smtpPassword si el usuario escribió una nueva.
    if (cambiarPwd && smtpPassword) body.smtpPassword = smtpPassword;
    guardar.mutate({ body, mensajeExito: "Configuración SMTP guardada correctamente." });
  }

  // Descarta cambios locales y vuelve a la configuración guardada.
  function cancelarSmtp() {
    if (data) setForm({ ...PYA_DEFAULTS, ...data });
    setSmtpPassword("");
    setCambiarPwd(false);
    setError(null);
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
  const adminActivos = Object.values(form.administrativeReminders ?? {}).filter((r) => r.enabled).length;

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

      <Acordeon titulo="Configuración básica" resumen={`${form.emailFromName} · ${form.emailFrom}`}>
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
            <button type="button" onClick={() => setCambiarPwd(true)}>{form.smtpPasswordConfigured ? "Cambiar contraseña SMTP" : "Configurar contraseña SMTP"}</button>
          ) : (
            <>
              <input
                type="password"
                autoComplete="new-password"
                aria-label="Contraseña SMTP"
                value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)}
              />
              <p className="texto-ayuda" style={{ marginTop: 4 }}>
                Si deja este campo vacío, se conservará la contraseña actual.
              </p>
              <button type="button" style={{ marginTop: 6 }} onClick={() => { setCambiarPwd(false); setSmtpPassword(""); }}>
                Descartar nueva contraseña
              </button>
            </>
          )}
        </div>

        <div className="acciones-formulario" style={{ marginTop: 12 }}>
          <button type="button" onClick={cancelarSmtp} disabled={guardar.isPending}>Cancelar</button>
          <button type="button" className="primario" onClick={guardarSmtp} disabled={guardar.isPending}>
            {guardar.isPending ? "Guardando..." : "Guardar configuración SMTP"}
          </button>
        </div>
      </Acordeon>

      <Acordeon titulo="Recordatorios a actualizadores" resumen={`${form.remindersEnabled ? "Activo" : "Inactivo"} · ${form.defaultReminderDaysBefore.join(",")} días · ${form.defaultReminderTime} · ${form.defaultTimezone}`}>
        <p className="texto-ayuda">Esta configuración se usará como valor por defecto para los recordatorios de actualizaciones programadas, salvo que se defina una configuración específica.</p>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.remindersEnabled} onChange={(e) => actualizar("remindersEnabled", e.target.checked)} />
          Activar recordatorios automáticos
        </label></div>
        {form.remindersEnabled && (
          <>
            <div className="fila-formulario"><label>Días previos separados por coma <Tooltip texto="0 significa el mismo día de la actualización." /></label>
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

      <Acordeon titulo="Alertas de tareas vencidas" resumen={`${form.overdueAlertsEnabled ? "Activo" : "Inactivo"} · ${form.overdueAlertFrequency === "weekly" ? "Semanal" : "Diaria"} · ${form.overdueAlertTime}`}>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.overdueAlertsEnabled} onChange={(e) => actualizar("overdueAlertsEnabled", e.target.checked)} />
          Activar alertas de vencidos <Tooltip texto="Las tareas vencidas son tareas con fecha programada anterior a hoy que aún no están completadas ni canceladas." />
        </label></div>
        {form.overdueAlertsEnabled && (
          <>
            <h4>Frecuencia de alertas de vencidos</h4>
            <div className="fila-formulario"><label>Frecuencia <Tooltip texto="Define si el resumen de vencidos se envía máximo una vez al día o una vez por semana configurada." /></label>
              <select value={form.overdueAlertFrequency ?? "daily"} onChange={(e) => actualizar("overdueAlertFrequency", e.target.value as any)}>
                <option value="daily">Diaria</option>
                <option value="weekly">Semanal</option>
              </select></div>
            {(form.overdueAlertFrequency ?? "daily") === "weekly" && (
              <div className="fila-formulario"><label>Días de semana</label>
                {Object.entries(DIAS_SEMANA).map(([k, v]) => (
                  <label key={k} style={{ display: "inline-flex", alignItems: "center", marginRight: 12, fontWeight: 400 }}>
                    <input type="checkbox" style={{ width: "auto", marginRight: 4 }} checked={(form.overdueAlertWeekdays ?? []).includes(k)} onChange={() => actualizar("overdueAlertWeekdays", alternar(form.overdueAlertWeekdays, k))} />
                    {v}
                  </label>
                ))}
              </div>
            )}
            <div className="fila-formulario"><label>Hora de envío</label>
              <p className="texto-ayuda">Hora local en la que se intentará enviar la alerta. <Tooltip texto="El timer puede correr varias veces, pero el sistema evita duplicados del mismo periodo." /></p>
              <input value={form.overdueAlertTime} onChange={(e) => actualizar("overdueAlertTime", e.target.value)} /></div>
            <div className="fila-formulario"><label>Zona horaria</label>
              <p className="texto-ayuda">Zona usada para calcular las alertas de vencidos. <Tooltip texto="Use America/Bogota para operar con hora Colombia." /></p>
              <input value={form.overdueAlertTimezone} onChange={(e) => actualizar("overdueAlertTimezone", e.target.value)} /></div>
            <h4>Destinatarios de alertas</h4>
            <RolesChecklist label="Roles destinatarios" valores={form.overdueAlertRecipientRoleIds ?? []} onChange={(v) => actualizar("overdueAlertRecipientRoleIds", v)} />
            <div className="fila-formulario"><label>Correos adicionales <Tooltip texto="Separe varios correos con punto y coma. Los duplicados se eliminan al enviar." /></label>
              <input placeholder="vencidos1@empresa.com; vencidos2@empresa.com" value={(form.overdueAlertCustomEmails ?? []).join("; ")}
                onChange={(e) => actualizar("overdueAlertCustomEmails", parseCorreos(e.target.value))} /></div>
          </>
        )}
      </Acordeon>

      <Acordeon titulo="Alertas de tareas bloqueadas / errores de actualización" resumen={`${form.blockedAlertsEnabled ?? true ? "Activo" : "Inactivo"} · Roles: ${(form.blockedAlertRecipientRoleIds ?? []).length} · ${(form.blockedAlertCustomEmails ?? []).length} correos adicionales`}>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.blockedAlertsEnabled ?? true} onChange={(e) => actualizar("blockedAlertsEnabled", e.target.checked)} />
          Activar alertas de bloqueos <Tooltip texto="Una tarea bloqueada representa un error de actualización o un bloqueo operativo." />
        </label></div>
        <RolesChecklist label="Roles destinatarios" valores={form.blockedAlertRecipientRoleIds ?? []} onChange={(v) => actualizar("blockedAlertRecipientRoleIds", v)} />
        <div className="fila-formulario"><label>Correos adicionales</label>
          <input placeholder="bloqueos1@empresa.com; bloqueos2@empresa.com" value={(form.blockedAlertCustomEmails ?? []).join("; ")}
            onChange={(e) => actualizar("blockedAlertCustomEmails", parseCorreos(e.target.value))} /></div>
        <Alerta tipo="info">Cuando una tarea se bloquee, se enviará una alerta inmediata a los destinatarios configurados.</Alerta>
        <h4>Recordatorios si el bloqueo sigue sin resolverse</h4>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.blockedReminderEnabled ?? false} onChange={(e) => actualizar("blockedReminderEnabled", e.target.checked)} />
          Activar recordatorios de bloqueos no resueltos <Tooltip texto="Solo se envían si la tarea sigue bloqueada en los días configurados." />
        </label></div>
        {form.blockedReminderEnabled && (
          <>
            <div className="fila-formulario"><label>Días después del bloqueo <Tooltip texto="Ejemplo: 1,3,5 enviará recordatorios al día 1, 3 y 5 si sigue bloqueada." /></label>
              <input value={(form.blockedReminderDaysAfter ?? []).join(", ")} onChange={(e) => actualizar("blockedReminderDaysAfter", e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0))} />
            </div>
            <div className="fila-formulario"><label>Hora de envío</label>
              <input value={form.blockedReminderTime ?? "08:00"} onChange={(e) => actualizar("blockedReminderTime", e.target.value)} /></div>
            <div className="fila-formulario"><label>Zona horaria</label>
              <input value={form.blockedReminderTimezone ?? "America/Bogota"} onChange={(e) => actualizar("blockedReminderTimezone", e.target.value)} /></div>
          </>
        )}
      </Acordeon>

      <Acordeon titulo="Recordatorios administrativos" resumen={`${adminActivos} activos · Último día hábil del mes`}>
        {form.administrativeReminders && (
          <>
            <AdminReminderCard
              titulo="Guardar versión mensual de SAG Web"
              valor={form.administrativeReminders.sagWebVersionReminder}
              onChange={(v) => actualizar("administrativeReminders", { ...form.administrativeReminders!, sagWebVersionReminder: v })}
              onTest={(recipients) => enviarPruebaAdmin.mutate({ key: "sag-web-version", recipients })}
            />
            <AdminReminderCard
              titulo={'Crear documento "¿Qué hay de nuevo en SAG Web?"'}
              valor={form.administrativeReminders.whatsNewReminder}
              onChange={(v) => actualizar("administrativeReminders", { ...form.administrativeReminders!, whatsNewReminder: v })}
              onTest={(recipients) => enviarPruebaAdmin.mutate({ key: "whats-new", recipients })}
            />
            {resultadoAdmin && <Alerta tipo={resultadoAdmin.ok ? "exito" : "error"}>{resultadoAdmin.message}{resultadoAdmin.details && <div>{resultadoAdmin.details}</div>}</Alerta>}
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

function RolesChecklist({ label, valores, onChange }: { label: string; valores: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="fila-formulario"><label>{label} <Tooltip texto="Se resolverán los usuarios activos con estos roles y se deduplicarán con los correos manuales." /></label>
      {Object.entries(ETIQUETAS_ROLES).map(([k, v]) => (
        <label key={k} style={{ display: "inline-flex", alignItems: "center", marginRight: 12, fontWeight: 400 }}>
          <input type="checkbox" style={{ width: "auto", marginRight: 4 }} checked={valores.includes(k)} onChange={() => onChange(alternar(valores, k))} />
          {v}
        </label>
      ))}
    </div>
  );
}

function AdminReminderCard({ titulo, valor, onChange, onTest }: { titulo: string; valor: AdminReminder; onChange: (v: AdminReminder) => void; onTest: (recipients: string) => void }) {
  const recipientsText = valor.recipients.join("; ");
  const sendRule = valor.sendRule ?? "last_business_day";
  const idBase = titulo.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <div className="tarjeta tarjeta-compacta">
      <h4>{titulo}</h4>
      <div className="fila-formulario"><label>
        <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={valor.enabled} onChange={(e) => onChange({ ...valor, enabled: e.target.checked })} />
        Activar recordatorio
      </label></div>
      <div className="fila-formulario"><label>Destinatarios</label>
        <input value={recipientsText} onChange={(e) => onChange({ ...valor, recipients: parseCorreos(e.target.value) })} placeholder="persona1@pya.com.co; persona2@pya.com.co" /></div>
      <div className="fila-formulario"><label htmlFor={`${idBase}-regla`}>Regla de envío <Tooltip texto="Último día hábil envía viernes y lunes si el mes termina en fin de semana." /></label>
        <select id={`${idBase}-regla`} value={sendRule} onChange={(e) => onChange({ ...valor, sendRule: e.target.value as any })}>
          <option value="first_day">Primer día del mes</option>
          <option value="last_day">Último día del mes</option>
          <option value="last_business_day">Último día hábil del mes</option>
          <option value="fixed_day">Día fijo del mes</option>
        </select></div>
      {sendRule === "fixed_day" && (
        <div className="fila-formulario"><label htmlFor={`${idBase}-dia`}>Día del mes</label>
          <input id={`${idBase}-dia`} type="number" min={1} max={28} value={valor.dayOfMonth} onChange={(e) => onChange({ ...valor, dayOfMonth: Number(e.target.value) })} /></div>
      )}
      <div className="fila-formulario"><label>Hora</label>
        <input value={valor.time} onChange={(e) => onChange({ ...valor, time: e.target.value })} /></div>
      <div className="fila-formulario"><label>Zona horaria</label>
        <input value={valor.timezone} onChange={(e) => onChange({ ...valor, timezone: e.target.value })} /></div>
      <div className="fila-formulario"><label>Asunto del correo</label>
        <input value={valor.subject} onChange={(e) => onChange({ ...valor, subject: e.target.value })} /></div>
      <button type="button" onClick={() => onTest(recipientsText)}>Enviar prueba</button>
    </div>
  );
}
