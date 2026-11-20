import { useQuery } from "@tanstack/react-query";
import { api, type ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type {
  CargadoresIndicadores, IndicadorDominiosCliente, IndicadorLicenciasCliente,
} from "../components/CatalogoClienteIndicadores";
import { catalogRefreshServiceIfEnabled } from "../hooks/useCatalogRefresh";
import { hasPermissionForRoleIds } from "../permissionAccess";
import type { RoleDefinition } from "../permissionModel";
import CatalogoClientesPage, {
  type CatalogoClientesQuery,
  type CatalogoClientesResponse,
  type ResumenCatalogoCliente,
} from "./CatalogoClientesPage";
import ClientesPage from "./ClientesPage";

export function catalogCustomersPath(query: CatalogoClientesQuery, directoryV2 = false): string {
  const params = new URLSearchParams({
    state: query.state,
    web: query.web,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.search && !directoryV2) params.set("search", query.search);
  for (const id of new Set(query.sourceIds)) params.append("sourceId", id);
  return `/catalog/customers${directoryV2 && query.search ? "/search" : ""}?${params}`;
}

function loadCustomers(query: CatalogoClientesQuery, signal: AbortSignal, directoryV2: boolean): Promise<CatalogoClientesResponse> {
  const path = catalogCustomersPath(query, directoryV2);
  if (directoryV2 && query.search) return api.post<CatalogoClientesResponse>(path, { search: query.search }, { signal });
  return api.get<CatalogoClientesResponse>(path, { signal });
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
  const catalogoCompletoHabilitado = import.meta.env.VITE_PORTAL_CATALOG_READ_ENABLED === "true";
  const catalogoHabilitado = catalogoCompletoHabilitado || import.meta.env.VITE_PORTAL_CATALOG_CLIENTS_READ_ENABLED === "true";
  const directorioV2 = import.meta.env.VITE_PORTAL_CATALOG_DIRECTORY_V2_ENABLED === "true";
  const consultaRoles = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
    enabled: catalogoCompletoHabilitado && !auth.cargando && !!auth.usuario,
  });
  if (!catalogoHabilitado) return <ClientesPage />;
  if (auth.cargando || !auth.usuario) return null;
  // Unknown permissions do not enable optional indicator queries.
  const roles = consultaRoles.isSuccess && Array.isArray(consultaRoles.data) ? consultaRoles.data : [];
  const verDominios = catalogoCompletoHabilitado && hasPermissionForRoleIds(auth.usuario.roles, "clients.domains.view", roles);
  const verLicencias = catalogoCompletoHabilitado && hasPermissionForRoleIds(auth.usuario.roles, "clients.licensing.view", roles);
  const indicadores: CargadoresIndicadores = {
    dominios: verDominios ? (id, signal) => api.get<IndicadorDominiosCliente>(`/catalog/customers/${encodeURIComponent(id)}/domains`, { signal }) : undefined,
    licencias: verLicencias ? (id, signal) => api.get<IndicadorLicenciasCliente>(`/catalog/customers/${encodeURIComponent(id)}/licenses`, { signal }) : undefined,
  };
  const scope = JSON.stringify([auth.usuario.id, [...auth.usuario.roles].sort()]);
  return <CatalogoClientesPage
    key={scope}
    scopeKey={scope}
    load={(query, signal) => loadCustomers(query, signal, directorioV2)}
    loadDetail={loadDetail}
    indicadores={indicadores}
    refreshService={catalogRefreshServiceIfEnabled()}
  />;
}
