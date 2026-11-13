import { useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alerta, Modal } from "../components/Comunes";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../permissionModel";
import { hasPermissionForRoleIds } from "../permissionAccess";

/*
  Agregar logo a la compañía (Implementación).
  Las llaves solo viven en el estado de esta pantalla: no se guardan en el
  navegador ni en el servidor. Al terminar o al limpiar, se borran.
*/

const BASE = "/implementation/company-logo";
const MAX_BYTES = 2 * 1024 * 1024;
const ALMACENAMIENTO_FIJO = "https://storcube.sagweb.co:8333";
/* Hoja con los datos de almacenamiento de cada compañía (acceso restringido por correo en Google). */
const HOJA_ALMACENAMIENTO = "https://docs.google.com/spreadsheets/d/1lZQ2gpeKZ-lDu3vFQ17y2-Ngw-bXr6bw2-4FBpucCLM/edit?gid=232262362#gid=232262362";

type ExistingLogo = { name: string; bytes: number; lastModified: string | null };
type CheckResult = { folder: string; existing: ExistingLogo[] };
type UploadResult = {
  url: string;
  fileName: string;
  bytes: number;
  replacedCount: number;
  sql: string;
  sqlFileName: string;
};

type Form = { bucket: string; accessKey: string; secretKey: string; databaseName: string };
const EMPTY: Form = { bucket: "", accessKey: "", secretKey: "", databaseName: "" };

type Imagen = { name: string; base64: string; previewUrl: string; bytes: number };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Ocurrió un error inesperado.";
}

function trimmedForm(form: Form): Form {
  return {
    bucket: form.bucket.trim(),
    accessKey: form.accessKey.trim(),
    secretKey: form.secretKey.trim(),
    databaseName: form.databaseName.trim(),
  };
}

/** Validación en pantalla (el API vuelve a validar todo). Devuelve el primer problema o null. */
export function validateLogoForm(form: Form): string | null {
  const value = trimmedForm(form);
  if (!value.bucket) return "Escriba el bucket (contenedor del almacenamiento).";
  if (value.bucket.length < 3 || value.bucket.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value.bucket) || value.bucket.includes("..")) {
    return "El bucket solo admite minúsculas, números, puntos y guiones (entre 3 y 63 caracteres).";
  }
  if (!value.accessKey) return "Escriba la llave de acceso (access key).";
  if (/\s/.test(value.accessKey)) return "La llave de acceso no puede tener espacios en medio.";
  if (!value.secretKey) return "Escriba la llave secreta (secret key).";
  if (/\s/.test(value.secretKey)) return "La llave secreta no puede tener espacios en medio.";
  if (value.secretKey.length < 8) return "La llave secreta parece incompleta. Cópiela de nuevo.";
  if (!value.databaseName) return "Escriba el nombre de la base de datos de la compañía.";
  if (!/^[A-Za-z0-9_-]+$/.test(value.databaseName)) {
    return "El nombre de la base de datos solo admite letras sin tildes, números, guion y guion bajo (sin espacios).";
  }
  return null;
}

function downloadSql(result: UploadResult): void {
  const blob = new Blob([result.sql], { type: "application/sql;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.sqlFileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readImage(file: File): Promise<Imagen> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve({ name: file.name, base64: dataUrl.slice(dataUrl.indexOf(",") + 1), previewUrl: dataUrl, bytes: file.size });
    };
    reader.onerror = () => reject(new Error("No fue posible leer la imagen."));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function LogoCompaniaPage() {
  const auth = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Form>({ ...EMPTY });
  const [imagen, setImagen] = useState<Imagen | null>(null);
  const [notice, setNotice] = useState<{ type: "error" | "exito" | "info"; text: string } | null>(null);
  const [existing, setExisting] = useState<ExistingLogo[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  const { data: roleResponse } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
  });
  const roles = Array.isArray(roleResponse) && roleResponse.length > 0 ? roleResponse : DEFAULT_ROLE_DEFINITIONS;
  const roleIds = auth.cargando || !auth.usuario ? [] : auth.usuario.roles;
  const canUpload = hasPermissionForRoleIds(roleIds, "implementation.company_logo.upload", roles);

  const formProblem = validateLogoForm(form);
  const allFilled = Boolean(form.bucket.trim() && form.accessKey.trim() && form.secretKey.trim() && form.databaseName.trim() && imagen);
  const folder = `${form.databaseName.trim() || "{base de datos}"}/Archivos/Imagenes/LogoEmpresa/`;

  function update(field: keyof Form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setExisting(null);
  }

  async function onImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!/\.(png|jpe?g)$/.test(name)) {
      setNotice({ type: "error", text: "La imagen debe ser PNG o JPG." });
      event.target.value = "";
      return;
    }
    if (file.size > MAX_BYTES) {
      setNotice({ type: "error", text: "La imagen supera 2 MB. Redúzcala e intente de nuevo." });
      event.target.value = "";
      return;
    }
    try {
      setImagen(await readImage(file));
      setNotice(null);
    } catch (error) {
      setNotice({ type: "error", text: messageOf(error) });
    }
  }

  const check = useMutation({
    mutationFn: () => api.post<CheckResult>(`${BASE}/check`, trimmedForm(form)),
  });

  const upload = useMutation({
    mutationFn: (replaceConfirmed: boolean) => api.post<UploadResult>(`${BASE}/upload`, {
      ...trimmedForm(form),
      imageBase64: imagen!.base64,
      imageName: imagen!.name,
      replaceConfirmed,
    }),
    onSuccess: (response) => {
      setConfirming(false);
      setResult(response);
      downloadSql(response);
      // Las llaves ya no se necesitan: se borran de la pantalla.
      setForm((current) => ({ ...current, accessKey: "", secretKey: "" }));
      setNotice({
        type: "exito",
        text: response.replacedCount > 0
          ? "Logo subido. El SQL se descargó: ejecútelo en la base de la compañía para que SAG Web muestre el logo nuevo. Las imágenes anteriores se conservan."
          : "Logo subido. El SQL se descargó: ejecútelo en la base de la compañía.",
      });
    },
    onError: (error) => {
      setConfirming(false);
      setNotice({ type: "error", text: messageOf(error) });
    },
  });

  async function testConnection() {
    if (formProblem) { setNotice({ type: "error", text: formProblem }); return; }
    try {
      const response = await check.mutateAsync();
      setExisting(response.existing);
      setNotice({
        type: "info",
        text: response.existing.length > 0
          ? `Conexión correcta. Esta compañía ya tiene ${response.existing.length === 1 ? "un logo" : `${response.existing.length} imágenes de logo`} en el almacenamiento.`
          : "Conexión correcta. Esta compañía todavía no tiene logo en el almacenamiento.",
      });
    } catch (error) {
      setExisting(null);
      setNotice({ type: "error", text: messageOf(error) });
    }
  }

  async function start() {
    if (formProblem) { setNotice({ type: "error", text: formProblem }); return; }
    if (!imagen) { setNotice({ type: "error", text: "Seleccione la imagen del logo." }); return; }
    setResult(null);
    try {
      const response = await check.mutateAsync();
      setExisting(response.existing);
      if (response.existing.length > 0) setConfirming(true);
      else upload.mutate(false);
    } catch (error) {
      setNotice({ type: "error", text: messageOf(error) });
    }
  }

  function reset() {
    setForm({ ...EMPTY });
    setImagen(null);
    setExisting(null);
    setResult(null);
    setNotice(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  const busy = check.isPending || upload.isPending;

  return (
    <div>
      <div className="encabezado-pagina"><h1>Agregar logo a la compañía</h1></div>
      <Alerta tipo="info">
        Sube el logo al almacenamiento de la compañía y genera el SQL que lo activa en SAG Web.
        Las llaves no se guardan en ningún lugar: se usan solo durante la subida.
      </Alerta>
      {notice ? <div role={notice.type === "error" ? "alert" : "status"}><Alerta tipo={notice.type}>{notice.text}</Alerta></div> : null}

      <section className="tarjeta conexion-panel">
        <div className="conexion-panel-titulo">
          <div>
            <h2>Datos del almacenamiento</h2>
            <p className="texto-ayuda">
              Cópielos de la hoja de almacenamiento de las compañías:{" "}
              <a href={HOJA_ALMACENAMIENTO} target="_blank" rel="noopener noreferrer">abrir la hoja de almacenamiento (pestaña nueva)</a>.
            </p>
          </div>
        </div>
        <div className="logo-grid">
          <label htmlFor="logo-bucket">Bucket (contenedor del almacenamiento)
            <input id="logo-bucket" className="valor-tecnico" value={form.bucket} onChange={(e) => update("bucket", e.target.value)} placeholder="cliente.sagerp.cloud.buk" autoComplete="off" spellCheck={false} disabled={!canUpload} />
          </label>
          <label htmlFor="logo-base">Nombre de la base de datos de la compañía
            <input id="logo-base" className="valor-tecnico" value={form.databaseName} onChange={(e) => update("databaseName", e.target.value)} placeholder="SAGWebCliente" autoComplete="off" spellCheck={false} disabled={!canUpload} />
            <small className="texto-ayuda">Es la carpeta de la compañía: {folder}</small>
          </label>
          <label htmlFor="logo-access" className="logo-campo-ancho">Llave de acceso (access key)
            <input id="logo-access" className="valor-tecnico" value={form.accessKey} onChange={(e) => update("accessKey", e.target.value)} autoComplete="off" spellCheck={false} disabled={!canUpload} />
          </label>
          <label htmlFor="logo-secret" className="logo-campo-ancho">Llave secreta (secret key)
            <input id="logo-secret" className="valor-tecnico" value={form.secretKey} onChange={(e) => update("secretKey", e.target.value)} autoComplete="off" spellCheck={false} disabled={!canUpload} />
          </label>
          <label htmlFor="logo-imagen" className="logo-campo-ancho">Imagen del logo (PNG o JPG, máximo 2 MB)
            <input id="logo-imagen" ref={fileInput} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" onChange={onImage} disabled={!canUpload} />
          </label>
        </div>
        {imagen ? (
          <div className="logo-vista-previa">
            <img src={imagen.previewUrl} alt="Vista previa del logo seleccionado" />
            <span className="texto-ayuda">{imagen.name} · {formatBytes(imagen.bytes)}</span>
          </div>
        ) : null}
        <p className="texto-ayuda">Servidor, puerto y ruta son fijos para todas las compañías: {ALMACENAMIENTO_FIJO} · Archivos/</p>

        {existing && existing.length > 0 ? (
          <div className="logo-existentes">
            <strong>Imágenes de logo que ya existen</strong>
            <ul>
              {existing.map((item) => (
                <li key={item.name}><code>{item.name}</code> · {formatBytes(item.bytes)}{item.lastModified ? ` · ${new Date(item.lastModified).toLocaleString("es-CO")}` : ""}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {canUpload ? (
          <div className="acciones-formulario logo-acciones">
            <button onClick={reset} disabled={busy}>Limpiar</button>
            <button onClick={testConnection} disabled={busy || !form.bucket.trim() || !form.accessKey.trim() || !form.secretKey.trim() || !form.databaseName.trim()}>
              {check.isPending && !upload.isPending ? "Probando..." : "Probar conexión"}
            </button>
            <button className="primario" onClick={start} disabled={busy || !allFilled} title={allFilled ? undefined : "Complete los cinco datos para habilitar este botón."}>
              {upload.isPending ? "Subiendo..." : "Subir logo y generar SQL"}
            </button>
          </div>
        ) : <Alerta tipo="info">Su rol puede ver esta opción, pero no subir logos.</Alerta>}
      </section>

      {result ? (
        <section className="tarjeta conexion-panel" aria-label="Resultado">
          <div className="conexion-panel-titulo">
            <div>
              <h2>SQL listo</h2>
              <p className="texto-ayuda">Ejecútelo en la base de datos de la compañía. Muestra el logo antes y después del cambio.</p>
            </div>
            <button className="primario" onClick={() => downloadSql(result)}>Descargar el SQL de nuevo</button>
          </div>
          <p><strong>Archivo:</strong> <code>{result.sqlFileName}</code></p>
          <p><strong>URL del logo:</strong> <code className="logo-url">{result.url}</code></p>
          <pre className="logo-sql">{result.sql}</pre>
          <div className="acciones-formulario">
            <button onClick={reset}>Subir otro logo</button>
          </div>
        </section>
      ) : null}

      <Modal titulo="Esta compañía ya tiene logo" abierto={confirming} onCerrar={() => setConfirming(false)}>
        <p>
          En el almacenamiento ya {existing && existing.length === 1 ? "hay una imagen" : `hay ${existing?.length ?? 0} imágenes`} de logo.
          ¿Desea reemplazarlo por el logo nuevo?
        </p>
        <p className="texto-ayuda">
          Las imágenes anteriores no se borran: el logo actual sigue funcionando hasta que se ejecute el SQL nuevo en la base de la compañía.
        </p>
        <div className="acciones-formulario">
          <button onClick={() => setConfirming(false)} disabled={upload.isPending}>Cancelar</button>
          <button className="primario" onClick={() => upload.mutate(true)} disabled={upload.isPending}>
            {upload.isPending ? "Subiendo..." : "Sí, reemplazar"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
