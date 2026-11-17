import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alerta, Modal } from "../components/Comunes";
import AvisoFlotante, { nuevoAviso, type Aviso } from "../components/AvisoFlotante";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../permissionModel";
import { hasPermissionForRoleIds } from "../permissionAccess";

/*
  Almacenamiento de archivos y logo (Implementación).
  Escribe directo en parametros_web de la compañía. Llaves, usuario y
  contraseña de SQL solo viven en el estado de esta pantalla: no se guardan en
  el navegador ni en el servidor. Al terminar o al limpiar, se borran.
*/

const BASE = "/implementation/company-logo";
const MAX_BYTES = 2 * 1024 * 1024;
/* Hoja con los datos de almacenamiento de cada compañía (acceso restringido por correo en Google). */
const HOJA_ALMACENAMIENTO = "https://docs.google.com/spreadsheets/d/1lZQ2gpeKZ-lDu3vFQ17y2-Ngw-bXr6bw2-4FBpucCLM/edit?gid=232262362#gid=232262362";

export type StorageForm = { bucket: string; accessKey: string; secretKey: string };
export type OptionsForm = { endpoint: string; port: string; basePath: string; region: string };
export type DatabaseForm = { server: string; databaseName: string; username: string; password: string };

const EMPTY_STORAGE: StorageForm = { bucket: "", accessKey: "", secretKey: "" };
export const DEFAULT_OPTIONS: OptionsForm = { endpoint: "storcube.sagweb.co", port: "8333", basePath: "Archivos/", region: "us-east-1" };
const EMPTY_DATABASE: DatabaseForm = { server: "", databaseName: "", username: "", password: "" };

type ExistingLogo = { name: string; bytes: number; lastModified: string | null };
type StorageCheck = { folder: string | null; existing: ExistingLogo[] };
type DatabaseCheck = {
  databaseName: string;
  current: { logoUrl: string; bucket: string; folder: string; endpoint: string; port: string; useSsl: string; basePath: string; keysConfigured: boolean };
};
type FieldChange = { field: string; label: string; before: string; after: string };
type Confirmation = {
  changes: FieldChange[];
  keysChanged: boolean;
  currentLogoUrl: string;
  existingLogoCount: number;
  replacesLogo: boolean;
};
type ApplyResult = {
  databaseName: string;
  logoUpdated: boolean;
  logoUrl: string | null;
  previousLogoCount: number;
};

type Imagen = { name: string; base64: string; previewUrl: string; bytes: number };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Ocurrió un error inesperado.";
}

const sinEspacios = (value: string) => !/\s/.test(value);

/* Validación en pantalla (el API vuelve a validar todo). Cada una devuelve el primer problema o null. */
export function validateStorage(form: StorageForm): string | null {
  const bucket = form.bucket.trim();
  const accessKey = form.accessKey.trim();
  const secretKey = form.secretKey.trim();
  if (!bucket) return "Escriba el bucket.";
  if (!sinEspacios(bucket)) return "El bucket no puede tener espacios.";
  if (bucket.length < 3 || bucket.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    return "El bucket solo admite minúsculas, números, puntos y guiones (entre 3 y 63 caracteres).";
  }
  if (!accessKey) return "Escriba el access key.";
  if (!sinEspacios(accessKey)) return "El access key no puede tener espacios.";
  if (!secretKey) return "Escriba el secret key.";
  if (!sinEspacios(secretKey)) return "El secret key no puede tener espacios.";
  if (secretKey.length < 8) return "El secret key parece incompleto. Cópielo de nuevo.";
  return null;
}

export function validateOptions(options: OptionsForm): string | null {
  const endpoint = options.endpoint.trim();
  const port = options.port.trim();
  const basePath = options.basePath.trim();
  const region = options.region.trim();
  if (!endpoint || !sinEspacios(endpoint)) return "Escriba el servidor del almacenamiento, sin espacios.";
  if (!/^[A-Za-z0-9.-]+$/.test(endpoint)) return "Escriba solo el nombre del servidor del almacenamiento, sin https:// ni barras (ej.: storcube.sagweb.co).";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return "El puerto del almacenamiento debe ser un número entre 1 y 65535.";
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/$/.test(basePath)) return "La ruta base debe terminar en / y no tener espacios (ej.: Archivos/).";
  if (!/^[a-z0-9-]+$/.test(region)) return "La región solo admite minúsculas, números y guiones (ej.: us-east-1).";
  return null;
}

export function validateDatabase(form: DatabaseForm): string | null {
  const server = form.server.trim();
  const databaseName = form.databaseName.trim();
  const username = form.username.trim();
  if (!server) return "Escriba el servidor y puerto de la base de datos.";
  if (!sinEspacios(server)) return "El servidor y puerto no puede tener espacios. Escríbalo así: servidor,puerto.";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?:,\d{1,5})?$/.test(server)) {
    return "Escriba el servidor y el puerto así: servidor,puerto (ej.: data14.sagerp.co,54103).";
  }
  if (!databaseName) return "Escriba el nombre de la base de datos.";
  if (!sinEspacios(databaseName)) return "El nombre de la base de datos no puede tener espacios.";
  if (!/^[A-Za-z0-9_-]+$/.test(databaseName)) return "El nombre de la base de datos solo admite letras sin tildes, números, guion y guion bajo.";
  if (!username) return "Escriba el usuario de SQL.";
  if (!sinEspacios(username)) return "El usuario de SQL no puede tener espacios.";
  if (!form.password.trim()) return "Escriba la contraseña de SQL.";
  return null;
}

function storagePayload(form: StorageForm, options: OptionsForm) {
  return {
    bucket: form.bucket.trim(),
    accessKey: form.accessKey.trim(),
    secretKey: form.secretKey.trim(),
    options: {
      endpoint: options.endpoint.trim(),
      port: Number(options.port.trim()),
      basePath: options.basePath.trim(),
      region: options.region.trim(),
    },
  };
}

function databasePayload(form: DatabaseForm) {
  return {
    server: form.server.trim(),
    databaseName: form.databaseName.trim(),
    username: form.username.trim(),
    password: form.password.trim(),
  };
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
  const [storage, setStorage] = useState<StorageForm>({ ...EMPTY_STORAGE });
  const [options, setOptions] = useState<OptionsForm>({ ...DEFAULT_OPTIONS });
  const [database, setDatabase] = useState<DatabaseForm>({ ...EMPTY_DATABASE });
  const [imagen, setImagen] = useState<Imagen | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [ultimoResultado, setUltimoResultado] = useState<Aviso | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [withLogo, setWithLogo] = useState(false);

  const { data: roleResponse } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
  });
  const roles = Array.isArray(roleResponse) && roleResponse.length > 0 ? roleResponse : DEFAULT_ROLE_DEFINITIONS;
  const roleIds = auth.cargando || !auth.usuario ? [] : auth.usuario.roles;
  const canConfigure = hasPermissionForRoleIds(roleIds, "implementation.company_logo.upload", roles);

  const avisar = useCallback((tipo: Aviso["tipo"], texto: string) => {
    const nuevo = nuevoAviso(tipo, texto);
    setAviso(nuevo);
    setUltimoResultado(nuevo);
  }, []);
  const cerrarAviso = useCallback(() => setAviso(null), []);

  const storageFilled = Boolean(storage.bucket.trim() && storage.accessKey.trim() && storage.secretKey.trim());
  const databaseFilled = Boolean(database.server.trim() && database.databaseName.trim() && database.username.trim() && database.password.trim());
  const baseFolder = database.databaseName.trim() || "{nombre de la base de datos}";

  function firstProblem(): string | null {
    return validateStorage(storage) ?? validateOptions(options) ?? validateDatabase(database);
  }

  async function onImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      avisar("error", "La imagen supera 2 MB. Redúzcala e intente de nuevo.");
      event.target.value = "";
      return;
    }
    try {
      setImagen(await readImage(file));
    } catch (error) {
      avisar("error", messageOf(error));
    }
  }

  const storageCheck = useMutation({
    mutationFn: () => {
      const databaseName = database.databaseName.trim();
      return api.post<StorageCheck>(`${BASE}/storage/check`, {
        storage: storagePayload(storage, options),
        ...(databaseName && /^[A-Za-z0-9_-]+$/.test(databaseName) ? { databaseName } : {}),
      });
    },
    onSuccess: (response) => {
      if (!response.folder) {
        avisar("exito", "Conexión correcta con el almacenamiento. Escriba el nombre de la base de datos para revisar si ya tiene logo.");
      } else if (response.existing.length > 0) {
        avisar("info", `Conexión correcta con el almacenamiento. Esta compañía ya tiene ${response.existing.length === 1 ? "un logo" : `${response.existing.length} imágenes de logo`}.`);
      } else {
        avisar("exito", "Conexión correcta con el almacenamiento. Esta compañía todavía no tiene logo.");
      }
    },
    onError: (error) => avisar("error", messageOf(error)),
  });

  const databaseCheck = useMutation({
    mutationFn: () => api.post<DatabaseCheck>(`${BASE}/database/check`, { database: databasePayload(database) }),
    onSuccess: (response) => {
      const current = response.current;
      const estado = current.bucket || current.keysConfigured
        ? `ya tiene almacenamiento configurado${current.bucket ? ` (bucket ${current.bucket})` : ""}`
        : "todavía no tiene almacenamiento configurado";
      avisar("exito", `Conexión correcta con la base ${response.databaseName}. La compañía ${estado}${current.logoUrl ? " y ya tiene logo" : ""}.`);
    },
    onError: (error) => avisar("error", messageOf(error)),
  });

  const apply = useMutation({
    mutationFn: (variables: { confirmed: boolean; logo: boolean }) => api.post<ApplyResult>(`${BASE}/apply`, {
      storage: storagePayload(storage, options),
      database: databasePayload(database),
      ...(variables.logo && imagen ? { logo: { imageBase64: imagen.base64, imageName: imagen.name } } : {}),
      confirmed: variables.confirmed,
    }),
    onSuccess: (response) => {
      setConfirmation(null);
      // Las llaves y la contraseña ya no se necesitan: se borran de la pantalla.
      setStorage((current) => ({ ...current, accessKey: "", secretKey: "" }));
      setDatabase((current) => ({ ...current, password: "" }));
      avisar("exito", response.logoUpdated
        ? `Almacenamiento de archivos configurado y logo actualizado en ${response.databaseName}. Cierre sesión en SAG Web y vuelva a entrar para ver el logo nuevo.`
        : `Almacenamiento de archivos configurado en ${response.databaseName}.`);
    },
    onError: (error) => {
      const apiError = error as ApiError;
      if (apiError.status === 409 && apiError.data?.requiresConfirmation) {
        setConfirmation(apiError.data as unknown as Confirmation);
        return;
      }
      setConfirmation(null);
      avisar("error", messageOf(error));
    },
  });

  function start(logo: boolean) {
    const problem = firstProblem();
    if (problem) { avisar("error", problem); return; }
    if (logo && !imagen) { avisar("error", "Adjunte la imagen del logo."); return; }
    setWithLogo(logo);
    apply.mutate({ confirmed: false, logo });
  }

  function testStorage() {
    const problem = validateStorage(storage) ?? validateOptions(options);
    if (problem) { avisar("error", problem); return; }
    storageCheck.mutate();
  }

  function testDatabase() {
    const problem = validateDatabase(database);
    if (problem) { avisar("error", problem); return; }
    databaseCheck.mutate();
  }

  function reset() {
    setStorage({ ...EMPTY_STORAGE });
    setOptions({ ...DEFAULT_OPTIONS });
    setDatabase({ ...EMPTY_DATABASE });
    setImagen(null);
    setAviso(null);
    setUltimoResultado(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  const busy = storageCheck.isPending || databaseCheck.isPending || apply.isPending;
  const disabled = !canConfigure || busy;

  return (
    <div>
      <AvisoFlotante aviso={aviso} onCerrar={cerrarAviso} />
      <div className="encabezado-pagina"><h1>Almacenamiento de archivos y logo</h1></div>
      {ultimoResultado ? <Alerta tipo={ultimoResultado.tipo}>{ultimoResultado.texto}</Alerta> : null}
      {!canConfigure ? <Alerta tipo="info">Su rol puede ver esta opción, pero no configurar el almacenamiento ni subir logos.</Alerta> : null}

      <section className="tarjeta conexion-panel" aria-labelledby="titulo-almacenamiento">
        <h2 id="titulo-almacenamiento">1. Almacenamiento de objetos</h2>
        <div className="logo-grid">
          <label htmlFor="logo-bucket">Bucket
            <input id="logo-bucket" className="valor-tecnico" value={storage.bucket} onChange={(e) => setStorage({ ...storage, bucket: e.target.value })} placeholder="cliente.sagerp.cloud.buk" autoComplete="off" spellCheck={false} disabled={disabled} />
          </label>
          <label htmlFor="logo-access">Access key
            <input id="logo-access" className="valor-tecnico" value={storage.accessKey} onChange={(e) => setStorage({ ...storage, accessKey: e.target.value })} autoComplete="off" spellCheck={false} disabled={disabled} />
          </label>
          <label htmlFor="logo-secret" className="logo-campo-ancho">Secret key
            <input id="logo-secret" className="valor-tecnico" value={storage.secretKey} onChange={(e) => setStorage({ ...storage, secretKey: e.target.value })} autoComplete="off" spellCheck={false} disabled={disabled} />
          </label>
        </div>
        <p className="texto-ayuda">
          Los datos del almacenamiento de cada compañía están en la{" "}
          <a href={HOJA_ALMACENAMIENTO} target="_blank" rel="noopener noreferrer">hoja de almacenamiento (se abre en una pestaña nueva)</a>.
        </p>
        <details className="logo-adicionales">
          <summary>Configurar parámetros adicionales (opcional)</summary>
          <div className="logo-grid">
            <label htmlFor="logo-endpoint">Servidor del almacenamiento
              <input id="logo-endpoint" className="valor-tecnico" value={options.endpoint} onChange={(e) => setOptions({ ...options, endpoint: e.target.value })} autoComplete="off" spellCheck={false} disabled={disabled} />
            </label>
            <label htmlFor="logo-port">Puerto
              <input id="logo-port" className="valor-tecnico" inputMode="numeric" value={options.port} onChange={(e) => setOptions({ ...options, port: e.target.value })} autoComplete="off" disabled={disabled} />
            </label>
            <label htmlFor="logo-basepath">Ruta base
              <input id="logo-basepath" className="valor-tecnico" value={options.basePath} onChange={(e) => setOptions({ ...options, basePath: e.target.value })} autoComplete="off" spellCheck={false} disabled={disabled} />
            </label>
            <label htmlFor="logo-region">Región
              <input id="logo-region" className="valor-tecnico" value={options.region} onChange={(e) => setOptions({ ...options, region: e.target.value })} autoComplete="off" spellCheck={false} disabled={disabled} />
            </label>
          </div>
          <p className="texto-ayuda">La conexión al almacenamiento siempre es cifrada (HTTPS) y solo se permiten servidores aprobados (por defecto, los de sagweb.co).</p>
          <div className="acciones-formulario">
            <button type="button" onClick={() => setOptions({ ...DEFAULT_OPTIONS })} disabled={disabled}>Restaurar valores por defecto</button>
          </div>
        </details>
        <div className="acciones-formulario">
          <button type="button" onClick={testStorage} disabled={disabled || !storageFilled}>
            {storageCheck.isPending ? "Probando..." : "Probar conexión"}
          </button>
        </div>
      </section>

      <section className="tarjeta conexion-panel" aria-labelledby="titulo-base">
        <h2 id="titulo-base">2. Acceso a la base de datos de la compañía</h2>
        <div className="logo-grid">
          <label htmlFor="bd-servidor">Servidor y puerto
            <input id="bd-servidor" className="valor-tecnico" value={database.server} onChange={(e) => setDatabase({ ...database, server: e.target.value })} placeholder="servidor,puerto" autoComplete="off" spellCheck={false} disabled={disabled} />
          </label>
          <label htmlFor="bd-nombre">Nombre de la base de datos
            <input id="bd-nombre" className="valor-tecnico" value={database.databaseName} onChange={(e) => setDatabase({ ...database, databaseName: e.target.value })} autoComplete="off" spellCheck={false} disabled={disabled} />
            <small className="texto-ayuda">También es la carpeta del almacenamiento: {baseFolder}/{options.basePath.trim()}</small>
          </label>
          <label htmlFor="bd-usuario">Usuario de SQL
            <input id="bd-usuario" className="valor-tecnico" value={database.username} onChange={(e) => setDatabase({ ...database, username: e.target.value })} autoComplete="off" spellCheck={false} disabled={disabled} />
          </label>
          <label htmlFor="bd-clave">Contraseña
            <input id="bd-clave" type="password" value={database.password} onChange={(e) => setDatabase({ ...database, password: e.target.value })} autoComplete="new-password" disabled={disabled} />
          </label>
        </div>
        <div className="acciones-formulario">
          <button type="button" onClick={testDatabase} disabled={disabled || !databaseFilled}>
            {databaseCheck.isPending ? "Probando..." : "Probar conexión"}
          </button>
        </div>
      </section>

      <section className="tarjeta conexion-panel" aria-labelledby="titulo-logo">
        <h2 id="titulo-logo">3. Logo (opcional)</h2>
        <label htmlFor="logo-imagen">Imagen del logo (máximo 2 MB)
          <input id="logo-imagen" ref={fileInput} type="file" accept="image/*,.svg" onChange={onImage} disabled={disabled} />
        </label>
        {imagen ? (
          <div className="logo-vista-previa">
            <img src={imagen.previewUrl} alt="Vista previa del logo seleccionado" />
            <span className="texto-ayuda">{imagen.name} · {formatBytes(imagen.bytes)}</span>
          </div>
        ) : null}
      </section>

      {canConfigure ? (
        <div className="acciones-formulario logo-acciones">
          <button type="button" onClick={reset} disabled={busy}>Limpiar</button>
          <button
            type="button"
            onClick={() => start(false)}
            disabled={busy || !storageFilled || !databaseFilled}
            title={storageFilled && databaseFilled ? undefined : "Complete las secciones 1 y 2 para habilitar este botón."}
          >
            {apply.isPending && !withLogo ? "Configurando..." : "Configurar almacenamiento de archivos"}
          </button>
          <button
            type="button"
            className="primario"
            onClick={() => start(true)}
            disabled={busy || !storageFilled || !databaseFilled || !imagen}
            title={storageFilled && databaseFilled && imagen ? undefined : "Complete las secciones 1 y 2 y adjunte el logo para habilitar este botón."}
          >
            {apply.isPending && withLogo ? "Configurando..." : "Configurar almacenamiento de archivos y subir nuevo logo"}
          </button>
        </div>
      ) : null}

      <Modal titulo="Esta compañía ya tiene una configuración" abierto={Boolean(confirmation)} onCerrar={() => setConfirmation(null)}>
        {confirmation ? (
          <>
            <p>Revise qué va a cambiar en la base <strong>{database.databaseName.trim()}</strong>:</p>
            <ul className="logo-cambios">
              {confirmation.changes.map((change) => (
                <li key={change.field}><strong>{change.label}:</strong> <code>{change.before}</code> → <code>{change.after}</code></li>
              ))}
              {confirmation.keysChanged ? <li><strong>Access key y secret key:</strong> se reemplazan por las nuevas.</li> : null}
              {confirmation.replacesLogo ? (
                <li>
                  <strong>Logo:</strong> se reemplaza por el nuevo
                  {confirmation.existingLogoCount > 0 ? ` (en el almacenamiento hay ${confirmation.existingLogoCount === 1 ? "una imagen" : `${confirmation.existingLogoCount} imágenes`} de logo; no se borran)` : ""}.
                </li>
              ) : null}
            </ul>
            <div className="acciones-formulario">
              <button type="button" onClick={() => setConfirmation(null)} disabled={apply.isPending}>Cancelar</button>
              <button type="button" className="primario" onClick={() => apply.mutate({ confirmed: true, logo: withLogo })} disabled={apply.isPending}>
                {apply.isPending ? "Configurando..." : "Sí, reemplazar"}
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
