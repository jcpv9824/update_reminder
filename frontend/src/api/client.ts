// Cliente HTTP. Agrega automáticamente Authorization: Bearer <token>
// si hay un token guardado en localStorage.
const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL ?? "/api";
const TOKEN_KEY = "erp_update_token";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {/* */}
}

function devHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem("devUser");
    if (!raw) return {};
    const u = JSON.parse(raw);
    return {
      "x-dev-user-id": u.id ?? "",
      "x-dev-user-email": u.email ?? "",
      "x-dev-user-name": u.displayName ?? u.name ?? "",
      "x-dev-user-roles": Array.isArray(u.roles) ? u.roles.join(",") : (u.roles ?? ""),
    };
  } catch { return {}; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...devHeaders(),
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    let mensaje = `Error ${res.status}`;
    try { const data = await res.json(); mensaje = data.error ?? mensaje; } catch {/* */}
    if (res.status === 401) {
      // token expirado o inválido: limpiarlo para forzar login.
      setToken(null);
    }
    throw new Error(mensaje);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
