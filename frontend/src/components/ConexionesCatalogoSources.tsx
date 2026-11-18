import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type CatalogSourceRole = "erp-customers" | "sag-admin";
export type CatalogSourceState = "draft" | "active" | "retired";

export type CatalogSourceItem = Readonly<{
  id: string;
  profileId: string;
  label: string;
  role: CatalogSourceRole;
  state: CatalogSourceState;
  issuerScope?: string;
  canReadCurrentProfile: boolean;
}>;

export type CatalogSourceLoader = (signal: AbortSignal) => Promise<{ items: readonly CatalogSourceItem[] }>;
export type CatalogSourceDraftInput =
  | { role: "erp-customers"; issuerScope: string }
  | { role: "sag-admin" };
export type CatalogSourceDraftBinder = (profileId: string, input: CatalogSourceDraftInput) => Promise<unknown>;

type Props = {
  /** Non-secret opaque scope; change it whenever the effective authorization changes. */
  scopeKey: string;
  profiles: readonly { id: string; displayName: string }[];
  load: CatalogSourceLoader;
  canEdit: boolean;
  bindDraft?: CatalogSourceDraftBinder;
};

const STATUS_LABEL: Record<CatalogSourceState, string> = { draft: "Borrador", active: "Activo", retired: "Retirado" };
const ISSUER_SCOPE = /^[A-Z]{2}:[A-Z0-9][A-Z0-9_-]{0,31}$/;

/** Uses already-authorized metadata; never accepts or displays connection credentials. */
export default function ConexionesCatalogoSources(props: Props) {
  return <CatalogSourceSections key={props.scopeKey} {...props} />;
}

function CatalogSourceSections({ scopeKey, profiles, load, canEdit, bindDraft }: Props) {
  const id = useId();
  const client = useQueryClient();
  const queryKey = ["integration-connections", "catalog-sources", scopeKey] as const;
  const sources = useQuery({ queryKey, queryFn: ({ signal }) => load(signal), retry: false, gcTime: 0 });
  const [profileId, setProfileId] = useState("");
  const [role, setRole] = useState<CatalogSourceRole>("erp-customers");
  const [issuerScope, setIssuerScope] = useState("");
  const [notice, setNotice] = useState<{ type: "error" | "exito"; message: string } | null>(null);

  const draft = useMutation({
    mutationFn: ({ profile, input }: { profile: string; input: CatalogSourceDraftInput }) => {
      if (!canEdit || !bindDraft) throw new Error("Catalog source edit not available");
      return bindDraft(profile, input);
    },
    retry: false,
    onSuccess: () => {
      setProfileId("");
      setIssuerScope("");
      setNotice({ type: "exito", message: "Perfil vinculado como borrador. No se activó el catálogo." });
      return client.invalidateQueries({ queryKey, exact: true });
    },
    onError: () => setNotice({ type: "error", message: "No se pudo vincular el perfil." }),
  });

  const items = sources.isError ? undefined : sources.data?.items;
  const lockedProfiles = new Set(items?.filter(item => item.state !== "draft").map(item => item.profileId));
  const availableProfiles = profiles.filter(profile => !lockedProfiles.has(profile.id));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !bindDraft || !items || draft.isPending || sources.isFetching) return;
    setNotice(null);
    if (!availableProfiles.some(profile => profile.id === profileId)) {
      setNotice({ type: "error", message: "Selecciona un perfil SQL disponible." });
      return;
    }
    if (role === "sag-admin") {
      draft.mutate({ profile: profileId, input: { role } });
      return;
    }
    const scope = issuerScope.trim().toUpperCase();
    if (!ISSUER_SCOPE.test(scope)) {
      setNotice({ type: "error", message: "Usa un ámbito con formato país:tipo, por ejemplo CO:NIT." });
      return;
    }
    draft.mutate({ profile: profileId, input: { role, issuerScope: scope } });
  }

  return (
    <>
      {sources.isPending && <p className="cargando" role="status">Consultando fuentes del catálogo…</p>}
      {sources.isError && (
        <div className="alerta alerta-error" role="alert">
          No se pudieron consultar las fuentes del catálogo.{" "}
          <button type="button" className="secundario" onClick={() => void sources.refetch()}>Reintentar</button>
        </div>
      )}
      <CatalogSourceSection id={`${id}-erp`} title="Bases de datos externas que suministran clientes"
        items={items?.filter(item => item.role === "erp-customers")} />
      <CatalogSourceSection id={`${id}-sag`} title="Base de datos de SAG Admin"
        description="Sólo puede haber una fuente SAG Admin activa."
        items={items?.filter(item => item.role === "sag-admin")} />

      {canEdit && bindDraft && items && (
        <form className="tarjeta" onSubmit={submit} aria-labelledby={`${id}-form`}>
          <h3 id={`${id}-form`}>Vincular perfil al catálogo</h3>
          <p className="texto-ayuda">
            Usa un perfil existente. El borrador no queda activo ni se publica hasta que se valide.
          </p>
          <div className="conexion-grid">
            <div className="campo">
              <label htmlFor={`${id}-profile`}>Perfil SQL existente</label>
              <select id={`${id}-profile`} value={profileId} disabled={draft.isPending}
                onChange={event => setProfileId(event.target.value)} required>
                <option value="">Selecciona un perfil</option>
                {availableProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
              </select>
            </div>
            <div className="campo">
              <label htmlFor={`${id}-role`}>Uso del perfil</label>
              <select id={`${id}-role`} value={role} disabled={draft.isPending}
                onChange={event => {
                  setRole(event.target.value === "sag-admin" ? "sag-admin" : "erp-customers");
                  setIssuerScope("");
                }}>
                <option value="erp-customers">Suministra clientes (ERP)</option>
                <option value="sag-admin">SAG Admin</option>
              </select>
            </div>
            {role === "erp-customers" && <div className="campo">
              <label htmlFor={`${id}-issuer`}>Ámbito emisor (país:tipo)</label>
              <input id={`${id}-issuer`} value={issuerScope} placeholder="CO:NIT" maxLength={35}
                disabled={draft.isPending} onChange={event => setIssuerScope(event.target.value)} required />
            </div>}
          </div>
          {availableProfiles.length === 0 && <p>No hay perfiles SQL disponibles para vincular.</p>}
          <button type="submit" className="primario" disabled={sources.isFetching || draft.isPending || !availableProfiles.length}>
            {draft.isPending ? "Vinculando…" : "Vincular como borrador"}
          </button>
          {notice && <p className={`alerta alerta-${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>
            {notice.message}
          </p>}
        </form>
      )}
    </>
  );
}

function CatalogSourceSection({ id, title, description, items }: {
  id: string;
  title: string;
  description?: string;
  items?: readonly CatalogSourceItem[];
}) {
  return (
    <section className="tarjeta" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {description && <p className="texto-ayuda">{description}</p>}
      {items && (items.length > 0 ? (
        <div className="tabla-contenedor">
          <table aria-label={title}>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Estado</th><th scope="col">Validación</th></tr></thead>
            <tbody>{items.map(item => <tr key={item.id}>
              <th scope="row">{item.label}</th>
              <td>{STATUS_LABEL[item.state]}</td>
              <td>{item.canReadCurrentProfile ? "Lectura del perfil actual confirmada" : "Lectura no confirmada para el perfil actual"}</td>
            </tr>)}</tbody>
          </table>
        </div>
      ) : <p>Sin perfiles vinculados.</p>)}
    </section>
  );
}
