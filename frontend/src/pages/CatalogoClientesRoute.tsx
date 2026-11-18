import { api, type ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import CatalogoClientesPage, {
  type CatalogoClientesQuery,
  type CatalogoClientesResponse,
  type ResumenCatalogoCliente,
} from "./CatalogoClientesPage";
import ClientesPage from "./ClientesPage";

export function catalogCustomersPath(query: CatalogoClientesQuery): string {
  const params = new URLSearchParams({
    state: query.state,
    web: query.web,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.search) params.set("search", query.search);
  for (const id of new Set(query.sourceIds)) params.append("sourceId", id);
  return `/catalog/customers?${params}`;
}

async function loadDetail(id: string, signal: AbortSignal): Promise<ResumenCatalogoCliente | null> {
  try {
    return await api.get<ResumenCatalogoCliente>(`/catalog/customers/${encodeURIComponent(id)}`, { signal });
  } catch (error) {
    if ((error as ApiError | undefined)?.status === 404) return null;
    throw error;
  }
}

export default function CatalogoClientesRoute() {
  const auth = useAuth();
  if (import.meta.env.VITE_PORTAL_CATALOG_READ_ENABLED !== "true") return <ClientesPage />;
  if (auth.cargando || !auth.usuario) return null;
  const scope = JSON.stringify([auth.usuario.id, [...auth.usuario.roles].sort()]);
  return <CatalogoClientesPage
    key={scope}
    scopeKey={scope}
    load={(query, signal) => api.get<CatalogoClientesResponse>(catalogCustomersPath(query), { signal })}
    loadDetail={loadDetail}
  />;
}
