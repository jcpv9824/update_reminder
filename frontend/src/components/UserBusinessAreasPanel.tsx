import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

const AREAS = [
  ["soporte", "Soporte"], ["desarrollo", "Desarrollo"],
  ["ventas", "Ventas"], ["administrativa", "Administrativa"],
] as const;
type Area = (typeof AREAS)[number][0];
type AreasResponse = { areas: Area[]; etag: string };

/** Classification only: this form never changes roles, permissions or active state. */
export default function UserBusinessAreasPanel({ actorScope, userId, canEdit, onSaved }: {
  actorScope: string; userId: string; canEdit: boolean; onSaved: () => void;
}) {
  const client = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const queryKey = ["user-business-areas", actorScope, userId];
  const path = `/whats-new/users/${encodeURIComponent(userId)}/business-areas`;
  const [selected, setSelected] = useState<Area[]>([]);
  const [blocked, setBlocked] = useState(false);
  const query = useQuery({
    queryKey, queryFn: () => api.get<AreasResponse>(path),
    retry: false, gcTime: 0, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (query.data) setSelected([...query.data.areas]);
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: (input: { areas: Area[]; version: string }) => api.put<AreasResponse>(
      path, { areas: input.areas }, { headers: { "If-Match": input.version } },
    ),
    onSuccess: result => {
      void client.invalidateQueries({ queryKey: ["whats-new"] });
      if (mounted.current) {
        client.setQueryData(queryKey, result);
        onSaved();
      }
    },
    onError: () => { if (mounted.current) setBlocked(true); },
    retry: false,
  });
  function save(event: FormEvent) {
    event.preventDefault();
    if (canEdit && !blocked && !mutation.isPending && !query.isFetching && query.data?.etag) {
      mutation.mutate({ areas: [...selected], version: query.data.etag });
    }
  }
  function reload() {
    void query.refetch().then(result => {
      if (!result.error && result.data) {
        setSelected([...result.data.areas]); setBlocked(false); mutation.reset();
      }
    });
  }
  if (query.isPending) return <p role="status">Consultando áreas…</p>;
  if (query.isError || !query.data) return <div>
    <p className="alerta alerta-error" role="alert">No se pudieron consultar las áreas.</p>
    <button type="button" onClick={reload} disabled={query.isFetching}>Volver a consultar</button>
  </div>;
  const disabled = !canEdit || mutation.isPending || query.isFetching;
  return <form onSubmit={save}>
    <p className="texto-ayuda">Clasifica a la persona. Estas áreas no conceden roles ni permisos.</p>
    <fieldset disabled={disabled}>
      <legend>Áreas de la persona</legend>
      {AREAS.map(([code, label]) => <label key={code}>
        <input type="checkbox" checked={selected.includes(code)} onChange={event => {
          setSelected(previous => event.target.checked ? [...previous, code] : previous.filter(value => value !== code));
        }} /> {label}
      </label>)}
    </fieldset>
    {mutation.isError && <p className="alerta alerta-error" role="alert">
      No se pudieron guardar las áreas. Vuelve a consultar e inténtalo de nuevo.
    </p>}
    <div className="acciones-formulario">
      <button type="button" onClick={reload} disabled={mutation.isPending || query.isFetching}>Volver a consultar</button>
      {canEdit && <button type="submit" className="primario" disabled={disabled || blocked}>
        {mutation.isPending ? "Guardando…" : "Guardar áreas"}
      </button>}
    </div>
  </form>;
}
