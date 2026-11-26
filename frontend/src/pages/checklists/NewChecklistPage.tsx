import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ErpClientCombobox } from "../queHayDeNuevo/componentes/ErpClientCombobox";
import { checklistsApi } from "./api";
import { ErrorNotice, Loading, useRefreshTemplates, useTemplateKeys } from "./components";
import { implementationPath } from "./ImplementationChecklistsRoutes";
import { checklistDate, environmentNames } from "./ChecklistsPage";
import type { CreateChecklist, Environment } from "./types";
export function ExistingChecklistLink({ error }: { error: unknown }) {
  const e = error as { data?: { error?: string; details?: { existing?: { id?: string } } } }; const id = e?.data?.details?.existing?.id;
  return id ? <Link to={`${implementationPath}/${encodeURIComponent(id)}`}>{e.data?.error === "duplicate_completed" ? "Ver el completado" : "Abrir el checklist existente"}</Link> : null;
}
export default function NewChecklistPage() {
  const keys = useTemplateKeys(); const refresh = useRefreshTemplates(); const navigate = useNavigate();
  const source = useQuery({ queryKey: [...keys, "create-options"], queryFn: () => checklistsApi.list() });
  const [client, setClient] = useState<{ id: string; label: string } | null>(null); const [templateId, setTemplateId] = useState(""); const [environment, setEnvironment] = useState<Environment | "">(""); const [error, setError] = useState(""); const [confirmation, setConfirmation] = useState(false);
  const creation = useMutation({ mutationFn: (body: CreateChecklist) => checklistsApi.create(body), onSuccess: async c => { await refresh(); navigate(`${implementationPath}/${c.id}`); }, onError: e => { if ((e as { data?: { error?: string } }).data?.error === "duplicate_completed") setConfirmation(true); } });
  if (source.isPending) return <Loading />;
  if (source.error) return <ErrorNotice error={source.error} />;
  if (source.data.availableTemplates === undefined) return <p role="alert">No tiene permiso para crear checklists.</p>;
  const template = source.data.availableTemplates.find(t => t.id === templateId);
  function submit(confirmDuplicate = false) {
    setError(""); if (!client) return setError("Seleccione un cliente de la lista"); if (!template) return setError("Seleccione la plantilla"); if (template.requiresEnvironment && !environment) return setError("Seleccione el ambiente");
    creation.mutate({ clientId: client.id, templateId, ...(template.requiresEnvironment && environment ? { environment } : {}), ...(confirmDuplicate ? { confirmDuplicate: true } : {}) });
  }
  const duplicate = (creation.error as { data?: { error?: string; details?: { existing?: { ownerName?: string; createdAt?: string; completedAt?: string } } } } | null)?.data;
  return <><nav className="checklists-migas" aria-label="Migas de pan">Implementación › <Link to={implementationPath}>Checklists</Link> › Nuevo</nav><section className="tarjeta"><header className="checklists-heading"><Link to={implementationPath}>Volver</Link><h1>Nuevo checklist</h1></header><form onSubmit={e => { e.preventDefault(); submit(); }}><fieldset className="checklists-create-grid" disabled={creation.isPending}>
    <ErpClientCombobox name={client?.label ?? null} readOnly={false} scope={keys} lookup={checklistsApi.clients} onSelect={setClient} onInputChange={() => { setClient(null); setConfirmation(false); creation.reset(); }} label="Clientes" labelPrefix="" helpText="Escriba al menos 3 letras" isQueryValid={q => (q.match(/\p{L}/gu)?.length ?? 0) >= 3} />
    <label>Plantilla<select value={templateId} onChange={e => { setTemplateId(e.target.value); setEnvironment(""); setConfirmation(false); creation.reset(); }}><option value="">Seleccione…</option>{source.data.availableTemplates.map(t => <option key={t.id} value={t.id}>{t.name} · v{t.number}.0</option>)}</select></label>
    {template?.requiresEnvironment && <label>Ambiente<select value={environment} onChange={e => { setEnvironment(e.target.value as Environment); setConfirmation(false); creation.reset(); }}><option value="">Seleccione…</option>{Object.entries(environmentNames).map(([v,label]) => <option value={v} key={v}>{label}</option>)}</select></label>}
    </fieldset>{error && <div className="alerta alerta-error" role="alert">{error}</div>}<ErrorNotice error={creation.error} />{duplicate?.error === "duplicate_in_progress" && <p>Ya hay un checklist en progreso de esta plantilla para {client?.label}{environment ? ` en ${environmentNames[environment]}` : ""} (de {duplicate.details?.existing?.ownerName}, creado el {checklistDate(duplicate.details?.existing?.createdAt ?? null)}). Continúe ese en vez de crear otro.</p>}<ExistingChecklistLink error={creation.error} />
    {confirmation && <div className="alerta alerta-info"><p>Ya hay uno completado de esta plantilla para {client?.label}{environment ? ` en ${environmentNames[environment]}` : ""} (terminado el {checklistDate(duplicate?.details?.existing?.completedAt ?? null)}). ¿Crear otro de todos modos?</p><button type="button" disabled={creation.isPending} onClick={() => { setConfirmation(false); creation.reset(); }}>Cancelar confirmación</button><button type="button" className="primario" disabled={creation.isPending} onClick={() => submit(true)}>Sí, crear otro</button></div>}
    {!source.data.availableTemplates.length && <p>No hay plantillas con versión vigente. Solicite que se publique una plantilla.</p>}<div className="acciones-formulario"><Link to={implementationPath}>Cancelar</Link><button className="primario" disabled={creation.isPending || confirmation}>Crear checklist</button></div></form></section></>;
}
