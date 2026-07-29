import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alerta, DialogoConfirmar, Modal } from "../components/Comunes";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../permissionModel";
import { hasPermissionForRoleIds } from "../permissionAccess";
import type {
  ConnectionTestStatus,
  ExternalDatabaseConnection,
  IntegrationConnections,
  SeaweedFSConnection,
} from "../types";

const BASE = "/settings/integrations";

type SeaweedForm = {
  displayName: string;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKey: string;
  secretKey: string;
  active: boolean;
};

type DatabaseForm = {
  id?: string;
  etag?: string;
  displayName: string;
  purpose: string;
  serverHost: string;
  serverPort: number;
  databaseName: string;
  username: string;
  password: string;
  active: boolean;
};

const EMPTY_SEAWEED: SeaweedForm = {
  displayName: "SeaweedFS principal",
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  forcePathStyle: true,
  accessKey: "",
  secretKey: "",
  active: false,
};

const EMPTY_DATABASE: DatabaseForm = {
  displayName: "",
  purpose: "",
  serverHost: "",
  serverPort: 1433,
  databaseName: "",
  username: "",
  password: "",
  active: true,
};

function seaweedForm(value: SeaweedFSConnection | null): SeaweedForm {
  return value ? {
    displayName: value.displayName,
    endpoint: value.endpoint,
    region: value.region,
    bucket: value.bucket,
    forcePathStyle: value.forcePathStyle,
    accessKey: "",
    secretKey: "",
    active: value.active,
  } : { ...EMPTY_SEAWEED };
}

function databaseForm(value?: ExternalDatabaseConnection): DatabaseForm {
  return value ? {
    id: value.id,
    etag: value.etag,
    displayName: value.displayName,
    purpose: value.purpose ?? "",
    serverHost: value.serverHost,
    serverPort: value.serverPort,
    databaseName: value.databaseName,
    username: value.username,
    password: "",
    active: value.active,
  } : { ...EMPTY_DATABASE };
}

function Result({ value }: { value?: ConnectionTestStatus | null }) {
  if (!value) return <span className="texto-ayuda">Sin validación registrada.</span>;
  return (
    <span className={value.succeeded ? "conexion-prueba-exito" : "conexion-prueba-error"}>
      {value.succeeded ? "Validada" : "Falló"} · {new Date(value.testedAt).toLocaleString("es-CO")}
      <small>{value.message}</small>
    </span>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Ocurrió un error inesperado.";
}

export default function ConexionesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [seaweed, setSeaweed] = useState<SeaweedForm>({ ...EMPTY_SEAWEED });
  const [database, setDatabase] = useState<DatabaseForm | null>(null);
  const [deleting, setDeleting] = useState<ExternalDatabaseConnection | null>(null);
  const [notice, setNotice] = useState<{ type: "error" | "exito" | "info"; text: string } | null>(null);
  const [seaweedResult, setSeaweedResult] = useState<ConnectionTestStatus | null>(null);
  const [databaseResult, setDatabaseResult] = useState<ConnectionTestStatus | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["integration-connections"],
    queryFn: () => api.get<IntegrationConnections>(BASE),
  });
  const { data: roleResponse } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
  });
  const roles = Array.isArray(roleResponse) && roleResponse.length > 0
    ? roleResponse
    : DEFAULT_ROLE_DEFINITIONS;
  const roleIds = auth.cargando || !auth.usuario ? [] : auth.usuario.roles;
  const can = (action: string) => hasPermissionForRoleIds(
    roleIds,
    `configuration.integrations.${action}`,
    roles,
  );

  useEffect(() => {
    if (data) setSeaweed(seaweedForm(data.objectStorage));
  }, [data]);

  function seaweedBody() {
    return {
      displayName: seaweed.displayName.trim(),
      endpoint: seaweed.endpoint.trim(),
      region: seaweed.region.trim(),
      bucket: seaweed.bucket.trim(),
      forcePathStyle: seaweed.forcePathStyle,
      ...(seaweed.accessKey ? { accessKey: seaweed.accessKey } : {}),
      ...(seaweed.secretKey ? { secretKey: seaweed.secretKey } : {}),
      active: seaweed.active,
    };
  }

  const testSeaweed = useMutation({
    mutationFn: () => data?.objectStorage?.credentialsConfigured && !seaweed.accessKey && !seaweed.secretKey
      ? api.post<{ connection: SeaweedFSConnection; result: ConnectionTestStatus }>(
        `${BASE}/object-storage/seaweedfs/test-saved`,
      )
      : api.post<{ result: ConnectionTestStatus }>(
        `${BASE}/object-storage/seaweedfs/test`,
        {
          endpoint: seaweed.endpoint.trim(),
          region: seaweed.region.trim(),
          bucket: seaweed.bucket.trim(),
          forcePathStyle: seaweed.forcePathStyle,
          accessKey: seaweed.accessKey,
          secretKey: seaweed.secretKey,
        },
      ),
    onSuccess: (response) => {
      setSeaweedResult(response.result);
      setNotice({ type: response.result.succeeded ? "exito" : "error", text: response.result.message });
      queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
    },
    onError: (error) => setNotice({ type: "error", text: messageOf(error) }),
  });

  const saveSeaweed = useMutation({
    mutationFn: () => api.put<SeaweedFSConnection>(`${BASE}/object-storage/seaweedfs`, {
      ...seaweedBody(),
      ...(data?.objectStorage?.etag ? { etag: data.objectStorage.etag } : {}),
    }),
    onSuccess: (saved) => {
      queryClient.setQueryData<IntegrationConnections>(["integration-connections"], (current) => ({
        objectStorage: saved,
        externalDatabases: current?.externalDatabases ?? [],
      }));
      setSeaweed(seaweedForm(saved));
      setSeaweedResult(saved.lastTest ?? null);
      setNotice({ type: "exito", text: "SeaweedFS fue validado y guardado. El proveedor activo no cambió." });
    },
    onError: (error) => setNotice({ type: "error", text: messageOf(error) }),
  });

  const saveDatabase = useMutation({
    mutationFn: (form: DatabaseForm) => {
      const payload = {
        ...(form.id ? { id: form.id } : {}),
        ...(form.etag ? { etag: form.etag } : {}),
        displayName: form.displayName.trim(),
        purpose: form.purpose.trim() || undefined,
        serverHost: form.serverHost.trim(),
        serverPort: form.serverPort,
        databaseName: form.databaseName.trim(),
        username: form.username.trim(),
        ...(form.password ? { password: form.password } : {}),
        active: form.active,
      };
      return form.id
        ? api.put<ExternalDatabaseConnection>(`${BASE}/external-databases/${form.id}`, payload)
        : api.post<ExternalDatabaseConnection>(`${BASE}/external-databases`, payload);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<IntegrationConnections>(["integration-connections"], (current) => ({
        objectStorage: current?.objectStorage ?? null,
        externalDatabases: [
          ...(current?.externalDatabases ?? []).filter((item) => item.id !== saved.id),
          saved,
        ].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      }));
      setDatabase(null);
      setDatabaseResult(null);
      setNotice({ type: "exito", text: "La conexión SQL Server fue validada y guardada." });
    },
    onError: (error) => setNotice({ type: "error", text: messageOf(error) }),
  });

  const testDatabase = useMutation({
    mutationFn: (form: DatabaseForm) => form.id && !form.password
      ? api.post<{ connection: ExternalDatabaseConnection; result: ConnectionTestStatus }>(
        `${BASE}/external-databases/${form.id}/test`,
      )
      : api.post<{ result: ConnectionTestStatus }>(`${BASE}/external-databases/test`, {
        serverHost: form.serverHost.trim(),
        serverPort: form.serverPort,
        databaseName: form.databaseName.trim(),
        username: form.username.trim(),
        password: form.password,
      }),
    onSuccess: (response) => {
      setDatabaseResult(response.result);
      setNotice({ type: response.result.succeeded ? "exito" : "error", text: response.result.message });
      queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
    },
    onError: (error) => setNotice({ type: "error", text: messageOf(error) }),
  });

  const testSavedDatabase = useMutation({
    mutationFn: (id: string) => api.post<{ connection: ExternalDatabaseConnection; result: ConnectionTestStatus }>(
      `${BASE}/external-databases/${id}/test`,
    ),
    onSuccess: (response) => {
      setNotice({ type: response.result.succeeded ? "exito" : "error", text: response.result.message });
      queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
    },
    onError: (error) => setNotice({ type: "error", text: messageOf(error) }),
  });

  const deleteDatabase = useMutation({
    mutationFn: (item: ExternalDatabaseConnection) => api.del<void>(
      `${BASE}/external-databases/${item.id}`,
      { headers: { "If-Match": `"${item.etag}"` } },
    ),
    onSuccess: (_, item) => {
      queryClient.setQueryData<IntegrationConnections>(["integration-connections"], (current) => ({
        objectStorage: current?.objectStorage ?? null,
        externalDatabases: (current?.externalDatabases ?? []).filter((entry) => entry.id !== item.id),
      }));
      setDeleting(null);
      setNotice({ type: "exito", text: "El perfil fue eliminado; la base de datos externa no fue modificada." });
    },
    onError: (error) => setNotice({ type: "error", text: messageOf(error) }),
  });

  if (isLoading || !data) return <div className="cargando">Cargando conexiones...</div>;

  return (
    <div>
      <div className="encabezado-pagina"><h1>Conexiones</h1></div>
      <Alerta tipo="info">Las contraseñas y claves se guardan en Azure Key Vault. El portal nunca vuelve a mostrarlas ni las almacena en SQL.</Alerta>
      {notice ? <Alerta tipo={notice.type}>{notice.text}</Alerta> : null}

      <section className="tarjeta conexion-panel">
        <div className="conexion-panel-titulo">
          <div>
            <h2>Almacenamiento de objetos · SeaweedFS</h2>
            <p className="texto-ayuda">La prueba escribe, verifica, lee y elimina un objeto temporal.</p>
          </div>
          <Result value={seaweedResult ?? data.objectStorage?.lastTest} />
        </div>
        <div className="conexion-grid">
          <label>Nombre<input value={seaweed.displayName} onChange={(e) => setSeaweed({ ...seaweed, displayName: e.target.value })} /></label>
          <label>Endpoint HTTPS<input value={seaweed.endpoint} onChange={(e) => setSeaweed({ ...seaweed, endpoint: e.target.value })} placeholder="https://s3.ejemplo.com" /></label>
          <label>Región de firma<input value={seaweed.region} onChange={(e) => setSeaweed({ ...seaweed, region: e.target.value })} /></label>
          <label>Bucket<input value={seaweed.bucket} onChange={(e) => setSeaweed({ ...seaweed, bucket: e.target.value })} /></label>
          <label>Access key<input type="password" autoComplete="new-password" value={seaweed.accessKey} onChange={(e) => setSeaweed({ ...seaweed, accessKey: e.target.value })} placeholder={data.objectStorage?.credentialsConfigured ? "Configurada; deje vacío para conservar" : ""} /></label>
          <label>Secret key<input type="password" autoComplete="new-password" value={seaweed.secretKey} onChange={(e) => setSeaweed({ ...seaweed, secretKey: e.target.value })} placeholder={data.objectStorage?.credentialsConfigured ? "Configurada; deje vacío para conservar" : ""} /></label>
        </div>
        <div className="conexion-opciones">
          <label><input type="checkbox" checked={seaweed.forcePathStyle} onChange={(e) => setSeaweed({ ...seaweed, forcePathStyle: e.target.checked })} /> Usar path-style</label>
          <label><input type="checkbox" checked={seaweed.active} onChange={(e) => setSeaweed({ ...seaweed, active: e.target.checked })} /> Perfil habilitado</label>
          <span className="texto-ayuda">Credenciales: {data.objectStorage?.credentialsConfigured ? "configuradas" : "pendientes"}</span>
        </div>
        <Alerta tipo="info">Guardar no cambia el proveedor activo. Blob Storage seguirá en producción hasta un cambio controlado posterior. La validación CORS del navegador es una comprobación separada.</Alerta>
        <div className="acciones-formulario">
          {can("test_object_storage") ? <button onClick={() => testSeaweed.mutate()} disabled={testSeaweed.isPending}>{testSeaweed.isPending ? "Validando..." : "Probar conexión"}</button> : null}
          {can("edit_object_storage") ? <button className="primario" onClick={() => saveSeaweed.mutate()} disabled={saveSeaweed.isPending}>{saveSeaweed.isPending ? "Validando y guardando..." : "Guardar y validar"}</button> : null}
        </div>
      </section>

      <section className="tarjeta conexion-panel">
        <div className="conexion-panel-titulo">
          <div><h2>Bases de datos externas</h2><p className="texto-ayuda">Son independientes del SQL Server principal. La prueba usa TLS estricto y una consulta de lectura.</p></div>
          {can("create_database") ? <button className="primario" onClick={() => { setDatabase(databaseForm()); setDatabaseResult(null); }}>Nueva conexión</button> : null}
        </div>
        <div className="tabla-contenedor">
          <table>
            <thead><tr><th>Conexión</th><th>Servidor</th><th>Base de datos</th><th>TLS</th><th>Última prueba</th><th>Acciones</th></tr></thead>
            <tbody>
              {data.externalDatabases.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.displayName}</strong>{item.purpose ? <div className="texto-ayuda">{item.purpose}</div> : null}</td>
                  <td>{item.serverHost}:{item.serverPort}<div className="texto-ayuda">{item.username}</div></td>
                  <td>{item.databaseName}</td>
                  <td>Cifrado obligatorio</td>
                  <td><Result value={item.lastTest} /></td>
                  <td className="acciones-tabla">
                    {can("test_database") ? <button onClick={() => testSavedDatabase.mutate(item.id)}>Probar</button> : null}
                    {can("edit_database") ? <button onClick={() => { setDatabase(databaseForm(item)); setDatabaseResult(item.lastTest ?? null); }}>Editar</button> : null}
                    {can("delete_database") ? <button className="peligro" onClick={() => setDeleting(item)}>Eliminar</button> : null}
                  </td>
                </tr>
              ))}
              {data.externalDatabases.length === 0 ? <tr><td colSpan={6} className="vacio">No hay conexiones externas configuradas.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <Modal titulo={database?.id ? "Editar conexión SQL Server" : "Nueva conexión SQL Server"} abierto={Boolean(database)} onCerrar={() => setDatabase(null)}>
        {database ? (
          <form onSubmit={(event) => { event.preventDefault(); saveDatabase.mutate(database); }}>
            <div className="conexion-grid">
              <label>Nombre *<input required value={database.displayName} onChange={(e) => setDatabase({ ...database, displayName: e.target.value })} /></label>
              <label>Propósito<input value={database.purpose} onChange={(e) => setDatabase({ ...database, purpose: e.target.value })} /></label>
              <label>Host o IP *<input required value={database.serverHost} onChange={(e) => setDatabase({ ...database, serverHost: e.target.value })} /></label>
              <label>Puerto *<input required type="number" min={1} max={65535} value={database.serverPort} onChange={(e) => setDatabase({ ...database, serverPort: Number(e.target.value) })} /></label>
              <label>Base de datos *<input required value={database.databaseName} onChange={(e) => setDatabase({ ...database, databaseName: e.target.value })} /></label>
              <label>Usuario SQL *<input required value={database.username} onChange={(e) => setDatabase({ ...database, username: e.target.value })} /></label>
              <label>Contraseña *<input type="password" autoComplete="new-password" required={!database.id} value={database.password} onChange={(e) => setDatabase({ ...database, password: e.target.value })} placeholder={database.id ? "Configurada; deje vacío para conservar" : ""} /></label>
              <label><input type="checkbox" checked disabled /> Cifrado TLS obligatorio</label>
              <label><input type="checkbox" checked={database.active} onChange={(e) => setDatabase({ ...database, active: e.target.checked })} /> Perfil habilitado</label>
            </div>
            <Result value={databaseResult} />
            <div className="acciones-formulario">
              {can("test_database") ? <button type="button" onClick={() => testDatabase.mutate(database)} disabled={testDatabase.isPending}>{testDatabase.isPending ? "Validando..." : "Probar conexión"}</button> : null}
              <button type="submit" className="primario" disabled={saveDatabase.isPending}>{saveDatabase.isPending ? "Validando y guardando..." : "Guardar y validar"}</button>
            </div>
          </form>
        ) : null}
      </Modal>

      <DialogoConfirmar
        abierto={Boolean(deleting)}
        titulo="Eliminar perfil de conexión"
        mensaje={`Se ocultará “${deleting?.displayName ?? ""}”. La base de datos externa no se elimina.`}
        textoConfirmar="Eliminar perfil"
        variante="peligro"
        onCancelar={() => setDeleting(null)}
        onConfirmar={() => deleting && deleteDatabase.mutate(deleting)}
      />
    </div>
  );
}
