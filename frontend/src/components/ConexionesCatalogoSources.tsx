import { useId, useState, type FormEvent, type ReactNode } from "react";
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
export type CatalogSourceVerifier = (sourceId: string) => Promise<{ status: "verified" }>;
export type CatalogSourceActivator = (sourceId: string) => Promise<{ status: "activated" }>;
type DraftAction = "verify" | "activate";

type Props = {
  /** Non-secret opaque scope; change it whenever the effective authorization changes. */
  scopeKey: string;
  profiles: readonly { id: string; displayName: string }[];
  load: CatalogSourceLoader;
  canEdit: boolean;
  canTest: boolean;
  bindDraft?: CatalogSourceDraftBinder;
  verifyDraft?: CatalogSourceVerifier;
  activateDraft?: CatalogSourceActivator;
};

const STATUS_LABEL: Record<CatalogSourceState, string> = { draft: "Borrador", active: "Activo", retired: "Retirado" };
const ISSUER_SCOPE = /^[A-Z]{2}:[A-Z0-9][A-Z0-9_-]{0,31}$/;

function needsValidation(item: CatalogSourceItem) {
  return item.state === "draft" || (item.state === "active" && !item.canReadCurrentProfile);
}

/** Uses already-authorized metadata; never accepts or displays connection credentials. */
export default function ConexionesCatalogoSources(props: Props) {
  return <CatalogSourceSections key={props.scopeKey} {...props} />;
}

function CatalogSourceSections({ scopeKey, profiles, load, canEdit, canTest, bindDraft, verifyDraft, activateDraft }: Props) {
  const id = useId();
  const client = useQueryClient();
  const queryKey = ["integration-connections", "catalog-sources", scopeKey] as const;
  const sources = useQuery({ queryKey, queryFn: ({ signal }) => load(signal), retry: false, gcTime: 0 });
  const [profileId, setProfileId] = useState("");
  const [role, setRole] = useState<CatalogSourceRole>("erp-customers");
  const [issuerScope, setIssuerScope] = useState("");
  const [notice, setNotice] = useState<{ type: "error" | "exito"; message: string } | null>(null);
  const [confirmSourceId, setConfirmSourceId] = useState<string | null>(null);
  const items = sources.isError ? undefined : sources.data?.items;
  const allowVerify = canTest && !!verifyDraft;
  const allowActivate = canTest && canEdit && !!activateDraft;
  const confirming = allowActivate && !!items?.some(item => item.id === confirmSourceId && needsValidation(item));

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

  const operation = useMutation({
    mutationFn: async ({ action, sourceId }: { action: DraftAction; sourceId: string; isDraft: boolean }) => {
      if (!items?.some(item => item.id === sourceId
        && (action === "verify" ? item.state !== "retired" : needsValidation(item)))) {
        throw new Error("Catalog source unavailable for verification");
      }
      if (action === "verify" && allowVerify && verifyDraft) {
        if ((await verifyDraft(sourceId)).status === "verified") return;
      }
      if (action === "activate" && allowActivate && activateDraft && confirmSourceId === sourceId) {
        if ((await activateDraft(sourceId)).status === "activated") return;
      }
      throw new Error("Unexpected catalog source operation");
    },
    retry: false,
    onSuccess: (_, { action, isDraft }) => setNotice({
      type: "exito",
      message: action === "verify"
        ? (isDraft ? "Verificación completada. La fuente sigue en borrador." : "Verificación completada. El estado de la fuente no cambió.")
        : (isDraft ? "Fuente activada." : "Fuente revalidada."),
    }),
    onError: (_, { action, isDraft }) => setNotice({
      type: "error",
      message: action === "verify" ? "No se pudo verificar la fuente."
        : (isDraft ? "No se pudo activar la fuente." : "No se pudo revalidar la fuente."),
    }),
    onSettled: (_, _error, { action }) => {
      if (action === "activate") setConfirmSourceId(null);
      return client.invalidateQueries({ queryKey, exact: true });
    },
  });
  const busy = draft.isPending || operation.isPending || sources.isFetching;
  const lockedProfiles = new Set(items?.filter(item => item.state !== "draft").map(item => item.profileId));
  const availableProfiles = profiles.filter(profile => !lockedProfiles.has(profile.id));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !bindDraft || !items || busy || confirming) return;
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

  function runOperation(action: DraftAction, item: CatalogSourceItem) {
    if (busy || (action === "verify" && (!allowVerify || confirming)) ||
        (action === "activate" && (!confirming || confirmSourceId !== item.id))) return;
    setNotice(null);
    operation.mutate({ action, sourceId: item.id, isDraft: item.state === "draft" });
  }

  function renderActions(item: CatalogSourceItem) {
    if (item.state === "retired") return null;
    const isDraft = item.state === "draft";
    if (confirming && confirmSourceId === item.id) {
      return (
        <div role="group" aria-label={`Confirmar ${isDraft ? "activación" : "revalidación"} de ${item.label}`}>
          <p className="texto-ayuda">Se volverá a verificar el perfil antes de habilitar la fuente para el catálogo.</p>
          <div className="acciones-formulario">
            <button type="button" className="secundario" disabled={operation.isPending}
              onClick={() => setConfirmSourceId(null)} autoFocus>Cancelar</button>
            <button type="button" className="primario" disabled={busy} onClick={() => runOperation("activate", item)}>
              {operation.isPending ? "Procesando…" : (isDraft ? "Confirmar activación" : "Confirmar revalidación")}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="acciones-formulario">
        {allowVerify && (
          <button type="button" className="secundario" disabled={busy || confirming}
            onClick={() => runOperation("verify", item)}>
            {operation.isPending && operation.variables?.sourceId === item.id ? "Verificando…" : "Verificar"}
          </button>
        )}
        {allowActivate && needsValidation(item) && (
          <button type="button" className="primario" disabled={busy || confirming}
            onClick={() => { setNotice(null); setConfirmSourceId(item.id); }}>
            {isDraft ? "Activar" : "Revalidar fuente"}
          </button>
        )}
      </div>
    );
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
        items={items?.filter(item => item.role === "erp-customers")}
        renderActions={allowVerify || allowActivate ? renderActions : undefined} />
      <CatalogSourceSection id={`${id}-sag`} title="Base de datos de SAG Admin"
        description="Sólo puede haber una fuente SAG Admin activa."
        items={items?.filter(item => item.role === "sag-admin")}
        renderActions={allowVerify || allowActivate ? renderActions : undefined} />
      {notice && <p className={`alerta alerta-${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>
        {notice.message}
      </p>}

      {canEdit && bindDraft && items && (
        <form className="tarjeta" onSubmit={submit} aria-labelledby={`${id}-form`}>
          <h3 id={`${id}-form`}>Vincular perfil al catálogo</h3>
          <p className="texto-ayuda">
            Usa un perfil existente. Verificar no activa la fuente ni publica el catálogo.
          </p>
          <div className="conexion-grid">
            <div className="campo">
              <label htmlFor={`${id}-profile`}>Perfil SQL existente</label>
              <select id={`${id}-profile`} value={profileId} disabled={busy || confirming}
                onChange={event => setProfileId(event.target.value)} required>
                <option value="">Selecciona un perfil</option>
                {availableProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
              </select>
            </div>
            <div className="campo">
              <label htmlFor={`${id}-role`}>Uso del perfil</label>
              <select id={`${id}-role`} value={role} disabled={busy || confirming}
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
                disabled={busy || confirming} onChange={event => setIssuerScope(event.target.value)} required />
            </div>}
          </div>
          {availableProfiles.length === 0 && <p>No hay perfiles SQL disponibles para vincular.</p>}
          <button type="submit" className="primario" disabled={busy || confirming || !availableProfiles.length}>
            {draft.isPending ? "Vinculando…" : "Vincular como borrador"}
          </button>
        </form>
      )}
    </>
  );
}

function CatalogSourceSection({ id, title, description, items, renderActions }: {
  id: string;
  title: string;
  description?: string;
  items?: readonly CatalogSourceItem[];
  renderActions?: (item: CatalogSourceItem) => ReactNode;
}) {
  return (
    <section className="tarjeta" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {description && <p className="texto-ayuda">{description}</p>}
      {items && (items.length > 0 ? (
        <div className="tabla-contenedor">
          <table aria-label={title}>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Estado</th><th scope="col">Validación</th>
              {renderActions && <th scope="col">Acciones</th>}
            </tr></thead>
            <tbody>{items.map(item => <tr key={item.id}>
              <th scope="row">{item.label}</th>
              <td>{STATUS_LABEL[item.state]}</td>
              <td>{item.canReadCurrentProfile ? "Lectura del perfil actual confirmada" : "Lectura no confirmada para el perfil actual"}</td>
              {renderActions && <td>{renderActions(item)}</td>}
            </tr>)}</tbody>
          </table>
        </div>
      ) : <p>Sin perfiles vinculados.</p>)}
    </section>
  );
}
