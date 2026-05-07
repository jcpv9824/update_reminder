import { useEffect, useState } from "react";
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

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
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
  const [exito, setExito] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultadoPrueba, setResultadoPrueba] = useState<{ ok: boolean; message: string; details?: string } | null>(null);

  useEffect(() => { if (data) setForm(data); }, [data]);

  const guardar = useMutation({
    mutationFn: (body: any) => api.put<Settings>(RUTA, body),
    onSuccess: (s) => { qc.setQueryData(["settings-email-alerts"], s); setExito("Configuración guardada."); setError(null); setSmtpPassword(""); setCambiarPwd(false); },
    onError: (e: any) => setError(e?.message ?? "Error al guardar."),
  });

  const enviarPrueba = useMutation({
    mutationFn: (to: string) => api.post<{ ok: boolean; message: string; details?: string }>(`${RUTA}/test-email`, { to }),
    onSuccess: (r) => setResultadoPrueba(r),
    onError: (e: any) => setResultadoPrueba({ ok: false, message: e?.message ?? "Error desconocido." }),
  });

  if (isLoading || !form) return <div className="cargando">Cargando configuración...</div>;

  function actualizar<K extends keyof Settings>(k: K, v: Settings[K]) {
    setForm((f) => (f ? { ...f, [k]: v } : f));
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
        if (lista.length === 0 || !lista.every(isEmail)) return setError("Ingrese correos válidos para las alertas personalizadas.");
      }
    }
    const body: any = { ...form };
    if (cambiarPwd && smtpPassword) body.smtpPassword = smtpPassword;
    delete body.smtpPasswordConfigured;
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

  return (
    <>
      <div className="encabezado-pagina"><h2>Alertas y correos</h2></div>
      {exito && <Alerta tipo="exito">{exito}</Alerta>}
      {error && <Alerta tipo="error">{error}</Alerta>}

      {/* Sección 1: Proveedor */}
      <div className="tarjeta">
        <h3 style={{ marginTop: 0 }}>Proveedor de correo</h3>
        <div className="fila-formulario">
          <label>Proveedor</label>
          <select value={form.emailProvider} onChange={(e) => actualizar("emailProvider", e.target.value as any)}>
            <option value="mock">Simulado (mock)</option>
            <option value="smtp">SMTP</option>
            <option value="sendgrid">SendGrid</option>
            <option value="acs">Azure Communication Services</option>
          </select>
        </div>
        <div className="fila-formulario"><label>Correo remitente *</label>
          <input type="email" value={form.emailFrom} onChange={(e) => actualizar("emailFrom", e.target.value)} /></div>
        <div className="fila-formulario"><label>Nombre del remitente</label>
          <input value={form.emailFromName} onChange={(e) => actualizar("emailFromName", e.target.value)} /></div>
        <div className="fila-formulario"><label>URL de la aplicación</label>
          <input value={form.frontendBaseUrl ?? ""} onChange={(e) => actualizar("frontendBaseUrl", e.target.value)} placeholder="https://miapp.azurestaticapps.net" /></div>
      </div>

      {/* Sección 2: SMTP */}
      {form.emailProvider === "smtp" && (
        <div className="tarjeta">
          <h3 style={{ marginTop: 0 }}>Configuración SMTP</h3>
          <div className="fila-formulario"><label>Servidor SMTP *</label>
            <input value={form.smtpHost ?? ""} onChange={(e) => actualizar("smtpHost", e.target.value)} placeholder="smtp.office365.com" /></div>
          <div className="fila-formulario"><label>Puerto *</label>
            <input type="number" min={1} max={65535} value={form.smtpPort ?? 587} onChange={(e) => actualizar("smtpPort", Number(e.target.value))} /></div>
          <div className="fila-formulario"><label>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={!!form.smtpSecure} onChange={(e) => actualizar("smtpSecure", e.target.checked)} />
            Usar SSL/TLS (puerto 465 o conexión segura)
          </label></div>
          <div className="fila-formulario"><label>Usuario SMTP *</label>
            <input type="email" value={form.smtpUser ?? ""} onChange={(e) => actualizar("smtpUser", e.target.value)} /></div>

          <div className="fila-formulario">
            <label>Contraseña / contraseña de aplicación</label>
            <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 6px" }}>
              La contraseña actual no se muestra por seguridad. Escriba una nueva solo si desea cambiarla.
            </p>
            <p style={{ fontSize: 12, margin: "0 0 6px" }}>
              Contraseña configurada: <strong>{form.smtpPasswordConfigured ? "Sí" : "No"}</strong>
            </p>
            {!cambiarPwd ? (
              <button onClick={() => setCambiarPwd(true)}>{form.smtpPasswordConfigured ? "Cambiar contraseña SMTP" : "Configurar contraseña SMTP"}</button>
            ) : (
              <>
                <input type="password" autoComplete="new-password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} />
                <button style={{ marginTop: 6 }} onClick={() => { setCambiarPwd(false); setSmtpPassword(""); }}>Cancelar</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Sección 3: Recordatorios */}
      <div className="tarjeta">
        <h3 style={{ marginTop: 0 }}>Recordatorios a actualizadores</h3>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.remindersEnabled} onChange={(e) => actualizar("remindersEnabled", e.target.checked)} />
          Activar recordatorios automáticos
        </label></div>
        {form.remindersEnabled && (
          <>
            <div className="fila-formulario"><label>Días previos (separados por coma; 0 = el mismo día)</label>
              <input value={form.defaultReminderDaysBefore.join(", ")}
                onChange={(e) => {
                  const arr = e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
                  actualizar("defaultReminderDaysBefore", arr);
                }} /></div>
            <div className="fila-formulario"><label>Hora de envío (HH:mm)</label>
              <input value={form.defaultReminderTime} onChange={(e) => actualizar("defaultReminderTime", e.target.value)} /></div>
            <div className="fila-formulario"><label>Zona horaria</label>
              <input value={form.defaultTimezone} onChange={(e) => actualizar("defaultTimezone", e.target.value)} /></div>
          </>
        )}
      </div>

      {/* Sección 4: Alertas de vencidos */}
      <div className="tarjeta">
        <h3 style={{ marginTop: 0 }}>Alertas a administradores</h3>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.overdueAlertsEnabled} onChange={(e) => actualizar("overdueAlertsEnabled", e.target.checked)} />
          Activar alertas diarias de vencidos
        </label></div>
        {form.overdueAlertsEnabled && (
          <>
            <div className="fila-formulario"><label>Hora de envío (HH:mm)</label>
              <input value={form.overdueAlertTime} onChange={(e) => actualizar("overdueAlertTime", e.target.value)} /></div>
            <div className="fila-formulario"><label>Zona horaria</label>
              <input value={form.overdueAlertTimezone} onChange={(e) => actualizar("overdueAlertTimezone", e.target.value)} /></div>
            <div className="fila-formulario"><label>Destinatarios</label>
              <select value={form.overdueAlertRecipientsMode} onChange={(e) => actualizar("overdueAlertRecipientsMode", e.target.value as any)}>
                <option value="admins">Administradores activos</option>
                <option value="adminsAndClientManagers">Administradores + administradores de clientes</option>
                <option value="customEmails">Correos personalizados</option>
              </select></div>
            {form.overdueAlertRecipientsMode === "customEmails" && (
              <div className="fila-formulario"><label>Correos personalizados (separados por coma)</label>
                <input value={(form.customAdminAlertEmails ?? []).join(", ")}
                  onChange={(e) => actualizar("customAdminAlertEmails", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} /></div>
            )}
          </>
        )}
      </div>

      {/* Sección 5: Notificaciones de contraseña */}
      <div className="tarjeta">
        <h3 style={{ marginTop: 0 }}>Notificaciones de contraseña</h3>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.passwordNotificationEnabled} onChange={(e) => actualizar("passwordNotificationEnabled", e.target.checked)} />
          Enviar correo al crear usuario o restablecer contraseña
        </label></div>
        <div className="fila-formulario"><label>
          <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={form.sendTemporaryPasswordByEmail} onChange={(e) => actualizar("sendTemporaryPasswordByEmail", e.target.checked)} />
          Incluir la contraseña temporal en el correo
        </label></div>
        {form.sendTemporaryPasswordByEmail && (
          <Alerta tipo="info">
            No se recomienda enviar contraseñas por correo. Use esta opción solo si su política interna lo permite.
          </Alerta>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginBottom: 24 }}>
        <button className="primario" onClick={validarYGuardar} disabled={guardar.isPending}>
          {guardar.isPending ? "Guardando..." : "Guardar configuración"}
        </button>
      </div>

      {/* Sección 6: Correo de prueba */}
      <div className="tarjeta">
        <h3 style={{ marginTop: 0 }}>Enviar correo de prueba</h3>
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
      </div>
    </>
  );
}
